import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  getAppIdFromToken,
  getPhoneNumberRegistration,
  getSubscribedApps,
  listMessageTemplates,
  PHONE_REGISTRATION_FIELDS,
} from '@/lib/whatsapp/meta-api'
import { appSubscriptionState } from '@/lib/whatsapp/waba-pairing'
import { assessRegistration } from '@/lib/whatsapp/registration-state'
import {
  assessCampaignReadiness,
  REQUIRED_TOKEN_SCOPES,
} from '@/lib/whatsapp/campaign-readiness'
import { writeConfigRow } from '@/lib/whatsapp/config-columns'

/**
 * GET /api/whatsapp/config/verify-registration  —  "Verify Connection"
 *
 * The read-only diagnostic, and the only thing that decides Campaign
 * Ready. Every check reports its own result so the UI can show which
 * step passes and which fails, and the raw Meta values are returned
 * alongside so a failure can be read rather than guessed at.
 *
 * What changed and why
 * --------------------
 * This endpoint used to derive "is the number registered" from the
 * local `registered_at` column — the same mistake that made Save
 * Configuration attempt a doomed /register. A number registered through
 * Embedded Signup or by another tool has that column NULL while being
 * entirely live, so `live` could never become true no matter how well
 * the channel worked. It now reads Meta's `platform_type` + `status`.
 *
 * The WABA subscription check also used to read "the subscriber list is
 * non-empty, therefore it includes us". That is wrong on any WABA with
 * more than one subscriber. It now matches our app id, recovered from
 * the access token via /debug_token.
 *
 * Writes: only the diagnostic's own findings — Meta's reported state,
 * `last_verified_at`, and `campaign_ready_at` / blockers. It never
 * registers, deregisters, subscribes, unsubscribes or sends.
 */
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // whatsapp_config is one-row-per-account post-017. Resolve the
  // caller's account_id so a teammate who joined an existing account
  // sees the same registration state as the admin who set it up.
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json({
      live: false,
      campaign_ready: false,
      checks: { config_exists: false },
      message: 'Your profile is not linked to an account.',
    })
  }

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()

  if (!config) {
    return NextResponse.json({
      live: false,
      campaign_ready: false,
      checks: { config_exists: false },
      message: 'No WhatsApp configuration saved yet.',
    })
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    return NextResponse.json({
      live: false,
      campaign_ready: false,
      checks: {
        config_exists: true,
        token_decryptable: false,
      },
      message:
        'Stored access token can\'t be decrypted — likely ENCRYPTION_KEY changed. Re-enter the token to repair.',
    })
  }

  const errors: string[] = []
  const evidence: Record<string, unknown> = {
    phone_number_id: config.phone_number_id,
    waba_id: config.waba_id ?? null,
    fields_requested: PHONE_REGISTRATION_FIELDS,
  }

  // --- 1. Token identity and permissions ------------------------------
  const identity = await getAppIdFromToken({ accessToken })
  const appId = identity?.appId ?? process.env.META_APP_ID ?? null
  const tokenScopes = identity ? identity.scopes : null
  evidence.token = identity
    ? {
        app_id: identity.appId,
        app_name: identity.appName,
        type: identity.tokenType,
        is_valid: identity.isValid,
        never_expires: identity.neverExpires,
        scopes: identity.scopes,
        missing_scopes: REQUIRED_TOKEN_SCOPES.filter((s) => !identity.scopes.includes(s)),
      }
    : { introspected: false, app_id_source: process.env.META_APP_ID ? 'META_APP_ID env' : 'unknown' }

  // --- 2. Phone metadata + Meta's registration verdict ----------------
  let phoneInfo: Awaited<ReturnType<typeof getPhoneNumberRegistration>> | null = null
  try {
    phoneInfo = await getPhoneNumberRegistration({
      phoneNumberId: config.phone_number_id,
      accessToken,
    })
    evidence.phone = phoneInfo
  } catch (err) {
    errors.push(
      `Phone metadata check failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const registration = phoneInfo ? assessRegistration(phoneInfo) : null
  if (registration && !registration.registered) {
    errors.push(registration.summary)
  }

  // --- 3. WABA subscription, matched by app id -------------------------
  let wabaSubscribedToThisApp: boolean | null = null
  if (config.waba_id) {
    try {
      const subs = await getSubscribedApps({ wabaId: config.waba_id, accessToken })
      const subscribedIds = subs
        .map((s) => s.whatsapp_business_api_data?.id)
        .filter((id): id is string => typeof id === 'string')
      const state = appSubscriptionState(subs, appId)
      // `appIdMatch` is null when the app id is unknown — report that as
      // unknown rather than falling back to "the list isn't empty".
      wabaSubscribedToThisApp = state.appIdMatch
      evidence.waba_subscription = {
        app_id: appId,
        subscribed_app_ids: subscribedIds,
        this_app_subscribed: state.appIdMatch,
        other_apps_subscribed: subscribedIds.filter((id) => id !== appId),
      }
      if (state.appIdMatch === false) {
        errors.push(
          'This app is not subscribed to the WhatsApp Business Account, so Meta will not ' +
            'deliver inbound messages. Click Subscribe Webhooks.',
        )
      } else if (state.appIdMatch === null) {
        errors.push(
          'Could not determine which Meta app the access token belongs to, so the ' +
            'subscription could not be matched by app id. Set META_APP_ID to confirm it.',
        )
      }
      if (state.appIdMatch && subscribedIds.length > 1) {
        // Not an error — but every subscriber receives the same events,
        // which is worth knowing when debugging duplicate handling.
        errors.push(
          `Note: ${subscribedIds.length} apps are subscribed to this WhatsApp Business ` +
            `Account (${subscribedIds.join(', ')}). Each one receives the same inbound events.`,
        )
      }
    } catch (err) {
      errors.push(
        `WABA subscription check failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } else {
    errors.push(
      'No WABA ID on file — webhooks can\'t be wired without it. Add it in the form and re-save.',
    )
  }

  // --- 4. Something approved to send ----------------------------------
  let approvedTemplateCount = 0
  if (config.waba_id) {
    try {
      const templates = await listMessageTemplates({ wabaId: config.waba_id, accessToken })
      const approved = templates.filter((t) => (t.status ?? '').toUpperCase() === 'APPROVED')
      approvedTemplateCount = approved.length
      evidence.templates = {
        total: templates.length,
        approved: approved.map((t) => ({ name: t.name, language: t.language, category: t.category })),
      }
    } catch (err) {
      errors.push(
        `Template check failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // --- 5. Proven delivery, both directions -----------------------------
  // These columns arrive with migration 043; before it they read
  // undefined, which the readiness check treats as "not proven".
  const outboundAt =
    (config.last_outbound_test_status === 'delivered' || config.last_outbound_test_status === 'read'
      ? config.last_outbound_test_at
      : null) ?? null
  const inboundAt = config.last_inbound_event_at ?? null
  evidence.delivery = {
    outbound_test_at: config.last_outbound_test_at ?? null,
    outbound_test_wamid: config.last_outbound_test_wamid ?? null,
    outbound_test_status: config.last_outbound_test_status ?? null,
    inbound_last_event_at: inboundAt,
  }
  if (config.last_outbound_test_status === 'accepted') {
    errors.push(
      'The test template was accepted by Meta but no `delivered` status has arrived on the ' +
        'webhook yet. Either delivery is still in flight, or the webhook is not reaching this ' +
        'server — which is the same thing the inbound check below measures.',
    )
  }

  // --- 6. Campaign readiness -------------------------------------------
  const readiness = assessCampaignReadiness({
    credentialsValid: phoneInfo !== null,
    registration,
    wabaSubscribedToThisApp,
    approvedTemplateCount,
    outboundDeliveryConfirmedAt: outboundAt,
    inboundEventAt: inboundAt,
    tokenScopes,
  })

  // `live` keeps its old meaning for the UI — credentials good, number
  // registered on Meta, webhooks subscribed to this app — but is now
  // decided from Meta's state instead of a local timestamp.
  const live =
    phoneInfo !== null &&
    registration?.registered === true &&
    wabaSubscribedToThisApp === true

  const checks = {
    config_exists: true,
    token_decryptable: true,
    token_scopes_ok: readiness.checks.token_scopes === 'pass',
    phone_metadata_ok: phoneInfo !== null,
    meta_registered: registration?.registered ?? null,
    waba_subscribed_to_app: wabaSubscribedToThisApp,
    approved_template_available: approvedTemplateCount > 0,
    outbound_delivery_confirmed: outboundAt != null,
    inbound_event_received: inboundAt != null,
    // Kept for continuity with the previous response shape; no longer
    // part of any verdict.
    locally_marked_registered: config.registered_at != null,
  }

  const nowIso = new Date().toISOString()
  const { migrationPending } = await writeConfigRow({
    supabase,
    accountId,
    row: {
      last_verified_at: nowIso,
      // Persist Meta's verdict so the rest of the app stops depending on
      // the stale local timestamp. `registered_at` is stamped — never
      // cleared — when Meta confirms the number is live, so a number
      // registered elsewhere stops reading as "never registered".
      ...(registration?.registered
        ? {
            registered_at:
              config.registered_at ??
              (phoneInfo?.last_onboarded_time
                ? new Date(phoneInfo.last_onboarded_time).toISOString()
                : nowIso),
            last_registration_error: null,
          }
        : {}),
      ...(phoneInfo
        ? {
            meta_status: phoneInfo.status ?? null,
            meta_platform_type: phoneInfo.platform_type ?? null,
            meta_pin_enabled:
              typeof phoneInfo.is_pin_enabled === 'boolean' ? phoneInfo.is_pin_enabled : null,
            meta_onboarded_at: phoneInfo.last_onboarded_time
              ? new Date(phoneInfo.last_onboarded_time).toISOString()
              : null,
          }
        : {}),
      meta_app_id: appId,
      // Stamped only on a clean sweep; cleared the moment anything fails,
      // so the badge can never outlive the evidence for it.
      campaign_ready_at: readiness.ready ? nowIso : null,
      campaign_ready_blockers: readiness.blockers,
      updated_at: nowIso,
    },
  })

  return NextResponse.json({
    live,
    campaign_ready: readiness.ready,
    campaign_ready_checks: readiness.checks,
    campaign_ready_blockers: readiness.blockers,
    checks,
    errors,
    registration: registration
      ? {
          registered: registration.registered,
          registration_required: registration.registrationRequired,
          pin_requirement: registration.pinRequirement,
          pin_deprecation_eligible: registration.pinDeprecationEligible,
          summary: registration.summary,
          blockers: registration.blockers,
        }
      : null,
    evidence,
    last_registration_error: registration?.registered
      ? null
      : (config.last_registration_error ?? null),
    registered_at: config.registered_at ?? null,
    subscribed_apps_at: config.subscribed_apps_at ?? null,
    verified_at: nowIso,
    migration_pending: migrationPending,
  })
}
