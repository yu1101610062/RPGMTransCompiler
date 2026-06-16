import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import type { RuntimeProfile } from "../src/core/types.js";
import { scanProject } from "../src/engines/scanner.js";
import { collectMvMzCandidates } from "../src/pretranslate/mvmzCandidates.js";
import { estimatePretranslateRuntime, pretranslateRuntime } from "../src/pretranslate/pretranslate.js";
import {
  ensureRuntimeDirs,
  hexEncode,
  makeRuntimeCacheEntry,
  normalizeRuntimeText,
  placeholderSignature,
  readRuntimeCache,
  runtimeCachePath,
  runtimeRoot,
  runtimeSurfaceKey,
  runtimeTextKey,
  writeRuntimeCacheAtomic,
  type RuntimeTextRequest
} from "../src/runtime/protocol.js";

describe("pretranslate cache", () => {
  it("extracts MV/MZ safe candidates, review-only records, and writes text-scope cache entries", async () => {
    const { profile } = makeMvProfile();
    const candidates = collectMvMzCandidates(profile);
    const sources = candidates.map(item => item.source);

    expect(sources).toContain("Welcome to town\nPlease rest at the inn");
    expect(sources).not.toContain("Welcome to town");
    expect(sources).toContain("Take the job?");
    expect(sources).toContain("Plugin visible text");
    expect(sources).toContain("ShowPopup Welcome traveler");
    expect(sources).toContain("Translator note");
    expect(sources).not.toContain("img/faces/Hero.png");
    expect(candidates.find(item => item.source === "Plugin visible text")?.action).toBe("review");

    const result = await pretranslateRuntime(profile, "mock");
    expect(result.issues).toHaveLength(0);
    expect(result.translated).toBeGreaterThan(0);

    const cache = readRuntimeCache(runtimeCachePath(profile.outputRoot));
    const key = runtimeTextKey("MV", "zh-Hans", "Welcome to town\nPlease rest at the inn");
    const entry = cache.get(key);
    expect(entry?.scope).toBe("text");
    expect(entry?.key).toBe(key);
    expect(entry?.target).toBe("[zh-Hans] Welcome to town\nPlease rest at the inn");
    expect([...cache.values()].some(item => item.source === "Plugin visible text")).toBe(false);

    const manifest = readJsonl(path.join(runtimeRoot(profile.outputRoot), "cache", "pretranslate-candidates.jsonl"));
    const pluginRecord = manifest.find(item => item.normalizedSource === "Plugin visible text");
    expect(pluginRecord?.action).toBe("review");
    expect(pluginRecord?.occurrences?.[0]?.fieldName).toBe("plugin_command_mz");
  });

  it("does not overwrite an existing runtime cache entry unless requested", async () => {
    const { profile } = makeMvProfile();
    const source = "Welcome to town\nPlease rest at the inn";
    const request = makeRequest(profile, source);
    writeRuntimeCacheAtomic(runtimeCachePath(profile.outputRoot), [
      makeRuntimeCacheEntry(request, "已有译文", "manual")
    ]);

    const skipped = await pretranslateRuntime(profile, "mock");
    expect(skipped.skippedCached).toBeGreaterThan(0);
    expect(readRuntimeCache(runtimeCachePath(profile.outputRoot)).get(request.textKey)?.target).toBe("已有译文");

    const overwritten = await pretranslateRuntime(profile, "mock", { overwrite: true });
    expect(overwritten.translated).toBeGreaterThan(0);
    expect(readRuntimeCache(runtimeCachePath(profile.outputRoot)).get(request.textKey)?.target).toBe("[zh-Hans] Welcome to town\nPlease rest at the inn");
  });

  it("emits progress and writes the pretranslate progress sidecar", async () => {
    const { profile } = makeMvProfile();
    const phases: string[] = [];
    const result = await pretranslateRuntime(profile, "mock", {
      batchSize: 2,
      concurrency: 100,
      onProgress: progress => phases.push(progress.phase)
    });

    expect(result.translated).toBeGreaterThan(0);
    expect(phases).toContain("scan");
    expect(phases).toContain("translate");
    expect(phases.at(-1)).toBe("done");

    const sidecar = JSON.parse(fs.readFileSync(path.join(profile.outputRoot, "RPGMTransRuntime", "cache", "pretranslate.json"), "utf8")) as {
      phase: string;
      translated: number;
      batchesTotal: number;
      batchesCompleted: number;
    };
    expect(sidecar.phase).toBe("done");
    expect(sidecar.translated).toBe(result.translated);
    expect(sidecar.batchesCompleted).toBe(sidecar.batchesTotal);
  });

  it("estimates provider tokens and cost before execution", () => {
    const { profile } = makeMvProfile();
    const estimate = estimatePretranslateRuntime(profile, {
      batchSize: 2,
      inputTokenPricePerMillion: 1,
      outputTokenPricePerMillion: 2
    });

    expect(estimate.scanned).toBeGreaterThan(0);
    expect(estimate.queued).toBeGreaterThan(0);
    expect(estimate.estimatedInputTokens).toBeGreaterThan(0);
    expect(estimate.estimatedOutputTokens).toBeGreaterThan(0);
    expect(estimate.estimatedTotalCost).toBeCloseTo(
      estimate.estimatedInputTokens / 1_000_000 + estimate.estimatedOutputTokens * 2 / 1_000_000,
      6
    );
  });

  it("feeds runtime misses back into pretranslation", async () => {
    const { profile } = makeMvProfile();
    ensureRuntimeDirs(profile.outputRoot);
    writeRuntimeRequest(profile, "Runtime-only line");

    const result = await pretranslateRuntime(profile, "mock");

    expect(result.translated).toBeGreaterThan(0);
    const cache = readRuntimeCache(runtimeCachePath(profile.outputRoot));
    expect(cache.get(runtimeTextKey("MV", "zh-Hans", "Runtime-only line"))?.target).toBe("[zh-Hans] Runtime-only line");
  });

  it("pretranslates Ren'Py games that only contain rpyc files without writing source to the game directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpgmtrans-renpy-rpyc-"));
    fs.mkdirSync(path.join(root, "game"), { recursive: true });
    fs.mkdirSync(path.join(root, "renpy"), { recursive: true });
    fs.writeFileSync(path.join(root, "Game.exe"), "", "utf8");
    const payload = zlib.deflateSync(Buffer.from("Okay, I see now\nYou are a cute little shrimp", "utf8"));
    fs.writeFileSync(path.join(root, "game", "script.rpyc"), Buffer.concat([Buffer.from("RENPY RPC2\n"), payload]));
    const { profile } = scanProject(root, { db: path.join(root, "project.sqlite") });

    const result = await pretranslateRuntime(profile, "mock", { batchSize: 2, concurrency: 2 });
    expect(result.translated).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(root, "game", "script.rpy"))).toBe(false);
    const cache = readRuntimeCache(runtimeCachePath(root));
    expect([...cache.values()].some(entry => entry.source.includes("Okay, I see now"))).toBe(true);
  });

  it("pretranslates Tyrano scenario text and visible tag parameters", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpgmtrans-tyrano-pre-"));
    fs.mkdirSync(path.join(root, "data", "scenario"), { recursive: true });
    fs.mkdirSync(path.join(root, "tyrano", "plugins", "kag"), { recursive: true });
    fs.writeFileSync(path.join(root, "index.html"), "<html></html>", "utf8");
    fs.writeFileSync(path.join(root, "tyrano", "plugins", "kag", "kag.js"), "", "utf8");
    fs.writeFileSync(path.join(root, "data", "scenario", "first.ks"), [
      "Hello [emb exp=\"f.name\"]!",
      "Page break line[p]",
      "[glink text=\"Start\" target=\"*start\"]",
      "[chara_ptext name=\"Meisa\"]",
      "tf.is_replay_open = false;",
      "if(sf.replay_id[mp.id]){",
      "[macro name=\"skipme\"]",
      "Do not scan this macro",
      "[endmacro]",
      ""
    ].join("\n"), "utf8");
    const { profile } = scanProject(root, { db: path.join(root, "project.sqlite") });

    const result = await pretranslateRuntime(profile, "mock");
    expect(result.translated).toBeGreaterThanOrEqual(2);
    const cache = readRuntimeCache(runtimeCachePath(root));
    expect([...cache.values()].some(entry => entry.source === "Hello [emb exp=\"f.name\"]!")).toBe(true);
    expect([...cache.values()].some(entry => entry.source === "Page break line")).toBe(true);
    expect([...cache.values()].some(entry => entry.source === "Page break line[p]")).toBe(false);
    expect([...cache.values()].some(entry => entry.source === "Start")).toBe(true);
    expect([...cache.values()].some(entry => entry.source === "Meisa")).toBe(true);
    expect([...cache.values()].some(entry => entry.source.includes("is_replay_open"))).toBe(false);
    expect([...cache.values()].some(entry => entry.source.includes("replay_id"))).toBe(false);
    expect([...cache.values()].some(entry => entry.source.includes("macro"))).toBe(false);
  });

  it("pretranslates Tyrano scenario text from an NW.js executable package", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpgmtrans-tyrano-exe-pre-"));
    writeFakePackagedExe(path.join(root, "Game.exe"), [
      {
        name: "data/scenario/first.ks",
        text: [
          "Hello from packaged scenario",
          "[glink text=\"Start packaged game\" target=\"*start\"]",
          ""
        ].join("\n")
      },
      { name: "tyrano/plugins/kag/kag.js", text: "window.TYRANO={};" }
    ]);
    const { profile } = scanProject(root, { db: path.join(root, "project.sqlite") });

    expect(profile.engine.name).toBe("TYRANO");
    expect(profile.data.files[0]).toContain("!/data/scenario/first.ks");
    const result = await pretranslateRuntime(profile, "mock");

    expect(result.issues).toHaveLength(0);
    expect(result.translated).toBeGreaterThanOrEqual(2);
    const cache = readRuntimeCache(runtimeCachePath(root));
    expect([...cache.values()].some(entry => entry.source === "Hello from packaged scenario")).toBe(true);
    expect([...cache.values()].some(entry => entry.source === "Start packaged game")).toBe(true);
  });
});

