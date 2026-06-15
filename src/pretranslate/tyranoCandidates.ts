import fs from "node:fs";
import path from "node:path";
import type { RuntimeProfile, SemanticHint } from "../core/types.js";
import { normalizePath } from "../core/paths.js";
import type { RuntimeTextCandidate } from "./types.js";

export function collectTyranoCandidates(profile: RuntimeProfile): RuntimeTextCandidate[] {
  const files = profile.data.files.length ? profile.data.files : listFiles(path.join(profile.outputRoot, "data", "scenario"), /\.ks$/i);
  const out: RuntimeTextCandidate[] = [];
  for (const file of files) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    collectKs(profile, file, text, out);
  }
  return out;
}

function collectKs(profile: RuntimeProfile, file: string, text: string, out: RuntimeTextCandidate[]): void {
  const rel = normalizePath(path.relative(profile.outputRoot, file).startsWith("..")
    ? path.relative(profile.sourceRoot, file)
    : path.relative(profile.outputRoot, file));
  const lines = text.split(/\r?\n/);
  let inMacro = false;
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("*")) continue;
    if (/^\[(macro|iscript)\b/i.test(line) || /^@(macro|iscript)\b/i.test(line)) {
      inMacro = true;
      continue;
    }
    if (/^\[(endmacro|endscript)\b/i.test(line) || /^@(endmacro|endscript)\b/i.test(line)) {
      inMacro = false;
      continue;
    }
    if (inMacro) continue;

    for (const match of line.matchAll(/\[(?:glink|ptext|button|link|text)\b[^\]]*\btext=(["'])(.*?)\1[^\]]*\]/gi)) {
      add(out, profile, rel, index, decodeKsString(match[2]), "choice", "text");
    }
    for (const match of line.matchAll(/@(?:glink|ptext|button|link|text)\b[^\r\n]*\btext=(["'])(.*?)\1/gi)) {
      add(out, profile, rel, index, decodeKsString(match[2]), "choice", "text");
    }
    for (const match of line.matchAll(/\[chara_name\b[^\]]*\bname=(["'])(.*?)\1[^\]]*\]/gi)) {
      add(out, profile, rel, index, decodeKsString(match[2]), "name", "name");
    }
    for (const match of line.matchAll(/\[link\b[^\]]*\]([\s\S]*?)\[endlink\]/gi)) {
      add(out, profile, rel, index, stripInlineTags(match[1]), "choice", "link");
    }

    if (line.startsWith("[") || line.startsWith("@") || line.startsWith("#")) continue;
    add(out, profile, rel, index, raw, "dialogue", "line");
  }
}

function add(
  out: RuntimeTextCandidate[],
  profile: RuntimeProfile,
  file: string,
  lineIndex: number,
  source: string,
  semanticHint: SemanticHint,
  fieldName: string
): void {
  const value = source.trim();
  if (!isSafeText(value)) return;
  out.push({
    engine: profile.engine.name,
    source: value,
    semanticHint,
    file,
    path: `line:${lineIndex + 1}:${fieldName}`,
    fieldName,
    context: { origin: "pretranslate", engine: "tyrano", file, line: lineIndex + 1, fieldName }
  });
}

function decodeKsString(input: string): string {
  return input
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

function stripInlineTags(input: string): string {
  return input.replace(/\[[^\]\r\n]{1,200}\]/g, "").trim();
}

function isSafeText(value: string): boolean {
  const text = value.trim();
  if (!text || text.length < 2) return false;
  if (/^\[[^\]]+\]$/.test(text)) return false;
  if (/^[A-Za-z0-9_./\\:-]+\.(png|jpg|jpeg|webp|ogg|opus|mp3|wav|ks|js|json)$/i.test(text)) return false;
  if (/^[A-Za-z0-9_./\\:-]+$/.test(text) && /[./\\]/.test(text)) return false;
  if (/^\$?\{.*\}$/.test(text)) return false;
  return /[A-Za-z\u3040-\u30ff\u3400-\u9fff]/.test(text);
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
