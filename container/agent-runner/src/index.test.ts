import { describe, expect, it } from 'vitest';

import { resolveUsageModel } from './index.js';

describe('resolveUsageModel', () => {
  it('returns the only model in modelUsage', () => {
    expect(
      resolveUsageModel('claude-opus-4-6', {
        'claude-opus-4-6': {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      }),
    ).toBe('claude-opus-4-6');
  });

  it('does not fall back to currentModel when it is not present in modelUsage', () => {
    expect(
      resolveUsageModel('claude-opus-4-6', {
        'claude-haiku-4-5': {
          inputTokens: 25,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        'claude-sonnet-4-6': {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      }),
    ).toBe('claude-sonnet-4-6');
  });

  it('returns the highest-token model when multiple models are present', () => {
    expect(
      resolveUsageModel('claude-haiku-4-5', {
        'claude-haiku-4-5': {
          inputTokens: 10,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        'claude-sonnet-4-6': {
          inputTokens: 40,
          outputTokens: 20,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      }),
    ).toBe('claude-sonnet-4-6');
  });

  it('returns null when no usage model is available', () => {
    expect(resolveUsageModel(undefined, {})).toBeNull();
  });
});
