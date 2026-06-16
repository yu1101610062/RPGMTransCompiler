import { describe, expect, it } from "vitest";
import { evaluateRuntimeText } from "../src/runtime/eligibility.js";
import { protectPlaceholders, restorePlaceholders, validatePlaceholders } from "../src/extractors/placeholders.js";

describe("placeholder protection", () => {
  it("protects and restores RPG Maker control codes", () => {
    const protectedSet = protectPlaceholders("Hello \\N[1], you have \\V[3]G.");
    expect(protectedSet.protected).toBe("Hello <PH_0/>, you have <PH_1/>G.");
    expect(validatePlaceholders("你好 <PH_0/>，你有 <PH_1/>G。", protectedSet.placeholders)).toEqual({ ok: true });
    expect(restorePlaceholders("你好 <PH_0/>，你有 <PH_1/>G。", protectedSet.placeholders)).toBe("你好 \\N[1]，你有 \\V[3]G。");
  });

  it("rejects missing placeholders", () => {
    const protectedSet = protectPlaceholders("Use %s on {target}.");
    expect(validatePlaceholders("使用 <PH_0/>。", protectedSet.placeholders)).toEqual({
      ok: false,
      message: "Missing placeholder <PH_1/>"
    });
  });

  it("protects common tags and interpolations", () => {
    const protectedSet = protectPlaceholders("\\cn[Amanda]\nUse <b>%s</b> on #{target} and ${actor}.");
    expect(protectedSet.placeholders.map(item => item.kind)).toEqual([
      "rpgm.control.bracket",
      "html.tag",
      "printf",
      "html.tag",
      "ruby.interpolation",
      "js.template.expression"
    ]);
    expect(restorePlaceholders("<PH_0/>\n对 <PH_4/> 使用 <PH_1/><PH_2/><PH_3/> 和 <PH_5/>。", protectedSet.placeholders))
      .toBe("\\cn[Amanda]\n对 #{target} 使用 <b>%s</b> 和 ${actor}。");
  });
});

describe("runtime text eligibility", () => {
  it("keeps CJK natural text and rejects only unsafe obvious non-text", () => {
    expect(evaluateRuntimeText("魔王城", "zh-Hans").ok).toBe(true);
    expect(evaluateRuntimeText("こんにちは", "zh-Hans").ok).toBe(true);
    expect(evaluateRuntimeText("[zh-Hans] 已翻译", "zh-Hans").category).toBe("already_translated");
    expect(evaluateRuntimeText("img/faces/Hero.png", "zh-Hans").category).toBe("resource");
    expect(evaluateRuntimeText("!", "zh-Hans").category).toBe("too_short");
    expect(evaluateRuntimeText("<PH_1/>", "zh-Hans").category).toBe("placeholder_only");
  });
});
