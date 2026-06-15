import fs from "node:fs";
import path from "node:path";
import type { EngineName, TranslationUnit } from "../core/types.js";
import { protectPlaceholders } from "../extractors/placeholders.js";

export const RUNTIME_DIR = "RPGMTransRuntime";
export const REQUEST_DIR = "requests";
export const CACHE_DIR = "cache";
export const DIAG_DIR = "diag";
export const CACHE_FILE = "translations.rtc";
export const MANIFEST_FILE = "manifest.json";

export interface RuntimeTextRequest {
  version: "1";
  engine: EngineName;
  targetLang: string;
  textKey: string;
  surfaceKey: string;
  hook: string;
  scene: string;
  window: string;
  width: string;
  align: string;
  source: string;
  sourceHex: string;
  normalizedSource: string;
  placeholderSignature: string;
  createdAt: string;
}

export interface RuntimeCacheEntry {
  version: "1";
  scope: "text" | "surface";
  key: string;
  textKey: string;
  surfaceKey: string;
  engine: EngineName;
  targetLang: string;
  sourceHex: string;
  targetHex: string;
  source: string;
  target: string;
  provider: string;
  updatedAt: string;
}

export interface RuntimeInstallManifest {
  version: 1;
  projectId: string;
  engine: EngineName;
  targetLang: string;
  sourceRoot: string;
  outputRoot: string;
  installedAt: string;
  plugin: {
    name: "RPGMTransRuntime";
    protocol: 1;
  };
}

export function runtimeRoot(gameRoot: string): string {
  return path.join(gameRoot, RUNTIME_DIR);
}

export function runtimeCachePath(gameRoot: string): string {
  return path.join(runtimeRoot(gameRoot), CACHE_DIR, CACHE_FILE);
}

export function runtimeManifestPath(gameRoot: string): string {
  return path.join(runtimeRoot(gameRoot), MANIFEST_FILE);
}

export function ensureRuntimeDirs(gameRoot: string): void {
  for (const dir of [
    runtimeRoot(gameRoot),
    path.join(runtimeRoot(gameRoot), REQUEST_DIR),
    path.join(runtimeRoot(gameRoot), CACHE_DIR),
    path.join(runtimeRoot(gameRoot), DIAG_DIR)
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const cache = runtimeCachePath(gameRoot);
  if (!fs.existsSync(cache)) fs.writeFileSync(cache, "# RPGMTransRuntime cache v1\n", "utf8");
}

export function normalizeRuntimeText(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[ \t]+/g, " ").trim();
}

export function hexEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("hex");
}

export function hexDecode(input: string): string {
  return Buffer.from(input, "hex").toString("utf8");
}

export function placeholderSignature(input: string): string {
  const protectedSet = protectPlaceholders(input);
  if (protectedSet.placeholders.length === 0) return "none";
  return protectedSet.placeholders.map(item => hexEncode(item.raw)).join(",");
}

export function runtimeHash(input: string): string {
  const bytes = Buffer.from(input, "utf8");
  const seeds = [0x811c9dc5, 0x1f123bb5, 0x9e3779b9, 0x85ebca6b];
  return seeds.map(seed => {
    let hash = seed >>> 0;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }).join("");
}

export function runtimeTextKey(engine: EngineName, targetLang: string, source: string): string {
  const normalized = normalizeRuntimeText(source);
  return `tk_${runtimeHash([
    "rpgmtrans-runtime-text-v1",
    engine,
    targetLang,
    normalized,
    placeholderSignature(normalized)
  ].join("\n"))}`;
}

export function runtimeSurfaceKey(input: {
  engine: EngineName;
  targetLang: string;
  source: string;
  hook: string;
  scene: string;
  window: string;
  width: string | number;
  align: string;
}): string {
  const textKey = runtimeTextKey(input.engine, input.targetLang, input.source);
  return `sk_${runtimeHash([
    "rpgmtrans-runtime-surface-v1",
    textKey,
    input.hook,
    input.scene,
    input.window,
    String(input.width),
    input.align
  ].join("\n"))}`;
}

export function requestToUnit(request: RuntimeTextRequest): TranslationUnit {
  const protectedSet = protectPlaceholders(request.source);
  return {
    unitId: request.textKey,
    engine: request.engine,
    file: "RPGMTransRuntime",
    path: request.surfaceKey,
    pathJson: {
      textKey: request.textKey,
      surfaceKey: request.surfaceKey,
      hook: request.hook,
      scene: request.scene,
      window: request.window,
      width: request.width,
      align: request.align
    },
    source: request.source,
    protectedSource: protectedSet.protected,
    placeholders: protectedSet.placeholders,
    action: "AUTO",
    semanticHint: request.hook === "message" ? "dialogue" : "unknown",
    status: "planned",
    sourceHash: request.textKey,
    context: {
      hook: request.hook,
      scene: request.scene,
      window: request.window,
      width: request.width,
      align: request.align
    }
  };
}

export function parseRuntimeRequestLine(line: string): RuntimeTextRequest | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const parts = trimmed.split("\t");
  if (parts.length < 14 || parts[0] !== "1") return undefined;
  const source = hexDecode(parts[11]);
  return {
    version: "1",
    engine: parts[1] as EngineName,
    targetLang: parts[2],
    textKey: parts[3],
    surfaceKey: parts[4],
    hook: parts[5],
    scene: parts[6],
    window: parts[7],
    width: parts[8],
    align: parts[9],
    normalizedSource: hexDecode(parts[10]),
    sourceHex: parts[11],
    source,
    placeholderSignature: parts[12],
    createdAt: parts[13]
  };
}

