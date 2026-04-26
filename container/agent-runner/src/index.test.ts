import { describe, expect, it, vi } from 'vitest';

import { captureTokenUsageSummaries, resolveUsageModel } from './index.js';

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

  it('returns null when currentModel is not present and modelUsage has multiple models', () => {
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
    ).toBeNull();
  });

  it('returns null for multi-model usage so callers can record each model', () => {
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
    ).toBeNull();
  });

  it('returns null when no usage model is available', () => {
    expect(resolveUsageModel(undefined, {})).toBeNull();
  });

  it('returns null when currentModel is not present and modelUsage is empty', () => {
    expect(resolveUsageModel('claude-opus-4-6', {})).toBeNull();
  });
});

describe('captureTokenUsageSummaries', () => {
  it('returns one usage row per modelUsage entry with per-model costs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_710_000_000_500);

    const summaries = captureTokenUsageSummaries({
      groupJid: 'group-1@g.us',
      sessionId: 'session-a',
      currentModel: 'claude-opus-4-6',
      queryStartedAt: 1_710_000_000_000,
      message: {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 600,
          output_tokens: 300,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 15,
        },
        modelUsage: {
          'claude-haiku-4-5': {
            inputTokens: 100,
            outputTokens: 40,
            cacheReadInputTokens: 5,
            cacheCreationInputTokens: 2,
            costUSD: 0.0002,
          },
          'claude-sonnet-4-6': {
            inputTokens: 500,
            outputTokens: 260,
            cacheReadInputTokens: 25,
            cacheCreationInputTokens: 13,
            costUSD: 0.006,
          },
        },
      } as any,
    });

    expect(summaries).toEqual([
      {
        group_jid: 'group-1@g.us',
        session_id: 'session-a',
        model: 'claude-haiku-4-5',
        prompt_tokens: 100,
        completion_tokens: 40,
        total_tokens: 147,
        cache_read_tokens: 5,
        cache_write_tokens: 2,
        cost_usd: 0.0002,
        latency_ms: 500,
        ts: 1_710_000_000_500,
      },
      {
        group_jid: 'group-1@g.us',
        session_id: 'session-a',
        model: 'claude-sonnet-4-6',
        prompt_tokens: 500,
        completion_tokens: 260,
        total_tokens: 798,
        cache_read_tokens: 25,
        cache_write_tokens: 13,
        cost_usd: 0.006,
        latency_ms: 500,
        ts: 1_710_000_000_500,
      },
    ]);

    vi.useRealTimers();
  });
});
