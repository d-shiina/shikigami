import { describe, expect, it } from "vitest";
import { setLocale } from "./i18n";
import { build, carryOver, columnOf, defaultExpression, recognize, slotsOf, splitParts, textOf, TRANSFORMS, transformByKey, wordsOf } from "./transforms";

describe("transforms", () => {
  it("recognise their own default expressions and build them back", () => {
    for (const def of TRANSFORMS) {
      const expr = defaultExpression(def);
      const m = recognize(expr);
      expect(m?.def.key, `${def.key}: ${expr}`).toBe(def.key);
      expect(build(def, m!.slots)).toBe(expr);
    }
  });

  it("read expressions an AI writes, whatever the spacing", () => {
    const m = recognize("sum( map(orders,row=>num(row.税込金額)) )");
    expect(m?.def.key).toBe("aggregate");
    expect(m?.slots).toMatchObject({ agg: "sum", table: "orders", r: "row", col: ".税込金額" });
    expect(recognize("avg(map(rows, r => num(r['税込 金額'])))")?.slots.col).toBe("['税込 金額']");
    expect(recognize("trim(row.氏名)")?.slots.text).toBe("row.氏名");
  });

  it("tell a calculation from joining text", () => {
    expect(recognize("pass + 1")?.def.key).toBe("calc");
    expect(recognize("sei + mei")?.def.key).toBe("calc");
    expect(recognize("sei + ' ' + mei")?.def.key).toBe("concat");
    expect(recognize("'ID-' + no")?.def.key).toBe("concat");
    expect(splitParts("sei + ' ' + mei")).toEqual(["sei", "' '", "mei"]);
  });

  it("pick the variant for the choices and filled slots", () => {
    const filter = transformByKey.get("filter")!;
    const base = { table: "rows", r: "r", col: ".区分", value: "'A'" };
    expect(build(filter, { ...base, op: "==" })).toBe("filter(rows, r => r.区分 == 'A')");
    expect(build(filter, { ...base, op: "contains" })).toBe("filter(rows, r => contains(r.区分, 'A'))");
    expect(build(filter, { ...base, op: ">=", value: "limit" })).toBe("filter(rows, r => num(r.区分) >= limit)");
    expect(recognize("filter(rows, r => r.区分 != 'A')")?.slots.op).toBe("!=");
    const slice = transformByKey.get("slice")!;
    expect(build(slice, { text: "code", start: "2", end: "" })).toBe("slice(code, 2)");
    const round = transformByKey.get("round")!;
    expect(build(round, { mode: "floor", x: "a", digits: "2" })).toBe("floor(a)");
    expect(recognize("ceil(a)")?.slots.mode).toBe("ceil");
    const sort = transformByKey.get("sort")!;
    expect(recognize("reverse(sortBy(rows, r => r.氏名))")?.slots).toMatchObject({ order: "desc", as: "text" });
    expect(build(sort, { table: "rows", r: "r", col: ".金額", order: "desc", as: "number" })).toBe("reverse(sortBy(rows, r => num(r.金額)))");
    expect(recognize("dateAdd(today(), 1, \"month\")")?.slots.unit).toBe("'month'");
  });

  it("leave other expressions as expressions", () => {
    for (const e of ["", "sum(map(rows, r => num(r.a) * 2))", "a + b * c", "trim(", "filter(rows, r => r.a == 1 && r.b == 2)", "len(rows) > 0", "slice(code, a, b)"]) {
      expect(recognize(e), e).toBeNull();
    }
  });

  it("keep the table and column when switching", () => {
    const from = recognize("sum(map(rows, r => num(r.金額)))");
    expect(build(transformByKey.get("filter")!, carryOver(from, transformByKey.get("filter")!))).toBe("filter(rows, r => num(r.金額) >= 10000)");
  });

  it("read slot values", () => {
    expect(textOf("'a\\'b'")).toBe("a'b");
    expect(textOf("a")).toBeNull();
    expect(columnOf(".金額")).toBe("金額");
    expect(columnOf("['税込 金額']")).toBe("税込 金額");
  });

  it.each(["ja", "en"] as const)("have words for every slot and choice (%s)", (locale) => {
    setLocale(locale, false);
    for (const def of TRANSFORMS) {
      const words = wordsOf(def);
      expect(words.label).not.toBe(def.key);
      for (const s of slotsOf(def)) if (s.kind !== "param") expect(words.slots[s.name], `${def.key}.${s.name}`).toBeTruthy();
    }
    setLocale("ja", false);
  });
});
