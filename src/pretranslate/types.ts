import type { EngineName, SemanticHint } from "../core/types.js";

export interface RuntimeTextCandidate {
  engine: EngineName;
  source: string;
  semanticHint: SemanticHint;
  file: string;
  path: string;
  context: Record<string, unknown>;
  commandCode?: number;
  fieldName?: string;
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
