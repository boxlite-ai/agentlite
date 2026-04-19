import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MAX_RETRIES,
  getRetryDelayMs,
  getRetryDescriptor,
  normalizeMaxRetries,
  withRetry,
} from './retry.js';

describe('retry helpers', () => {
  it('detects rate-limit errors from HTTP 429 responses', () => {
    const retry = getRetryDescriptor({
      status: 429,
      message: 'Too many requests',
    });

    expect(retry).toEqual({
      kind: 'rate_limit',
      message: 'Too many requests',
      statusCode: 429,
    });
  });

  it('detects transient errors from nested response status codes', () => {
    const retry = getRetryDescriptor({
      message: 'upstream failed',
      cause: { response: { status: 503 } },
    });

    expect(retry).toEqual({
      kind: 'transient',
      message: 'upstream failed',
      statusCode: 503,
    });
  });

  it('does not retry non-retryable errors', () => {
    expect(
      getRetryDescriptor({
        statusCode: 400,
        message: 'Bad request',
      }),
    ).toBeNull();
  });

  it('computes exponential backoff with jitter and caps at 60s', () => {
    expect(getRetryDelayMs(1, () => 0)).toBe(1_000);
    expect(getRetryDelayMs(3, () => 0.5)).toBe(6_000);
    expect(getRetryDelayMs(10, () => 1)).toBe(60_000);
  });

  it('normalizes invalid retry counts to safe integers', () => {
    expect(normalizeMaxRetries(undefined)).toBe(DEFAULT_MAX_RETRIES);
    expect(normalizeMaxRetries(-3)).toBe(0);
    expect(normalizeMaxRetries(3.9)).toBe(3);
  });

  it('retries retryable errors and reports the backoff delay', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const onRetry = vi.fn(async () => {});
    let attempts = 0;

    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw {
            status: 429,
            message: `try ${attempts}`,
          };
        }
        return 'ok';
      },
      {
        maxRetries: 5,
        random: () => 0,
        sleep,
        onRetry,
      },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 1_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2_000);
    expect(onRetry).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        attempt: 1,
        maxRetries: 5,
        delayMs: 1_000,
        kind: 'rate_limit',
      }),
    );
    expect(onRetry).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        attempt: 2,
        maxRetries: 5,
        delayMs: 2_000,
        kind: 'rate_limit',
      }),
    );
  });
});
