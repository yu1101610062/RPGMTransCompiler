import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanProject } from "../src/engines/scanner.js";

describe("engine detection", () => {
  it("detects Ren'Py games with compiled scripts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpgmtrans-renpy-scan-"));
    fs.mkdirSync(path.join(root, "game"), { recursive: true });
    fs.mkdirSync(path.join(root, "renpy"), { recursive: true });
    fs.writeFileSync(path.join(root, "game", "script.rpyc"), "compiled", "utf8");
    fs.writeFileSync(path.join(root, "Game.exe"), "", "utf8");

    const { profile } = scanProject(root, { db: path.join(root, "project.sqlite") });
    expect(profile.engine.family).toBe("REN_PY");
    expect(profile.engine.name).toBe("RENPY");
    expect(profile.data.format).toBe("renpy");
    expect(profile.data.files.some(file => file.endsWith("script.rpyc"))).toBe(true);
  });

  it("detects Tyrano games with scenario scripts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpgmtrans-tyrano-scan-"));
    fs.mkdirSync(path.join(root, "data", "scenario"), { recursive: true });
    fs.mkdirSync(path.join(root, "tyrano", "plugins", "kag"), { recursive: true });
    fs.writeFileSync(path.join(root, "index.html"), "<html></html>", "utf8");
    fs.writeFileSync(path.join(root, "data", "scenario", "first.ks"), "Hello", "utf8");
    fs.writeFileSync(path.join(root, "tyrano", "plugins", "kag", "kag.js"), "", "utf8");

    const { profile } = scanProject(root, { db: path.join(root, "project.sqlite") });
    expect(profile.engine.family).toBe("TYRANO");
    expect(profile.engine.name).toBe("TYRANO");
    expect(profile.data.format).toBe("tyrano");
    expect(profile.data.files.some(file => file.endsWith("first.ks"))).toBe(true);
  });
});
