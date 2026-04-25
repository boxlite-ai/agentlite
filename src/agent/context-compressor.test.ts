import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  ContextCompressor,
  type FormattedMessage,
} from './context-compressor.js';

function buildMessages(count: number): FormattedMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    sender: `User ${index + 1}`,
    content: `message ${index + 1}`,
  }));
}

function createAnthropicMock(summary = 'compact summary'): Anthropic {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: summary }],
      })),
    },
  } as unknown as Anthropic;
}

describe('ContextCompressor', () => {
  it('returns false for null utilization', () => {
    const compressor = new ContextCompressor(createAnthropicMock());

    expect(compressor.needsCompression(null)).toBe(false);
  });

  it('returns false below 80% utilization', () => {
    const compressor = new ContextCompressor(createAnthropicMock());

    expect(compressor.needsCompression(0.79)).toBe(false);
  });

  it('returns true at 80% utilization', () => {
    const compressor = new ContextCompressor(createAnthropicMock());

    expect(compressor.needsCompression(0.8)).toBe(true);
  });

  it('returns true above 80% utilization', () => {
    const compressor = new ContextCompressor(createAnthropicMock());

    expect(compressor.needsCompression(0.95)).toBe(true);
  });

  it('compress keeps the most recent 20% and summarizes the rest', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'compact summary' }],
    });
    const anthropic = {
      messages: {
        create,
      },
    } as unknown as Anthropic;
    const compressor = new ContextCompressor(anthropic);

    const result = await compressor.compress(buildMessages(10));

    expect(result.summary).toBe('compact summary');
    expect(result.messagesKept).toBeGreaterThanOrEqual(1);
    expect(result.messagesKept).toBe(2);
    expect(result.messagesCompressed).toBe(8);
    expect(result.messagesKept + result.messagesCompressed).toBe(10);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
    });
    expect(create.mock.calls[0]?.[0].messages[0].content).toContain(
      '[User 1]: message 1',
    );
    expect(create.mock.calls[0]?.[0].messages[0].content).toContain(
      '[User 8]: message 8',
    );
    expect(create.mock.calls[0]?.[0].messages[0].content).not.toContain(
      '[User 9]: message 9',
    );
  });

  it('compress keeps a single message and skips summarization', async () => {
    const anthropic = createAnthropicMock();
    const compressor = new ContextCompressor(anthropic);

    const result = await compressor.compress([
      { sender: 'User', content: 'one' },
    ]);

    expect(result).toEqual({
      summary: '',
      messagesCompressed: 0,
      messagesKept: 1,
    });
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it('formatSummaryBlock wraps and escapes summary content', () => {
    const compressor = new ContextCompressor({} as Anthropic);

    const block = compressor.formatSummaryBlock(
      'Use <tags> & "quotes"',
      '2026-04-25T00:00:00.000Z',
    );

    expect(block).toContain('<context_summary type="compressed"');
    expect(block).toContain('compressed_at="2026-04-25T00:00:00.000Z"');
    expect(block).toContain('Use &lt;tags&gt; &amp; &quot;quotes&quot;');
    expect(block).toContain('</context_summary>');
  });

  it('calls Haiku with the expected model', async () => {
    const anthropic = createAnthropicMock();
    const compressor = new ContextCompressor(anthropic);

    await compressor.compress([
      { sender: 'user', content: 'old context' },
      { sender: 'assistant', content: 'new context' },
    ]);

    expect(anthropic.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-haiku-4-5-20251001',
      }),
    );
  });
});
