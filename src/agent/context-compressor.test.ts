import { ContextCompressor, FormattedMessage } from './context-compressor';
import Anthropic from '@anthropic-ai/sdk';

describe('ContextCompressor', () => {
  let compressor: ContextCompressor;
  let mockAnthropic: jest.Mocked<Anthropic>;

  beforeEach(() => {
    mockAnthropic = {
      messages: {
        create: jest.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'Summary of conversation' }],
        }),
      },
    } as unknown as jest.Mocked<Anthropic>;
    compressor = new ContextCompressor(mockAnthropic);
  });

  describe('needsCompression', () => {
    it('returns false for null utilization', () => {
      expect(compressor.needsCompression(null)).toBe(false);
    });

    it('returns false below threshold', () => {
      expect(compressor.needsCompression(0.79)).toBe(false);
    });

    it('returns true at threshold', () => {
      expect(compressor.needsCompression(0.8)).toBe(true);
    });

    it('returns true above threshold', () => {
      expect(compressor.needsCompression(0.95)).toBe(true);
    });
  });

  describe('compress', () => {
    it('keeps 20% of messages verbatim', async () => {
      const messages: FormattedMessage[] = Array.from(
        { length: 10 },
        (_, i) => ({
          sender: 'user',
          content: `message ${i}`,
        }),
      );
      const result = await compressor.compress(messages);
      expect(result.messagesKept).toBe(2);
      expect(result.messagesCompressed).toBe(8);
      expect(result.summary).toBe('Summary of conversation');
    });

    it('always keeps at least 1 message', async () => {
      const messages: FormattedMessage[] = [
        { sender: 'user', content: 'only message' },
      ];
      const result = await compressor.compress(messages);
      expect(result.messagesKept).toBe(1);
      expect(result.messagesCompressed).toBe(0);
    });
  });
});
