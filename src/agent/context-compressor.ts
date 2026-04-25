import Anthropic from '@anthropic-ai/sdk';

export interface FormattedMessage {
  sender: string;
  content: string;
}

export interface CompressResult {
  summary: string;
  messagesCompressed: number;
  messagesKept: number;
}

export class ContextCompressor {
  constructor(private anthropic: Anthropic) {}

  needsCompression(utilization: number | null): boolean {
    return utilization !== null && utilization >= 0.8;
  }

  async compress(messages: FormattedMessage[]): Promise<CompressResult> {
    const keepCount = Math.max(1, Math.floor(messages.length * 0.2));
    const toSummarize = messages.slice(0, messages.length - keepCount);
    const toKeep = messages.slice(messages.length - keepCount);
    const summary = await this.callHaiku(toSummarize);
    return {
      summary,
      messagesCompressed: toSummarize.length,
      messagesKept: toKeep.length,
    };
  }

  private async callHaiku(messages: FormattedMessage[]): Promise<string> {
    const transcript = messages
      .map((m) => `[${m.sender}]: ${m.content}`)
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
    return (response.content[0] as Anthropic.TextBlock).text;
  }
}
