import { describe, expect, it } from "vitest";
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

  it("protects custom RPG Maker bracket control codes", () => {
    const protectedSet = protectPlaceholders("\\cn[Amanda]\nGreetings.");
    expect(protectedSet.protected).toBe("<PH_0/>\nGreetings.");
    expect(restorePlaceholders("<PH_0/>\n你好。", protectedSet.placeholders)).toBe("\\cn[Amanda]\n你好。");
  });
});
