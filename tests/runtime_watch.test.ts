import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeProfile } from "../src/core/types.js";
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
import { processRuntimeRequests, RuntimeRequestReader } from "../src/runtime/watch.js";

describe("runtime watch cache skipping", () => {
  it("skips cached translations by default", async () => {
    const { profile } = makeProfile();
    const request = writeRequest(profile, "Hello there");
    writeRuntimeCacheAtomic(runtimeCachePath(profile.outputRoot), [
      makeRuntimeCacheEntry(request, "已有译文", "manual")
    ]);

    const result = await processRuntimeRequests(profile, "mock", new RuntimeRequestReader(profile.outputRoot), 20, 1, true);

    expect(result.processed).toBe(1);
    expect(result.skippedCached).toBe(1);
    expect(result.translated).toBe(0);
    expect(readRuntimeCache(runtimeCachePath(profile.outputRoot)).get(request.textKey)?.target).toBe("已有译文");
  });

  it("overwrites cached translations only when skipTranslated is disabled", async () => {
    const { profile } = makeProfile();
    const request = writeRequest(profile, "Hello there");
    writeRuntimeCacheAtomic(runtimeCachePath(profile.outputRoot), [
      makeRuntimeCacheEntry(request, "已有译文", "manual")
    ]);

    const result = await processRuntimeRequests(profile, "mock", new RuntimeRequestReader(profile.outputRoot), 20, 1, false);

    expect(result.skippedCached).toBe(0);
    expect(result.translated).toBe(1);
    expect(readRuntimeCache(runtimeCachePath(profile.outputRoot)).get(request.textKey)?.target).toBe("[zh-Hans] Hello there");
  });
});

function makeProfile(): { root: string; profile: RuntimeProfile } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpgmtrans-watch-"));
  const sourceRoot = path.join(root, "source");
  const outputRoot = path.join(root, "out");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(outputRoot, { recursive: true });
  ensureRuntimeDirs(outputRoot);
  return {
    root,
    profile: {
      projectId: "watch-fixture",
      sourceRoot,
      targetLang: "zh-Hans",
      workRoot: path.join(root, "work"),
      extractedRoot: path.join(root, "work", "extracted"),
      outputRoot,
      engine: { family: "RPG_MAKER", name: "VXA", detectedBy: [], confidence: 1 },
      data: { format: "marshal", encoding: "utf-8", root: path.join(outputRoot, "Data"), files: [] },
      scriptRuntime: { language: "ruby", runtime: "rgss3" },
      safety: { scriptTranslationDefault: "skip", allowRuntimeExecution: true, networkDisabledInRunner: true }
    }
  };
}

function writeRequest(profile: RuntimeProfile, source: string): RuntimeTextRequest {
  const request: RuntimeTextRequest = {
    version: "1",
    engine: profile.engine.name,
    targetLang: profile.targetLang,
    textKey: runtimeTextKey(profile.engine.name, profile.targetLang, source),
    surfaceKey: runtimeSurfaceKey({
      engine: profile.engine.name,
      targetLang: profile.targetLang,
      source,
      hook: "message_converted",
      scene: "Scene_Battle",
      window: "Window_SceneMessage",
      width: "520",
      align: ""
    }),
    hook: "message_converted",
    scene: "Scene_Battle",
    window: "Window_SceneMessage",
    width: "520",
    align: "",
    source,
    sourceHex: hexEncode(source),
    normalizedSource: normalizeRuntimeText(source),
    placeholderSignature: placeholderSignature(source),
    createdAt: new Date().toISOString()
  };
  const line = [
    "1",
    request.engine,
    request.targetLang,
    request.textKey,
    request.surfaceKey,
    request.hook,
    request.scene,
    request.window,
    request.width,
    request.align,
    hexEncode(request.normalizedSource),
    request.sourceHex,
    request.placeholderSignature,
    request.createdAt
  ].join("\t");
  fs.appendFileSync(path.join(runtimeRoot(profile.outputRoot), "requests", "session-test.rtlog"), `${line}\n`, "utf8");
  return request;
}
