import fs from "node:fs";
import path from "node:path";
import type { EligibilityResult, Issue, RuntimeProfile, TranslationUnit } from "../core/types.js";
import { protectPlaceholders, restorePlaceholders, validatePlaceholders } from "../extractors/placeholders.js";
import { evaluateRuntimeText } from "../runtime/eligibility.js";
import {
  ensureRuntimeDirs,
  hexEncode,
  makeRuntimeCacheEntry,
  mergeRuntimeCacheAtomic,
  normalizeRuntimeText,
  parseRuntimeRequestLine,
  placeholderSignature,
  readRuntimeCache,
  runtimeCachePath,
  runtimeRoot,
  runtimeSurfaceKey,
  runtimeTextKey,
  type RuntimeCacheEntry,
  type RuntimeTextRequest
} from "../runtime/protocol.js";
import { buildTokenBatches, estimateTextTokens } from "../translation/batching.js";
import { createProvider } from "../translation/providers.js";
import { builtInRuntimeTranslation } from "../runtime/watch.js";
import { collectMvMzCandidates } from "./mvmzCandidates.js";
import { collectRenpyCandidates } from "./renpyCandidates.js";
import { collectRgssCandidates } from "./rgssCandidates.js";
import { collectTyranoCandidates } from "./tyranoCandidates.js";
import type { PretranslateCandidateManifestRecord, PretranslateEstimate, PretranslateEstimateOptions, PretranslateOptions, PretranslateProgress, PretranslateResult, RuntimeTextCandidate } from "./types.js";

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_CONCURRENCY = 100;
const MAX_CONCURRENCY = 100;
const SYSTEM_PROMPT_TOKENS = 120;
const BATCH_PAYLOAD_OVERHEAD_TOKENS = 48;
const UNIT_METADATA_TOKENS = 38;
const OUTPUT_BATCH_OVERHEAD_TOKENS = 16;
const OUTPUT_UNIT_JSON_TOKENS = 28;

type PretranslateInput = { candidate: RuntimeTextCandidate; request: RuntimeTextRequest; unit: TranslationUnit };
type SkipReasonRecord = {
  phase: "pretranslate" | "runtime";
  textKey: string;
  sourceHex: string;
  action: "translate" | "review";
  reason: string;
  category: EligibilityResult["category"] | "review";
  file?: string;
  path?: string;
  hook?: string;
  createdAt: string;
};

export function estimatePretranslateRuntime(profile: RuntimeProfile, options: PretranslateEstimateOptions = {}): PretranslateEstimate {
  const mode = options.mode || "safe";
  if (mode !== "safe") throw new Error(`Unsupported pretranslate mode: ${mode}`);
  const batchSize = positiveInt(options.batchSize, DEFAULT_BATCH_SIZE);
  const overwrite = Boolean(options.overwrite);
  const issues: Issue[] = [];
  const rawCandidates = [...collectCandidates(profile, issues), ...collectRuntimeMissCandidates(profile)];
  const unique = new Map<string, PretranslateInput>();
  let skippedUnsafe = 0;

  for (const candidate of rawCandidates) {
    const request = requestFromCandidate(profile, candidate);
    const action = candidate.action || "translate";
    const eligibility = evaluateRuntimeText(candidate.source, profile.targetLang);
    if (action === "review" || !eligibility.ok) {
      skippedUnsafe++;
      continue;
    }
    if (unique.has(request.textKey)) continue;
    unique.set(request.textKey, {
      candidate,
      request,
      unit: unitFromCandidate(candidate, request)
    });
  }

  const cache = readRuntimeCache(runtimeCachePath(profile.outputRoot));
  const providerInputs: PretranslateInput[] = [];
  let skippedCached = 0;
  let builtIn = 0;
  for (const item of unique.values()) {
    if (!overwrite && cache.has(item.request.textKey)) {
      skippedCached++;
      continue;
    }
    if (builtInRuntimeTranslation(item.request.source, profile.targetLang) !== undefined) {
      builtIn++;
      continue;
    }
    providerInputs.push(item);
  }

  const batches = buildTokenBatches(providerInputs, {
    maxItems: batchSize,
    estimateTokens: item => estimateTextTokens(item.unit.protectedSource)
  });
  let estimatedInputTokens = 0;
  let estimatedOutputTokens = 0;
  for (const batch of batches) {
    estimatedInputTokens += estimateBatchInputTokens(batch);
    estimatedOutputTokens += estimateBatchOutputTokens(batch);
  }
  const inputTokenPricePerMillion = positiveNumber(options.inputTokenPricePerMillion, 0);
  const outputTokenPricePerMillion = positiveNumber(options.outputTokenPricePerMillion, 0);
  const estimatedInputCost = costForTokens(estimatedInputTokens, inputTokenPricePerMillion);
  const estimatedOutputCost = costForTokens(estimatedOutputTokens, outputTokenPricePerMillion);

  return {
    scanned: rawCandidates.length,
    candidates: unique.size,
    queued: providerInputs.length,
    skippedCached,
    skippedUnsafe,
    builtIn,
    batchesTotal: batches.length,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
    inputTokenPricePerMillion,
    outputTokenPricePerMillion,
    estimatedInputCost,
    estimatedOutputCost,
    estimatedTotalCost: estimatedInputCost + estimatedOutputCost
  };
}

