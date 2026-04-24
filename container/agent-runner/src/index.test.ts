import { describe, expect, it } from 'vitest';

import { resolveUsageModel } from './index.js';

describe('resolveUsageModel', () => {
  it('returns the only model when modelUsage has one entry', () => {
    expect(
      resolveUsageModel('claude-opus-4-6', {
        'claude-sonnet-4-6': {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      }),
    ).toBe('claude-sonnet-4-6');
  });

  it('does not use currentModel when it is missing from modelUsage', () => {
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

  it('returns the highest-token model for multi-model usage', () => {
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
});
