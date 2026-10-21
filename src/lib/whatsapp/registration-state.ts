/**
 * Decide — from Meta's own account state, not from a local timestamp —
 * whether a phone number still needs `POST /{phone_number_id}/register`
 * and whether that call may carry a two-step verification PIN.
 *
 * Why this module exists
 * ----------------------
 * `POST /api/whatsapp/config` used to infer "needs registration" from
 * the local `whatsapp_config.registered_at` column: NULL meant
 * unregistered. That is not what the column tracks. It records whether
 * *wacrm itself* ever ran /register — so a number that was onboarded
 * through Embedded Signup, or registered by another tool, or simply
 * saved before this column existed, reads as unregistered forever.
 *
 * Save Configuration then attempted /register with whatever the user
 * typed into the PIN box. On a number with no two-step verification
 * PIN, Meta compares that value against nothing and answers
 *
 *     (#133005) Two-step verification PIN mismatch
 *
 * which wacrm surfaced as "The two-step verification PIN is wrong" and
 * then wrote `status='disconnected'` over a channel that was in fact
 * fully live. Observed on +91 80 6548 1576 (1236852602854510), which
 * Meta reports as:
 *
 *     status            = CONNECTED
 *     platform_type     = CLOUD_API      <- already registered
 *     is_pin_enabled    = false          <- no PIN exists to send
 *     last_onboarded_time = 2026-09-21T11:47:14+0000
 *
 * Two-step PIN deprecation
 * ------------------------
 * Meta's Two-Step Verification page (updated 2026-06-28) states the
 * 6-digit PIN "is being deprecated for eligible Cloud API phone
 * numbers", rolling out per-number, and that an eligible number loses
 * the Two-step verification tab in WhatsApp Manager — there is no PIN
 * to read and no documented API field for eligibility. `is_pin_enabled`
 * is the readable proxy: when Meta reports `false`, no PIN exists on the
 * number, whether because it was never enabled or because the number is
 * in the deprecated cohort. In both cases the correct call is /register
 * *without* a `pin` parameter.
 *
 * This is not a security bypass. We never guess, suppress or retry past
 * a PIN. When Meta says a PIN is enabled we require one and send it
 * verbatim; when Meta says none exists we omit the parameter rather than
 * send a value that cannot be verified, and Meta remains the authority
 * on the outcome. The registration endpoint's documented cost is also
 * why this matters: it is capped at 10 calls per number per 72-hour
 * moving window (error 133016), so a save path that re-registers on
 * every attempt can lock a production number out of registration
 * entirely.
 *
 * Pure — no I/O, no env.
 *
 * Refs:
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/two-step-verification/
 */

/** The subset of the Meta phone-number node this decision reads. */
export interface PhoneRegistrationFields {
  /** `CONNECTED`, `PENDING`, `BANNED`, `RESTRICTED`, … */
  status?: string | null
  /** `CLOUD_API`, `ON_PREMISE`, `NOT_APPLICABLE`. */
  platform_type?: string | null
  /** Whether a two-step verification PIN exists on the number. */
  is_pin_enabled?: boolean | null
  code_verification_status?: string | null
  name_status?: string | null
  account_mode?: string | null
  last_onboarded_time?: string | null
}

/**
 * What /register may carry.
 *   `required`  — Meta reports a PIN on the number; one must be supplied.
 *   `not_set`   — Meta reports no PIN; the parameter must be omitted.
 *   `unknown`   — Meta did not say; pass through whatever the user gave.
 */
export type PinRequirement = 'required' | 'not_set' | 'unknown'

export interface RegistrationAssessment {
  /** Meta already has this number live on the Cloud API. */
  registered: boolean
  /** /register still has work to do. Inverse of `registered`. */
  registrationRequired: boolean
  pinRequirement: PinRequirement
  /**
   * Meta reports no two-step PIN on this number — never enabled, or the
   * number sits in Meta's 2026 PIN-deprecation cohort. Either way a
   * `pin` must not be sent to /register.
   */
  pinDeprecationEligible: boolean
  /** Account-level states registration cannot fix. */
  blockers: string[]
  /** One line for the UI and the diagnostic report. */
  summary: string
  /** Echoed so callers can show what the decision was made from. */
  fields: PhoneRegistrationFields
}

