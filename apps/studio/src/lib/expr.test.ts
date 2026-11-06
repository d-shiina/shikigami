import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classify, cursorContext, fieldAccess, paramSource, readsVariables, tokenize } from "./expr";
import { functionHelpEn } from "./locales/functionHelp.en";
import { functionHelpJa } from "./locales/functionHelp.ja";

describe("expressions", () => {
  it("tokenise like Core", () => {
    expect(tokenize("num(r.金額) >= 1,000").filter((x) => x.kind !== "space").map((x) => x.text)).toEqual(["num", "(", "r", ".", "金額", ")", ">=", "1", ",", "000"]);
    expect(tokenize("'it\\'s'")[0]).toMatchObject({ kind: "string", value: "it's" });
    expect(tokenize("'open")[0]?.kind).toBe("error");
  });

  it("tell variables from functions, fields and parameters", () => {
    const roles = classify("sum(map(rows, r => num(r.金額))) + pass + nope", new Set(["rows", "pass"]))
      .filter((p) => p.kind === "ident")
      .map((p) => `${p.text}:${p.role}`);
    expect(roles).toEqual(["sum:function", "map:function", "rows:variable", "r:param", "num:function", "r:param", "金額:field", "pass:variable", "nope:unknown"]);
    expect(readsVariables("filter(rows, r => r.a == code)")).toEqual(["rows", "code"]);
  });

  it("know where the cursor is", () => {
    expect(cursorContext("trim(te", 7)).toMatchObject({ word: "te", from: 5, call: { name: "trim", arg: 0 } });
    expect(cursorContext("replace(a, 'x', ", 16).call).toEqual({ name: "replace", arg: 2 });
    expect(cursorContext("map(rows, r => r.金", 18)).toMatchObject({ word: "金", owner: "r" });
    expect(paramSource("map(rows, r => r.金", "r")).toBe("rows");
    expect(fieldAccess("税込 金額")).toBe("['税込 金額']");
  });

  it("have words for every function in docs/expressions.md", () => {
    const doc = readFileSync(new URL("../../../../docs/expressions.md", import.meta.url), "utf8");
    const names = [...doc.matchAll(/^\| `(\w+)\(/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(50);
    expect(Object.keys(functionHelpJa).sort()).toEqual([...new Set(names)].sort());
    expect(Object.keys(functionHelpEn).sort()).toEqual(Object.keys(functionHelpJa).sort());
  });
});
