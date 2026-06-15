import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanProject } from "../src/engines/scanner.js";
import { installRuntime, restoreRuntime } from "../src/runtime/install.js";
import { readRuntimeCache, runtimeCachePath, runtimeManifestPath, runtimeTextKey } from "../src/runtime/protocol.js";

describe("runtime install in place", () => {
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
    expect(fs.existsSync(path.join(game, "js", "plugins", "RPGMTransRuntime.js"))).toBe(true);
    expect(fs.readFileSync(path.join(game, "js", "plugins.js"), "utf8")).toContain("RPGMTransRuntime");
    expect(fs.existsSync(path.join(game, "RPGMTransRuntime", "backups", "backup-manifest.json"))).toBe(true);
    expect(readRuntimeCache(runtimeCachePath(game)).get(key)?.target).toBe("新游戏");

    const restored = restoreRuntime(profile);
    expect(restored.issues.filter(issue => issue.severity === "fatal" || issue.severity === "error")).toHaveLength(0);
    expect(fs.readFileSync(path.join(game, "js", "plugins.js"), "utf8")).toBe("var $plugins = [];\n");
    expect(fs.existsSync(path.join(game, "js", "plugins", "RPGMTransRuntime.js"))).toBe(false);
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
    expect(fs.readFileSync(first, "utf8")).toContain('[loadjs storage="rpgmtrans_runtime.js"]');

    const restored = restoreRuntime(profile);
    expect(restored.issues.filter(issue => issue.severity === "fatal" || issue.severity === "error")).toHaveLength(0);
    expect(fs.existsSync(path.join(root, "data", "others", "rpgmtrans_runtime.js"))).toBe(false);
    expect(fs.readFileSync(first, "utf8")).toBe("Hello\n");
  });
});
