import fs from "node:fs";
import path from "node:path";
import { defaultWorkRoot, normalizePath } from "../core/paths.js";
import { sha256File, shortHash } from "../core/hash.js";
import type { EngineName, RuntimeProfile } from "../core/types.js";
import { runtimeManifestPath, type RuntimeInstallManifest } from "../runtime/protocol.js";
import { readRgssArchiveVersion } from "./rgss/archive.js";

export interface ScanOptions {
  targetLang?: string;
  out?: string;
  db?: string;
}

export interface ScanResult {
  profile: RuntimeProfile;
  dbPath: string;
}

export function scanProject(sourceRootInput: string, options: ScanOptions = {}): ScanResult {
  const scanRoot = normalizePath(sourceRootInput);
  if (!fs.existsSync(scanRoot) || !fs.statSync(scanRoot).isDirectory()) {
    throw new Error(`Source root does not exist or is not a directory: ${scanRoot}`);
  }
  const existingRuntime = readExistingRuntime(scanRoot);
  const sourceRoot = scanRoot;
  const targetLang = options.targetLang || existingRuntime?.targetLang || "zh-Hans";
  const detected = detectEngine(scanRoot);
  const projectId = shortHash(`${sourceRoot}\n${scanRoot}\n${detected.engine}\n${detected.detectedBy.join("\n")}\n${detected.archiveHash ?? ""}`);
  const workRoot = normalizePath(options.db ? path.dirname(path.resolve(options.db)) : path.join(defaultWorkRoot, `${path.basename(sourceRoot)}-${projectId}`));
  const extractedRoot = normalizePath(path.join(workRoot, "extracted"));
  const outputRoot = normalizePath(options.out || scanRoot);
  const dbPath = normalizePath(options.db || path.join(workRoot, "project.sqlite"));

  const profile: RuntimeProfile = {
    projectId,
    sourceRoot,
    targetLang,
    workRoot,
    extractedRoot,
    outputRoot,
    engine: {
      family: detected.family,
      name: detected.engine,
      detectedBy: detected.detectedBy,
      confidence: detected.confidence
    },
    data: {
      format: detected.dataFormat,
      encoding: detected.encoding,
      root: detected.dataRoot,
      files: detected.dataFiles
    },
    scriptRuntime: detected.scriptRuntime,
    archive: detected.archive,
    plugins: detected.plugins,
    safety: {
      scriptTranslationDefault: "skip",
      allowRuntimeExecution: true,
      networkDisabledInRunner: true
    }
  };

  return { profile, dbPath };
}

function readExistingRuntime(root: string): RuntimeInstallManifest | undefined {
  const manifest = runtimeManifestPath(root);
  if (!fs.existsSync(manifest)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(manifest, "utf8")) as RuntimeInstallManifest;
  } catch {
    return undefined;
  }
}

interface Detection {
  family: RuntimeProfile["engine"]["family"];
  engine: EngineName;
  confidence: number;
  detectedBy: string[];
  dataFormat: RuntimeProfile["data"]["format"];
  dataRoot: string;
  dataFiles: string[];
  encoding: string;
  archive?: RuntimeProfile["archive"];
  archiveHash?: string;
  scriptRuntime: RuntimeProfile["scriptRuntime"];
  plugins?: RuntimeProfile["plugins"];
}

