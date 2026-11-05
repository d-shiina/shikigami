import { describe, expect, it } from "vitest";
import { setLocale } from "./i18n";
import { presets } from "./presets";

describe("presets", () => {
  it.each(["ja", "en"] as const)("have unique keys, words and an expression that uses their function (%s)", (locale) => {
    setLocale(locale, false);
    const list = presets();
    expect(new Set(list.map((p) => p.key)).size).toBe(list.length);
    for (const p of list) {
      expect(p.name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      expect(p.expression).toContain(p.keyword);
      expect(p.label).not.toBe(p.keyword);
      expect(p.description).not.toBe("");
    }
    setLocale("ja", false);
  });
});
