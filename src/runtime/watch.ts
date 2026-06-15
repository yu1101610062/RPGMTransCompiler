import fs from "node:fs";
import path from "node:path";
import type { Issue, RuntimeProfile } from "../core/types.js";
import { restorePlaceholders, validatePlaceholders } from "../extractors/placeholders.js";
import { createProvider } from "../translation/providers.js";
import {
  makeRuntimeCacheEntry,
  mergeRuntimeCacheAtomic,
  parseRuntimeRequestLine,
  readRuntimeCache,
  requestToUnit,
  runtimeCachePath,
  runtimeRoot,
  type RuntimeCacheEntry,
  type RuntimeTextRequest
} from "./protocol.js";

export interface RuntimeWatchOptions {
  once?: boolean;
  pollMs?: number;
  batchSize?: number;
  concurrency?: number;
  skipTranslated?: boolean;
}

export interface RuntimeWatchResult {
  processed: number;
  translated: number;
  skippedCached: number;
  issues: Issue[];
}

interface CursorState {
  offset: number;
  carry: string;
}

export class RuntimeRequestReader {
  private cursors = new Map<string, CursorState>();

  constructor(private readonly root: string) {}

  readNew(): RuntimeTextRequest[] {
    const requestDir = path.join(runtimeRoot(this.root), "requests");
    if (!fs.existsSync(requestDir)) return [];
    const out: RuntimeTextRequest[] = [];
    for (const file of fs.readdirSync(requestDir).filter(name => name.endsWith(".rtlog")).sort()) {
      const full = path.join(requestDir, file);
      const stat = fs.statSync(full);
      const cursor = this.cursors.get(full) || { offset: 0, carry: "" };
      if (stat.size < cursor.offset) {
        cursor.offset = 0;
        cursor.carry = "";
      }
      if (stat.size === cursor.offset) continue;
      const fd = fs.openSync(full, "r");
      try {
        const length = stat.size - cursor.offset;
        const buffer = Buffer.allocUnsafe(length);
        fs.readSync(fd, buffer, 0, length, cursor.offset);
        let chunk = cursor.carry + buffer.toString("utf8");
        const complete = chunk.endsWith("\n") || chunk.endsWith("\r");
        const lines = chunk.split(/\r?\n/);
        cursor.carry = complete ? "" : (lines.pop() || "");
        chunk = "";
        for (const line of lines) {
          const request = parseRuntimeRequestLine(line);
          if (request) out.push(request);
        }
        cursor.offset = complete ? stat.size : stat.size - Buffer.byteLength(cursor.carry, "utf8");
        this.cursors.set(full, cursor);
      } finally {
        fs.closeSync(fd);
      }
    }
    return out;
  }
}

