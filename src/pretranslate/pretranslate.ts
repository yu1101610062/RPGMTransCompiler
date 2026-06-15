import fs from "node:fs";
import path from "node:path";
import type { Issue, RuntimeProfile, TranslationUnit } from "../core/types.js";
import { protectPlaceholders, restorePlaceholders, validatePlaceholders } from "../extractors/placeholders.js";
import {
  ensureRuntimeDirs,
  hexEncode,
  makeRuntimeCacheEntry,
  mergeRuntimeCacheAtomic,
  normalizeRuntimeText,
  placeholderSignature,
  readRuntimeCache,
  runtimeCachePath,
  runtimeRoot,
  runtimeSurfaceKey,
  runtimeTextKey,
  type RuntimeCacheEntry,
  type RuntimeTextRequest
} from "../runtime/protocol.js";
import { builtInRuntimeTranslation, shouldTranslateRuntimeText } from "../runtime/watch.js";
import { createProvider } from "../translation/providers.js";
import { collectMvMzCandidates } from "./mvmzCandidates.js";
import { collectRgssCandidates } from "./rgssCandidates.js";
import type { PretranslateOptions, PretranslateProgress, PretranslateResult, RuntimeTextCandidate } from "./types.js";

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_CONCURRENCY = 100;
const MAX_CONCURRENCY = 100;

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
      // 进度回调不能影响翻译流程。
    }
  };

  ensureRuntimeDirs(profile.outputRoot);
  if (mode !== "safe") {
    issues.push(issue("pretranslate_mode_unsupported", "fatal", `Unsupported pretranslate mode: ${mode}`));
    emit("done", `预翻译模式不支持: ${mode}`);
    return { scanned, candidates, translated, skippedCached, skippedUnsafe, issues };
  }

  emit("scan", "开始扫描静态文本候选。");
  const rawCandidates = collectCandidates(profile, issues);
  scanned = rawCandidates.length;
  emit("prepare", `扫描完成：原始候选 ${scanned} 条，开始去重和安全过滤。`);
  const unique = new Map<string, { candidate: RuntimeTextCandidate; request: RuntimeTextRequest; unit: TranslationUnit }>();

  for (const candidate of rawCandidates) {
    if (!shouldTranslateRuntimeText(candidate.source, profile.targetLang)) {
      skippedUnsafe++;
      continue;
    }
    const request = requestFromCandidate(profile, candidate);
    if (unique.has(request.textKey)) continue;
    unique.set(request.textKey, {
      candidate,
      request,
      unit: unitFromCandidate(candidate, request)
    });
  }
  candidates = unique.size;

  const cacheFile = runtimeCachePath(profile.outputRoot);
  const cache = readRuntimeCache(cacheFile);
  const providerInputs: Array<{ candidate: RuntimeTextCandidate; request: RuntimeTextRequest; unit: TranslationUnit }> = [];
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
  emit("prepare", `准备完成：候选 ${candidates} 条，已缓存跳过 ${skippedCached} 条，内置写入 ${builtInFlush.written} 条，待模型翻译 ${queued} 条。`);

  const batches: Array<Array<{ candidate: RuntimeTextCandidate; request: RuntimeTextRequest; unit: TranslationUnit }>> = [];
  for (let offset = 0; offset < providerInputs.length; offset += batchSize) {
    batches.push(providerInputs.slice(offset, offset + batchSize));
  }
  batchesTotal = batches.length;
  if (batches.length > 0) {
    const provider = createProvider(providerName);
    let nextBatch = 0;
    emit("translate", `开始模型翻译：${queued} 条，批大小 ${batchSize}，并发 ${concurrency}。`);
    const heartbeat = setInterval(() => {
      emit("translate", `模型翻译中：批次 ${batchesCompleted}/${batchesTotal}，运行中 ${inFlight}，已写入 ${translated}。`);
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
            const entries: RuntimeCacheEntry[] = [];
            const byId = new Map(result.translations.map(item => [item.unitId, item.target]));
            for (const item of batch) {
              const target = byId.get(item.request.textKey);
              if (!target) {
                issues.push(issue("pretranslate_provider_missing_unit", "error", `Provider omitted pretranslate text ${item.request.textKey}`, item.candidate));
                continue;
              }
              const placeholderCheck = validatePlaceholders(target, item.unit.placeholders);
              if (!placeholderCheck.ok) {
                issues.push(issue("pretranslate_placeholder_mismatch", "fatal", placeholderCheck.message, { candidate: item.candidate, target }));
                continue;
              }
              const restored = restorePlaceholders(target, item.unit.placeholders);
              entries.push(makeRuntimeCacheEntry(item.request, restored, provider.name));
            }
            const flushed = flushCacheEntries(cacheFile, entries, overwrite);
            translated += flushed.written;
            skippedCached += flushed.skippedCached;
          } catch (error) {
            issues.push(issue("pretranslate_provider_failed", "error", error instanceof Error ? error.message : String(error), { batchIndex, batchSize: batch.length }));
          } finally {
            inFlight--;
            batchesCompleted++;
            emit("translate", `批次 ${batchesCompleted}/${batchesTotal} 完成，已写入 ${translated}，问题 ${issues.length}。`);
          }
        }
      }));
    } finally {
      clearInterval(heartbeat);
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
  emit("done", `预翻译完成：扫描 ${scanned}，候选 ${candidates}，写入 ${translated}，跳过 ${skippedCached + skippedUnsafe}，问题 ${issues.length}。`);
  return result;
}

function collectCandidates(profile: RuntimeProfile, issues: Issue[]): RuntimeTextCandidate[] {
  try {
    if (profile.engine.name === "MV" || profile.engine.name === "MZ") return collectMvMzCandidates(profile);
    if (profile.engine.name === "XP" || profile.engine.name === "VX" || profile.engine.name === "VXA") return collectRgssCandidates(profile);
    issues.push(issue("pretranslate_engine_unsupported", "fatal", `Pretranslate does not support ${profile.engine.name}.`));
    return [];
  } catch (error) {
    issues.push(issue("pretranslate_collect_failed", "fatal", error instanceof Error ? error.message : String(error)));
    return [];
  }
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

function flushCacheEntries(cacheFile: string, entries: RuntimeCacheEntry[], overwrite: boolean): { written: number; skippedCached: number } {
  return mergeRuntimeCacheAtomic(cacheFile, entries, { overwrite });
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
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  fs.writeFileSync(sidecar, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.floor(value));
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