function detectEngine(root: string): Detection {
  const detectedBy: string[] = [];
  const gameIni = path.join(root, "Game.ini");
  const ini = fs.existsSync(gameIni) ? fs.readFileSync(gameIni, "utf8") : "";
  const rgssArchive = findFirst(root, ["Game.rgss3a", "Game.rgss2a", "Game.rgssad"]);
  const archiveVersion = rgssArchive ? readRgssArchiveVersion(rgssArchive) : undefined;

  const renpy = detectRenpy(root);
  if (renpy) return renpy;

  if (fs.existsSync(path.join(root, "data", "System.json")) || fs.existsSync(path.join(root, "www", "data", "System.json"))) {
    const isMz = fs.existsSync(path.join(root, "js", "rmmz_core.js")) || fs.existsSync(path.join(root, "www", "js", "rmmz_core.js"));
    const dataRoot = fs.existsSync(path.join(root, "data")) ? path.join(root, "data") : path.join(root, "www", "data");
    const jsRoot = fs.existsSync(path.join(root, "js")) ? path.join(root, "js") : path.join(root, "www", "js");
    detectedBy.push(path.relative(root, path.join(dataRoot, "System.json")).replace(/\\/g, "/"));
    detectedBy.push(path.relative(root, jsRoot).replace(/\\/g, "/"));
    const plugins = readPlugins(path.join(jsRoot, "plugins.js"));
    return {
      family: "RPG_MAKER",
      engine: isMz ? "MZ" : "MV",
      confidence: 0.95,
      detectedBy,
      dataFormat: "json",
      dataRoot: normalizePath(dataRoot),
      dataFiles: listFiles(dataRoot, /\.json$/i),
      encoding: "utf-8",
      scriptRuntime: { language: "javascript", runtime: "nwjs" },
      plugins
    };
  }

  const tyrano = detectTyrano(root);
  if (tyrano) return tyrano;

  if (ini.includes("RGSS301") || fs.existsSync(path.join(root, "Game.rvproj2")) || archiveVersion === 3) {
    if (ini.includes("RGSS301")) detectedBy.push("Game.ini:Library=System\\RGSS301.dll");
    if (rgssArchive) detectedBy.push(path.basename(rgssArchive));
    const archive = rgssArchive && archiveVersion
      ? {
          path: normalizePath(rgssArchive),
          kind: "RGSSAD" as const,
          version: archiveVersion,
          sha256: sha256File(rgssArchive)
        }
      : undefined;
    return {
      family: "RPG_MAKER",
      engine: "VXA",
      confidence: archive ? 0.98 : 0.9,
      detectedBy,
      dataFormat: "marshal",
      dataRoot: normalizePath(path.join(root, "Data")),
      dataFiles: fs.existsSync(path.join(root, "Data")) ? listFiles(path.join(root, "Data"), /\.rvdata2$/i) : [],
      encoding: "binary",
      archive,
      archiveHash: archive?.sha256,
      scriptRuntime: { language: "ruby", runtime: "rgss3", engineVersion: "RGSS3" }
    };
  }

  if (ini.includes("RGSS202") || fs.existsSync(path.join(root, "Game.rvproj")) || path.extname(rgssArchive || "") === ".rgss2a") {
    if (ini) detectedBy.push("Game.ini");
    if (rgssArchive) detectedBy.push(path.basename(rgssArchive));
    return rgssDetection(root, "VX", "rgss2", ".rvdata", rgssArchive, archiveVersion, detectedBy);
  }

  if (ini.includes("RGSS102") || fs.existsSync(path.join(root, "Game.rxproj")) || path.extname(rgssArchive || "") === ".rgssad") {
    if (ini) detectedBy.push("Game.ini");
    if (rgssArchive) detectedBy.push(path.basename(rgssArchive));
    return rgssDetection(root, "XP", "rgss", ".rxdata", rgssArchive, archiveVersion, detectedBy);
  }

  if (fs.existsSync(path.join(root, "RPG_RT.ldb")) || fs.existsSync(path.join(root, "RPG_RT.lmt"))) {
    detectedBy.push(...["RPG_RT.ldb", "RPG_RT.lmt"].filter(file => fs.existsSync(path.join(root, file))));
    const files = listFiles(root, /\.(ldb|lmt|lmu)$/i);
    return {
      family: "RPG_MAKER",
      engine: "RM2K3",
      confidence: 0.8,
      detectedBy,
      dataFormat: "lcf",
      dataRoot: root,
      dataFiles: files,
      encoding: "cp932-or-locale",
      scriptRuntime: { language: "none", runtime: "none" }
    };
  }

  return {
    family: "RPG_MAKER",
    engine: "UNKNOWN",
    confidence: 0,
    detectedBy: [],
    dataFormat: "unknown",
    dataRoot: root,
    dataFiles: [],
    encoding: "unknown",
    scriptRuntime: { language: "unknown", runtime: "unknown" }
  };
}

