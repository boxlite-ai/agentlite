import Anthropic from '@anthropic-ai/sdk';

export interface CompressMessage {
  role: string;
  content: string;
}

export interface CompressResult {
  summary: string;
  messagesCompressed: number;
  messagesKept: number;
}

export class ContextCompressor {
  private static readonly THRESHOLD = 0.8;
  private static readonly KEEP_RATIO = 0.2;

  constructor(private anthropic: Anthropic) {}

  needsCompression(utilization: number | null): boolean {
    return utilization !== null && utilization >= ContextCompressor.THRESHOLD;
  }

  async compress(messages: CompressMessage[]): Promise<CompressResult> {
    const keepCount = Math.max(
      1,
      Math.floor(messages.length * ContextCompressor.KEEP_RATIO),
    );
    const toSummarize = messages.slice(0, messages.length - keepCount);
    const kept = messages.slice(messages.length - keepCount);
    const summary = await this.callHaiku(toSummarize);
    return {
      summary,
      messagesCompressed: toSummarize.length,
      messagesKept: kept.length,
    };
  }

  private async callHaiku(messages: CompressMessage[]): Promise<string> {
    const transcript = messages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join('\n');
    const response = await this.anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Summarize this conversation compactly, preserving key facts, decisions, and context:\n\n${transcript}`,
        },
      ],
    });
    const block = response.content[0];
    if (block.type !== 'text')
      throw new Error('Unexpected response type from Haiku');
    return block.text;
  }
}
