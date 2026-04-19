export const DEFAULT_MAX_RETRIES = 5;
export const RETRY_BASE_DELAY_MS = 1_000;
export const RETRY_MAX_DELAY_MS = 60_000;

export type RetryKind = 'rate_limit' | 'transient';

export interface RetryDescriptor {
  kind: RetryKind;
  message: string;
  statusCode?: number;
}

export interface RetryAttempt {
  attempt: number;
  maxRetries: number;
  retryAfterMs: number;
  kind: RetryKind;
  message: string;
  statusCode?: number;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function extractStatusCode(error: unknown): number | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);

    const record = asObject(current);
    if (!record) continue;

    const direct = readNumber(record.status);
    if (direct !== undefined) return direct;

    const statusCode = readNumber(record.statusCode);
    if (statusCode !== undefined) return statusCode;

    const snakeCase = readNumber(record.status_code);
    if (snakeCase !== undefined) return snakeCase;

    queue.push(record.response, record.error, record.body, record.cause);
  }

  return undefined;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  const record = asObject(error);
  if (typeof record?.message === 'string') {
    return record.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function getRetryDescriptor(error: unknown): RetryDescriptor | null {
  const record = asObject(error);
  if (
    (readNumber(record?.resultCount) ?? 0) > 0 ||
    record?.closedDuringQuery === true
  ) {
    return null;
  }

  const statusCode = extractStatusCode(error);
  const message = getErrorMessage(error);

  if (statusCode === 429) {
    return {
      kind: 'rate_limit',
      message,
      statusCode,
    };
  }

  if (statusCode === 500 || statusCode === 503) {
    return {
      kind: 'transient',
      message,
      statusCode,
    };
  }

  return null;
}

export function normalizeMaxRetries(maxRetries: number | undefined): number {
  if (maxRetries === undefined) return DEFAULT_MAX_RETRIES;
  if (!Number.isFinite(maxRetries)) return DEFAULT_MAX_RETRIES;
  return Math.max(0, Math.floor(maxRetries));
}

export function getRetryDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt);
  const cappedBase = Math.min(
    RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * 2 ** exponent,
  );
  const jitterFactor = Math.min(1, Math.max(0, random()));
  return Math.floor(cappedBase * (1 + jitterFactor * 0.3));
}

export async function sleepMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getRetriesExhaustedMessage(
  retry: RetryDescriptor,
  maxRetries: number,
): string {
  const statusSuffix =
    retry.statusCode !== undefined ? ` (status ${retry.statusCode})` : '';
  return `Rate limit / transient error — retries exhausted after ${maxRetries} retries${statusSuffix}: `;
}

function toRetriesExhaustedError(
  error: unknown,
  retry: RetryDescriptor,
  maxRetries: number,
): Error {
  const message = `${getRetriesExhaustedMessage(retry, maxRetries)}${getErrorMessage(error)}`;
  if (error instanceof Error) {
    error.message = message;
    return error;
  }
  return new Error(message, { cause: error });
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  opts?: {
    maxRetries?: number;
    random?: () => number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (attempt: RetryAttempt) => void | Promise<void>;
  },
): Promise<T> {
  const maxRetries = normalizeMaxRetries(opts?.maxRetries);
  const random = opts?.random ?? Math.random;
  const sleep = opts?.sleep ?? sleepMs;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const retry = getRetryDescriptor(error);
      if (!retry) {
        throw error;
      }
      if (attempt >= maxRetries) {
        throw toRetriesExhaustedError(error, retry, maxRetries);
      }

      const retryAttempt = attempt + 1;
      const retryAfterMs = getRetryDelayMs(attempt, random);
      await opts?.onRetry?.({
        ...retry,
        attempt: retryAttempt,
        maxRetries,
        retryAfterMs,
      });
      await sleep(retryAfterMs);
    }
  }
}
