import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// The safety contract of "Register Number".
//
// The bug this endpoint exists to end: Save Configuration attempted
// POST /{phone_number_id}/register on every first save, deciding it was
// needed from the local `registered_at` column. For the production number
// +91 80 6548 1576 Meta already reported
//
//     status = CONNECTED, platform_type = CLOUD_API, is_pin_enabled = false
//
// so no PIN existed, every PIN was "wrong" (error 133005), and the route
// wrote status='disconnected' over a live channel. Each attempt also spent
// one of the 10 /register calls Meta allows per number per 72 hours.
//
// These tests pin the three properties that must never regress:
//   1. An already-registered number triggers NO /register call at all.
//   2. A PIN is never sent to a number Meta says has none.
//   3. A PIN that IS required is never bypassed.
// ---------------------------------------------------------------------------

/** Rows the route wrote, so we can assert nothing destructive landed. */
const configUpdates: Array<Record<string, unknown>> = []

/** The phone-number node Meta returns for the scenario under test. */
let phoneNode: Record<string, unknown> = {}

function makeSupabaseMock() {
  function builder(table: string) {
    const selectResult = () => {
      switch (table) {
        case 'profiles':
          return { data: { account_id: 'acct-1' }, error: null }
        case 'whatsapp_config':
          return {
            data: {
              phone_number_id: '1236852602854510',
              waba_id: '1882552683151636',
              access_token: 'enc-token',
              registered_at: null,
            },
            error: null,
          }
        default:
          return { data: null, error: null }
      }
    }

    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'delete']) {
      b[m] = vi.fn(chain)
    }
    b.update = vi.fn((payload: Record<string, unknown>) => {
      if (table === 'whatsapp_config') configUpdates.push(payload)
      return b
    })
    b.insert = vi.fn(() => b)
    b.single = vi.fn(() => Promise.resolve(selectResult()))
    b.maybeSingle = vi.fn(() => Promise.resolve(selectResult()))
    b.then = (resolve: (v: unknown) => unknown) => resolve(selectResult())
    return b
  }

  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })),
    },
    from: vi.fn((table: string) => builder(table)),
  }
}

let supabaseMock = makeSupabaseMock()
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plaintext-token'),
  encrypt: vi.fn(() => 'enc-token'),
  isLegacyFormat: vi.fn(() => false),
}))

const { getPhoneNumberRegistration, registerPhoneNumber } = vi.hoisted(() => ({
  getPhoneNumberRegistration:
    vi.fn<(args: Record<string, unknown>) => Promise<Record<string, unknown>>>(),
  // Typed with its argument object so `.mock.calls[0][0]` is inspectable —
  // asserting on whether a `pin` key was present is the point of this suite.
  registerPhoneNumber: vi.fn<
    (args: Record<string, unknown>) => Promise<{ success: boolean; alreadyRegistered: boolean }>
  >(async () => ({ success: true, alreadyRegistered: false })),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getPhoneNumberRegistration,
  registerPhoneNumber,
}))

import { POST } from './route'

