import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Issue, RuntimeProfile, SemanticHint } from "../core/types.js";
import { normalizePath, renpyHelperPath } from "../core/paths.js";
import { sha256File, shortHash } from "../core/hash.js";
import type { RuntimeTextCandidate } from "./types.js";

export function collectRenpyCandidates(profile: RuntimeProfile, issues: Issue[]): RuntimeTextCandidate[] {
  const scripts = prepareRenpyScripts(profile, issues);
  const out: RuntimeTextCandidate[] = [];
  for (const file of scripts) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      issues.push(issue("renpy_script_read_failed", "warning", error instanceof Error ? error.message : String(error), file));
      continue;
    }
    collectScript(profile, file, text, out);
  }
  return out;
}

function prepareRenpyScripts(profile: RuntimeProfile, issues: Issue[]): string[] {
  const gameRoot = profile.data.root;
  const workRoot = path.join(profile.workRoot, "renpy");
  const extractedRoot = path.join(workRoot, "extracted");
  const decompiledRoot = path.join(workRoot, "decompiled");
  fs.mkdirSync(extractedRoot, { recursive: true });
  fs.mkdirSync(decompiledRoot, { recursive: true });

  const sourceFiles = profile.data.files.length ? profile.data.files : listFiles(gameRoot, /\.(rpy|rpyc|rpymc|rpa)$/i);
  const prepared: string[] = [];
  const compiled: string[] = [];

  for (const file of sourceFiles) {
    const ext = path.extname(file).toLowerCase();
    if (ext === ".rpy") {
      prepared.push(file);
    } else if (ext === ".rpyc" || ext === ".rpymc") {
      compiled.push(file);
    } else if (ext === ".rpa") {
      const archiveOut = path.join(extractedRoot, `${path.basename(file)}-${shortHash(sha256File(file))}`);
      const result = runRenpyHelper("extract-rpa", [file, archiveOut]);
      if (!result.ok) {
        issues.push(issue("renpy_rpa_extract_failed", "warning", String(result.error || "Unable to extract RPA scripts."), file));
        continue;
      }
      const extracted = listFiles(archiveOut, /\.(rpy|rpyc|rpymc)$/i);
      for (const item of extracted) {
        const extractedExt = path.extname(item).toLowerCase();
        if (extractedExt === ".rpy") prepared.push(item);
        else compiled.push(item);
      }
    }
  }

  for (const file of compiled) {
    const digest = sha256File(file);
    const output = path.join(decompiledRoot, `${path.basename(file)}-${shortHash(`${digest}\nrenpy-helper-v2`)}.rpy`);
    if (!fs.existsSync(output)) {
      const result = runRenpyHelper("dump-rpyc", [file, output]);
      if (!result.ok) {
        issues.push(issue("renpy_rpyc_decompile_failed", "warning", String(result.error || "Unable to dump RPYC strings."), file));
        continue;
      }
    }
    prepared.push(output);
  }

  return [...new Set(prepared.map(normalizePath))];
}

function collectScript(profile: RuntimeProfile, file: string, text: string, out: RuntimeTextCandidate[]): void {
  const rel = relativeCandidateFile(profile, file);
  const lines = text.split(/\r?\n/);
  let inMacro = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const synthetic = [...trimmed.matchAll(/^['"]((?:\\.|[^'"\\])+)['"],?\s*$/g)];
    for (const match of synthetic) add(out, profile, rel, linePath(index, "compiled"), decodePythonString(match[1]), "dialogue", "compiled");

    const old = /^\s*old\s+(['"])((?:\\.|(?!\1).)+)\1/.exec(line);
    if (old) add(out, profile, rel, linePath(index, "old"), decodePythonString(old[2]), "dialogue", "old");

    const menu = /^\s*(['"])((?:\\.|(?!\1).)+)\1\s*:/.exec(line);
    if (menu) add(out, profile, rel, linePath(index, "menu"), decodePythonString(menu[2]), "choice", "menu");

    const screen = /^\s*(?:text|textbutton|label)\s+(['"])((?:\\.|(?!\1).)+)\1/.exec(line);
    if (screen) add(out, profile, rel, linePath(index, "screen"), decodePythonString(screen[2]), "system_term", "screen");

    const say = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*\s+)?(['"])((?:\\.|(?!\1).)+)\1\s*(?:#.*)?$/.exec(line);
    if (say && !/^(old|new|text|textbutton|label)\b/.test(trimmed)) {
      add(out, profile, rel, linePath(index, "say"), decodePythonString(say[2]), "dialogue", "say");
    }

    for (const match of line.matchAll(/_{1,2}\(\s*(['"])((?:\\.|(?!\1).)+)\1\s*\)/g)) {
      add(out, profile, rel, linePath(index, "string"), decodePythonString(match[2]), "system_term", "string");
    }

    if (/^\s*init\s+python\b|^\s*python\b/.test(line)) inMacro = true;
    if (inMacro && !/^\s+/.test(line) && trimmed) inMacro = false;
  }
}

function add(
  out: RuntimeTextCandidate[],
  profile: RuntimeProfile,
  file: string,
  candidatePath: string,
  source: string,
  semanticHint: SemanticHint,
  fieldName: string
): void {
  if (!isSafeText(source)) return;
  out.push({
    engine: profile.engine.name,
    source,
    semanticHint,
    file,
    path: candidatePath,
    fieldName,
    context: { origin: "pretranslate", engine: "renpy", file, path: candidatePath, fieldName }
  });
}

function decodePythonString(input: string): string {
  return input
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

function isSafeText(value: string): boolean {
  const text = value.trim();
  if (!text || text.length < 2) return false;
  if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(text)) return false;
  if (/^[A-Za-z0-9_./\\:-]+\.(png|jpg|jpeg|webp|ogg|opus|mp3|wav|rpy|rpyc|rpymc|rpa)$/i.test(text)) return false;
  if (/^(renpy|config|style|store)\./.test(text)) return false;
  return /[A-Za-z\u3040-\u30ff\u3400-\u9fff]/.test(text);
}

function runRenpyHelper(command: string, args: string[]): Record<string, unknown> & { ok?: boolean; error?: string } {
  const result = spawnSync("python", [renpyHelperPath, command, ...args], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024
  });
  if (result.error) return { ok: false, error: result.error.message };
  const output = (result.stdout || "").trim();
  if (!output) return { ok: false, error: result.stderr || `renpy helper exited ${result.status}` };
  try {
    return JSON.parse(output) as Record<string, unknown> & { ok?: boolean; error?: string };
  } catch {
    return { ok: false, error: output.slice(0, 500) };
  }
}

function relativeCandidateFile(profile: RuntimeProfile, file: string): string {
  const root = fs.existsSync(profile.outputRoot) ? profile.outputRoot : profile.sourceRoot;
  const rel = path.relative(root, file);
  if (!rel.startsWith("..")) return normalizePath(rel);
  return normalizePath(path.relative(profile.workRoot, file));
}

function linePath(index: number, kind: string): string {
  return `line:${index + 1}:${kind}`;
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
