import { describe, expect, it, vi } from 'vitest';
import { MetaApiError } from './meta-api';
import {
  isOutside24HourWindowError,
  isRetryableMetaError,
  isWithin24HourWindow,
  withTransientRetry,
} from './retry-policy';

describe('retry-policy', () => {
  it('classifies transient Meta/HTTP errors as retryable', () => {
    expect(
      isRetryableMetaError(
        new MetaApiError('Rate limit hit', { code: 130429, httpStatus: 429 }),
      ),
    ).toBe(true);
    expect(
      isRetryableMetaError(
        new MetaApiError('Service unavailable', { code: 131016, httpStatus: 503 }),
      ),
    ).toBe(true);
    expect(isRetryableMetaError(new TypeError('fetch failed'))).toBe(true);
  });

  it('never retries 24-hour window or invalid parameter errors', () => {
    expect(
      isRetryableMetaError(
        new MetaApiError('Re-engagement message', {
          code: 131047,
          httpStatus: 400,
        }),
      ),
    ).toBe(false);
    expect(
      isRetryableMetaError(
        new MetaApiError('Invalid parameter', { code: 100, httpStatus: 400 }),
      ),
    ).toBe(false);
    expect(isOutside24HourWindowError(131047, null)).toBe(true);
    expect(
      isOutside24HourWindowError(null, 'More than 24 hours have passed'),
    ).toBe(true);
  });

  it('enforces the 24-hour customer service window strictly', () => {
    const now = new Date('2026-11-23T12:00:00Z');
    expect(isWithin24HourWindow(null, now)).toBe(false);
    expect(isWithin24HourWindow('2026-11-22T12:00:01Z', now)).toBe(true);
    expect(isWithin24HourWindow('2026-11-22T12:00:00Z', now)).toBe(false);
    expect(isWithin24HourWindow('2026-11-20T12:00:00Z', now)).toBe(false);
  });

  it('retries transient failures and succeeds without duplicate calls on success', async () => {
    let calls = 0;
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await withTransientRetry(
      async () => {
        calls++;
        if (calls < 2) {
          throw new MetaApiError('Temp unavailable', {
            code: 131016,
            httpStatus: 503,
          });
        }
        return 'wamid.ok';
      },
      { sleep, delaysMs: [10, 20] },
    );

    expect(result).toBe('wamid.ok');
    expect(calls).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-retryable errors', async () => {
    let calls = 0;
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      withTransientRetry(
        async () => {
          calls++;
          throw new MetaApiError('Re-engagement required', {
            code: 131047,
            httpStatus: 400,
          });
        },
        { sleep, delaysMs: [10, 20] },
      ),
    ).rejects.toThrow('Re-engagement required');

    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