function detectRenpy(root: string): Detection | undefined {
  const gameDir = path.join(root, "game");
  if (!fs.existsSync(gameDir) || !fs.statSync(gameDir).isDirectory()) return undefined;
  const scriptFiles = listFiles(gameDir, /\.(rpy|rpyc|rpymc|rpa)$/i);
  const renpyDir = path.join(root, "renpy");
  const exeNames = fs.readdirSync(root).filter(name => /\.exe$/i.test(name));
  const hasRenpySignal = fs.existsSync(renpyDir)
    || scriptFiles.length > 0
    || exeNames.some(name => /renpy|python/i.test(name));
  if (!hasRenpySignal) return undefined;
  const detectedBy = ["game/"];
  if (fs.existsSync(renpyDir)) detectedBy.push("renpy/");
  detectedBy.push(...scriptFiles.slice(0, 8).map(file => path.relative(root, file).replace(/\\/g, "/")));
  return {
    family: "REN_PY",
    engine: "RENPY",
    confidence: fs.existsSync(renpyDir) ? 0.95 : 0.85,
    detectedBy,
    dataFormat: "renpy",
    dataRoot: normalizePath(gameDir),
    dataFiles: scriptFiles,
    encoding: "utf-8-or-compiled",
    scriptRuntime: { language: "python", runtime: "renpy" }
  };
}

function detectTyrano(root: string): Detection | undefined {
  const indexHtml = path.join(root, "index.html");
  const scenarioRoot = path.join(root, "data", "scenario");
  const tyranoRoot = path.join(root, "tyrano");
  const kag = path.join(root, "tyrano", "plugins", "kag", "kag.js");
  const tyranoJs = path.join(root, "tyrano", "tyrano.js");
  const hasTyranoSignal = fs.existsSync(indexHtml)
    && (fs.existsSync(scenarioRoot) || fs.existsSync(kag) || fs.existsSync(tyranoJs));
  if (!hasTyranoSignal) return undefined;
  const scenarioFiles = fs.existsSync(scenarioRoot) ? listFiles(scenarioRoot, /\.ks$/i) : [];
  const detectedBy = ["index.html"];
  if (fs.existsSync(scenarioRoot)) detectedBy.push("data/scenario/");
  if (fs.existsSync(kag)) detectedBy.push("tyrano/plugins/kag/kag.js");
  if (fs.existsSync(tyranoJs)) detectedBy.push("tyrano/tyrano.js");
  return {
    family: "TYRANO",
    engine: "TYRANO",
    confidence: scenarioFiles.length > 0 ? 0.95 : 0.8,
    detectedBy,
    dataFormat: "tyrano",
    dataRoot: normalizePath(path.join(root, "data")),
    dataFiles: scenarioFiles,
    encoding: "utf-8",
    scriptRuntime: { language: "javascript", runtime: "tyrano" }
  };
}

function rgssDetection(
  root: string,
  engine: "XP" | "VX",
  runtime: "rgss" | "rgss2",
  dataExt: ".rxdata" | ".rvdata",
  archivePath: string | undefined,
  archiveVersion: 1 | 2 | 3 | undefined,
  detectedBy: string[]
): Detection {
  const archive = archivePath && archiveVersion
    ? {
        path: normalizePath(archivePath),
        kind: "RGSSAD" as const,
        version: archiveVersion,
        sha256: sha256File(archivePath)
      }
    : undefined;
  const dataRoot = path.join(root, "Data");
  return {
    family: "RPG_MAKER",
    engine,
    confidence: archive ? 0.9 : 0.8,
    detectedBy,
    dataFormat: "marshal",
    dataRoot: normalizePath(dataRoot),
    dataFiles: fs.existsSync(dataRoot) ? listFiles(dataRoot, new RegExp(`${escapeRegExp(dataExt)}$`, "i")) : [],
    encoding: "binary",
    archive,
    archiveHash: archive?.sha256,
    scriptRuntime: { language: "ruby", runtime, engineVersion: runtime.toUpperCase() }
  };
}

function findFirst(root: string, names: string[]): string | undefined {
  for (const name of names) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function listFiles(root: string, pattern: RegExp): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (pattern.test(entry.name)) out.push(normalizePath(full));
    }
  }
  return out.sort();
}

function readPlugins(file: string): RuntimeProfile["plugins"] {
  if (!fs.existsSync(file)) return { loaded: [] };
  const text = fs.readFileSync(file, "utf8");
  const matches = [...text.matchAll(/"name"\s*:\s*"([^"]+)"[\s\S]*?"status"\s*:\s*(true|false)/g)];
  return {
    managerFile: normalizePath(file),
    loaded: matches.map(match => ({ name: match[1], status: match[2] === "true" }))
  };
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
