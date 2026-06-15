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
      add(out, profile, file, `${basePath}[${index}].parameters[0]`, params[0], "dialogue", "message", code);
    } else if (code === 102 && Array.isArray(params[0])) {
      params[0].forEach((choice, choiceIndex) => add(out, profile, file, `${basePath}[${index}].parameters[0][${choiceIndex}]`, choice, "choice", "choice", code));
    } else if (code === 405 && typeof params[0] === "string") {
      scrollLines.push({ text: params[0], index });
      add(out, profile, file, `${basePath}[${index}].parameters[0]`, params[0], "dialogue", "scroll", code);
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
  commandCode?: number
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
    context: { origin: "pretranslate", file, path: candidatePath, fieldName, commandCode }
  });
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
