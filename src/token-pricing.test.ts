import { describe, expect, it } from 'vitest';

import { computeCostUsd } from './token-pricing.js';

describe('computeCostUsd', () => {
  it('returns the configured price for claude-opus-4-6', () => {
    expect(
      computeCostUsd({
        model: 'claude-opus-4-6',
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBe(110.25);
  });

  it('returns the configured price for claude-sonnet-4-6', () => {
    expect(
      computeCostUsd({
        model: 'claude-sonnet-4-6',
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBe(22.05);
  });

  it('returns the configured price for claude-haiku-4-5', () => {
    expect(
      computeCostUsd({
        model: 'claude-haiku-4-5',
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBe(5.88);
  });

  it('returns undefined for unknown models', () => {
    expect(
      computeCostUsd({
        model: 'unknown-model',
        promptTokens: 123,
        completionTokens: 456,
      }),
    ).toBeUndefined();
  });
});
