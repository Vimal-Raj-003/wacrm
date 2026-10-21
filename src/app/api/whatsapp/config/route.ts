import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  getAppIdFromToken,
  getPhoneNumberRegistration,
  getSubscribedApps,
  listWabaPhoneNumbers,
} from '@/lib/whatsapp/meta-api'
import {
  explainMetaError,
  metaErrorPayload,
  type MetaConnectStep,
  type MetaErrorContext,
} from '@/lib/whatsapp/meta-error-explain'
import {
  appSubscriptionState,
  describeWabaPhoneMismatch,
  isNumericMetaId,
  phoneNumberBelongsToWaba,
} from '@/lib/whatsapp/waba-pairing'
import { assessRegistration } from '@/lib/whatsapp/registration-state'
import { writeConfigRow } from '@/lib/whatsapp/config-columns'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

/**
 * Resolve the caller's account_id from their profile. Inlined here
 * (rather than going through `@/lib/auth/account.getCurrentAccount`)
 * because the GET handler wants to return shaped 200s for every
 * non-auth failure mode, not throw — keeping the helper minimal lets
 * the existing response branches stay as-is.
 *
 * Returns null if the user has no profile or no account; callers
 * should treat that the same as "not connected".
 */
async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

// Lazy-initialised service-role client. We need it to detect a
// phone_number_id already claimed by a *different* user — under RLS,
// the user's own session can't see other users' rows, so the conflict
// would be invisible without the service role.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * Shape every failed Meta call into `{ error, meta }` — the actionable
 * text plus the code / subcode / fbtrace_id / step a user can quote to
 * Meta support. Status is 400 when the fix is on the user's side (token,
 * ids, PIN) and 502 when Meta has to change something (issue #505).
 */
function metaFailure(err: unknown, step: MetaConnectStep, ctx: MetaErrorContext) {
  const explained = explainMetaError(err, step, ctx)
  console.error(`[whatsapp/config] Meta ${step} failed:`, explained.metaMessage, {
    code: explained.code,
    subcode: explained.subcode,
    fbtrace_id: explained.fbtraceId,
  })
  return NextResponse.json(
    { error: explained.summary, meta: metaErrorPayload(explained) },
    { status: explained.httpStatus },
  )
}

/**
 * Which Meta app the stored token belongs to. Preferred over the
 * `META_APP_ID` env var because it is always right and needs no
 * configuration; the env var remains the fallback for tokens that
 * cannot introspect themselves.
 */
async function resolveAppId(accessToken: string): Promise<string | null> {
  const identity = await getAppIdFromToken({ accessToken })
  return identity?.appId ?? process.env.META_APP_ID ?? null
}

/**
 * GET /api/whatsapp/config
 *
 * "Verify Connection" — a read-only health check. Returns 200 in all
 * non-auth cases so the UI can render an appropriate message rather
 * than show a 500. Performs no writes and no Meta mutations.
 *
 * Response shape:
 *   { connected: true,  phone_info: {...},
 *     registration: { registered, registration_required, pin_requirement, ... },
 *     waba_subscription: { checked, subscribed, app_id_match, app_id, subscribed_app_ids } }
 *   { connected: false, reason: 'no_config',        message: '...' }
 *   { connected: false, reason: 'token_corrupted',  message: '...', needs_reset: true }
 *   { connected: false, reason: 'meta_api_error',   message: '...',
 *     meta: { code, subcode, fbtrace_id, step, field, message } }
 */
export async function GET() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_account',
          message: 'Your profile is not linked to an account.',
        },
        { status: 200 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, waba_id, access_token, status')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError) {
      console.error('Error fetching whatsapp_config:', configError)
      return NextResponse.json(
        { connected: false, reason: 'db_error', message: 'Failed to fetch configuration' },
        { status: 200 }
      )
    }

    if (!config) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message: 'No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.',
        },
        { status: 200 }
      )
    }

    // Try to decrypt the stored token with the current ENCRYPTION_KEY.
    // If this fails, the key changed (or was never consistent across envs).
    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch (err) {
      console.error('[whatsapp/config GET] Token decryption failed:', err)
      return NextResponse.json(
        {
          connected: false,
          reason: 'token_corrupted',
          needs_reset: true,
          message:
            'The stored access token cannot be decrypted with the current ENCRYPTION_KEY. This usually means the key changed, or it differs between environments (local vs Hostinger vs Vercel). Click "Reset Configuration" below, then re-save.',
        },
        { status: 200 }
      )
    }

    // Validate credentials against Meta, reading the registration
    // fields in the same call — `status` and `platform_type` are what
    // actually say whether this number is live, and they cost nothing
    // extra here.
    let phoneInfo
    try {
      phoneInfo = await getPhoneNumberRegistration({
        phoneNumberId: config.phone_number_id,
        accessToken,
      })
    } catch (err) {
      const explained = explainMetaError(err, 'verify_number', {
        phoneNumberId: config.phone_number_id,
        wabaId: config.waba_id,
      })
      console.error('[whatsapp/config GET] Meta API verification failed:', explained.metaMessage)
      return NextResponse.json(
        {
          connected: false,
          reason: 'meta_api_error',
          message: explained.summary,
          meta: metaErrorPayload(explained),
        },
        { status: 200 }
      )
    }

    const registration = assessRegistration(phoneInfo)

    // Credentials work. Also report whether the WABA is subscribed to
    // this app — valid credentials with an unsubscribed WABA is exactly
    // the "connected but no messages arrive" state (issue #505). Never
    // fatal: the token may lack whatsapp_business_management and still
    // be fine for sending.
    //
    // The match is by app id, recovered from the token itself. The old
    // "the list is non-empty, so it must be us" shortcut is wrong on any
    // WABA with more than one subscriber, which is common.
    let wabaSubscription: {
      checked: boolean
      subscribed: boolean | null
      app_id_match: boolean | null
      app_id?: string | null
      subscribed_app_ids?: string[]
      error?: string
    } = { checked: false, subscribed: null, app_id_match: null }
    if (config.waba_id) {
      try {
        const appId = await resolveAppId(accessToken)
        const subs = await getSubscribedApps({ wabaId: config.waba_id, accessToken })
        const state = appSubscriptionState(subs, appId)
        wabaSubscription = {
          checked: true,
          subscribed: state.subscribed,
          app_id_match: state.appIdMatch,
          app_id: appId,
          subscribed_app_ids: subs
            .map((s) => s.whatsapp_business_api_data?.id)
            .filter((id): id is string => typeof id === 'string'),
        }
      } catch (err) {
        const explained = explainMetaError(err, 'subscribed_apps', { wabaId: config.waba_id })
        wabaSubscription = {
          checked: true,
          subscribed: null,
          app_id_match: null,
          error: explained.summary,
        }
      }
    }

    return NextResponse.json({
      connected: true,
      phone_info: phoneInfo,
      registration: {
        registered: registration.registered,
        registration_required: registration.registrationRequired,
        pin_requirement: registration.pinRequirement,
        pin_deprecation_eligible: registration.pinDeprecationEligible,
        summary: registration.summary,
        blockers: registration.blockers,
      },
      waba_subscription: wabaSubscription,
    })
  } catch (error) {
    console.error('Error in WhatsApp config GET:', error)
    return NextResponse.json(
      { connected: false, reason: 'unknown', message: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/whatsapp/config  —  Save Configuration, and nothing else.
 *
 * What this used to do, and why it broke
 * --------------------------------------
 * Saving also attempted `POST /{phone_number_id}/register` and
 * `POST /{waba_id}/subscribed_apps`, deciding that registration was
 * needed whenever the local `registered_at` column was NULL. That
 * column only records whether *wacrm* ever registered the number, so a
 * number onboarded through Embedded Signup — or registered by any other
 * tool — looked unregistered forever. Save therefore sent /register
 * with whatever sat in the PIN box, and on a number with no two-step
 * verification PIN Meta answered `(#133005) Two-step verification PIN
 * mismatch`. The route stored that as `last_registration_error` and
 * wrote `status='disconnected'` over a channel that was live and
 * sending. Each attempt also burned one of the 10 /register calls Meta
 * allows per number per 72 hours (error 133016).
 *
 * What it does now
 * ----------------
 * Saving is a save. It verifies the credentials, proves the number
 * belongs to the WABA, reads Meta's authoritative registration state,
 * and stores all of it. It never registers, never deregisters, never
 * subscribes, and never asks for a PIN. The three mutating steps are
 * explicit, separately invoked endpoints:
 *
 *   POST /api/whatsapp/config/register            (Register Number)
 *   POST /api/whatsapp/config/subscribe-webhooks  (Subscribe Webhooks)
 *   POST /api/whatsapp/config/test-template       (Send Test Template)
 *
 * and `GET /api/whatsapp/config/verify-registration` is the read-only
 * diagnostic that decides Campaign Ready.
 *
 * Every Meta failure answers `{ error, meta: { code, subcode,
 * fbtrace_id, step, field, message } }` — `error` is the actionable
 * text, `meta` is what to quote to Meta support. 400 = fix it on the
 * form, 502 = Meta has to change something.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const { phone_number_id, waba_id, access_token, verify_token } = body

    if (!access_token || !phone_number_id) {
      return NextResponse.json(
        { error: 'access_token and phone_number_id are required' },
        { status: 400 }
      )
    }

    // Meta ids are decimal digit strings. Catch the classic paste
    // mistakes (the +phone number, a display name, a URL) here with a
    // named field, instead of letting Meta answer "(#100) Unsupported
    // get request" for a value we could have rejected up front.
    if (!isNumericMetaId(phone_number_id)) {
      return NextResponse.json(
        {
          error:
            'Phone Number ID must contain only digits — it is the numeric id shown under Meta → WhatsApp → API Setup, not the phone number itself.',
          field: 'phone_number_id',
        },
        { status: 400 }
      )
    }
    if (waba_id !== undefined && waba_id !== null && waba_id !== '' && !isNumericMetaId(waba_id)) {
      return NextResponse.json(
        {
          error:
            'WhatsApp Business Account ID must contain only digits — copy it from Meta → WhatsApp → API Setup.',
          field: 'waba_id',
        },
        { status: 400 }
      )
    }
    const metaCtx: MetaErrorContext = { phoneNumberId: phone_number_id, wabaId: waba_id || null }

    // Reject if another account has already claimed this phone_number_id.
    // wacrm is single-tenant-per-WhatsApp-number — letting two accounts
    // bind the same number causes the webhook's `.single()` lookup to
    // throw PGRST116 ("multiple rows"), silently dropping every
    // inbound message. See issue #136. Post-multi-user we key on
    // account_id (not user_id) since teammates inside the same account
    // all share one config; the conflict is between accounts.
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phone_number_id)
      .neq('account_id', accountId)
      .maybeSingle()

    if (claimedError) {
      console.error('Error checking phone_number_id ownership:', claimedError)
      return NextResponse.json(
        { error: 'Failed to validate configuration' },
        { status: 500 }
      )
    }

    if (claimed) {
      return NextResponse.json(
        {
          error:
            'This WhatsApp phone number is already linked to another account on this instance. Each phone number can only be connected to one wacrm user.',
        },
        { status: 409 }
      )
    }

    // Verify credentials with Meta BEFORE saving, reading the
    // registration fields in the same request.
    let phoneInfo
    try {
      phoneInfo = await getPhoneNumberRegistration({
        phoneNumberId: phone_number_id,
        accessToken: access_token,
      })
    } catch (err) {
      return metaFailure(err, 'verify_number', metaCtx)
    }

    // The number resolves — now make sure it lives under the WABA the
    // user typed. A foreign-but-valid WABA ID used to save fine and
    // subscribe the *wrong* account, surfacing days later as a webhook
    // that never fires. Failing here names the mismatch instead.
    if (waba_id) {
      let wabaNumbers
      try {
        wabaNumbers = await listWabaPhoneNumbers({
          wabaId: waba_id,
          accessToken: access_token,
        })
      } catch (err) {
        return metaFailure(err, 'waba_phone_numbers', metaCtx)
      }
      if (!phoneNumberBelongsToWaba(wabaNumbers, phone_number_id)) {
        return NextResponse.json(
          {
            error: describeWabaPhoneMismatch(wabaNumbers, phone_number_id, waba_id),
            field: 'waba_id',
            meta: {
              code: null,
              subcode: null,
              fbtrace_id: null,
              step: 'waba_phone_numbers',
              field: 'waba_id',
              message: 'phone_number_id is not listed under waba_id',
            },
          },
          { status: 400 }
        )
      }
    }

    const registration = assessRegistration(phoneInfo)

    // Which app the token belongs to — stored so the subscription check
    // can match by id without a META_APP_ID env var. Best-effort.
    const appId = await resolveAppId(access_token)

    // Encrypt sensitive tokens before storing
    let encryptedAccessToken: string
    let encryptedVerifyToken: string | null
    try {
      encryptedAccessToken = encrypt(access_token)
      encryptedVerifyToken = verify_token ? encrypt(verify_token) : null
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown encryption error'
      console.error('Encryption failed:', message)
      return NextResponse.json(
        {
          error:
            'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        { status: 500 }
      )
    }

    // Read the existing row so this save preserves everything it is not
    // responsible for. Notably `subscribed_apps_at`, which the previous
    // implementation overwrote with NULL whenever no waba_id was
    // submitted, and `verify_token`, which must survive a save that
    // didn't include one.
    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id, registered_at, subscribed_apps_at, verify_token, phone_number_id')
      .eq('account_id', accountId)
      .maybeSingle()

    const sameNumber = existing?.phone_number_id === phone_number_id

    // `registered_at` keeps its historical meaning (when wacrm last
    // registered) but is also stamped from Meta's own onboarding time
    // when Meta says the number is live — so a number registered
    // elsewhere stops reading as "never registered". Never cleared here:
    // a save is not evidence that a registration went away.
    const metaOnboardedAt = phoneInfo.last_onboarded_time
      ? new Date(phoneInfo.last_onboarded_time).toISOString()
      : null
    const registeredAt = registration.registered
      ? (existing?.registered_at ?? metaOnboardedAt ?? new Date().toISOString())
      : sameNumber
        ? (existing?.registered_at ?? null)
        : null

    const nowIso = new Date().toISOString()
    const row: Record<string, unknown> = {
      phone_number_id,
      waba_id: waba_id || null,
      access_token: encryptedAccessToken,
      // Only overwrite the stored verify_token when a new one was
      // supplied; a save without it must not wipe a working webhook.
      ...(encryptedVerifyToken !== null
        ? { verify_token: encryptedVerifyToken }
        : sameNumber
          ? {}
          : { verify_token: null }),
      // Credentials verified against Meta, which is what "connected"
      // has always meant on this screen. Registration and webhook
      // delivery are reported separately and no longer able to flip a
      // working channel to 'disconnected'.
      status: 'connected',
      connected_at: nowIso,
      registered_at: registeredAt,
      // Preserved — subscribing is a separate action now.
      subscribed_apps_at: existing?.subscribed_apps_at ?? null,
      // Meta's verdict replaces the stale PIN error. A save that proves
      // the number is live must not leave "the PIN is wrong" on screen.
      last_registration_error: registration.registered
        ? null
        : registration.blockers[0] ?? null,
      meta_status: phoneInfo.status ?? null,
      meta_platform_type: phoneInfo.platform_type ?? null,
      meta_pin_enabled:
        typeof phoneInfo.is_pin_enabled === 'boolean' ? phoneInfo.is_pin_enabled : null,
      meta_onboarded_at: metaOnboardedAt,
      meta_app_id: appId,
      updated_at: nowIso,
    }

    const { error: writeError, migrationPending } = existing
      ? await writeConfigRow({ supabase, accountId, row })
      : await writeConfigRow({
          supabase,
          accountId,
          mode: 'insert',
          // Insert with both columns: `account_id` is the tenancy key
          // (NOT NULL post-017, UNIQUE so duplicates trip the constraint
          // up-front), `user_id` is the audit column identifying which
          // member of the account saved the config.
          row: { account_id: accountId, user_id: user.id, ...row },
        })

    if (writeError) {
      console.error('Error saving whatsapp_config:', writeError)
      return NextResponse.json(
        { error: existing ? 'Failed to update configuration' : 'Failed to save configuration' },
        { status: 500 }
      )
    }

    // Tell the UI what is left to do, in order. Saving no longer
    // pretends to have done any of it.
    const nextSteps: string[] = []
    if (registration.registrationRequired && !registration.blockers.length) {
      nextSteps.push('register')
    }
    if (waba_id) nextSteps.push('subscribe_webhooks')
    nextSteps.push('verify')

    return NextResponse.json({
      success: true,
      saved: true,
      phone_info: phoneInfo,
      registration: {
        registered: registration.registered,
        registration_required: registration.registrationRequired,
        pin_requirement: registration.pinRequirement,
        pin_deprecation_eligible: registration.pinDeprecationEligible,
        summary: registration.summary,
        blockers: registration.blockers,
      },
      next_steps: nextSteps,
      migration_pending: migrationPending,
    })
  } catch (error) {
    console.error('Error in WhatsApp config POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/whatsapp/config
 *
 * Removes the authenticated user's WhatsApp configuration row.
 * Used by the "Reset Configuration" button to recover from a corrupted
 * encrypted token (mismatched ENCRYPTION_KEY across environments).
 *
 * Local only: this deletes wacrm's stored credentials. It never
 * deregisters the number on Meta's side, never unsubscribes the WABA,
 * and leaves contacts, conversations and message history untouched.
 */
export async function DELETE() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const { error: deleteError } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('account_id', accountId)

    if (deleteError) {
      console.error('Error deleting whatsapp_config:', deleteError)
      return NextResponse.json(
        { error: 'Failed to delete configuration' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in WhatsApp config DELETE:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
