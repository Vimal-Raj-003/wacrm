import { describe, expect, it, vi } from 'vitest';
import {
  REGISTRATION_TRUTH_COLUMNS,
  isUnknownColumnError,
  withoutColumns,
  writeConfigRow,
} from './config-columns';

describe('isUnknownColumnError', () => {
  it('recognises the PostgREST write error for a missing column', () => {
    // Captured live from PostgREST on 2026-10-18 before migration 043.
    expect(
      isUnknownColumnError({
        code: 'PGRST204',
        message: "Could not find the 'meta_status' column of 'whatsapp_config' in the schema cache",
      }),
    ).toBe(true);
  });

  it('recognises the Postgres read error for a missing column', () => {
    expect(
      isUnknownColumnError({
        code: '42703',
        message: 'column whatsapp_config.meta_status does not exist',
      }),
    ).toBe(true);
  });

  it('does not mistake other failures for a missing column', () => {
    expect(isUnknownColumnError({ code: '23505', message: 'duplicate key value' })).toBe(false);
    expect(isUnknownColumnError({ code: '42501', message: 'permission denied' })).toBe(false);
    expect(isUnknownColumnError(null)).toBe(false);
    expect(isUnknownColumnError(undefined)).toBe(false);
  });
});

describe('withoutColumns', () => {
  it('drops exactly the named keys and keeps the rest', () => {
    const row = {
      phone_number_id: '123',
      status: 'connected',
      meta_status: 'CONNECTED',
      campaign_ready_at: null,
    };
    expect(withoutColumns(row, ['meta_status', 'campaign_ready_at'])).toEqual({
      phone_number_id: '123',
      status: 'connected',
    });
  });

  it('leaves the original object untouched', () => {
    const row = { a: 1, meta_status: 'X' };
    withoutColumns(row, ['meta_status']);
    expect(row).toHaveProperty('meta_status');
  });
});

/** Minimal stand-in for the chained Supabase query builder. */
function fakeSupabase(responses: Array<{ error: unknown }>) {
  const calls: Array<Record<string, unknown>> = [];
  let i = 0;
  const client = {
    from: () => client,
    update: (row: Record<string, unknown>) => {
      calls.push(row);
      return client;
    },
    insert: (row: Record<string, unknown>) => {
      calls.push(row);
      return client;
    },
    eq: () => Promise.resolve(responses[i++] ?? { error: null }),
  };
  return { client, calls };
}

describe('writeConfigRow', () => {
  it('writes every column when the schema has them', async () => {
    const { client, calls } = fakeSupabase([{ error: null }]);
    const res = await writeConfigRow({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
      accountId: 'acct',
      row: { phone_number_id: '1', meta_status: 'CONNECTED' },
    });
    expect(res.error).toBeNull();
    expect(res.migrationPending).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveProperty('meta_status', 'CONNECTED');
  });

  it('retries without the 043 columns when they do not exist yet', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, calls } = fakeSupabase([
      {
        error: {
          code: 'PGRST204',
          message: "Could not find the 'meta_status' column of 'whatsapp_config' in the schema cache",
        },
      },
      { error: null },
    ]);
    const res = await writeConfigRow({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
      accountId: 'acct',
      row: { phone_number_id: '1', status: 'connected', meta_status: 'CONNECTED' },
    });
    expect(res.error).toBeNull();
    // The caller needs to know the truth columns were not persisted, so
    // the UI can say "run migration 043" instead of silently reporting
    // state it never stored.
    expect(res.migrationPending).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toHaveProperty('meta_status');
    // The legacy columns still had to land.
    expect(calls[1]).toEqual({ phone_number_id: '1', status: 'connected' });
    warn.mockRestore();
  });

  it('does not retry on an unrelated error', async () => {
    const { client, calls } = fakeSupabase([
      { error: { code: '42501', message: 'permission denied for table whatsapp_config' } },
    ]);
    const res = await writeConfigRow({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
      accountId: 'acct',
      row: { phone_number_id: '1', meta_status: 'CONNECTED' },
    });
    expect(res.error).toMatchObject({ code: '42501' });
    expect(calls).toHaveLength(1);
  });

  it('every 043 column is listed so none can be missed by the retry', () => {
    for (const c of [
      'meta_status',
      'meta_platform_type',
      'meta_pin_enabled',
      'meta_onboarded_at',
      'meta_app_id',
      'last_verified_at',
      'last_outbound_test_at',
      'last_outbound_test_wamid',
      'last_outbound_test_status',
      'last_inbound_event_at',
      'campaign_ready_at',
      'campaign_ready_blockers',
    ]) {
      expect(REGISTRATION_TRUTH_COLUMNS).toContain(c);
    }
  });
});
