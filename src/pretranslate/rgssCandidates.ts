import { spawnSync } from "node:child_process";
import type { RuntimeProfile, SemanticHint } from "../core/types.js";
import { rgssBridgePath } from "../core/paths.js";
import type { RuntimeTextCandidate } from "./types.js";

interface RubyCandidate {
  engine?: string;
  source?: string;
  semanticHint?: string;
  file?: string;
  path?: string;
  context?: Record<string, unknown>;
  commandCode?: number;
  fieldName?: string;
}

export function collectRgssCandidates(profile: RuntimeProfile): RuntimeTextCandidate[] {
  const root = profile.outputRoot;
  const result = spawnSync("ruby", [rgssBridgePath, "dump_candidates", root, profile.engine.name], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Ruby RGSS candidate dump failed: ${result.stderr || result.stdout}`);

  const candidates: RuntimeTextCandidate[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as RubyCandidate;
    if (typeof parsed.source !== "string" || !parsed.source.trim()) continue;
    candidates.push({
      engine: profile.engine.name,
      source: parsed.source,
      semanticHint: normalizeHint(parsed.semanticHint),
      file: parsed.file || "Data",
      path: parsed.path || "",
      context: parsed.context || {},
      commandCode: parsed.commandCode,
      fieldName: parsed.fieldName
    });
  }
  return candidates;
}

function normalizeHint(value: string | undefined): SemanticHint {
  switch (value) {
    case "dialogue":
    case "choice":
    case "description":
    case "name":
    case "system_term":
      return value;
    default:
      return "unknown";
  }
}
