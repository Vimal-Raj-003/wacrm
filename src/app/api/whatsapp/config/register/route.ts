import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  getPhoneNumberRegistration,
  registerPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import { explainMetaError, metaErrorPayload } from '@/lib/whatsapp/meta-error-explain'
import { assessRegistration, pinBodyFor } from '@/lib/whatsapp/registration-state'
import { writeConfigRow } from '@/lib/whatsapp/config-columns'

/**
 * POST /api/whatsapp/config/register  —  "Register Number"
 *
 * The explicit, deliberate registration step, split out of Save
 * Configuration. Saving credentials no longer triggers it; a human has
 * to ask for it.
 *
 * Safety rules this endpoint enforces, in order:
 *
 *   1. It reads Meta's state first. If Meta already reports the number
 *      as `platform_type=CLOUD_API, status=CONNECTED`, it makes NO call
 *      and answers `already_registered`. That protects the working
 *      production number and protects the registration budget — Meta
 *      caps /register at 10 calls per number per 72-hour moving window
 *      and answers 133016 after that, which would lock the number out
 *      of registration entirely.
 *
 *   2. It never sends a PIN Meta cannot verify. When Meta reports
 *      `is_pin_enabled: false` — a number that never had two-step
 *      verification, or one in Meta's 2026 PIN-deprecation cohort — the
 *      `pin` parameter is omitted rather than filled with a guess.
 *      Sending one is what produced `(#133005) Two-step verification
 *      PIN mismatch` on a number that was already live.
 *
 *   3. It never relaxes a PIN that does exist. When Meta reports
 *      `is_pin_enabled: true`, a 6-digit PIN is required, is sent
 *      verbatim, and a rejection is surfaced verbatim. There is no
 *      retry-without-PIN fallback, because that would be exactly the
 *      security bypass this must not perform.
 *
 *   4. It never deregisters, migrates or deletes anything. There is no
 *      code path here that calls DELETE /register or /deregister.
 *
 * Body: `{ pin?: string }` — only read when Meta says a PIN exists.
 */
