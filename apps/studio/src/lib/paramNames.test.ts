import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "./i18n";
import { paramsEn } from "./locales/params.en";
import { paramsJa } from "./locales/params.ja";
import { choiceLabel, paramLabel, plainHint } from "./nodeRows";

interface Schema {
  properties?: Record<string, Schema>;
  enum?: unknown[];
  oneOf?: Schema[];
}

// The built-in nodes as the CLI and MCP describe them (kept current by a Rust test).
const contract = JSON.parse(readFileSync(new URL("../../../../schemas/contract/step-types.json", import.meta.url), "utf8")) as {
  stepTypes: { type: string; params: Schema }[];
};

afterEach(() => setLocale("ja", false));

describe("names of node settings", () => {
  it("name every setting of every built-in node", () => {
    const missing = contract.stepTypes.flatMap(({ type, params }) =>
      Object.keys(params.properties ?? {})
        .filter((key) => paramLabel(key, type) === key)
        .map((key) => `${type}.${key}`),
    );
    expect(missing).toEqual([]);
  });

  it("put every choice in words", () => {
    const missing = contract.stepTypes.flatMap(({ type, params }) =>
      Object.entries(params.properties ?? {}).flatMap(([key, schema]) =>
        [...(schema.enum ?? []), ...(schema.oneOf ?? []).flatMap((b) => b.enum ?? [])]
          // GET, POST… are the words people use too.
          .filter((value) => key !== "method" && !paramsJa.choices[key]?.[String(value)])
          .map((value) => `${type}.${key}=${String(value)}`),
      ),
    );
    expect(missing).toEqual([]);
  });

  it("have the same entries in Japanese and English", () => {
    expect(Object.keys(paramsEn.labels).sort()).toEqual(Object.keys(paramsJa.labels).sort());
    expect(Object.keys(paramsEn.for).sort()).toEqual(Object.keys(paramsJa.for).sort());
    for (const type of Object.keys(paramsJa.for)) expect(Object.keys(paramsEn.for[type]!).sort()).toEqual(Object.keys(paramsJa.for[type]!).sort());
    for (const key of Object.keys(paramsJa.choices)) expect(Object.keys(paramsEn.choices[key]!).sort()).toEqual(Object.keys(paramsJa.choices[key]!).sort());
  });

  it("name a setting by what the node does with it", () => {
    expect(paramLabel("path", "file.readCsv")).toBe("ファイル");
    expect(paramLabel("path", "file.writeCsv")).toBe("保存先");
    expect(paramLabel("to", "file.copy")).toBe("コピー先");
    expect(choiceLabel("state", "visible")).toBe("表示されている");
    expect(choiceLabel("state", "someday")).toBe("someday");
    setLocale("en", false);
    expect(paramLabel("sheet", "excel.readRange")).toBe("Sheet");
  });

  it("show only plain hints under a field", () => {
    expect(plainHint("シート名（完全一致）。省略すると先頭のシート")).toBe("シート名（完全一致）。省略すると先頭のシート");
    expect(plainHint('入力する文字。パスワードは登録済みシークレット { "secret": "名前" }')).toBeUndefined();
    expect(plainHint("実行後にブックを保存する（既定 true）")).toBeUndefined();
    setLocale("en", false);
    expect(plainHint("シート名")).toBeUndefined();
  });
});

// docs/design/wording.md: names of nodes, settings and value forms are
// nouns ("待機時間", not "待つ"). Choices may stay as states ("表示されている").
const verbEnding = /(?:[うくぐすつぬぶむる]|ない|か)$/;
const nameOnly = (s: string) => s.replace(/[（(].*$/, "").trim();

describe("names are nouns", () => {
  it("names every setting with a noun", async () => {
    const all = [...Object.values(paramsJa.labels), ...Object.values(paramsJa.for).flatMap((m) => Object.values(m as Record<string, string>))];
    expect(all.filter((s) => verbEnding.test(nameOnly(s)))).toEqual([]);
  });

  it("names every value form with a noun", async () => {
    const { transformsJa } = await import("./locales/transforms.ja");
    const forms = Object.values((transformsJa as unknown as { items: Record<string, { label: string }> }).items);
    expect(forms.map((f) => f.label).filter((s) => verbEnding.test(nameOnly(s)))).toEqual([]);
  });
});
