/**
 * Retry classification and backoff policy for individual WhatsApp
 * outbound messaging.
 *
 * Goals:
 *  - Automatically retry transient network / API failures (429, 5xx,
 *    Meta temporary service codes, dropped connections) within seconds
 *    so agents do not have to wait or manually resend.
 *  - NEVER retry permanent / policy errors (such as 24-hour window
 *    expired `131047`, invalid recipient, expired token, invalid params)
 *    or risk duplicate sends when Meta already accepted the message.
 *  - Enforce WhatsApp's 24-hour customer service window before retrying
 *    any non-template message.
 */

import { MetaApiError } from './meta-api';
import { extractTemplateVariables } from './template-validators';

/** Automatic retry attempts after the initial try (total = 1 + MAX_AUTO_RETRIES). */
export const MAX_AUTO_RETRIES = 2;

/** Short backoff delays (ms) for transient failures — completes well under 10s. */
export const AUTO_RETRY_DELAYS_MS = [1500, 3500] as const;

/** 24 hours in milliseconds. */
export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Meta Cloud API error codes that represent temporary/transient conditions
 * where retrying shortly after is appropriate.
 */
const TRANSIENT_META_CODES = new Set<number>([
  1, // API Unknown temporary error
  2, // API Service temporary issue
  4, // API Too Many Calls
  17, // API User Too Many Calls
  130429, // Rate limit hit
  131016, // Service temporarily unavailable
  131048, // Spam rate limit hit (temporary)
  131056, // Pair rate limit hit (temporary)
]);

/** Meta Cloud API error code for outside the 24-hour customer service window. */
export const META_OUTSIDE_24H_WINDOW_CODE = 131047;

export function isOutside24HourWindowError(
  code?: number | null,
  message?: string | null,
): boolean {
  if (code === META_OUTSIDE_24H_WINDOW_CODE) return true;
  if (!message) return false;
  return (
    /131047/.test(message) ||
    /re-?engagement/i.test(message) ||
    /more than 24 hours/i.test(message)
  );
}

/**
 * Determine whether an error thrown during a Meta send call is a
 * transient failure safe to automatically retry.
 */
export function isRetryableMetaError(err: unknown): boolean {
  if (err instanceof MetaApiError) {
    if (err.code !== null && isOutside24HourWindowError(err.code, err.message)) {
      return false;
    }
    if (err.code !== null && TRANSIENT_META_CODES.has(err.code)) {
      return true;
    }
    if (
      err.httpStatus === 429 ||
      err.httpStatus === 500 ||
      err.httpStatus === 502 ||
      err.httpStatus === 503 ||
      err.httpStatus === 504
    ) {
      return true;
    }
    return false;
  }

  if (err instanceof Error) {
    // Node fetch throws TypeError on DNS / TCP reset / timeout failures.
    const msg = err.message.toLowerCase();
    if (
      err.name === 'AbortError' ||
      msg.includes('fetch failed') ||
      msg.includes('network') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('eai_again') ||
      msg.includes('socket hang up') ||
      msg.includes('temporarily unavailable')
    ) {
      return true;
    }
  }

  return false;
}

/**
 * True when the customer sent a message within the last 24 hours.
 * Returns false if the customer has never sent a message (business-initiated).
 */
export function isWithin24HourWindow(
  lastCustomerMessageAt: string | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!lastCustomerMessageAt) return false;
  const ts =
    lastCustomerMessageAt instanceof Date
      ? lastCustomerMessageAt.getTime()
      : new Date(lastCustomerMessageAt).getTime();
  if (!Number.isFinite(ts)) return false;
  return now.getTime() - ts < CUSTOMER_SERVICE_WINDOW_MS;
}