function makeMvProfile(): { root: string; profile: RuntimeProfile } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpgmtrans-pretranslate-"));
  const sourceRoot = path.join(root, "source");
  const outputRoot = path.join(root, "out");
  const dataRoot = path.join(sourceRoot, "data");
  const jsRoot = path.join(sourceRoot, "js");
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(jsRoot, { recursive: true });
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "System.json"), JSON.stringify({
    gameTitle: "Fixture Game",
    currencyUnit: "Gold",
    terms: { commands: ["Fight", "Escape"], messages: { possession: "Possession" } }
  }), "utf8");
  fs.writeFileSync(path.join(dataRoot, "Actors.json"), JSON.stringify([
    null,
    { name: "Hero", nickname: "", profile: "A quiet fighter.", note: "img/faces/Hero.png" }
  ]), "utf8");
  fs.writeFileSync(path.join(dataRoot, "Map001.json"), JSON.stringify({
    displayName: "Test Map",
    events: [
      null,
      {
        pages: [
          {
            list: [
              { code: 101, parameters: ["", 0, 0, 2] },
              { code: 401, parameters: ["Welcome to town"] },
              { code: 401, parameters: ["Please rest at the inn"] },
              { code: 102, parameters: [["Take the job?", "Leave"], 0, 0, 2, 0] },
              { code: 356, parameters: ["ShowPopup Welcome traveler"] },
              { code: 357, parameters: ["SamplePlugin", "show", 0, { text: "Plugin visible text", image: "img/faces/Hero.png" }] },
              { code: 108, parameters: ["Translator note"] },
              { code: 355, parameters: ["this.showText('Script text')"] },
              { code: 0, parameters: [] }
            ]
          }
        ]
      }
    ]
  }), "utf8");
  const pluginsJs = path.join(jsRoot, "plugins.js");
  fs.writeFileSync(pluginsJs, "var $plugins = " + JSON.stringify([
    { name: "SamplePlugin", status: true, parameters: { title: "Plugin menu title", image: "img/pictures/title.png" } }
  ]) + ";\n", "utf8");

  const files = fs.readdirSync(dataRoot).map(name => path.join(dataRoot, name));
  const profile: RuntimeProfile = {
    projectId: "fixture",
    sourceRoot,
    targetLang: "zh-Hans",
    workRoot: path.join(root, "work"),
    extractedRoot: path.join(root, "work", "extracted"),
    outputRoot,
    engine: { family: "RPG_MAKER", name: "MV", detectedBy: [], confidence: 1 },
    data: { format: "json", encoding: "utf-8", root: dataRoot, files },
    scriptRuntime: { language: "javascript", runtime: "nwjs" },
    plugins: { managerFile: pluginsJs, loaded: [] },
    safety: { scriptTranslationDefault: "skip", allowRuntimeExecution: true, networkDisabledInRunner: true }
  };
  return { root, profile };
}

