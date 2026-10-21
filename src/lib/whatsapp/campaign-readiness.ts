/**
 * "Campaign Ready" — the one badge that promises a broadcast will
 * actually reach people and that their replies will come back.
 *
 * It used to be implied by the green "Connected" banner, which only
 * meant `GET /{phone_number_id}` returned 200. That is why a number
 * could read as connected while Meta delivered nothing: valid
 * credentials say nothing about registration, webhook subscription,
 * template approval, or whether a single message has ever moved.
 *
 * So readiness is an observation, never an inference. Every check below
 * has to have *passed* — an unknown is not a pass — and the reasons it
 * has not are returned so the UI can list them instead of a shrug.
 *
 * Pure — no I/O, no env.
 */

import type { RegistrationAssessment } from './registration-state'

/**
 * Scopes a System User token needs for the full flow: management for
 * registration state / subscriptions / templates, messaging for sends.
 */
export const REQUIRED_TOKEN_SCOPES = [
  'whatsapp_business_management',
  'whatsapp_business_messaging',
] as const

export type CheckState = 'pass' | 'fail' | 'unknown'

export interface CampaignReadinessInput {
  /** `GET /{phone_number_id}` succeeded with the stored token. */
  credentialsValid: boolean
  /** Meta's registration verdict, or null when it could not be read. */
  registration: RegistrationAssessment | null
  /**
   * Whether THIS app's id appears in `GET /{waba_id}/subscribed_apps`.
   * `null` when the app id could not be determined — treated as unknown,
   * never as a pass, because that was the old bug: a non-empty
   * subscriber list was read as "it must be us".
   */
  wabaSubscribedToThisApp: boolean | null
  approvedTemplateCount: number
  /** When a real outbound template send was confirmed delivered. */
  outboundDeliveryConfirmedAt: string | null
  /** When a real inbound webhook event last arrived for this number. */
  inboundEventAt: string | null
  /** Scopes on the stored token, or null when introspection failed. */
  tokenScopes: readonly string[] | null
}

export type CampaignCheckName =
  | 'credentials'
  | 'token_scopes'
  | 'meta_registration'
  | 'waba_subscription'
  | 'approved_template'
  | 'outbound_delivery'
  | 'inbound_delivery'

export interface CampaignReadiness {
  ready: boolean
  checks: Record<CampaignCheckName, CheckState>
  blockers: string[]
}

export function assessCampaignReadiness(
  input: CampaignReadinessInput,
): CampaignReadiness {
  const checks = {} as Record<CampaignCheckName, CheckState>
  const blockers: string[] = []

  const record = (name: CampaignCheckName, state: CheckState, blocker?: string) => {
    checks[name] = state
    if (state !== 'pass' && blocker) blockers.push(blocker)
  }

  // 1. Credentials
  record(
    'credentials',
    input.credentialsValid ? 'pass' : 'fail',
    'Meta rejected the stored credentials, so nothing else can be trusted. ' +
      'Re-enter the Permanent Access Token and save again.',
  )

  // 2. Token scopes
  if (input.tokenScopes === null) {
    record(
      'token_scopes',
      'unknown',
      'The access token could not be introspected, so its permissions are unconfirmed. ' +
        'This is not necessarily a problem — the other checks below are the real test.',
    )
  } else {
    const missing = REQUIRED_TOKEN_SCOPES.filter((s) => !input.tokenScopes!.includes(s))
    record(
      'token_scopes',
      missing.length === 0 ? 'pass' : 'fail',
      `The access token is missing ${missing.join(' and ')}. Add the permission to its ` +
        'System User (Business Settings → System Users) and generate a new token.',
    )
  }

  // 3. Registration on Meta's side
  if (!input.registration) {
    record(
      'meta_registration',
      'unknown',
      'Meta did not return a registration state for this number, so wacrm cannot confirm ' +
        'it is live. Run Verify Connection again.',
    )
  } else {
    record(
      'meta_registration',
      input.registration.registered ? 'pass' : 'fail',
      input.registration.registered ? undefined : input.registration.summary,
    )
  }

  // 4. WABA subscribed to this app
  if (input.wabaSubscribedToThisApp === null) {
    record(
      'waba_subscription',
      'unknown',
      'Could not confirm that this WhatsApp Business Account is subscribed to this app, ' +
        'so inbound delivery is unproven. Run Subscribe Webhooks.',
    )
  } else {
    record(
      'waba_subscription',
      input.wabaSubscribedToThisApp ? 'pass' : 'fail',
      'This WhatsApp Business Account is not subscribed to this app, so Meta will not ' +
        'deliver inbound messages or status updates. Click Subscribe Webhooks.',
    )
  }

  // 5. Something to send
  record(
    'approved_template',
    input.approvedTemplateCount > 0 ? 'pass' : 'fail',
    'No APPROVED message template exists on this WhatsApp Business Account, so a campaign ' +
      'has nothing it is allowed to send. Submit one and wait for approval.',
  )

  // 6. Proven outbound
  record(
    'outbound_delivery',
    input.outboundDeliveryConfirmedAt ? 'pass' : 'fail',
    'No outbound template send has been confirmed delivered yet. Run Send Test Template ' +
      'so delivery is observed rather than assumed.',
  )

  // 7. Proven inbound
  record(
    'inbound_delivery',
    input.inboundEventAt ? 'pass' : 'fail',
    'No inbound webhook event has arrived for this number yet, so replies to a campaign ' +
      'are unproven. Send a WhatsApp message TO this number and re-run Verify Connection.',
  )

  return {
    ready: (Object.values(checks) as CheckState[]).every((s) => s === 'pass'),
    checks,
    blockers,
  }
}
