import { ContextCompressor, FormattedMessage } from './context-compressor';

const mockCreate = jest.fn();
const mockAnthropic = { messages: { create: mockCreate } } as any;

describe('ContextCompressor', () => {
  let compressor: ContextCompressor;

  beforeEach(() => {
    compressor = new ContextCompressor(mockAnthropic);
    mockCreate.mockReset();
  });

  describe('needsCompression', () => {
    it('returns false for null', () => {
      expect(compressor.needsCompression(null)).toBe(false);
    });
    it('returns false for 0.79', () => {
      expect(compressor.needsCompression(0.79)).toBe(false);
    });
    it('returns true for 0.80', () => {
      expect(compressor.needsCompression(0.80)).toBe(true);
    });
    it('returns true for 0.85', () => {
      expect(compressor.needsCompression(0.85)).toBe(true);
    });
    it('returns true for 1.0', () => {
      expect(compressor.needsCompression(1.0)).toBe(true);
    });
  });

  describe('compress', () => {
    it('keeps at least 1 message verbatim', async () => {
      mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'summary' }] });
      const msgs: FormattedMessage[] = [{ sender: 'user', content: 'hi' }];
      const result = await compressor.compress(msgs);
      expect(result.messagesKept).toBe(1);
      expect(result.messagesCompressed).toBe(0);
    });
    it('compresses 80% of messages', async () => {
      mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'summary' }] });
      const msgs: FormattedMessage[] = Array.from({ length: 10 }, (_, i) => ({ sender: 'user', content: `msg${i}` }));
      const result = await compressor.compress(msgs);
      expect(result.messagesKept).toBe(2);
      expect(result.messagesCompressed).toBe(8);
      expect(result.summary).toBe('summary');
    });
    it('calls Haiku model', async () => {
      mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'summary' }] });
      const msgs: FormattedMessage[] = Array.from({ length: 5 }, (_, i) => ({ sender: 'user', content: `msg${i}` }));
      await compressor.compress(msgs);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }));
    });
  });
});