export interface RetryOptions {
  maxRetries?: number;
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  shouldRetry?: (err: unknown) => boolean;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Execute `fn` with automatic bounded retries on transient failures.
 * Stops immediately on success or non-retryable errors.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? MAX_AUTO_RETRIES;
  const delays = options.delaysMs ?? AUTO_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  const shouldRetry = options.shouldRetry ?? isRetryableMetaError;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !shouldRetry(err)) {
        throw err;
      }
      const delay = delays[Math.min(attempt, delays.length - 1)] ?? 1500;
      attempt++;
      await sleep(delay);
    }
  }
}

/**
 * Reconstruct the ordered body variable values from a persisted
 * template message's rendered `content_text` by matching it against the
 * template's `body_text` (supporting both positional `{{1}}` and named
 * `{{customer_name}}` placeholders).
 *
 * Returns `[]` when the template has no variables, the ordered values
 * array when matched, or `null` when the rendered text cannot be
 * unambiguously matched back to the template.
 */
export function extractTemplateBodyParams(
  templateBody: string,
  renderedText: string | null | undefined,
): string[] | null {
  const keys = extractTemplateVariables(templateBody);
  if (keys.length === 0) return [];
  if (!renderedText) return null;

  const placeholderRegex = /\{\{([A-Za-z0-9_]+)\}\}/g;
  const occurrences: string[] = [];
  let pattern = '^';
  let lastIndex = 0;

  for (const match of templateBody.matchAll(placeholderRegex)) {
    const idx = match.index ?? 0;
    const literal = templateBody.slice(lastIndex, idx);
    pattern += literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    occurrences.push(match[1]);
    pattern += '([\\s\\S]+?)';
    lastIndex = idx + match[0].length;
  }

  const tail = templateBody.slice(lastIndex);
  pattern += tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  pattern += '$';

  const re = new RegExp(pattern);
  const matched = renderedText.match(re);
  if (!matched) return null;

  const byKey = new Map<string, string>();
  occurrences.forEach((key, i) => {
    const captured = matched[i + 1];
    if (captured !== undefined && !byKey.has(key)) {
      byKey.set(key, captured);
    }
  });

  const out: string[] = [];
  for (const key of keys) {
    const val = byKey.get(key);
    if (val === undefined) return null;
    out.push(val);
  }
  return out;
}

/**
 * Turn common Meta WhatsApp Cloud API messaging failure codes into
 * clear, actionable text so the agent knows immediately WHY a send or
 * retry failed.
 */
export function explainSendFailure(
  code: number | null | undefined,
  message: string,
  details?: string | null,
): string {
  switch (code) {
    case 131047:
      return '24-hour customer service window expired (#131047) — send an approved WhatsApp template to start or reopen this chat.';
    case 131026:
      return 'Message undeliverable (#131026) — recipient number may not be registered on WhatsApp or has not accepted WhatsApp Terms.';
    case 131049:
      return 'Meta ecosystem engagement limit (#131049) — Meta temporarily capped marketing templates to this recipient; retry later or use a Utility template.';
    case 131050:
      return 'Customer opted out of marketing messages (#131050).';
    case 131042:
      return 'WhatsApp Business payment/billing issue (#131042) — check your Meta Business payment method.';
    case 131031:
      return 'WhatsApp Business Account is restricted or locked (#131031) — check Meta Business Manager.';
    case 132000:
      return 'Template parameter count mismatch (#132000) — check that all template variables match Meta’s approved template.';
    case 132001:
      return 'Template does not exist or is not approved in this language (#132001) — sync templates from Meta in Settings.';
    case 132012:
      return 'Template parameter format mismatch (#132012) — verify header media/PDF URL and variable values.';
    case 130429:
      return 'Meta API rate limit hit (#130429) — please retry in 1–2 minutes.';
    case 131016:
      return 'WhatsApp service temporarily unavailable (#131016) — please retry in 1–2 minutes.';
    case 190:
      return 'Meta access token expired or invalid (#190) — update your token in Settings → WhatsApp.';
    default:
      return details ? `${message} — ${details}` : message;
  }
}
