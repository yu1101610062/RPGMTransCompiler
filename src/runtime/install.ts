import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Issue, RuntimeProfile } from "../core/types.js";
import { writeJson } from "../core/fs.js";
import { sha256File } from "../core/hash.js";
import { normalizePath, rgssBridgePath, rgssRuntimeScriptPath } from "../core/paths.js";
import { RgssArchive } from "../engines/rgss/archive.js";
import { buildMvMzRuntimePlugin } from "./mvmzPlugin.js";
import { ensureRuntimeDirs, runtimeManifestPath, runtimeRoot, type RuntimeInstallManifest } from "./protocol.js";

const BACKUP_DIR = "backups";
const BACKUP_MANIFEST = "backup-manifest.json";

export interface RuntimeInstallResult {
  outputRoot: string;
  installed: boolean;
  issues: Issue[];
}

export interface RuntimeRestoreResult {
  outputRoot: string;
  restored: number;
  deleted: number;
  issues: Issue[];
}

interface RuntimeBackupManifest {
  version: 1;
  gameRoot: string;
  createdAt: string;
  updatedAt: string;
  entries: RuntimeBackupEntry[];
}

interface RuntimeBackupEntry {
  path: string;
  existed: boolean;
  backupFile?: string;
  sha256?: string;
  size?: number;
  backedUpAt: string;
}

export function installRuntime(profile: RuntimeProfile): RuntimeInstallResult {
  prepareRuntimeRoot(profile);
  ensureRuntimeDirs(profile.outputRoot);

  const issues: Issue[] = [];
  if (profile.engine.name === "MV" || profile.engine.name === "MZ") {
    installMvMzRuntime(profile, issues);
  } else if (["XP", "VX", "VXA"].includes(profile.engine.name)) {
    installRgssRuntime(profile, issues);
  } else {
    issues.push(issue("runtime_engine_unsupported", "fatal", `Runtime bridge does not support ${profile.engine.name}.`));
  }

  const manifest: RuntimeInstallManifest = {
    version: 1,
    projectId: profile.projectId,
    engine: profile.engine.name,
    targetLang: profile.targetLang,
    sourceRoot: normalizePath(profile.sourceRoot),
    outputRoot: normalizePath(profile.outputRoot),
    installedAt: new Date().toISOString(),
    plugin: {
      name: "RPGMTransRuntime",
      protocol: 1
    }
  };
  writeJson(runtimeManifestPath(profile.outputRoot), manifest);
  return { outputRoot: profile.outputRoot, installed: issues.every(item => item.severity !== "fatal"), issues };
}

