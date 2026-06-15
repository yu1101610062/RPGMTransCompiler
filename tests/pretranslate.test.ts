import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeProfile } from "../src/core/types.js";
import { pretranslateRuntime } from "../src/pretranslate/pretranslate.js";
import { collectMvMzCandidates } from "../src/pretranslate/mvmzCandidates.js";
import {
  hexEncode,
  makeRuntimeCacheEntry,
  readRuntimeCache,
  runtimeCachePath,
  runtimeSurfaceKey,
  runtimeTextKey,
  writeRuntimeCacheAtomic,
  type RuntimeTextRequest
} from "../src/runtime/protocol.js";

describe("pretranslate cache", () => {
  it("extracts MV/MZ safe candidates and writes text-scope cache entries", async () => {
    const { profile } = makeMvProfile();
    const candidates = collectMvMzCandidates(profile);
    expect(candidates.map(item => item.source)).toContain("Welcome to town");
    expect(candidates.map(item => item.source)).toContain("Take the job?");
    expect(candidates.map(item => item.source)).not.toContain("img/faces/Hero.png");

    const result = await pretranslateRuntime(profile, "mock");
    expect(result.issues).toHaveLength(0);
    expect(result.translated).toBeGreaterThan(0);

    const cache = readRuntimeCache(runtimeCachePath(profile.outputRoot));
    const key = runtimeTextKey("MV", "zh-Hans", "Welcome to town");
    const entry = cache.get(key);
    expect(entry?.scope).toBe("text");
    expect(entry?.key).toBe(key);
    expect(entry?.target).toBe("[zh-Hans] Welcome to town");
  });

  it("does not overwrite an existing runtime cache entry unless requested", async () => {
    const { profile } = makeMvProfile();
    const source = "Welcome to town";
    const request = makeRequest(profile, source);
    writeRuntimeCacheAtomic(runtimeCachePath(profile.outputRoot), [
      makeRuntimeCacheEntry(request, "已有译文", "manual")
    ]);

    const skipped = await pretranslateRuntime(profile, "mock");
    expect(skipped.skippedCached).toBeGreaterThan(0);
    expect(readRuntimeCache(runtimeCachePath(profile.outputRoot)).get(request.textKey)?.target).toBe("已有译文");

    const overwritten = await pretranslateRuntime(profile, "mock", { overwrite: true });
    expect(overwritten.translated).toBeGreaterThan(0);
    expect(readRuntimeCache(runtimeCachePath(profile.outputRoot)).get(request.textKey)?.target).toBe("[zh-Hans] Welcome to town");
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
});

function makeMvProfile(): { root: string; profile: RuntimeProfile } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpgmtrans-pretranslate-"));
  const sourceRoot = path.join(root, "source");
  const outputRoot = path.join(root, "out");
  const dataRoot = path.join(sourceRoot, "data");
  fs.mkdirSync(dataRoot, { recursive: true });
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
              { code: 102, parameters: [["Take the job?", "Leave"], 0, 0, 2, 0] },
              { code: 0, parameters: [] }
            ]
          }
        ]
      }
    ]
  }), "utf8");

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
    normalizedSource: source,
    placeholderSignature: "none",
    createdAt: new Date().toISOString()
  };
}