function makeRequest(profile: RuntimeProfile, source: string): RuntimeTextRequest {
  const textKey = runtimeTextKey(profile.engine.name, profile.targetLang, source);
  return {
    version: "1",
    engine: profile.engine.name,
    targetLang: profile.targetLang,
    textKey,
    surfaceKey: runtimeSurfaceKey({ engine: profile.engine.name, targetLang: profile.targetLang, source, hook: "pretranslate", scene: "", window: "", width: "", align: "" }),
    hook: "pretranslate",
    scene: "",
    window: "",
    width: "",
    align: "",
    source,
    sourceHex: hexEncode(source),
    normalizedSource: normalizeRuntimeText(source),
    placeholderSignature: placeholderSignature(source),
    createdAt: new Date().toISOString()
  };
}

function writeRuntimeRequest(profile: RuntimeProfile, source: string): void {
  const request = makeRequest(profile, source);
  const line = [
    "1",
    request.engine,
    request.targetLang,
    request.textKey,
    request.surfaceKey,
    "message",
    "Scene_Map",
    "Window_Message",
    "",
    "",
    hexEncode(request.normalizedSource),
    request.sourceHex,
    request.placeholderSignature,
    request.createdAt
  ].join("\t");
  fs.appendFileSync(path.join(runtimeRoot(profile.outputRoot), "requests", "session-pretranslate.rtlog"), `${line}\n`, "utf8");
}

function readJsonl(file: string): Array<Record<string, any>> {
  return fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, any>);
}

function writeFakePackagedExe(file: string, entries: Array<{ name: string; text: string }>): void {
  fs.writeFileSync(file, Buffer.concat([Buffer.from("MZfake\n"), makeZip(entries)]));
}

function makeZip(entries: Array<{ name: string; text: string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const source = Buffer.from(entry.text, "utf8");
    const compressed = zlib.deflateRawSync(source);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectorySize, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}
