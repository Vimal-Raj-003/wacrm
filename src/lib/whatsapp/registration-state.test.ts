import { describe, expect, it } from 'vitest';
import {
  assessRegistration,
  pinBodyFor,
  type PhoneRegistrationFields,
} from './registration-state';

/**
 * Field set captured live from Meta on 2026-10-18 for the production
 * number +91 80 6548 1576 (phone_number_id 1236852602854510) — the
 * number whose Save Configuration kept failing with "The two-step
 * verification PIN is wrong." Meta already considers it registered and
 * reports no two-step PIN at all.
 */
const LIVE_PRODUCTION_NUMBER: PhoneRegistrationFields = {
  status: 'CONNECTED',
  platform_type: 'CLOUD_API',
  is_pin_enabled: false,
  code_verification_status: 'EXPIRED',
  name_status: 'NON_EXISTS',
  account_mode: 'LIVE',
  last_onboarded_time: '2026-09-21T11:47:14+0000',
};

describe('assessRegistration', () => {
  it('reports the live production number as already registered', () => {
    const a = assessRegistration(LIVE_PRODUCTION_NUMBER);
    expect(a.registered).toBe(true);
    expect(a.registrationRequired).toBe(false);
  });

  it('never asks for a PIN on a number Meta says has none', () => {
    const a = assessRegistration(LIVE_PRODUCTION_NUMBER);
    expect(a.pinRequirement).toBe('not_set');
    expect(a.pinDeprecationEligible).toBe(true);
  });

  it('treats CLOUD_API + CONNECTED as registered regardless of PIN state', () => {
    for (const is_pin_enabled of [true, false, null, undefined]) {
      const a = assessRegistration({
        status: 'CONNECTED',
        platform_type: 'CLOUD_API',
        is_pin_enabled,
      });
      expect(a.registered).toBe(true);
    }
  });

  it('requires registration when the number is not on CLOUD_API yet', () => {
    const a = assessRegistration({
      status: 'CONNECTED',
      platform_type: 'NOT_APPLICABLE',
      is_pin_enabled: true,
    });
    expect(a.registered).toBe(false);
    expect(a.registrationRequired).toBe(true);
    expect(a.pinRequirement).toBe('required');
  });

  it('requires registration when Meta has not connected the number', () => {
    for (const status of ['PENDING', 'DISCONNECTED', 'UNVERIFIED', 'MIGRATED']) {
      const a = assessRegistration({
        status,
        platform_type: 'CLOUD_API',
        is_pin_enabled: false,
      });
      expect(a.registered).toBe(false);
      expect(a.registrationRequired).toBe(true);
    }
  });

  it('reports pinRequirement unknown when Meta omits is_pin_enabled', () => {
    const a = assessRegistration({
      status: 'PENDING',
      platform_type: 'NOT_APPLICABLE',
    });
    expect(a.pinRequirement).toBe('unknown');
    expect(a.pinDeprecationEligible).toBe(false);
  });

  it('flags a BANNED or RESTRICTED number as a blocker, not a registration job', () => {
    const a = assessRegistration({
      status: 'BANNED',
      platform_type: 'CLOUD_API',
      is_pin_enabled: false,
    });
    expect(a.registered).toBe(false);
    expect(a.blockers.join(' ')).toMatch(/BANNED/i);
  });

  it('does not treat an expired code_verification_status as a send blocker', () => {
    // The live number reports EXPIRED here yet sends fine (quality GREEN,
    // TIER_250, status CONNECTED). Surfacing it as a blocker would make
    // the UI refuse a working channel.
    const a = assessRegistration(LIVE_PRODUCTION_NUMBER);
    expect(a.blockers).toEqual([]);
  });

  it('empty field set is treated as unknown, never as registered', () => {
    const a = assessRegistration({});
    expect(a.registered).toBe(false);
    expect(a.registrationRequired).toBe(true);
    expect(a.pinRequirement).toBe('unknown');
  });
});

describe('pinBodyFor', () => {
  it('omits pin entirely when Meta reports no two-step PIN on the number', () => {
    const a = assessRegistration({
      status: 'PENDING',
      platform_type: 'NOT_APPLICABLE',
      is_pin_enabled: false,
    });
    expect(pinBodyFor(a, undefined)).toEqual({});
    // Even a supplied PIN is dropped — there is nothing for Meta to
    // compare it against, and sending one is what produced error 133005.
    expect(pinBodyFor(a, '123456')).toEqual({});
  });

  it('sends the supplied pin when the number has two-step verification on', () => {
    const a = assessRegistration({
      status: 'PENDING',
      platform_type: 'NOT_APPLICABLE',
      is_pin_enabled: true,
    });
    expect(pinBodyFor(a, '123456')).toEqual({ pin: '123456' });
  });

  it('throws when a PIN is genuinely required but none was supplied', () => {
    const a = assessRegistration({
      status: 'PENDING',
      platform_type: 'NOT_APPLICABLE',
      is_pin_enabled: true,
    });
    expect(() => pinBodyFor(a, undefined)).toThrow(/PIN is required/i);
  });

  it('passes a supplied pin through when PIN state is unknown', () => {
    // Meta did not tell us; honour what the user typed rather than
    // guessing, and let Meta be the authority on whether it is right.
    const a = assessRegistration({ status: 'PENDING' });
    expect(pinBodyFor(a, '654321')).toEqual({ pin: '654321' });
    expect(pinBodyFor(a, undefined)).toEqual({});
  });
});