function post(body: unknown = {}) {
  return POST(
    new Request('http://localhost/api/whatsapp/config/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  configUpdates.length = 0
  supabaseMock = makeSupabaseMock()
  registerPhoneNumber.mockResolvedValue({ success: true, alreadyRegistered: false })
  getPhoneNumberRegistration.mockImplementation(async () => phoneNode)
})

describe('an already-registered production number', () => {
  beforeEach(() => {
    // Captured live from Meta on 2026-10-18.
    phoneNode = {
      id: '1236852602854510',
      display_phone_number: '+91 80 6548 1576',
      verified_name: 'GitGemVault',
      status: 'CONNECTED',
      platform_type: 'CLOUD_API',
      is_pin_enabled: false,
      last_onboarded_time: '2026-09-21T11:47:14+0000',
    }
  })

  it('makes NO /register call', async () => {
    const res = await post({ pin: null })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(registerPhoneNumber).not.toHaveBeenCalled()
    expect(body.called_register).toBe(false)
    expect(body.already_registered).toBe(true)
  })

  it('makes no /register call even when a PIN is supplied', async () => {
    // A user who still has the old habit of typing a PIN must not be
    // able to trigger the failing call.
    const res = await post({ pin: '123456' })
    await res.json()
    expect(registerPhoneNumber).not.toHaveBeenCalled()
  })

  it('clears the stale PIN error instead of leaving it on screen', async () => {
    await post({})
    const written = Object.assign({}, ...configUpdates)
    expect(written.last_registration_error).toBeNull()
  })

  it('stamps registered_at from Meta, so the number stops reading as unregistered', async () => {
    await post({})
    const written = Object.assign({}, ...configUpdates)
    expect(written.registered_at).toBe('2026-09-21T11:47:14.000Z')
    expect(written.meta_platform_type).toBe('CLOUD_API')
    expect(written.meta_status).toBe('CONNECTED')
    expect(written.meta_pin_enabled).toBe(false)
  })

  it('never writes a disconnected status or clears credentials', async () => {
    await post({})
    const written = Object.assign({}, ...configUpdates)
    expect(written).not.toHaveProperty('status')
    expect(written).not.toHaveProperty('access_token')
    expect(written).not.toHaveProperty('phone_number_id')
    expect(written).not.toHaveProperty('waba_id')
  })
})

describe('a number that genuinely needs registering, with no PIN on it', () => {
  beforeEach(() => {
    phoneNode = {
      id: 'PN2',
      status: 'PENDING',
      platform_type: 'NOT_APPLICABLE',
      is_pin_enabled: false,
    }
  })

  it('registers WITHOUT a pin parameter', async () => {
    getPhoneNumberRegistration
      .mockImplementationOnce(async () => phoneNode)
      .mockImplementationOnce(async () => ({
        ...phoneNode,
        status: 'CONNECTED',
        platform_type: 'CLOUD_API',
      }))
    const res = await post({})
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(registerPhoneNumber).toHaveBeenCalledTimes(1)
    const args = registerPhoneNumber.mock.calls[0][0]
    expect(args).not.toHaveProperty('pin')
    expect(body.pin_sent).toBe(false)
    expect(body.registration.registered).toBe(true)
  })

  it('drops a PIN the user typed anyway — Meta has nothing to compare it to', async () => {
    getPhoneNumberRegistration
      .mockImplementationOnce(async () => phoneNode)
      .mockImplementationOnce(async () => ({
        ...phoneNode,
        status: 'CONNECTED',
        platform_type: 'CLOUD_API',
      }))
    await post({ pin: '999999' })
    const args = registerPhoneNumber.mock.calls[0][0]
    expect(args).not.toHaveProperty('pin')
  })
})

describe('a number that genuinely has two-step verification enabled', () => {
  beforeEach(() => {
    phoneNode = {
      id: 'PN3',
      status: 'PENDING',
      platform_type: 'NOT_APPLICABLE',
      is_pin_enabled: true,
    }
  })

  it('refuses to register without a PIN rather than trying one', async () => {
    const res = await post({})
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(registerPhoneNumber).not.toHaveBeenCalled()
    expect(body.field).toBe('pin')
    expect(body.error).toMatch(/PIN is required/i)
  })

  it('sends the supplied PIN verbatim', async () => {
    getPhoneNumberRegistration
      .mockImplementationOnce(async () => phoneNode)
      .mockImplementationOnce(async () => ({
        ...phoneNode,
        status: 'CONNECTED',
        platform_type: 'CLOUD_API',
      }))
    const res = await post({ pin: '654321' })
    const body = await res.json()
    expect(registerPhoneNumber).toHaveBeenCalledTimes(1)
    expect(registerPhoneNumber.mock.calls[0][0]).toMatchObject({ pin: '654321' })
    expect(body.pin_sent).toBe(true)
  })

  it('rejects a malformed PIN before touching Meta', async () => {
    const res = await post({ pin: '12ab' })
    expect(res.status).toBe(400)
    expect(getPhoneNumberRegistration).not.toHaveBeenCalled()
    expect(registerPhoneNumber).not.toHaveBeenCalled()
  })

  it('surfaces a rejected PIN and never retries without one', async () => {
    registerPhoneNumber.mockRejectedValueOnce(
      Object.assign(new Error('Two-step verification PIN mismatch.'), {
        code: 133005,
        httpStatus: 400,
        fbtraceId: 'TRACE',
      }),
    )
    const res = await post({ pin: '000000' })
    const body = await res.json()
    expect(res.status).toBe(400)
    // Exactly one attempt. A fallback retry without the PIN would be a
    // security bypass, not a fix.
    expect(registerPhoneNumber).toHaveBeenCalledTimes(1)
    expect(body.meta.code).toBe(133005)
    // The failure is recorded, but the channel is not downgraded.
    const written = Object.assign({}, ...configUpdates)
    expect(written.last_registration_error).toMatch(/PIN/i)
    expect(written).not.toHaveProperty('status')
  })
})

describe('a number Meta reports as banned or restricted', () => {
  it('does not spend a registration attempt on it', async () => {
    phoneNode = {
      id: 'PN4',
      status: 'BANNED',
      platform_type: 'CLOUD_API',
      is_pin_enabled: false,
    }
    const res = await post({})
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(registerPhoneNumber).not.toHaveBeenCalled()
    expect(body.error).toMatch(/BANNED/i)
  })
})
