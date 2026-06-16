export interface BatchByTokenOptions<T> {
  maxItems: number;
  maxEstimatedTokens?: number;
  estimateTokens: (item: T) => number;
}

const DEFAULT_MAX_ESTIMATED_TOKENS = 6000;

export function buildTokenBatches<T>(items: T[], options: BatchByTokenOptions<T>): T[][] {
  const maxItems = Math.max(1, Math.floor(options.maxItems));
  const maxEstimatedTokens = Math.max(256, Math.floor(options.maxEstimatedTokens ?? DEFAULT_MAX_ESTIMATED_TOKENS));
  const batches: T[][] = [];
  let current: T[] = [];
  let currentTokens = 0;

  for (const item of items) {
    const itemTokens = Math.max(1, Math.ceil(options.estimateTokens(item)));
    if (current.length > 0 && (current.length >= maxItems || currentTokens + itemTokens > maxEstimatedTokens)) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(item);
    currentTokens += itemTokens;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 3) + 16;
}
