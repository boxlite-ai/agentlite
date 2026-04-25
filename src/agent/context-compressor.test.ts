import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextCompressor, CompressMessage } from './context-compressor';

const mockCreate = vi.fn();
const mockAnthropic = { messages: { create: mockCreate } } as any;

describe('ContextCompressor', () => {
  let compressor: ContextCompressor;

  beforeEach(() => {
    compressor = new ContextCompressor(mockAnthropic);
    mockCreate.mockClear();
  });

  describe('needsCompression', () => {
    it('returns false for null', () => {
      expect(compressor.needsCompression(null)).toBe(false);
    });

    it('returns false below threshold', () => {
      expect(compressor.needsCompression(0.79)).toBe(false);
    });

    it('returns true at exactly 0.80', () => {
      expect(compressor.needsCompression(0.8)).toBe(true);
    });

    it('returns true above threshold', () => {
      expect(compressor.needsCompression(0.95)).toBe(true);
    });
  });

  describe('compress', () => {
    const makeMessages = (n: number): CompressMessage[] =>
      Array.from({ length: n }, (_, i) => ({
        role: 'user',
        content: `msg ${i}`,
      }));

    beforeEach(() => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Summary text' }],
      });
    });

    it('keeps at least 1 message', async () => {
      const result = await compressor.compress(makeMessages(1));
      expect(result.messagesKept).toBeGreaterThanOrEqual(1);
    });

    it('returns correct counts for 10 messages', async () => {
      const result = await compressor.compress(makeMessages(10));
      expect(result.messagesCompressed + result.messagesKept).toBe(10);
      expect(result.messagesKept).toBe(2); // 20% of 10
      expect(result.messagesCompressed).toBe(8);
    });

    it('returns summary from Haiku', async () => {
      const result = await compressor.compress(makeMessages(5));
      expect(result.summary).toBe('Summary text');
    });

    it('calls Haiku with correct model', async () => {
      await compressor.compress(makeMessages(5));
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
      );
    });
  });
});