/** Statuses that mean "Meta has this number live on the Cloud API". */
const LIVE_STATUS = 'CONNECTED'

/**
 * Statuses where the problem is the account, not the registration.
 * Re-running /register against these cannot help and burns one of the
 * 10 attempts Meta allows per 72 hours.
 */
const BLOCKING_STATUSES = new Set([
  'BANNED',
  'RESTRICTED',
  'FLAGGED',
  'DELETED',
])

function up(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null
}

/**
 * Read Meta's phone-number fields and decide what, if anything, the
 * registration step still has to do.
 *
 * Deliberately conservative: an empty or partial field set is reported
 * as *not* registered rather than assumed fine, so a failed metadata
 * read can never silently promote a channel to live.
 */
export function assessRegistration(
  fields: PhoneRegistrationFields,
): RegistrationAssessment {
  const status = up(fields.status)
  const platform = up(fields.platform_type)

  const registered = platform === 'CLOUD_API' && status === LIVE_STATUS

  const pinRequirement: PinRequirement =
    fields.is_pin_enabled === true
      ? 'required'
      : fields.is_pin_enabled === false
        ? 'not_set'
        : 'unknown'

  const blockers: string[] = []
  if (status && BLOCKING_STATUSES.has(status)) {
    blockers.push(
      `Meta reports this phone number as ${status}. Registration cannot clear that — ` +
        'open WhatsApp Manager → Phone numbers (and Business Manager → Account quality) ' +
        'to see the restriction and appeal it.',
    )
  }

  let summary: string
  if (registered) {
    summary =
      'Meta already has this number registered on the Cloud API ' +
      `(platform_type=CLOUD_API, status=${status}). No registration call is needed` +
      (pinRequirement === 'not_set'
        ? ', and Meta reports no two-step verification PIN on it.'
        : '.')
  } else if (blockers.length) {
    summary = blockers[0]
  } else if (!status && !platform) {
    summary =
      'Meta did not return a registration state for this number, so wacrm cannot confirm ' +
      'it is live. Run Verify Connection to re-read it.'
  } else {
    summary =
      `Meta reports platform_type=${platform ?? 'unknown'}, status=${status ?? 'unknown'} — ` +
      'this number is not live on the Cloud API yet, so Register Number has work to do' +
      (pinRequirement === 'required'
        ? '. It has two-step verification on, so the 6-digit PIN is required.'
        : pinRequirement === 'not_set'
          ? '. Meta reports no two-step verification PIN on it, so none is needed.'
          : '.')
  }

  return {
    registered,
    registrationRequired: !registered,
    pinRequirement,
    pinDeprecationEligible: fields.is_pin_enabled === false,
    blockers,
    summary,
    fields,
  }
}

/**
 * The `pin` part of a /register body, decided by Meta's state rather
 * than by what happens to be typed in the form.
 *
 * Throws when Meta says a PIN is enabled and none was supplied — the
 * caller must ask the user rather than send a blank.
 */
export function pinBodyFor(
  assessment: RegistrationAssessment,
  pin: string | null | undefined,
): { pin?: string } {
  const supplied = typeof pin === 'string' && pin.trim() ? pin.trim() : null

  if (assessment.pinRequirement === 'not_set') {
    // Nothing on Meta's side to compare a PIN against. Sending one is
    // exactly what produced error 133005 on an already-live number.
    return {}
  }

  if (assessment.pinRequirement === 'required') {
    if (!supplied) {
      throw new Error(
        'A two-step verification PIN is required: Meta reports two-step verification is ' +
          'enabled on this number. Enter the 6-digit PIN from WhatsApp Manager → ' +
          'Phone numbers → Two-step verification.',
      )
    }
    return { pin: supplied }
  }

  // Unknown — pass through what the user gave and let Meta judge it.
  return supplied ? { pin: supplied } : {}
}
