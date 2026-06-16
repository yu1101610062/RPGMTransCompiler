import fs from "node:fs";
import path from "node:path";
import type { RuntimeProfile, SemanticHint } from "../core/types.js";
import { normalizePath } from "../core/paths.js";
import type { RuntimeTextCandidate } from "./types.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function collectMvMzCandidates(profile: RuntimeProfile): RuntimeTextCandidate[] {
  const files = profile.data.files.length ? profile.data.files : listJsonFiles(profile.data.root);
  const out: RuntimeTextCandidate[] = [];
  for (const file of files) {
    const base = path.basename(file, ".json");
    let data: JsonValue;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8")) as JsonValue;
    } catch {
      continue;
    }
    const rel = normalizePath(path.relative(profile.outputRoot, file).startsWith("..")
      ? path.relative(profile.sourceRoot, file)
      : path.relative(profile.outputRoot, file));
    collectFile(profile, rel, base, data, out);
  }
  collectPluginManagerParameters(profile, out);
  return out;
}

function collectFile(profile: RuntimeProfile, file: string, base: string, data: JsonValue, out: RuntimeTextCandidate[]): void {
  if (base === "System" && isObject(data)) {
    add(out, profile, file, "$.gameTitle", data.gameTitle, "system_term", "gameTitle");
    add(out, profile, file, "$.currencyUnit", data.currencyUnit, "system_term", "currencyUnit");
    collectTerms(profile, file, data.terms, out);
    return;
  }

  if (base === "MapInfos" && Array.isArray(data)) {
    data.forEach((item, index) => {
      if (isObject(item)) add(out, profile, file, `$[${index}].name`, item.name, "name", "name");
    });
    return;
  }

  if (/^Map\d+$/i.test(base) && isObject(data)) {
    add(out, profile, file, "$.displayName", data.displayName, "name", "displayName");
    const events = data.events;
    if (Array.isArray(events)) {
      events.forEach((event, eventIndex) => {
        if (!isObject(event)) return;
        const pages = Array.isArray(event.pages) ? event.pages : [];
        pages.forEach((page, pageIndex) => {
          if (isObject(page)) collectCommands(profile, file, `$.events[${eventIndex}].pages[${pageIndex}].list`, page.list, out);
        });
      });
    }
    return;
  }

  if (base === "CommonEvents" && Array.isArray(data)) {
    data.forEach((event, index) => {
      if (isObject(event)) collectCommands(profile, file, `$[${index}].list`, event.list, out);
    });
    return;
  }

  if (base === "Troops" && Array.isArray(data)) {
    data.forEach((troop, troopIndex) => {
      if (!isObject(troop)) return;
      add(out, profile, file, `$[${troopIndex}].name`, troop.name, "name", "name");
      const pages = Array.isArray(troop.pages) ? troop.pages : [];
      pages.forEach((page, pageIndex) => {
        if (isObject(page)) collectCommands(profile, file, `$[${troopIndex}].pages[${pageIndex}].list`, page.list, out);
      });
    });
    return;
  }

  if (Array.isArray(data)) collectDatabaseArray(profile, file, base, data, out);
}

function collectDatabaseArray(profile: RuntimeProfile, file: string, base: string, data: JsonValue[], out: RuntimeTextCandidate[]): void {
  const fields = databaseFields(base);
  if (!fields.length) return;
  data.forEach((item, index) => {
    if (!isObject(item)) return;
    for (const [field, hint] of fields) {
      add(out, profile, file, `$[${index}].${field}`, item[field], hint, field);
    }
  });
}

function databaseFields(base: string): Array<[string, SemanticHint]> {
  switch (base) {
    case "Actors":
      return [["name", "name"], ["nickname", "name"], ["profile", "description"]];
    case "Classes":
    case "Enemies":
      return [["name", "name"]];
    case "Skills":
      return [["name", "name"], ["description", "description"], ["message1", "description"], ["message2", "description"]];
    case "Items":
    case "Weapons":
    case "Armors":
      return [["name", "name"], ["description", "description"]];
    case "States":
      return [["name", "name"], ["message1", "description"], ["message2", "description"], ["message3", "description"], ["message4", "description"]];
    default:
      return [];
  }
}

function collectTerms(profile: RuntimeProfile, file: string, terms: JsonValue | undefined, out: RuntimeTextCandidate[]): void {
  if (!isObject(terms)) return;
  for (const key of ["basic", "params", "commands"] as const) {
    const value = terms[key];
    if (Array.isArray(value)) {
      value.forEach((item, index) => add(out, profile, file, `$.terms.${key}[${index}]`, item, "system_term", key));
    }
  }
  if (isObject(terms.messages)) {
    for (const [key, value] of Object.entries(terms.messages)) {
      add(out, profile, file, `$.terms.messages.${key}`, value, "system_term", key);
    }
  }
}

