import { describe, expect, it } from 'vitest';
import { assessRegistration } from './registration-state';
import { assessCampaignReadiness, REQUIRED_TOKEN_SCOPES } from './campaign-readiness';

const REGISTERED = assessRegistration({
  status: 'CONNECTED',
  platform_type: 'CLOUD_API',
  is_pin_enabled: false,
});

const UNREGISTERED = assessRegistration({
  status: 'PENDING',
  platform_type: 'NOT_APPLICABLE',
  is_pin_enabled: true,
});

/** Everything passing — the state the live number should reach. */
function allGood() {
  return {
    credentialsValid: true,
    registration: REGISTERED,
    wabaSubscribedToThisApp: true,
    approvedTemplateCount: 3,
    outboundDeliveryConfirmedAt: '2026-10-18T12:00:00.000Z',
    inboundEventAt: '2026-10-18T12:05:00.000Z',
    tokenScopes: [...REQUIRED_TOKEN_SCOPES],
  };
}

describe('assessCampaignReadiness', () => {
  it('is ready only when every check passes', () => {
    const r = assessCampaignReadiness(allGood());
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  it('is not ready when credentials do not verify', () => {
    const r = assessCampaignReadiness({ ...allGood(), credentialsValid: false });
    expect(r.ready).toBe(false);
    expect(r.checks.credentials).toBe('fail');
  });

  it('is not ready when Meta does not have the number registered', () => {
    const r = assessCampaignReadiness({ ...allGood(), registration: UNREGISTERED });
    expect(r.ready).toBe(false);
    expect(r.checks.meta_registration).toBe('fail');
    expect(r.blockers.join(' ')).toMatch(/not live on the Cloud API/i);
  });

  it('is not ready when the WABA is not subscribed to THIS app', () => {
    const r = assessCampaignReadiness({ ...allGood(), wabaSubscribedToThisApp: false });
    expect(r.ready).toBe(false);
    expect(r.checks.waba_subscription).toBe('fail');
    expect(r.blockers.join(' ')).toMatch(/inbound/i);
  });

  it('treats an unknown subscription as not ready, not as a pass', () => {
    const r = assessCampaignReadiness({ ...allGood(), wabaSubscribedToThisApp: null });
    expect(r.ready).toBe(false);
    expect(r.checks.waba_subscription).toBe('unknown');
  });

  it('is not ready without an approved template to send', () => {
    const r = assessCampaignReadiness({ ...allGood(), approvedTemplateCount: 0 });
    expect(r.ready).toBe(false);
    expect(r.checks.approved_template).toBe('fail');
  });

  it('is not ready until an outbound template has actually delivered', () => {
    const r = assessCampaignReadiness({ ...allGood(), outboundDeliveryConfirmedAt: null });
    expect(r.ready).toBe(false);
    expect(r.checks.outbound_delivery).toBe('fail');
    expect(r.blockers.join(' ')).toMatch(/outbound/i);
  });

  it('is not ready until an inbound event has actually arrived', () => {
    const r = assessCampaignReadiness({ ...allGood(), inboundEventAt: null });
    expect(r.ready).toBe(false);
    expect(r.checks.inbound_delivery).toBe('fail');
  });

  it('is not ready when the token is missing a required scope', () => {
    const r = assessCampaignReadiness({
      ...allGood(),
      tokenScopes: ['whatsapp_business_messaging'],
    });
    expect(r.ready).toBe(false);
    expect(r.checks.token_scopes).toBe('fail');
    expect(r.blockers.join(' ')).toMatch(/whatsapp_business_management/);
  });

  it('does not fail on scopes it could not read', () => {
    // debug_token is not always permitted. Unknown must not be a pass,
    // but it also must not be reported as a missing permission.
    const r = assessCampaignReadiness({ ...allGood(), tokenScopes: null });
    expect(r.checks.token_scopes).toBe('unknown');
    expect(r.blockers.join(' ')).not.toMatch(/missing/i);
  });

  it('reports a missing registration read as unknown rather than registered', () => {
    const r = assessCampaignReadiness({ ...allGood(), registration: null });
    expect(r.ready).toBe(false);
    expect(r.checks.meta_registration).toBe('unknown');
  });

  it('lists every failing check, not just the first', () => {
    const r = assessCampaignReadiness({
      credentialsValid: true,
      registration: REGISTERED,
      wabaSubscribedToThisApp: false,
      approvedTemplateCount: 0,
      outboundDeliveryConfirmedAt: null,
      inboundEventAt: null,
      tokenScopes: [...REQUIRED_TOKEN_SCOPES],
    });
    expect(r.blockers.length).toBeGreaterThanOrEqual(4);
  });
});