export async function pretranslateRuntime(profile: RuntimeProfile, providerName: string, options: PretranslateOptions = {}): Promise<PretranslateResult> {
  const mode = options.mode || "safe";
  const batchSize = positiveInt(options.batchSize, DEFAULT_BATCH_SIZE);
  const concurrency = Math.min(positiveInt(options.concurrency, DEFAULT_CONCURRENCY), MAX_CONCURRENCY);
  const overwrite = Boolean(options.overwrite);
  const issues: Issue[] = [];
  let scanned = 0;
  let candidates = 0;
  let queued = 0;
  let translated = 0;
  let skippedCached = 0;
  let skippedUnsafe = 0;
  let batchesTotal = 0;
  let batchesCompleted = 0;
  let inFlight = 0;
  const emit = (phase: PretranslateProgress["phase"], message: string): void => {
    const progress = progressSnapshot({
      phase,
      scanned,
      candidates,
      queued,
      translated,
      skippedCached,
      skippedUnsafe,
      issues,
      batchSize,
      concurrency,
      batchesTotal,
      batchesCompleted,
      inFlight,
      message
    });
    writePretranslateProgress(profile, progress);
    try {
      options.onProgress?.(progress);
    } catch {
      // Progress callbacks must not interrupt translation.
    }
  };

  ensureRuntimeDirs(profile.outputRoot);
  if (mode !== "safe") {
    issues.push(issue("pretranslate_mode_unsupported", "fatal", `Unsupported pretranslate mode: ${mode}`));
    emit("done", `Unsupported pretranslate mode: ${mode}`);
    return { scanned, candidates, translated, skippedCached, skippedUnsafe, issues };
  }

  emit("scan", "Scanning static and runtime-miss text candidates.");
  const rawCandidates = [...collectCandidates(profile, issues), ...collectRuntimeMissCandidates(profile)];
  scanned = rawCandidates.length;
  writePretranslateCandidateManifest(profile, buildCandidateManifest(profile, rawCandidates));
  emit("prepare", `Scanned ${scanned} raw candidates; deduplicating and filtering.`);

  const unique = new Map<string, PretranslateInput>();
  const skipReasons: SkipReasonRecord[] = [];
  for (const candidate of rawCandidates) {
    const request = requestFromCandidate(profile, candidate);
    const action = candidate.action || "translate";
    const eligibility = evaluateRuntimeText(candidate.source, profile.targetLang);
    if (action === "review" || !eligibility.ok) {
      skippedUnsafe++;
      skipReasons.push({
        phase: "pretranslate",
        textKey: request.textKey,
        sourceHex: request.sourceHex,
        action,
        reason: action === "review" ? "review-only candidate" : eligibility.reason,
        category: action === "review" ? "review" : eligibility.category,
        file: candidate.file,
        path: candidate.path,
        createdAt: new Date().toISOString()
      });
      continue;
    }
    if (unique.has(request.textKey)) continue;
    unique.set(request.textKey, {
      candidate,
      request,
      unit: unitFromCandidate(candidate, request)
    });
  }
  appendSkipReasons(profile.outputRoot, skipReasons);
  candidates = unique.size;

  const cacheFile = runtimeCachePath(profile.outputRoot);
  const cache = readRuntimeCache(cacheFile);
  const providerInputs: PretranslateInput[] = [];
  const builtInEntries: RuntimeCacheEntry[] = [];

  for (const item of unique.values()) {
    if (!overwrite && cache.has(item.request.textKey)) {
      skippedCached++;
      continue;
    }
    const builtIn = builtInRuntimeTranslation(item.request.source, profile.targetLang);
    if (builtIn !== undefined) {
      builtInEntries.push(makeRuntimeCacheEntry(item.request, builtIn, "builtin"));
      continue;
    }
    providerInputs.push(item);
  }
  const builtInFlush = flushCacheEntries(cacheFile, builtInEntries, overwrite);
  translated += builtInFlush.written;
  skippedCached += builtInFlush.skippedCached;
  queued = providerInputs.length;
  emit("prepare", `Prepared ${candidates} unique candidates; skipped ${skippedCached} cached and ${skippedUnsafe} unsafe/review candidates; queued ${queued} provider items.`);

  const batches = buildTokenBatches(providerInputs, {
    maxItems: batchSize,
    estimateTokens: item => estimateTextTokens(item.unit.protectedSource)
  });
  batchesTotal = batches.length;
  if (batches.length > 0) {
    const provider = createProvider(providerName);
    const retryInputs: PretranslateInput[] = [];
    let nextBatch = 0;
    emit("translate", `Starting provider translation for ${queued} items in ${batchesTotal} estimated-token batches.`);
    const heartbeat = setInterval(() => {
      emit("translate", `Provider translation in progress: ${batchesCompleted}/${batchesTotal} batches, ${inFlight} active, ${translated} written.`);
    }, 5000);
    try {
      const workerCount = Math.min(concurrency, batches.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (true) {
          const batchIndex = nextBatch++;
          if (batchIndex >= batches.length) return;
          const batch = batches[batchIndex];
          inFlight++;
          try {
            const result = await provider.translateBatch({
              requestId: `${profile.projectId}-pretranslate-${Date.now()}-${batchIndex}`,
              units: batch.map(item => item.unit),
              targetLang: profile.targetLang
            });
            const entries = entriesFromProviderResult(batch, result.translations, provider.name, retryInputs, issues, false);
            const flushed = flushCacheEntries(cacheFile, entries, overwrite);
            translated += flushed.written;
            skippedCached += flushed.skippedCached;
          } catch (error) {
            issues.push(issue("pretranslate_provider_failed", "error", error instanceof Error ? error.message : String(error), { batchIndex, batchSize: batch.length }));
          } finally {
            inFlight--;
            batchesCompleted++;
            emit("translate", `Completed batch ${batchesCompleted}/${batchesTotal}; ${translated} written, ${issues.length} issues.`);
          }
        }
      }));
    } finally {
      clearInterval(heartbeat);
    }

    if (retryInputs.length > 0) {
      emit("translate", `Retrying ${retryInputs.length} placeholder validation failures as single-item requests.`);
      for (let index = 0; index < retryInputs.length; index++) {
        const item = retryInputs[index];
        try {
          const result = await provider.translateBatch({
            requestId: `${profile.projectId}-pretranslate-placeholder-retry-${Date.now()}-${index}`,
            units: [item.unit],
            targetLang: profile.targetLang,
            placeholderRetry: true
          });
          const entries = entriesFromProviderResult([item], result.translations, provider.name, [], issues, true);
          const flushed = flushCacheEntries(cacheFile, entries, overwrite);
          translated += flushed.written;
          skippedCached += flushed.skippedCached;
        } catch (error) {
          issues.push(issue("pretranslate_placeholder_retry_failed", "error", error instanceof Error ? error.message : String(error), item.candidate));
        }
      }
    }
  }

  const result = {
    scanned,
    candidates,
    translated,
    skippedCached,
    skippedUnsafe,
    issues
  };
  emit("done", `Pretranslate complete: scanned ${scanned}, candidates ${candidates}, written ${translated}, skipped ${skippedCached + skippedUnsafe}, issues ${issues.length}.`);
  return result;
}

