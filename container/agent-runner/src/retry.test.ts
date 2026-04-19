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

  it('computes exponential backoff with 0-30% jitter on the capped base', () => {
    expect(getRetryDelayMs(0, () => 0)).toBe(1_000);
    expect(getRetryDelayMs(3, () => 0.5)).toBe(9_200);
    expect(getRetryDelayMs(10, () => 1)).toBe(78_000);
  });

  it('keeps jitter within the capped base and 30% upper bound', () => {
    const attempt = 5;
    const cappedBase = 32_000;
    const maxDelay = Math.floor(cappedBase * 1.3);

    expect(getRetryDelayMs(attempt, () => 0)).toBe(cappedBase);
    expect(getRetryDelayMs(attempt, () => 1)).toBe(maxDelay);

    const actual = getRetryDelayMs(attempt, () => 0.42);
    expect(actual).toBeGreaterThanOrEqual(cappedBase);
    expect(actual).toBeLessThanOrEqual(maxDelay);
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
        retryAfterMs: 1_000,
        kind: 'rate_limit',
      }),
    );
    expect(onRetry).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        attempt: 2,
        maxRetries: 5,
        retryAfterMs: 2_000,
        kind: 'rate_limit',
      }),
    );
  });

  it('retries HTTP 500 errors the same way as 429s', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const onRetry = vi.fn(async () => {});
    let attempts = 0;

    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw {
            status: 500,
            message: 'Internal server error',
          };
        }
        return 'ok';
      },
      {
        maxRetries: 1,
        random: () => 0,
        sleep,
        onRetry,
      },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        kind: 'transient',
        retryAfterMs: 1_000,
        statusCode: 500,
      }),
    );
  });

  it('throws immediately when maxRetries is 0', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const onRetry = vi.fn(async () => {});
    let attempts = 0;

    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw {
            status: 429,
            message: 'Too many requests',
          };
        },
        {
          maxRetries: 0,
          random: () => 0,
          sleep,
          onRetry,
        },
      ),
    ).rejects.toThrow(
      /^Rate limit \/ transient error — retries exhausted after 0 retries/,
    );

    expect(attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('throws an exhaustion error after the configured retries are spent', async () => {
    const sleep = vi.fn(async (_ms: number) => {});

    await expect(
      withRetry(
        async () => {
          throw {
            status: 429,
            message: 'Too many requests',
          };
        },
        {
          maxRetries: 2,
          random: () => 0,
          sleep,
        },
      ),
    ).rejects.toThrow(
      /^Rate limit \/ transient error — retries exhausted after 2 retries/,
    );

    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-HTTP errors without a retryable status code', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const error = new Error('Service unavailable');
    let attempts = 0;

    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw error;
        },
        {
          maxRetries: 5,
          sleep,
        },
      ),
    ).rejects.toBe(error);

    expect(attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
