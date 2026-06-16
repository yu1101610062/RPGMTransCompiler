import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
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

  it("detects Tyrano games packaged inside an NW.js executable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpgmtrans-tyrano-exe-scan-"));
    writeFakePackagedExe(path.join(root, "Game.exe"), [
      { name: "data/scenario/first.ks", text: "Hello from package" },
      { name: "tyrano/plugins/kag/kag.js", text: "window.TYRANO={};" }
    ]);

    const { profile } = scanProject(root, { db: path.join(root, "project.sqlite") });
    expect(profile.engine.family).toBe("TYRANO");
    expect(profile.engine.name).toBe("TYRANO");
    expect(profile.data.format).toBe("tyrano");
    expect(profile.data.root).toContain("zip://");
    expect(profile.data.files.some(file => file.includes("!/data/scenario/first.ks"))).toBe(true);
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
    const compressed = zlib.deflateRawSync(Buffer.from(entry.text, "utf8"));
    const uncompressedSize = Buffer.byteLength(entry.text, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(uncompressedSize, 24);
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
