import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ContextCompressor,
  type FormattedMessage,
} from './context-compressor.js';

const mockAnthropic = {
  messages: {
    create: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Mock summary of conversation.' }],
    }),
  },
} as any;

describe('ContextCompressor', () => {
  let compressor: ContextCompressor;

  beforeEach(() => {
    vi.clearAllMocks();
    compressor = new ContextCompressor(mockAnthropic);
  });

  describe('needsCompression', () => {
    it('returns false when utilization is null', () => {
      expect(compressor.needsCompression(null)).toBe(false);
    });
    it('returns false when utilization is below 0.80', () => {
      expect(compressor.needsCompression(0.79)).toBe(false);
    });
    it('returns true when utilization is exactly 0.80', () => {
      expect(compressor.needsCompression(0.8)).toBe(true);
    });
    it('returns true when utilization is above 0.80', () => {
      expect(compressor.needsCompression(0.85)).toBe(true);
    });
  });

  describe('compress', () => {
    it('returns empty result for empty messages', async () => {
      const result = await compressor.compress([]);
      expect(result).toEqual({
        summary: '',
        messagesCompressed: 0,
        messagesKept: 0,
      });
    });

    it('keeps at least 1 message verbatim', async () => {
      const messages: FormattedMessage[] = [
        { sender: 'user', content: 'hello' },
      ];
      const result = await compressor.compress(messages);
      expect(result.messagesKept).toBeGreaterThanOrEqual(1);
    });

    it('compresses and keeps correct counts for 10 messages', async () => {
      const messages: FormattedMessage[] = Array.from(
        { length: 10 },
        (_, i) => ({
          sender: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i}`,
        }),
      );
      const result = await compressor.compress(messages);
      expect(result.messagesKept).toBe(2); // 20% of 10
      expect(result.messagesCompressed).toBe(8);
      expect(result.summary).toBe('Mock summary of conversation.');
    });

    it('calls haiku model for summarization', async () => {
      const messages: FormattedMessage[] = Array.from(
        { length: 5 },
        (_, i) => ({
          sender: 'user',
          content: `msg ${i}`,
        }),
      );
      await compressor.compress(messages);
      expect(mockAnthropic.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
      );
    });
  });
});