export function restoreRuntime(profile: RuntimeProfile): RuntimeRestoreResult {
  const issues: Issue[] = [];
  const root = profile.outputRoot;
  const manifest = loadBackupManifest(root);
  if (!manifest) {
    issues.push(issue("runtime_backup_missing", "warning", `No runtime backup manifest was found in ${root}.`));
    return { outputRoot: root, restored: 0, deleted: 0, issues };
  }

  let restored = 0;
  let deleted = 0;
  for (const entry of [...manifest.entries].reverse()) {
    const target = path.join(root, ...entry.path.split("/"));
    try {
      if (entry.existed) {
        if (!entry.backupFile) throw new Error(`Backup file is missing for ${entry.path}`);
        const backup = path.join(runtimeRoot(root), entry.backupFile);
        if (!fs.existsSync(backup)) throw new Error(`Backup file does not exist: ${backup}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(backup, target);
        restored++;
      } else {
        if (fs.existsSync(target)) {
          fs.rmSync(target, { force: true });
          removeEmptyParents(path.dirname(target), root);
          deleted++;
        }
      }
    } catch (error) {
      issues.push(issue("runtime_restore_failed", "error", error instanceof Error ? error.message : String(error), entry));
    }
  }

  for (const rel of ["manifest.json"]) {
    const file = path.join(runtimeRoot(root), rel);
    try {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    } catch (error) {
      issues.push(issue("runtime_restore_cleanup_failed", "warning", error instanceof Error ? error.message : String(error), { file }));
    }
  }

  return { outputRoot: root, restored, deleted, issues };
}

export function validateRuntimeInstall(profile: RuntimeProfile): Issue[] {
  const issues: Issue[] = [];
  const manifest = runtimeManifestPath(profile.outputRoot);
  if (!fs.existsSync(manifest)) {
    issues.push(issue("runtime_manifest_missing", "fatal", `Runtime manifest is missing: ${manifest}`));
  }
  const runtimeDir = path.join(profile.outputRoot, "RPGMTransRuntime");
  for (const rel of ["requests", "cache", "diag", path.join("cache", "translations.rtc")]) {
    const full = path.join(runtimeDir, rel);
    if (!fs.existsSync(full)) issues.push(issue("runtime_file_missing", "error", `Runtime file or directory is missing: ${full}`));
  }
  if (profile.engine.name === "MV" || profile.engine.name === "MZ") {
    const jsRoot = findMvMzJsRoot(profile.outputRoot);
    if (!jsRoot) {
      issues.push(issue("mvmz_js_root_missing", "fatal", `Unable to locate MV/MZ js root in ${profile.outputRoot}`));
    } else {
      const pluginFile = path.join(jsRoot, "plugins", "RPGMTransRuntime.js");
      const pluginsJs = path.join(jsRoot, "plugins.js");
      if (!fs.existsSync(pluginFile)) issues.push(issue("mvmz_runtime_plugin_missing", "fatal", `Plugin file is missing: ${pluginFile}`));
      if (!fs.existsSync(pluginsJs) || !fs.readFileSync(pluginsJs, "utf8").includes("RPGMTransRuntime")) {
        issues.push(issue("mvmz_plugins_js_not_registered", "fatal", "RPGMTransRuntime is not registered in plugins.js."));
      }
    }
  }
  if (["XP", "VX", "VXA"].includes(profile.engine.name)) {
    const scripts = findRgssScriptsFile(profile.outputRoot);
    if (!scripts) issues.push(issue("rgss_scripts_missing", "fatal", "Scripts data file is missing after runtime install."));
  }
  return issues;
}

function prepareRuntimeRoot(profile: RuntimeProfile): void {
  const source = path.resolve(profile.sourceRoot).toLowerCase();
  const output = path.resolve(profile.outputRoot).toLowerCase();
  if (source !== output) {
    throw new Error("Runtime install now modifies the selected game directory in place. Output root must equal source root.");
  }
  if (!fs.existsSync(profile.outputRoot) || !fs.statSync(profile.outputRoot).isDirectory()) {
    throw new Error(`Game directory does not exist: ${profile.outputRoot}`);
  }
}

function installMvMzRuntime(profile: RuntimeProfile, issues: Issue[]): void {
  const jsRoot = findMvMzJsRoot(profile.outputRoot);
  if (!jsRoot) {
    issues.push(issue("mvmz_js_root_missing", "fatal", `Unable to locate MV/MZ js root in ${profile.outputRoot}`));
    return;
  }
  const pluginDir = path.join(jsRoot, "plugins");
  fs.mkdirSync(pluginDir, { recursive: true });
  const pluginFile = path.join(pluginDir, "RPGMTransRuntime.js");
  backupFile(profile.outputRoot, relativeGamePath(profile.outputRoot, pluginFile));
  fs.writeFileSync(pluginFile, buildMvMzRuntimePlugin(profile.engine.name, profile.targetLang), "utf8");

  const pluginsJs = path.join(jsRoot, "plugins.js");
  backupFile(profile.outputRoot, relativeGamePath(profile.outputRoot, pluginsJs));
  if (!fs.existsSync(pluginsJs)) {
    fs.writeFileSync(pluginsJs, "var $plugins = [];\n", "utf8");
  }
  let text = fs.readFileSync(pluginsJs, "utf8");
  if (!text.includes('"name":"RPGMTransRuntime"') && !text.includes('"name": "RPGMTransRuntime"')) {
    const entry = '{"name":"RPGMTransRuntime","status":true,"description":"Runtime translation bridge","parameters":{}}';
    const index = text.lastIndexOf("];");
    if (index < 0) {
      issues.push(issue("mvmz_plugins_js_invalid", "fatal", `Unable to update plugins.js: ${pluginsJs}`));
      return;
    }
    const prefix = text.slice(0, index).trimEnd();
    const suffix = text.slice(index);
    const needsComma = !/\[\s*$/.test(prefix);
    text = `${prefix}${needsComma ? "," : ""}\n${entry}\n${suffix}`;
    fs.writeFileSync(pluginsJs, text, "utf8");
  }
}

function installRgssRuntime(profile: RuntimeProfile, issues: Issue[]): void {
  ensureRgssArchiveExtracted(profile, issues);
  if (issues.some(item => item.severity === "fatal")) return;
  const scriptsFile = findRgssScriptsFile(profile.outputRoot);
  if (scriptsFile) backupFile(profile.outputRoot, relativeGamePath(profile.outputRoot, scriptsFile));
  const result = runRubyBridge("install_runtime", [profile.outputRoot, rgssRuntimeScriptPath, profile.engine.name, profile.targetLang]);
  if (!result.installed) {
    issues.push(issue("rgss_runtime_install_failed", "fatal", String(result.reason || "RGSS runtime install failed."), result));
    return;
  }
  if (profile.engine.name === "VXA") {
    const patch = runRubyBridge("patch_acezon_f12", [profile.outputRoot]);
    if (patch.reason) {
      issues.push(issue("rgss_runtime_patch_skipped", "info", String(patch.reason), patch));
    }
  }
}

function ensureRgssArchiveExtracted(profile: RuntimeProfile, issues: Issue[]): void {
  if (!profile.archive) return;
  const archiveRel = relativeGamePath(profile.outputRoot, profile.archive.path);
  const disabledArchiveRel = `${archiveRel}.rpgmtrans-disabled`;
  const archivePath = path.join(profile.outputRoot, ...archiveRel.split("/"));
  const disabledArchivePath = path.join(profile.outputRoot, ...disabledArchiveRel.split("/"));
  if (!fs.existsSync(archivePath)) {
    if (fs.existsSync(disabledArchivePath) && findRgssScriptsFile(profile.outputRoot)) return;
    issues.push(issue("rgss_archive_missing", "fatal", `RGSS archive is missing: ${archivePath}`));
    return;
  }
  const archive = new RgssArchive(profile.archive.path);
  try {
    for (const entry of archive.info.entries) {
      const output = path.join(profile.outputRoot, ...entry.name.split("/"));
      if (fs.existsSync(output)) continue;
      backupFile(profile.outputRoot, entry.name);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, archive.readEntry(entry));
    }
  } catch (error) {
    issues.push(issue("rgss_archive_extract_failed", "fatal", error instanceof Error ? error.message : String(error)));
  } finally {
    archive.close();
  }
  if (!issues.some(item => item.type === "rgss_archive_extract_failed" && item.severity === "fatal")) {
    try {
      if (fs.existsSync(archivePath)) {
        backupFile(profile.outputRoot, archiveRel);
        backupFile(profile.outputRoot, disabledArchiveRel);
        if (!fs.existsSync(disabledArchivePath)) fs.renameSync(archivePath, disabledArchivePath);
      }
    } catch (error) {
      issues.push(issue("rgss_archive_disable_failed", "fatal", error instanceof Error ? error.message : String(error)));
    }
  }
}

function runRubyBridge(command: string, args: string[]): Record<string, unknown> {
  const result = spawnSync("ruby", [rgssBridgePath, command, ...args], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Ruby RGSS bridge failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function findMvMzJsRoot(root: string): string | undefined {
  for (const rel of ["js", path.join("www", "js")]) {
    const candidate = path.join(root, rel);
    if (fs.existsSync(path.join(candidate, "rpg_core.js")) || fs.existsSync(path.join(candidate, "rmmz_core.js")) || fs.existsSync(path.join(candidate, "plugins.js"))) {
      return candidate;
    }
  }
  return undefined;
}

function findRgssScriptsFile(root: string): string | undefined {
  for (const name of ["Scripts.rvdata2", "Scripts.rvdata", "Scripts.rxdata"]) {
    const file = path.join(root, "Data", name);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

function backupFile(root: string, relPath: string): void {
  const rel = normalizeRelPath(relPath);
  if (!rel || rel.startsWith("../") || path.isAbsolute(rel)) throw new Error(`Invalid backup path: ${relPath}`);
  const manifest = loadBackupManifest(root) || newBackupManifest(root);
  if (manifest.entries.some(entry => entry.path === rel)) return;

  const target = path.join(root, ...rel.split("/"));
  const entry: RuntimeBackupEntry = {
    path: rel,
    existed: fs.existsSync(target),
    backedUpAt: new Date().toISOString()
  };
  if (entry.existed) {
    const backupFile = path.join(BACKUP_DIR, "original", `${Buffer.from(rel, "utf8").toString("hex")}.bak`);
    const backupFull = path.join(runtimeRoot(root), backupFile);
    fs.mkdirSync(path.dirname(backupFull), { recursive: true });
    fs.copyFileSync(target, backupFull);
    entry.backupFile = backupFile.replace(/\\/g, "/");
    entry.sha256 = sha256File(target);
    entry.size = fs.statSync(target).size;
  }
  manifest.entries.push(entry);
  manifest.updatedAt = new Date().toISOString();
  saveBackupManifest(root, manifest);
}

function loadBackupManifest(root: string): RuntimeBackupManifest | undefined {
  const file = backupManifestPath(root);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as RuntimeBackupManifest;
  } catch {
    return undefined;
  }
}

function newBackupManifest(root: string): RuntimeBackupManifest {
  const now = new Date().toISOString();
  return {
    version: 1,
    gameRoot: normalizePath(root),
    createdAt: now,
    updatedAt: now,
    entries: []
  };
}

function saveBackupManifest(root: string, manifest: RuntimeBackupManifest): void {
  const file = backupManifestPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function backupManifestPath(root: string): string {
  return path.join(runtimeRoot(root), BACKUP_DIR, BACKUP_MANIFEST);
}

function relativeGamePath(root: string, file: string): string {
  return normalizeRelPath(path.relative(root, file));
}

function normalizeRelPath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function removeEmptyParents(start: string, root: string): void {
  let current = path.resolve(start);
  const boundary = path.resolve(root);
  while (current.startsWith(boundary) && current !== boundary) {
    if (!fs.existsSync(current)) {
      current = path.dirname(current);
      continue;
    }
    if (fs.readdirSync(current).length > 0) return;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function issue(type: string, severity: Issue["severity"], message: string, payload?: unknown): Issue {
  return {
    issueId: `${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    severity,
    message,
    payload,
    createdAt: new Date().toISOString()
  };
}