function entriesFromProviderResult(
  batch: PretranslateInput[],
  translations: Array<{ unitId: string; target: string }>,
  providerName: string,
  retryInputs: PretranslateInput[],
  issues: Issue[],
  retry: boolean
): RuntimeCacheEntry[] {
  const entries: RuntimeCacheEntry[] = [];
  const byId = new Map(translations.map(item => [item.unitId, item.target]));
  for (const item of batch) {
    const target = byId.get(item.request.textKey);
    if (!target) {
      issues.push(issue("pretranslate_provider_missing_unit", "error", `Provider omitted pretranslate text ${item.request.textKey}`, item.candidate));
      continue;
    }
    const placeholderCheck = validatePlaceholders(target, item.unit.placeholders);
    if (!placeholderCheck.ok) {
      if (!retry) retryInputs.push(item);
      else issues.push(issue("pretranslate_placeholder_mismatch", "fatal", placeholderCheck.message, { candidate: item.candidate, target }));
      continue;
    }
    const restored = restorePlaceholders(target, item.unit.placeholders);
    entries.push(makeRuntimeCacheEntry(item.request, restored, providerName));
  }
  return entries;
}

function collectCandidates(profile: RuntimeProfile, issues: Issue[]): RuntimeTextCandidate[] {
  try {
    if (profile.engine.name === "MV" || profile.engine.name === "MZ") return collectMvMzCandidates(profile);
    if (profile.engine.name === "XP" || profile.engine.name === "VX" || profile.engine.name === "VXA") return collectRgssCandidates(profile);
    if (profile.engine.name === "RENPY") return collectRenpyCandidates(profile, issues);
    if (profile.engine.name === "TYRANO") return collectTyranoCandidates(profile);
    issues.push(issue("pretranslate_engine_unsupported", "fatal", `Pretranslate does not support ${profile.engine.name}.`));
    return [];
  } catch (error) {
    issues.push(issue("pretranslate_collect_failed", "fatal", error instanceof Error ? error.message : String(error)));
    return [];
  }
}

