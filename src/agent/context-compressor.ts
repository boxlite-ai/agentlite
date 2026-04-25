import Anthropic from '@anthropic-ai/sdk';
import type { TextBlock } from '@anthropic-ai/sdk/resources/messages';

export interface CompressResult {
  summary: string;
  messagesCompressed: number;
  messagesKept: number;
}

export interface CompressMessage {
  role?: string;
  sender?: string;
  content: string;
}

export type FormattedMessage = CompressMessage;

function isTextBlock(block: { type: string }): block is TextBlock {
  return block.type === 'text' && 'text' in block;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export class ContextCompressor {
  private static readonly THRESHOLD = 0.8;
  private static readonly KEEP_RATIO = 0.2;

  constructor(private anthropic?: Anthropic) {}

  needsCompression(utilization: number | null): boolean {
    return utilization !== null && utilization >= ContextCompressor.THRESHOLD;
  }

  async compress(messages: CompressMessage[]): Promise<CompressResult> {
    if (messages.length === 0) {
      return { summary: '', messagesCompressed: 0, messagesKept: 0 };
    }

    const keepCount = Math.max(
      1,
      Math.floor(messages.length * ContextCompressor.KEEP_RATIO),
    );
    const toSummarize = messages.slice(0, messages.length - keepCount);
    const summary =
      toSummarize.length > 0 ? await this.callHaiku(toSummarize) : '';

    return {
      summary,
      messagesCompressed: toSummarize.length,
      messagesKept: keepCount,
    };
  }

  formatSummaryBlock(
    summary: string,
    compressedAt: string = new Date().toISOString(),
  ): string {
    return `<context_summary type="compressed" compressed_at="${escapeXml(compressedAt)}">\nEarlier conversation summary (auto-generated):\n${escapeXml(summary)}\n</context_summary>`;
  }

  buildSummaryBlock(summary: string): string {
    return this.formatSummaryBlock(summary);
  }

  private getAnthropic(): Anthropic {
    if (!this.anthropic) {
      this.anthropic = new Anthropic();
    }
    return this.anthropic;
  }

  private async callHaiku(messages: CompressMessage[]): Promise<string> {
    const transcript = messages
      .map(
        (message) =>
          `[${message.role ?? message.sender ?? 'unknown'}]: ${message.content}`,
      )
      .join('\n');
    const anthropic = this.getAnthropic();
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Summarize this conversation compactly, preserving key facts, decisions, and context:\n\n${transcript}`,
        },
      ],
    });

    const textBlock = response.content.find(isTextBlock);

    if (!textBlock) {
      throw new Error(
        'Anthropic summary response did not include a text block',
      );
    }

    return textBlock.text;
  }
}
