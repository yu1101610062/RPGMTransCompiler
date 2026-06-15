import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  hexDecode,
  hexEncode,
  makeRuntimeCacheEntry,
  mergeRuntimeCacheAtomic,
  normalizeRuntimeText,
  parseRuntimeRequestLine,
  placeholderSignature,
  readRuntimeCache,
  runtimeSurfaceKey,
  runtimeTextKey,
  writeRuntimeCacheAtomic
} from "../src/runtime/protocol.js";

describe("runtime protocol", () => {
  it("encodes text as portable UTF-8 hex", () => {
    const text = "保存 \\V[1]";
    expect(hexDecode(hexEncode(text))).toBe(text);
  });

  it("normalizes and keys runtime text deterministically", () => {
    const source = " Save\t\\V[1] ";
    expect(normalizeRuntimeText(source)).toBe("Save \\V[1]");
    expect(placeholderSignature(source)).toBe(hexEncode("\\V[1]"));
    expect(runtimeTextKey("VXA", "zh-Hans", source)).toBe(runtimeTextKey("VXA", "zh-Hans", "Save \\V[1]"));
    expect(runtimeSurfaceKey({
      engine: "VXA",
      targetLang: "zh-Hans",
      source,
      hook: "draw_text",
      scene: "Scene_Title",
      window: "Window_TitleCommand",
      width: 160,
      align: "1"
    })).toMatch(/^sk_[a-f0-9]{32}$/);
  });

  it("parses request logs and writes cache files", () => {
    const source = "New Game";
    const normalized = normalizeRuntimeText(source);
    const textKey = runtimeTextKey("VXA", "zh-Hans", source);
    const surfaceKey = runtimeSurfaceKey({
      engine: "VXA",
      targetLang: "zh-Hans",
      source,
      hook: "draw_text",
      scene: "Scene_Title",
      window: "Window_Command",
      width: "160",
      align: "1"
    });
    const line = [
      "1",
      "VXA",
      "zh-Hans",
      textKey,
      surfaceKey,
      "draw_text",
      "Scene_Title",
      "Window_Command",
      "160",
      "1",
      hexEncode(normalized),
      hexEncode(source),
      placeholderSignature(normalized),
      "2026-06-14T00:00:00Z"
    ].join("\t");
    const request = parseRuntimeRequestLine(line);
    expect(request?.source).toBe(source);
    expect(request?.textKey).toBe(textKey);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpgmtrans-runtime-"));
    const cache = path.join(dir, "translations.rtc");
    writeRuntimeCacheAtomic(cache, [makeRuntimeCacheEntry(request!, "新游戏", "mock")]);
    const entries = readRuntimeCache(cache);
    expect(entries.get(textKey)?.target).toBe("新游戏");
  });

  it("merges concurrent cache writes without losing entries", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpgmtrans-runtime-concurrent-"));
    const cache = path.join(dir, "translations.rtc");
    const writes = Array.from({ length: 100 }, async (_, index) => {
      const source = `Line ${index}`;
      const textKey = runtimeTextKey("VXA", "zh-Hans", source);
      const surfaceKey = runtimeSurfaceKey({
        engine: "VXA",
        targetLang: "zh-Hans",
        source,
        hook: "pretranslate",
        scene: "",
        window: "",
        width: "",
        align: ""
      });
      mergeRuntimeCacheAtomic(cache, [makeRuntimeCacheEntry({
        version: "1",
        engine: "VXA",
        targetLang: "zh-Hans",
        textKey,
        surfaceKey,
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
      }, `译文 ${index}`, "mock")]);
    });

    await Promise.all(writes);
    const entries = readRuntimeCache(cache);
    expect(entries).toHaveLength(100);
    expect(entries.get(runtimeTextKey("VXA", "zh-Hans", "Line 42"))?.target).toBe("译文 42");
  });
});