function collectCommands(profile: RuntimeProfile, file: string, basePath: string, list: JsonValue | undefined, out: RuntimeTextCandidate[]): void {
  if (!Array.isArray(list)) return;
  let messageLines: Array<{ text: string; index: number }> = [];
  let scrollLines: Array<{ text: string; index: number }> = [];

  const flushMessages = () => {
    if (messageLines.length > 1) {
      add(out, profile, file, `${basePath}[${messageLines[0].index}..${messageLines.at(-1)!.index}]`, messageLines.map(line => line.text).join("\n"), "dialogue", "message", 401);
    } else if (messageLines.length === 1) {
      const line = messageLines[0];
      add(out, profile, file, `${basePath}[${line.index}].parameters[0]`, line.text, "dialogue", "message", 401);
    }
    messageLines = [];
  };
  const flushScroll = () => {
    if (scrollLines.length > 0) {
      add(out, profile, file, `${basePath}[${scrollLines[0].index}..${scrollLines.at(-1)!.index}]`, scrollLines.map(line => line.text).join("\n"), "dialogue", "scroll", 405);
    }
    scrollLines = [];
  };

  list.forEach((command, index) => {
    if (!isObject(command)) return;
    const code = typeof command.code === "number" ? command.code : undefined;
    const params = Array.isArray(command.parameters) ? command.parameters : [];
    if (code !== 401) flushMessages();
    if (code !== 405) flushScroll();

    if (code === 401 && typeof params[0] === "string") {
      messageLines.push({ text: params[0], index });
    } else if (code === 102 && Array.isArray(params[0])) {
      params[0].forEach((choice, choiceIndex) => add(out, profile, file, `${basePath}[${index}].parameters[0][${choiceIndex}]`, choice, "choice", "choice", code));
    } else if (code === 402 && typeof params[1] === "string") {
      add(out, profile, file, `${basePath}[${index}].parameters[1]`, params[1], "choice", "choice_branch", code);
    } else if (code === 405 && typeof params[0] === "string") {
      scrollLines.push({ text: params[0], index });
    } else if ((code === 108 || code === 408) && typeof params[0] === "string") {
      add(out, profile, file, `${basePath}[${index}].parameters[0]`, params[0], "comment", "comment", code, "review");
    } else if ((code === 355 || code === 655) && typeof params[0] === "string") {
      add(out, profile, file, `${basePath}[${index}].parameters[0]`, params[0], "script", "script", code, "review");
    } else if (code === 356 && typeof params[0] === "string") {
      add(out, profile, file, `${basePath}[${index}].parameters[0]`, params[0], "script", "plugin_command_mv", code, "review");
    } else if (code === 357) {
      collectPluginCommandParameters(profile, file, `${basePath}[${index}]`, params, out);
    }
  });
  flushMessages();
  flushScroll();
}

function add(
  out: RuntimeTextCandidate[],
  profile: RuntimeProfile,
  file: string,
  candidatePath: string,
  value: JsonValue | undefined,
  semanticHint: SemanticHint,
  fieldName: string,
  commandCode?: number,
  action: RuntimeTextCandidate["action"] = "translate"
): void {
  if (typeof value !== "string") return;
  if (!isSafeText(value)) return;
  out.push({
    engine: profile.engine.name,
    source: value,
    semanticHint,
    file,
    path: candidatePath,
    fieldName,
    commandCode,
    action,
    context: { origin: "pretranslate", file, path: candidatePath, fieldName, commandCode, action }
  });
}

function collectPluginCommandParameters(profile: RuntimeProfile, file: string, basePath: string, params: JsonValue[], out: RuntimeTextCandidate[]): void {
  params.forEach((param, index) => {
    collectNestedStrings(profile, file, `${basePath}.parameters[${index}]`, param, "plugin_command_mz", out);
  });
}

function collectPluginManagerParameters(profile: RuntimeProfile, out: RuntimeTextCandidate[]): void {
  const managerFile = profile.plugins?.managerFile || findPluginsJs(profile);
  if (!managerFile || !fs.existsSync(managerFile)) return;
  let entries: unknown;
  try {
    entries = parsePluginsJs(fs.readFileSync(managerFile, "utf8"));
  } catch {
    return;
  }
  if (!Array.isArray(entries)) return;
  const file = normalizePath(path.relative(profile.outputRoot, managerFile).startsWith("..")
    ? path.relative(profile.sourceRoot, managerFile)
    : path.relative(profile.outputRoot, managerFile));
  entries.forEach((entry, pluginIndex) => {
    if (!isObject(entry as JsonValue)) return;
    const parameters = (entry as { [key: string]: JsonValue }).parameters;
    collectNestedStrings(profile, file, `$plugins[${pluginIndex}].parameters`, parameters, "plugin_parameter", out);
  });
}

function collectNestedStrings(
  profile: RuntimeProfile,
  file: string,
  basePath: string,
  value: JsonValue | undefined,
  fieldName: string,
  out: RuntimeTextCandidate[]
): void {
  if (typeof value === "string") {
    add(out, profile, file, basePath, value, "script", fieldName, undefined, "review");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectNestedStrings(profile, file, `${basePath}[${index}]`, item, fieldName, out));
    return;
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) collectNestedStrings(profile, file, `${basePath}.${key}`, item, fieldName, out);
  }
}

function findPluginsJs(profile: RuntimeProfile): string | undefined {
  for (const root of [profile.outputRoot, profile.sourceRoot]) {
    for (const rel of ["js/plugins.js", "www/js/plugins.js"]) {
      const candidate = path.join(root, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function parsePluginsJs(text: string): unknown {
  const marker = text.indexOf("$plugins");
  const start = text.indexOf("[", marker < 0 ? 0 : marker);
  if (start < 0) return [];
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === "[") depth++;
    if (char === "]") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  return [];
}

function isSafeText(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (/^<[^>\n]+>$/.test(text)) return false;
  if (/^[A-Za-z0-9_./\\:-]+\.(png|jpg|jpeg|webp|ogg|m4a|mp3|wav|json|js)$/i.test(text)) return false;
  if (/^[A-Za-z0-9_./\\:-]+$/.test(text) && /[./\\]/.test(text)) return false;
  return true;
}

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function listJsonFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter(name => name.endsWith(".json"))
    .map(name => path.join(root, name));
}
