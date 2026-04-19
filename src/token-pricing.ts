// Cost per 1M tokens in USD
export const MODEL_PRICING: Record<
  string,
  {
    inputPer1M: number;
    outputPer1M: number;
    cacheReadPer1M?: number;
    cacheWritePer1M?: number;
  }
> = {
  'claude-opus-4-6': {
    inputPer1M: 15.0,
    outputPer1M: 75.0,
    cacheReadPer1M: 1.5,
    cacheWritePer1M: 18.75,
  },
  'claude-sonnet-4-6': {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheReadPer1M: 0.3,
    cacheWritePer1M: 3.75,
  },
  'claude-haiku-4-5': {
    inputPer1M: 0.8,
    outputPer1M: 4.0,
    cacheReadPer1M: 0.08,
    cacheWritePer1M: 1.0,
  },
};

export function computeCostUsd(params: {
  model: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): number | undefined {
  const pricing = MODEL_PRICING[params.model];
  if (!pricing) return undefined;

  const inputCost = (params.promptTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost =
    (params.completionTokens / 1_000_000) * pricing.outputPer1M;
  const cacheRead = pricing.cacheReadPer1M
    ? ((params.cacheReadTokens ?? 0) / 1_000_000) * pricing.cacheReadPer1M
    : 0;
  const cacheWrite = pricing.cacheWritePer1M
    ? ((params.cacheWriteTokens ?? 0) / 1_000_000) * pricing.cacheWritePer1M
    : 0;

  return inputCost + outputCost + cacheRead + cacheWrite;
}