function collectRuntimeMissCandidates(profile: RuntimeProfile): RuntimeTextCandidate[] {
  const requestDir = path.join(runtimeRoot(profile.outputRoot), "requests");
  if (!fs.existsSync(requestDir)) return [];
  const out: RuntimeTextCandidate[] = [];
  for (const name of fs.readdirSync(requestDir).filter(item => item.endsWith(".rtlog")).sort()) {
    const file = path.join(requestDir, name);
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const request = parseRuntimeRequestLine(line);
      if (!request) continue;
      out.push({
        engine: request.engine,
        source: request.source,
        semanticHint: request.hook === "message" ? "dialogue" : request.hook.includes("choice") ? "choice" : "unknown",
        file: normalizeRuntimeText(path.join("RPGMTransRuntime", "requests", name)).replace(/\\/g, "/"),
        path: request.surfaceKey,
        fieldName: request.hook,
        action: "translate",
        context: {
          origin: "runtime_miss",
          hook: request.hook,
          scene: request.scene,
          window: request.window,
          width: request.width,
          align: request.align
        }
      });
    }
  }
  return out;
}

function requestFromCandidate(profile: RuntimeProfile, candidate: RuntimeTextCandidate): RuntimeTextRequest {
  const textKey = runtimeTextKey(profile.engine.name, profile.targetLang, candidate.source);
  const surfaceKey = runtimeSurfaceKey({
    engine: profile.engine.name,
    targetLang: profile.targetLang,
    source: candidate.source,
    hook: "pretranslate",
    scene: "",
    window: "",
    width: "",
    align: ""
  });
  return {
    version: "1",
    engine: profile.engine.name,
    targetLang: profile.targetLang,
    textKey,
    surfaceKey,
    hook: "pretranslate",
    scene: "",
    window: "",
    width: "",
    align: "",
    source: candidate.source,
    sourceHex: hexEncode(candidate.source),
    normalizedSource: normalizeRuntimeText(candidate.source),
    placeholderSignature: placeholderSignature(normalizeRuntimeText(candidate.source)),
    createdAt: new Date().toISOString()
  };
}

