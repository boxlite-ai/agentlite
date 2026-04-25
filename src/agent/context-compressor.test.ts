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

describe('ContextCompressor', () => {
  it('needsCompression uses the 80% threshold', () => {
    const compressor = new ContextCompressor({} as Anthropic);

    expect(compressor.needsCompression(null)).toBe(false);
    expect(compressor.needsCompression(0.79)).toBe(false);
    expect(compressor.needsCompression(0.8)).toBe(true);
    expect(compressor.needsCompression(0.85)).toBe(true);
    expect(compressor.needsCompression(1.0)).toBe(true);
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
});
