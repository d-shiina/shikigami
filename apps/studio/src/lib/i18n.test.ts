import type { Step } from "@shikigami/schema";
import { afterEach, describe, expect, it } from "vitest";
import { blockLabel } from "./keywords";
import { blockName, locale, setLocale, stepLabel, t } from "./i18n";
import { ja } from "./locales/ja";
import { en } from "./locales/en";
import { plain, readable, sentence, targetText } from "./sentence";

afterEach(() => setLocale("ja", false));

/** Every key path of a dictionary, with functions and arrays as leaves. */
function paths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => paths(v, prefix ? `${prefix}.${k}` : k));
}

describe("dictionaries", () => {
  it("have the same keys in Japanese and English", () => {
    // Step and block names are English-only; preset expressions are overridden only where the example has words.
    const skip = (p: string) => /^(stepTypes|blockNames)(\.|$)/.test(p) || /^presets\..*\.expression$/.test(p);
    expect(paths(en).filter((p) => !skip(p))).toEqual(paths(ja).filter((p) => !skip(p)));
  });

  it("keep English free of Japanese except where it quotes input formats", () => {
    const japanese = /[\u3040-\u30ff\u4e00-\u9fff]/;
    const text = (v: unknown): string[] =>
      typeof v === "string" ? [v] : typeof v === "function" ? [] : v && typeof v === "object" ? Object.values(v).flatMap(text) : [];
    const offenders = text(en).filter((s) => japanese.test(s) && !s.includes("令和"));
    expect(offenders).toEqual([]);
  });
});

describe("switching", () => {
  it("swaps the live dictionary", () => {
    setLocale("en", false);
    expect(locale).toBe("en");
    expect(t.run).toBe("Run");
    setLocale("ja", false);
    expect(t.run).toBe("実行");
  });

  it("names step types and blocks in English, falling back to the registry", () => {
    setLocale("en", false);
    expect(stepLabel("browser.click", "クリック")).toBe("Click");
    expect(stepLabel("plugin.thing", "プラグイン")).toBe("プラグイン");
    expect(blockName("control.if", "then", "条件が真")).toBe("then");
    setLocale("ja", false);
    expect(stepLabel("browser.click", "クリック")).toBe("クリック");
  });
});

describe("English sentences", () => {
  it("read steps in English word order", () => {
    setLocale("en", false);
    expect(plain(sentence({ type: "control.if", params: { condition: "a > 1" } }, undefined))).toBe("If a > 1");
    expect(plain(sentence({ type: "browser.fill", params: { target: { label: "User" }, value: "{{ user }}" } }, undefined))).toBe(
      'Fill user into the "User" field',
    );
    expect(plain(sentence({ type: "browser.getText", params: { target: { text: "Total" } }, saveAs: "total" }, undefined))).toBe(
      'Read the text of "Total" (→ total)',
    );
    expect(targetText({ role: "button", name: "Log in" })).toBe('the "Log in" button');
    expect(readable("len(invoices) > 0 && !isEmpty(flagged)")).toBe("count of invoices > 0 and flagged is not empty");
  });

  it("spell block conditions in English", () => {
    setLocale("en", false);
    const loop: Step = { type: "control.forEach", params: { items: "invoices", itemVar: "invoice" } };
    expect(blockLabel(loop, "body", "要素ごとの処理")).toBe("forEach: each of invoices → invoice");
  });
});
