import type { Placeholder, PlaceholderSet } from "../core/types.js";

const tokenPatterns: Array<{ kind: string; regex: RegExp; allowReorder: boolean }> = [
  { kind: "tyrano.tag", regex: /\[[A-Za-z_][A-Za-z0-9_]*(?:\s+[^\]\r\n]{0,240})?\]/g, allowReorder: false },
  { kind: "renpy.text_tag", regex: /\{\/?[A-Za-z][A-Za-z0-9_]*(?:=[^{}\r\n]{0,120})?\}/g, allowReorder: false },
  { kind: "rpgm.control.indexed", regex: /[\\\x1b][VvNnPpCcIiSs]\[\d+\]/g, allowReorder: true },
  { kind: "rpgm.control.bracket", regex: /[\\\x1b][A-Za-z]{1,12}\[[^\]\r\n]{0,80}\]/g, allowReorder: true },
  { kind: "rpgm.control.single", regex: /[\\\x1b][Gg.!|><^{}\\]/g, allowReorder: true },
  { kind: "ruby.interpolation", regex: /#\{[^}]*\}/g, allowReorder: false },
  { kind: "js.template.expression", regex: /\$\{[^}]*\}/g, allowReorder: false },
  { kind: "printf", regex: /%(?:\d+\$)?[-+#0 ]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[bcdeEufFgGosxX]/g, allowReorder: true },
  { kind: "rpgm.percent_arg", regex: /%\d+/g, allowReorder: true },
  { kind: "html.tag", regex: /<\/?[A-Za-z][^>\n]{0,120}>/g, allowReorder: false },
  { kind: "brace.template", regex: /\{\{[^{}\n]{1,80}\}\}|\{[A-Za-z_][A-Za-z0-9_.-]{0,80}\}/g, allowReorder: true }
];

export function protectPlaceholders(source: string): PlaceholderSet {
  const matches: Array<{ start: number; end: number; raw: string; kind: string; allowReorder: boolean }> = [];
  for (const pattern of tokenPatterns) {
    pattern.regex.lastIndex = 0;
    for (const match of source.matchAll(pattern.regex)) {
      if (match.index === undefined) continue;
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        raw: match[0],
        kind: pattern.kind,
        allowReorder: pattern.allowReorder
      });
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end);

  const accepted: typeof matches = [];
  let lastEnd = -1;
  for (const match of matches) {
    if (match.start < lastEnd) continue;
    accepted.push(match);
    lastEnd = match.end;
  }

  const placeholders: Placeholder[] = [];
  let cursor = 0;
  let protectedText = "";
  for (const match of accepted) {
    protectedText += source.slice(cursor, match.start);
    const id = String(placeholders.length);
    protectedText += `<PH_${id}/>`;
    placeholders.push({ id, raw: match.raw, kind: match.kind, allowReorder: match.allowReorder });
    cursor = match.end;
  }
  protectedText += source.slice(cursor);

  return {
    source,
    protected: protectedText,
    placeholders
  };
}

export function restorePlaceholders(text: string, placeholders: Placeholder[]): string {
  let restored = text;
  for (const placeholder of placeholders) {
    restored = restored.replaceAll(`<PH_${placeholder.id}/>`, placeholder.raw);
  }
  return restored;
}

export function validatePlaceholders(text: string, placeholders: Placeholder[]): { ok: true } | { ok: false; message: string } {
  const expected = new Map(placeholders.map(placeholder => [`<PH_${placeholder.id}/>`, placeholder]));
  const seen = [...text.matchAll(/<PH_(\d+)\/>/g)].map(match => match[0]);
  for (const token of expected.keys()) {
    if (!seen.includes(token)) return { ok: false, message: `Missing placeholder ${token}` };
  }
  for (const token of seen) {
    if (!expected.has(token)) return { ok: false, message: `Unexpected placeholder ${token}` };
  }
  for (const placeholder of placeholders) {
    if (!placeholder.allowReorder) {
      const protectedToken = `<PH_${placeholder.id}/>`;
      if (!text.includes(protectedToken)) return { ok: false, message: `Locked placeholder moved or removed: ${protectedToken}` };
    }
  }
  return { ok: true };
}