export async function processRuntimeRequests(
  profile: RuntimeProfile,
  providerName: string,
  reader = new RuntimeRequestReader(profile.outputRoot),
  batchSize = 20,
  concurrency = 1,
  skipTranslated = true
): Promise<RuntimeWatchResult> {
  const requests = reader.readNew();
  const issues: Issue[] = [];
  const cacheFile = runtimeCachePath(profile.outputRoot);
  const cache = readRuntimeCache(cacheFile);
  const pending = new Map<string, RuntimeTextRequest>();
  let skippedCached = 0;

  for (const request of requests) {
    if (!shouldTranslateRuntimeText(request.source, profile.targetLang)) continue;
    const existing = cache.get(request.textKey);
    if (skipTranslated && existing && existing.sourceHex === request.sourceHex) {
      skippedCached++;
      continue;
    }
    if (!pending.has(request.textKey)) pending.set(request.textKey, request);
  }

  const provider = createProvider(providerName);
  let translated = 0;
  const providerRequests: RuntimeTextRequest[] = [];
  const builtInEntries: RuntimeCacheEntry[] = [];
  for (const request of pending.values()) {
    const builtIn = builtInRuntimeTranslation(request.source, profile.targetLang);
    if (builtIn !== undefined) {
      const entry = makeRuntimeCacheEntry(request, builtIn, "builtin");
      cache.set(request.textKey, entry);
      builtInEntries.push(entry);
      translated++;
    } else {
      providerRequests.push(request);
    }
  }
  if (builtInEntries.length > 0) mergeRuntimeCacheAtomic(cacheFile, builtInEntries, { overwrite: !skipTranslated });
  const batches: RuntimeTextRequest[][] = [];
  for (let offset = 0; offset < providerRequests.length; offset += batchSize) {
    batches.push(providerRequests.slice(offset, offset + batchSize));
  }
  let nextBatch = 0;
  const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, batches.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const batchIndex = nextBatch++;
      if (batchIndex >= batches.length) return;
      const batch = batches[batchIndex];
      const units = batch.map(requestToUnit);
      const result = await provider.translateBatch({
        requestId: `${profile.projectId}-runtime-${Date.now()}-${batchIndex}`,
        units,
        targetLang: profile.targetLang
      });
      const batchEntries: RuntimeCacheEntry[] = [];
      const byId = new Map(result.translations.map(item => [item.unitId, item.target]));
      for (const request of batch) {
        const target = byId.get(request.textKey);
        if (!target) {
          issues.push(issue("runtime_provider_missing_unit", "error", `Provider omitted runtime text ${request.textKey}`, request));
          continue;
        }
        const unit = requestToUnit(request);
        const placeholderCheck = validatePlaceholders(target, unit.placeholders);
        if (!placeholderCheck.ok) {
          issues.push(issue("runtime_placeholder_mismatch", "fatal", placeholderCheck.message, { request, target }));
          continue;
        }
        const restored = restorePlaceholders(target, unit.placeholders);
        const entry = makeRuntimeCacheEntry(request, restored, provider.name);
        cache.set(request.textKey, entry);
        batchEntries.push(entry);
        translated++;
      }
      if (batchEntries.length > 0) mergeRuntimeCacheAtomic(cacheFile, batchEntries, { overwrite: !skipTranslated });
    }
  }));

  return { processed: requests.length, translated, skippedCached, issues };
}

export function shouldTranslateRuntimeText(source: string, targetLang: string): boolean {
  const text = source.trim();
  if (!text) return false;
  if (text.startsWith(`[${targetLang}]`)) return false;
  const ascii = /^[\x00-\x7f]+$/.test(text);
  if (ascii && text.length === 1) return false;
  if (ascii && !/[A-Za-z]/.test(text)) return false;
  return true;
}

export function builtInRuntimeTranslation(source: string, targetLang: string): string | undefined {
  if (!targetLang.startsWith("zh")) return undefined;
  const text = source.trim();
  const map = new Map<string, string>([
    ["New Game", "新游戏"],
    ["Continue", "继续"],
    ["Options", "选项"],
    ["Save", "保存"],
    ["Load", "读取"],
    ["Game End", "结束游戏"],
    ["To Title", "返回标题"],
    ["Cancel", "取消"],
    ["OK", "确定"]
  ]);
  return map.get(text);
}

export async function watchRuntime(profile: RuntimeProfile, providerName: string, options: RuntimeWatchOptions = {}): Promise<RuntimeWatchResult> {
  const reader = new RuntimeRequestReader(profile.outputRoot);
  const pollMs = options.pollMs ?? 500;
  const batchSize = options.batchSize ?? 20;
  const concurrency = Math.max(1, options.concurrency ?? 100);
  const skipTranslated = options.skipTranslated ?? true;
  const total: RuntimeWatchResult = { processed: 0, translated: 0, skippedCached: 0, issues: [] };

  while (true) {
    const result = await processRuntimeRequests(profile, providerName, reader, batchSize, concurrency, skipTranslated);
    total.processed += result.processed;
    total.translated += result.translated;
    total.skippedCached += result.skippedCached;
    total.issues.push(...result.issues);
    if (options.once) return total;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
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
