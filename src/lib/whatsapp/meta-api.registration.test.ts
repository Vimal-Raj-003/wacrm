import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAppIdFromToken,
  getPhoneNumberRegistration,
  registerPhoneNumber,
  PHONE_REGISTRATION_FIELDS,
} from './meta-api';

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Verbatim response captured from Meta on 2026-10-18. */
const LIVE_PHONE_NODE = {
  id: '1236852602854510',
  display_phone_number: '+91 80 6548 1576',
  verified_name: 'GitGemVault',
  quality_rating: 'GREEN',
  status: 'CONNECTED',
  platform_type: 'CLOUD_API',
  code_verification_status: 'EXPIRED',
  name_status: 'NON_EXISTS',
  account_mode: 'LIVE',
  is_pin_enabled: false,
  is_preverified_number: false,
  messaging_limit_tier: 'TIER_250',
  throughput: { level: 'STANDARD' },
  last_onboarded_time: '2026-09-21T11:47:14+0000',
};

describe('getPhoneNumberRegistration', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(okResponse(LIVE_PHONE_NODE));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks Meta for the fields registration state is decided from', () => {
    for (const f of [
      'status',
      'platform_type',
      'is_pin_enabled',
      'code_verification_status',
      'last_onboarded_time',
    ]) {
      expect(PHONE_REGISTRATION_FIELDS).toContain(f);
    }
  });

  it('GETs the phone node with the registration field set', async () => {
    const info = await getPhoneNumberRegistration({
      phoneNumberId: 'PNID_123',
      accessToken: 'tok',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/PNID_123?fields=');
    expect(url).toContain('is_pin_enabled');
    expect(url).toContain('platform_type');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(info.status).toBe('CONNECTED');
    expect(info.platform_type).toBe('CLOUD_API');
    expect(info.is_pin_enabled).toBe(false);
  });

  it('throws a MetaApiError carrying the envelope on failure', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(400, {
        error: { message: 'Unsupported get request.', code: 100, fbtrace_id: 'TRACE' },
      }),
    );
    await expect(
      getPhoneNumberRegistration({ phoneNumberId: 'P', accessToken: 't' }),
    ).rejects.toMatchObject({ code: 100, fbtraceId: 'TRACE' });
  });
});

describe('getAppIdFromToken', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns the app id and scopes the token belongs to', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        data: {
          app_id: '2780686598984361',
          application: 'Vims Enterprise Messaging',
          type: 'SYSTEM_USER',
          is_valid: true,
          expires_at: 0,
          scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
        },
      }),
    );
    const info = await getAppIdFromToken({ accessToken: 'tok' });
    expect(info).toEqual({
      appId: '2780686598984361',
      appName: 'Vims Enterprise Messaging',
      tokenType: 'SYSTEM_USER',
      isValid: true,
      neverExpires: true,
      scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
    });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/debug_token?input_token=');
  });

  it('reports a token with an expiry as not never-expiring', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ data: { app_id: 'A', is_valid: true, expires_at: 1790000000, scopes: [] } }),
    );
    const info = await getAppIdFromToken({ accessToken: 'tok' });
    expect(info?.neverExpires).toBe(false);
  });

  it('returns null instead of throwing when debug_token is not permitted', async () => {
    // Some tokens cannot introspect themselves. That must degrade the
    // app-id match to "unknown", never fail the whole diagnostic.
    fetchMock.mockResolvedValueOnce(
      errorResponse(400, { error: { message: 'Invalid OAuth access token.', code: 190 } }),
    );
    await expect(getAppIdFromToken({ accessToken: 'tok' })).resolves.toBeNull();
  });
});

describe('registerPhoneNumber with an optional PIN', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(okResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('omits the pin parameter when none is supplied', async () => {
    await registerPhoneNumber({ phoneNumberId: 'PNID_123', accessToken: 'tok' });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ messaging_product: 'whatsapp' });
    expect(JSON.parse(init.body)).not.toHaveProperty('pin');
  });

  it('still sends the pin when one is supplied', async () => {
    await registerPhoneNumber({
      phoneNumberId: 'PNID_123',
      accessToken: 'tok',
      pin: '123456',
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp',
      pin: '123456',
    });
  });

  it('passes data_localization_region through when given', async () => {
    await registerPhoneNumber({
      phoneNumberId: 'PNID_123',
      accessToken: 'tok',
      dataLocalizationRegion: 'IN',
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp',
      data_localization_region: 'IN',
    });
  });

  it('still treats "already registered" as success', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(400, {
        error: { message: 'Phone number is already registered to this app.', code: 133005 },
      }),
    );
    const result = await registerPhoneNumber({
      phoneNumberId: 'P',
      accessToken: 't',
    });
    expect(result).toEqual({ success: true, alreadyRegistered: true });
  });

  it('surfaces a genuine PIN mismatch rather than swallowing it', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(400, {
        error: { message: 'Two-step verification PIN mismatch.', code: 133005 },
      }),
    );
    await expect(
      registerPhoneNumber({ phoneNumberId: 'P', accessToken: 't', pin: '000000' }),
    ).rejects.toMatchObject({ code: 133005 });
  });
});