function unitFromCandidate(candidate: RuntimeTextCandidate, request: RuntimeTextRequest): TranslationUnit {
  const protectedSet = protectPlaceholders(candidate.source);
  return {
    unitId: request.textKey,
    engine: request.engine,
    file: candidate.file,
    path: candidate.path,
    pathJson: { file: candidate.file, path: candidate.path, pretranslate: true },
    source: candidate.source,
    protectedSource: protectedSet.protected,
    placeholders: protectedSet.placeholders,
    action: "AUTO",
    semanticHint: candidate.semanticHint,
    status: "planned",
    sourceHash: request.textKey,
    context: candidate.context,
    commandCode: candidate.commandCode,
    fieldName: candidate.fieldName
  };
}

function buildCandidateManifest(profile: RuntimeProfile, rawCandidates: RuntimeTextCandidate[]): PretranslateCandidateManifestRecord[] {
  const records = new Map<string, PretranslateCandidateManifestRecord>();
  for (const candidate of rawCandidates) {
    const request = requestFromCandidate(profile, candidate);
    const action = candidate.action || "translate";
    const eligibility = evaluateRuntimeText(candidate.source, profile.targetLang);
    const existing = records.get(request.textKey);
    const occurrence = {
      file: candidate.file,
      path: candidate.path,
      semanticHint: candidate.semanticHint,
      fieldName: candidate.fieldName,
      commandCode: candidate.commandCode,
      action,
      eligibility
    };
    if (existing) {
      existing.count++;
      existing.occurrences.push(occurrence);
      if (action === "translate") existing.action = "translate";
      continue;
    }
    records.set(request.textKey, {
      textKey: request.textKey,
      sourceHex: request.sourceHex,
      normalizedSource: request.normalizedSource,
      count: 1,
      action,
      occurrences: [occurrence]
    });
  }
  return [...records.values()].sort((a, b) => a.textKey.localeCompare(b.textKey));
}

function writePretranslateCandidateManifest(profile: RuntimeProfile, records: PretranslateCandidateManifestRecord[]): void {
  const file = path.join(runtimeRoot(profile.outputRoot), "cache", "pretranslate-candidates.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), "utf8");
}

function appendSkipReasons(outputRoot: string, records: SkipReasonRecord[]): void {
  if (!records.length) return;
  const file = path.join(runtimeRoot(outputRoot), "diag", "skip-reasons.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

function flushCacheEntries(cacheFile: string, entries: RuntimeCacheEntry[], overwrite: boolean): { written: number; skippedCached: number } {
  return mergeRuntimeCacheAtomic(cacheFile, entries, { overwrite });
}

function estimateBatchInputTokens(batch: PretranslateInput[]): number {
  return SYSTEM_PROMPT_TOKENS
    + BATCH_PAYLOAD_OVERHEAD_TOKENS
    + batch.reduce((sum, item) => sum + UNIT_METADATA_TOKENS + estimateTextTokens(item.unit.protectedSource), 0);
}

function estimateBatchOutputTokens(batch: PretranslateInput[]): number {
  return OUTPUT_BATCH_OVERHEAD_TOKENS
    + batch.reduce((sum, item) => sum + OUTPUT_UNIT_JSON_TOKENS + Math.ceil(estimateTextTokens(item.unit.protectedSource) * 1.25), 0);
}

function costForTokens(tokens: number, pricePerMillion: number): number {
  return Math.round((tokens / 1_000_000) * pricePerMillion * 1_000_000) / 1_000_000;
}

function progressSnapshot(input: Omit<PretranslateProgress, "fatal" | "errors" | "issues" | "updatedAt"> & { issues: Issue[] }): PretranslateProgress {
  return {
    ...input,
    issues: input.issues.length,
    fatal: input.issues.filter(item => item.severity === "fatal").length,
    errors: input.issues.filter(item => item.severity === "error").length,
    updatedAt: new Date().toISOString()
  };
}

function writePretranslateProgress(profile: RuntimeProfile, progress: PretranslateProgress): void {
  const sidecar = path.join(runtimeRoot(profile.outputRoot), "cache", "pretranslate.json");
  const temp = `${sidecar}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(sidecar), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
    fs.renameSync(temp, sidecar);
  } catch {
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch {
      // Progress sidecars are best-effort and must not interrupt translation.
    }
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.floor(value));
}

function positiveNumber(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(0, value);
}

function issue(type: string, severity: Issue["severity"], message: string, payload?: unknown): Issue {
  return {
    issueId: `${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    severity,
    message,
    payload,
    createdAt: new Date().toISOString()
  };
}
