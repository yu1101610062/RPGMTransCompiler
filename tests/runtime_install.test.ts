import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { makeEmbeddedZipPath, readEmbeddedZipText } from "../src/core/embeddedZip.js";
import { scanProject } from "../src/engines/scanner.js";
import { installRuntime, restoreRuntime, validateRuntimeInstall } from "../src/runtime/install.js";
import { readRuntimeCache, runtimeCachePath, runtimeManifestPath, runtimeTextKey } from "../src/runtime/protocol.js";

describe("runtime install in place", () => {
  it("keeps RGSS VX message text hooks in the runtime script", () => {
    const runtimeText = fs.readFileSync(path.join(process.cwd(), "scripts", "runtime_rgss.rb"), "utf8");
    expect(runtimeText).toContain("elsif $game_message.respond_to?(:texts)");
    expect(runtimeText).toContain("rpgmtrans_runtime_prepare_vx_message_texts");
    expect(runtimeText).toContain("rpgmtrans_runtime_translate_message_lines");
    expect(runtimeText).toContain("$game_message.texts = translated_lines");
  });

  it("injects into the selected game directory, preserves cache, and restores original files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpgmtrans-inplace-"));
    const game = path.join(root, "OriginalGame");
    fs.mkdirSync(path.join(game, "data"), { recursive: true });
    fs.mkdirSync(path.join(game, "js", "plugins"), { recursive: true });
    fs.writeFileSync(path.join(game, "data", "System.json"), "{}", "utf8");
    fs.writeFileSync(path.join(game, "js", "rpg_core.js"), "", "utf8");
    fs.writeFileSync(path.join(game, "js", "plugins.js"), "var $plugins = [];\n", "utf8");
    fs.writeFileSync(path.join(game, "package.json"), "{}", "utf8");

    const { profile } = scanProject(game);
    expect(profile.sourceRoot).toBe(game.replace(/\\/g, "/"));
    expect(profile.outputRoot).toBe(game.replace(/\\/g, "/"));

    const key = runtimeTextKey("MV", "zh-Hans", "New Game");
    fs.mkdirSync(path.dirname(runtimeCachePath(game)), { recursive: true });
    fs.writeFileSync(runtimeCachePath(game), [
      "# RPGMTransRuntime cache v1",
      `1\ttext\t${key}\t${key}\tsk_test\tMV\tzh-Hans\t4e65772047616d65\tE696B0E6B8B8E6888F\tmanual\t2026-06-14T00:00:00.000Z`,
      ""
    ].join("\n"), "utf8");

    const result = installRuntime(profile);
    expect(result.issues.filter(issue => issue.severity === "fatal")).toHaveLength(0);
    const pluginFile = path.join(game, "js", "plugins", "RPGMTransRuntime.js");
    expect(fs.existsSync(pluginFile)).toBe(true);
    const pluginText = fs.readFileSync(pluginFile, "utf8");
    expect(pluginText).toContain("Window_Message.prototype.updateMessage");
    expect(pluginText).toContain("Window_Command.prototype.drawItem");
    expect(pluginText).toContain("Window_BattleLog.prototype.addText");
    expect(pluginText).toContain("bitmapBatch");
    expect(pluginText).toContain("withCjkFontFallback");
    expect(pluginText).toContain("Microsoft YaHei");
    expect(pluginText).toContain("hasPendingMessageInput");
    expect(pluginText).toContain("_rpgmtransRuntimeMessageSkipRepaint");
    expect(pluginText).toContain("repaintMessageWindowBody");
    expect(pluginText).toContain("Game_Interpreter.prototype.command101");
    expect(pluginText).toContain("message_event");
    expect(pluginText).toContain("_rpgmtransRuntimeTranslatedText");
    expect(pluginText).not.toContain("skipRepaint || probe.target");
    expect(pluginText).not.toContain("$gameMessage._texts =");
    expect(fs.readFileSync(path.join(game, "js", "plugins.js"), "utf8")).toContain("RPGMTransRuntime");
    expect(fs.existsSync(path.join(game, "RPGMTransRuntime", "backups", "backup-manifest.json"))).toBe(true);
    expect(readRuntimeCache(runtimeCachePath(game)).get(key)?.target).toBe("新游戏");

    const restored = restoreRuntime(profile);
    expect(restored.issues.filter(issue => issue.severity === "fatal" || issue.severity === "error")).toHaveLength(0);
    expect(fs.readFileSync(path.join(game, "js", "plugins.js"), "utf8")).toBe("var $plugins = [];\n");
    expect(fs.existsSync(pluginFile)).toBe(false);
    expect(fs.existsSync(runtimeManifestPath(game))).toBe(false);
    expect(readRuntimeCache(runtimeCachePath(game)).get(key)?.target).toBe("新游戏");
  });

  it("injects and restores a Ren'Py runtime script", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpgmtrans-renpy-install-"));
    fs.mkdirSync(path.join(root, "game"), { recursive: true });
    fs.mkdirSync(path.join(root, "renpy"), { recursive: true });
    fs.writeFileSync(path.join(root, "game", "script.rpy"), "\"Hello\"\n", "utf8");
    fs.writeFileSync(path.join(root, "Game.exe"), "", "utf8");

    const { profile } = scanProject(root, { db: path.join(root, "project.sqlite") });
    const result = installRuntime(profile);
    expect(result.issues.filter(issue => issue.severity === "fatal")).toHaveLength(0);
    const runtimeScript = path.join(root, "game", "rpgmtrans_runtime.rpy");
    expect(fs.existsSync(runtimeScript)).toBe(true);
    expect(fs.readFileSync(runtimeScript, "utf8")).toContain("RPGMTransRuntime bridge for Ren'Py");

    const restored = restoreRuntime(profile);
    expect(restored.issues.filter(issue => issue.severity === "fatal" || issue.severity === "error")).toHaveLength(0);
    expect(fs.existsSync(runtimeScript)).toBe(false);
  });

  it("injects and restores a Tyrano loadjs runtime", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpgmtrans-tyrano-install-"));
    fs.mkdirSync(path.join(root, "data", "scenario"), { recursive: true });
    fs.mkdirSync(path.join(root, "tyrano", "plugins", "kag"), { recursive: true });
    const first = path.join(root, "data", "scenario", "first.ks");
    fs.writeFileSync(path.join(root, "index.html"), "<html></html>", "utf8");
    fs.writeFileSync(first, "Hello\n", "utf8");
    fs.writeFileSync(path.join(root, "tyrano", "plugins", "kag", "kag.js"), "", "utf8");

    const { profile } = scanProject(root, { db: path.join(root, "project.sqlite") });
    const result = installRuntime(profile);
    expect(result.issues.filter(issue => issue.severity === "fatal")).toHaveLength(0);
    expect(fs.existsSync(path.join(root, "data", "others", "rpgmtrans_runtime.js"))).toBe(true);
    const runtimeText = fs.readFileSync(path.join(root, "data", "others", "rpgmtrans_runtime.js"), "utf8");
    expect(runtimeText).toContain("pm.val");
    expect(runtimeText).toContain("chara_ptext");
    expect(runtimeText).toContain("tyrano.plugin.kag.tag");
    expect(runtimeText).toContain("stripTyranoDisplayTags");
    expect(runtimeText).toContain("looksLikeCode");
    expect(runtimeText).toContain("repaintPendingDialogue");
    expect(runtimeText).toContain("recordMiss: false");
    expect(fs.readFileSync(first, "utf8")).toContain('[loadjs storage="rpgmtrans_runtime.js"]');

    const restored = restoreRuntime(profile);
    expect(restored.issues.filter(issue => issue.severity === "fatal" || issue.severity === "error")).toHaveLength(0);
    expect(fs.existsSync(path.join(root, "data", "others", "rpgmtrans_runtime.js"))).toBe(false);
    expect(fs.readFileSync(first, "utf8")).toBe("Hello\n");
  });

  it("injects and restores a Tyrano runtime inside an NW.js executable package", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpgmtrans-tyrano-exe-install-"));
    const exe = path.join(root, "Game.exe");
    writeFakePackagedExe(exe, [
      { name: "data/scenario/first.ks", text: "Hello packaged game\n" },
      { name: "tyrano/plugins/kag/kag.js", text: "window.TYRANO={};" }
    ]);

    const { profile } = scanProject(root, { db: path.join(root, "project.sqlite") });
    const result = installRuntime(profile);

    expect(result.issues.filter(issue => issue.severity === "fatal")).toHaveLength(0);
    expect(readEmbeddedZipText(makeEmbeddedZipPath(exe, "data/scenario/first.ks"))).toContain('[loadjs storage="rpgmtrans_runtime.js"]');
    expect(readEmbeddedZipText(makeEmbeddedZipPath(exe, "data/others/rpgmtrans_runtime.js"))).toContain("RPGMTransRuntime bridge for TyranoScript");
    expect(validateRuntimeInstall(profile).filter(issue => issue.severity === "fatal")).toHaveLength(0);

    const restored = restoreRuntime(profile);
    expect(restored.issues.filter(issue => issue.severity === "fatal" || issue.severity === "error")).toHaveLength(0);
    expect(readEmbeddedZipText(makeEmbeddedZipPath(exe, "data/scenario/first.ks"))).toBe("Hello packaged game\n");
    expect(() => readEmbeddedZipText(makeEmbeddedZipPath(exe, "data/others/rpgmtrans_runtime.js"))).toThrow();
  });
});

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
    local.writeUInt32LE(crc32(source), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(source), 16);
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

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = (() => {
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table.push(value >>> 0);
  }
  return table;
})();