export function serializeCacheEntry(entry: RuntimeCacheEntry): string {
  return [
    "1",
    entry.scope,
    entry.key,
    entry.textKey,
    entry.surfaceKey,
    entry.engine,
    entry.targetLang,
    entry.sourceHex,
    entry.targetHex,
    entry.provider,
    entry.updatedAt
  ].join("\t");
}

export function parseCacheLine(line: string): RuntimeCacheEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const parts = trimmed.split("\t");
  if (parts.length < 11 || parts[0] !== "1") return undefined;
  const source = hexDecode(parts[7]);
  const target = hexDecode(parts[8]);
  return {
    version: "1",
    scope: parts[1] === "surface" ? "surface" : "text",
    key: parts[2],
    textKey: parts[3],
    surfaceKey: parts[4],
    engine: parts[5] as EngineName,
    targetLang: parts[6],
    sourceHex: parts[7],
    targetHex: parts[8],
    source,
    target,
    provider: parts[9],
    updatedAt: parts[10]
  };
}

export function readRuntimeCache(file: string): Map<string, RuntimeCacheEntry> {
  const entries = new Map<string, RuntimeCacheEntry>();
  if (!fs.existsSync(file)) return entries;
  for (const line of readTextFileWithRetry(file).split(/\r?\n/)) {
    const entry = parseCacheLine(line);
    if (entry) entries.set(entry.key, entry);
  }
  return entries;
}

export function writeRuntimeCacheAtomic(file: string, entries: Iterable<RuntimeCacheEntry>): void {
  withRuntimeCacheLock(file, () => writeRuntimeCacheAtomicUnlocked(file, entries));
}

export function mergeRuntimeCacheAtomic(file: string, entries: Iterable<RuntimeCacheEntry>, options: { overwrite?: boolean } = {}): { written: number; skippedCached: number } {
  const incoming = [...entries];
  if (incoming.length === 0) return { written: 0, skippedCached: 0 };
  return withRuntimeCacheLock(file, () => {
    const latest = readRuntimeCache(file);
    let written = 0;
    let skippedCached = 0;
    const appendable: RuntimeCacheEntry[] = [];

    for (const entry of incoming) {
      if (!options.overwrite && latest.has(entry.key)) {
        skippedCached++;
        continue;
      }
      latest.set(entry.key, entry);
      appendable.push(entry);
      written++;
    }

    if (written === 0) return { written, skippedCached };
    if (options.overwrite) {
      writeRuntimeCacheAtomicUnlocked(file, latest.values());
    } else {
      appendRuntimeCacheEntriesUnlocked(file, appendable);
    }
    return { written, skippedCached };
  });
}

function writeRuntimeCacheAtomicUnlocked(file: string, entries: Iterable<RuntimeCacheEntry>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = [
    "# RPGMTransRuntime cache v1",
    ...[...entries].sort((a, b) => a.key.localeCompare(b.key)).map(serializeCacheEntry),
    ""
  ].join("\n");
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  writeTextFileWithRetry(tmp, body);
  try {
    renameWithRetry(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

function appendRuntimeCacheEntriesUnlocked(file: string, entries: RuntimeCacheEntry[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) writeTextFileWithRetry(file, "# RPGMTransRuntime cache v1\n");
  appendTextFileWithRetry(file, entries.map(serializeCacheEntry).join("\n") + "\n");
}

function renameWithRetry(from: string, to: string): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientFileError(error)) throw error;
      sleepSync(25 + attempt * 25);
    }
  }
  throw lastError;
}

function readTextFileWithRetry(file: string): string {
  return retryFileOperation(() => fs.readFileSync(file, "utf8"));
}

function writeTextFileWithRetry(file: string, text: string): void {
  retryFileOperation(() => {
    fs.writeFileSync(file, text, "utf8");
  });
}

function appendTextFileWithRetry(file: string, text: string): void {
  retryFileOperation(() => {
    fs.appendFileSync(file, text, "utf8");
  });
}

function retryFileOperation<T>(action: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      return action();
    } catch (error) {
      lastError = error;
      if (!isTransientFileError(error)) throw error;
      sleepSync(25 + Math.min(attempt, 20) * 25);
    }
  }
  throw lastError;
}

function isTransientFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return ["EPERM", "EACCES", "EBUSY", "EMFILE", "ENFILE"].includes(code || "");
}

function withRuntimeCacheLock<T>(file: string, action: () => T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 30_000;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lock, "wx");
      fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > 120_000) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for runtime cache lock: ${lock}`);
      sleepSync(20);
    }
  }

  try {
    return action();
  } finally {
    try {
      fs.closeSync(fd);
    } finally {
      try {
        fs.unlinkSync(lock);
      } catch {
        // 其他进程清理过期锁时可能已经删除，忽略即可。
      }
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function makeRuntimeCacheEntry(request: RuntimeTextRequest, target: string, provider: string): RuntimeCacheEntry {
  return {
    version: "1",
    scope: "text",
    key: request.textKey,
    textKey: request.textKey,
    surfaceKey: request.surfaceKey,
    engine: request.engine,
    targetLang: request.targetLang,
    sourceHex: request.sourceHex,
    targetHex: hexEncode(target),
    source: request.source,
    target,
    provider,
    updatedAt: new Date().toISOString()
  };
}