export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 403 },
    )
  }

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('phone_number_id, waba_id, access_token, registered_at')
    .eq('account_id', accountId)
    .maybeSingle()

  if (!config) {
    return NextResponse.json(
      { error: 'No WhatsApp configuration saved yet. Save the credentials first.' },
      { status: 400 },
    )
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    return NextResponse.json(
      {
        error:
          'The stored access token cannot be decrypted with the current ENCRYPTION_KEY. ' +
          'Re-enter the token and save, then try again.',
      },
      { status: 400 },
    )
  }

  let pin: unknown
  try {
    const body = await request.json()
    pin = body?.pin
  } catch {
    pin = undefined
  }
  if (pin !== undefined && pin !== null && pin !== '') {
    if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
      return NextResponse.json(
        { error: 'PIN must be exactly 6 digits.', field: 'pin' },
        { status: 400 },
      )
    }
  }

  const metaCtx = { phoneNumberId: config.phone_number_id, wabaId: config.waba_id }

  // --- Step 1: what does Meta actually say? --------------------------
  let phoneInfo
  try {
    phoneInfo = await getPhoneNumberRegistration({
      phoneNumberId: config.phone_number_id,
      accessToken,
    })
  } catch (err) {
    const explained = explainMetaError(err, 'verify_number', metaCtx)
    return NextResponse.json(
      { error: explained.summary, meta: metaErrorPayload(explained) },
      { status: explained.httpStatus },
    )
  }

  const assessment = assessRegistration(phoneInfo)
  const metaOnboardedAt = phoneInfo.last_onboarded_time
    ? new Date(phoneInfo.last_onboarded_time).toISOString()
    : null

  // --- Step 2: already registered? Do nothing. -----------------------
  if (assessment.registered) {
    const { migrationPending } = await writeConfigRow({
      supabase,
      accountId,
      row: {
        registered_at: config.registered_at ?? metaOnboardedAt ?? new Date().toISOString(),
        last_registration_error: null,
        meta_status: phoneInfo.status ?? null,
        meta_platform_type: phoneInfo.platform_type ?? null,
        meta_pin_enabled:
          typeof phoneInfo.is_pin_enabled === 'boolean' ? phoneInfo.is_pin_enabled : null,
        meta_onboarded_at: metaOnboardedAt,
        updated_at: new Date().toISOString(),
      },
    })
    return NextResponse.json({
      success: true,
      already_registered: true,
      called_register: false,
      registration: {
        registered: true,
        pin_requirement: assessment.pinRequirement,
        pin_deprecation_eligible: assessment.pinDeprecationEligible,
        summary: assessment.summary,
      },
      phone_info: phoneInfo,
      migration_pending: migrationPending,
      message:
        'No registration call was made: Meta already has this number live on the Cloud API. ' +
        'Nothing about the number was changed.',
    })
  }

  // --- Step 3: an account-level block registration cannot fix --------
  if (assessment.blockers.length) {
    return NextResponse.json(
      {
        error: assessment.blockers[0],
        called_register: false,
        registration: { registered: false, summary: assessment.summary },
      },
      { status: 400 },
    )
  }

  // --- Step 4: decide the PIN from Meta's state, not the form -------
  let pinBody: { pin?: string }
  try {
    pinBody = pinBodyFor(assessment, typeof pin === 'string' ? pin : undefined)
  } catch (err) {
    // Meta says two-step verification is on and no PIN was supplied.
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : 'A two-step verification PIN is required.',
        field: 'pin',
        called_register: false,
        registration: {
          registered: false,
          pin_requirement: assessment.pinRequirement,
          summary: assessment.summary,
        },
      },
      { status: 400 },
    )
  }

  // --- Step 5: register -----------------------------------------------
  try {
    const result = await registerPhoneNumber({
      phoneNumberId: config.phone_number_id,
      accessToken,
      ...pinBody,
    })

    // Re-read rather than assume the call worked as intended.
    let after = phoneInfo
    try {
      after = await getPhoneNumberRegistration({
        phoneNumberId: config.phone_number_id,
        accessToken,
      })
    } catch {
      // Keep the pre-call snapshot; the write below stays truthful.
    }
    const afterAssessment = assessRegistration(after)
    const nowIso = new Date().toISOString()

    const { migrationPending } = await writeConfigRow({
      supabase,
      accountId,
      row: {
        registered_at: afterAssessment.registered ? nowIso : null,
        last_registration_error: afterAssessment.registered
          ? null
          : 'Meta accepted the registration call but the number is not reporting as live yet. ' +
            'Registration can take a moment — run Verify Connection again.',
        meta_status: after.status ?? null,
        meta_platform_type: after.platform_type ?? null,
        meta_pin_enabled:
          typeof after.is_pin_enabled === 'boolean' ? after.is_pin_enabled : null,
        meta_onboarded_at: after.last_onboarded_time
          ? new Date(after.last_onboarded_time).toISOString()
          : null,
        updated_at: nowIso,
      },
    })

    return NextResponse.json({
      success: true,
      called_register: true,
      pin_sent: pinBody.pin !== undefined,
      already_registered: result.alreadyRegistered,
      registration: {
        registered: afterAssessment.registered,
        pin_requirement: afterAssessment.pinRequirement,
        pin_deprecation_eligible: afterAssessment.pinDeprecationEligible,
        summary: afterAssessment.summary,
      },
      phone_info: after,
      migration_pending: migrationPending,
    })
  } catch (err) {
    const explained = explainMetaError(err, 'register', metaCtx)
    console.error('[whatsapp/config/register] /register failed:', explained.metaMessage, {
      code: explained.code,
      fbtrace_id: explained.fbtraceId,
      pin_sent: pinBody.pin !== undefined,
    })
    // Record the failure but never downgrade `status` — the credentials
    // are still valid and the number may still be sending.
    await writeConfigRow({
      supabase,
      accountId,
      row: {
        last_registration_error: explained.summary,
        updated_at: new Date().toISOString(),
      },
    })
    return NextResponse.json(
      {
        error: explained.summary,
        meta: metaErrorPayload(explained),
        called_register: true,
        pin_sent: pinBody.pin !== undefined,
      },
      { status: explained.httpStatus },
    )
  }
}
