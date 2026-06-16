import type { EligibilityResult } from "../core/types.js";
import { protectPlaceholders } from "../extractors/placeholders.js";

const RESOURCE_PATH_RE = /^[A-Za-z0-9_./\\:@%+\- ]+\.(?:png|jpe?g|webp|gif|bmp|ogg|m4a|mp3|wav|flac|json|js|mjs|css|html?|ttf|otf|woff2?|rpgmvp|rpgmvo|rpgmvm)$/i;
const PATH_LIKE_RE = /^(?:[A-Za-z]:)?[A-Za-z0-9_. -]+(?:[\\/][A-Za-z0-9_. -]+)+$/;
const SYMBOL_ONLY_RE = /^[\s\d\p{P}\p{S}_]+$/u;
const NATURAL_TEXT_RE = /[\p{L}\p{N}]/u;
const CODE_LIKE_RE = /^(?:[$A-Za-z_][\w$]*\.)+[$A-Za-z_][\w$]*(?:\(.*\))?$|^(?:true|false|null|undefined|NaN)$/i;

export function evaluateRuntimeText(source: string, targetLang: string): EligibilityResult {
  const text = source.trim();
  if (!text) return result(false, "empty text", "empty");
  if (text.startsWith(`[${targetLang}]`)) return result(false, "already has target-language marker", "already_translated");
  if (looksLikePlaceholderOnly(text)) return result(false, "placeholder-only text", "placeholder_only");
  if (visibleLength(text) <= 1) return result(false, "single visible character", "too_short");
  if (RESOURCE_PATH_RE.test(text) || PATH_LIKE_RE.test(text)) return result(false, "resource or path-like text", "resource");
  if (looksLikeCode(text)) return result(false, "code-like text", "code");
  if (!NATURAL_TEXT_RE.test(text) || SYMBOL_ONLY_RE.test(text)) return result(false, "symbol-only text", "symbol_only");
  return result(true, "translatable", "ok");
}

export function shouldTranslateRuntimeText(source: string, targetLang: string): boolean {
  return evaluateRuntimeText(source, targetLang).ok;
}

function looksLikePlaceholderOnly(text: string): boolean {
  if (/^<PH_\d+\/>$/.test(text)) return true;
  if (/^<\/?[A-Za-z][^>\n]{0,120}>$/.test(text)) return true;
  const protectedSet = protectPlaceholders(text);
  if (!protectedSet.placeholders.length) return false;
  return protectedSet.protected.replace(/<PH_\d+\/>/g, "").trim().length === 0;
}

function looksLikeCode(text: string): boolean {
  if (CODE_LIKE_RE.test(text)) return true;
  if (/^[{}[\](),.;:+\-*/%<>=!&|"'`~\s]+$/.test(text)) return true;
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function visibleLength(text: string): number {
  const withoutPlaceholders = protectPlaceholders(text).protected.replace(/<PH_\d+\/>/g, "");
  return Array.from(withoutPlaceholders.trim()).length;
}

function result(ok: boolean, reason: string, category: EligibilityResult["category"]): EligibilityResult {
  return { ok, reason, category };
}
