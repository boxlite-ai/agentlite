import { describe, expect, it } from 'vitest';

import { resolveUsageModel } from './index.js';

describe('resolveUsageModel', () => {
  it('returns the current model when available', () => {
    expect(
      resolveUsageModel('claude-opus-4-6', {
        'claude-sonnet-4-6': {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      }),
    ).toBe('claude-opus-4-6');
  });

  it('falls back to the current model when modelUsage keys do not match it', () => {
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
    ).toBe('claude-opus-4-6');
  });

  it('falls back to the highest-token model when currentModel is unavailable', () => {
    expect(
      resolveUsageModel(undefined, {
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
});
