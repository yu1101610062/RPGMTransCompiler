import type { EngineName, PretranslateOccurrence, SemanticHint } from "../core/types.js";

export interface RuntimeTextCandidate {
  engine: EngineName;
  source: string;
  semanticHint: SemanticHint;
  file: string;
  path: string;
  context: Record<string, unknown>;
  action?: "translate" | "review";
  commandCode?: number;
  fieldName?: string;
}

export interface PretranslateCandidateManifestRecord {
  textKey: string;
  sourceHex: string;
  normalizedSource: string;
  count: number;
  action: "translate" | "review";
  occurrences: PretranslateOccurrence[];
}

export interface PretranslateOptions {
  mode?: "safe";
  batchSize?: number;
  concurrency?: number;
  overwrite?: boolean;
  onProgress?: (progress: PretranslateProgress) => void;
}

export interface PretranslateResult {
  scanned: number;
  candidates: number;
  translated: number;
  skippedCached: number;
  skippedUnsafe: number;
  issues: import("../core/types.js").Issue[];
}

export interface PretranslateEstimateOptions {
  mode?: "safe";
  batchSize?: number;
  overwrite?: boolean;
  inputTokenPricePerMillion?: number;
  outputTokenPricePerMillion?: number;
}

export interface PretranslateEstimate {
  scanned: number;
  candidates: number;
  queued: number;
  skippedCached: number;
  skippedUnsafe: number;
  builtIn: number;
  batchesTotal: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  inputTokenPricePerMillion: number;
  outputTokenPricePerMillion: number;
  estimatedInputCost: number;
  estimatedOutputCost: number;
  estimatedTotalCost: number;
}

export interface PretranslateProgress {
  phase: "scan" | "prepare" | "translate" | "done";
  scanned: number;
  candidates: number;
  queued: number;
  translated: number;
  skippedCached: number;
  skippedUnsafe: number;
  issues: number;
  fatal: number;
  errors: number;
  batchSize: number;
  concurrency: number;
  batchesTotal: number;
  batchesCompleted: number;
  inFlight: number;
  message: string;
  updatedAt: string;
}
