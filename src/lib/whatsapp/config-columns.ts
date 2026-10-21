/**
 * Forward-compatible writes to `whatsapp_config`.
 *
 * Migration 043 adds the columns that hold Meta's authoritative
 * connection state (`meta_status`, `meta_platform_type`,
 * `meta_pin_enabled`, …) plus the campaign-readiness stamps. Those are
 * applied by hand in the Supabase SQL editor on a self-hosted instance,
 * so there is a window where the code is deployed and the columns are
 * not there yet.
 *
 * Writing the new columns into an un-migrated table fails the whole
 * statement, which would break Save Configuration — the exact workflow
 * this change exists to repair. So every write goes through
 * `writeConfigRow`, which retries once without the 043 columns and
 * reports `migrationPending` so the UI can ask for the migration
 * instead of silently reporting state it never stored.
 *
 * Error codes are the ones PostgREST actually returns (captured against
 * the live project before 043 was applied):
 *   PGRST204 — "Could not find the 'X' column of 'whatsapp_config' in
 *              the schema cache"   (INSERT / PATCH)
 *   42703    — "column whatsapp_config.X does not exist"   (SELECT)
 */

/** Columns introduced by migration 043. */
export const REGISTRATION_TRUTH_COLUMNS = [
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
] as const

export type RegistrationTruthColumn = (typeof REGISTRATION_TRUTH_COLUMNS)[number]

/** True when a Supabase error means "that column isn't in the schema". */
export function isUnknownColumnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  if (code === 'PGRST204' || code === '42703') return true
  const message = (err as { message?: unknown }).message
  return (
    typeof message === 'string' &&
    /could not find the '.*' column|column .* does not exist/i.test(message)
  )
}

/** A copy of `row` with `columns` removed. Does not mutate the input. */
export function withoutColumns<T extends Record<string, unknown>>(
  row: T,
  columns: readonly string[],
): Record<string, unknown> {
  const drop = new Set(columns)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (!drop.has(k)) out[k] = v
  }
  return out
}

export interface WriteConfigRowArgs {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any
  accountId: string
  row: Record<string, unknown>
  /** Insert instead of update — used on first save. */
  mode?: 'update' | 'insert'
}

export interface WriteConfigRowResult {
  error: unknown
  /**
   * True when the row was written but the 043 columns were dropped
   * because the schema does not have them yet.
   */
  migrationPending: boolean
}

/**
 * Write a config row, degrading gracefully when migration 043 has not
 * been applied. Only ever retries for a missing-column error; any other
 * failure is returned to the caller untouched.
 */
export async function writeConfigRow(
  args: WriteConfigRowArgs,
): Promise<WriteConfigRowResult> {
  const { supabase, accountId, row, mode = 'update' } = args

  const attempt = async (payload: Record<string, unknown>) => {
    if (mode === 'insert') {
      const { error } = await supabase.from('whatsapp_config').insert(payload)
      return error
    }
    const { error } = await supabase
      .from('whatsapp_config')
      .update(payload)
      .eq('account_id', accountId)
    return error
  }

  const error = await attempt(row)
  if (!error) return { error: null, migrationPending: false }
  if (!isUnknownColumnError(error)) return { error, migrationPending: false }

  console.warn(
    '[whatsapp_config] migration 043 not applied — retrying the write without the ' +
      'registration-state columns. Apply supabase/migrations/043_whatsapp_registration_truth.sql ' +
      'so Meta connection state and campaign readiness can be persisted.',
  )
  const retryError = await attempt(withoutColumns(row, REGISTRATION_TRUTH_COLUMNS))
  return { error: retryError ?? null, migrationPending: true }
}
