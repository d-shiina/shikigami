import type { Step } from "@spellsheet/schema";
import { afterEach, describe, expect, it } from "vitest";
import { errorLine, explainError } from "./errorText";
import { setLocale } from "./i18n";
import { errorsEn } from "./locales/errors.en";
import { errorsJa } from "./locales/errors.ja";

afterEach(() => setLocale("ja", false));

const step = (type: string, params: Record<string, unknown>): Step => ({ id: "s1", type, params }) as Step;

describe("explainError", () => {
  it("words a missing element with the node's target", () => {
    const e = explainError(
      { code: "ELEMENT_NOT_FOUND", message: "no element matches role=button name=ログイン" },
      step("browser.click", { target: { role: "button", name: "ログイン" } }),
    );
    expect(e.known).toBe(true);
    expect(e.what).toContain("ログイン");
    expect(e.what).toContain("見つかりません");
    expect(e.todo).not.toBe("");
  });

  it("uses the details the Runtime gives", () => {
    expect(explainError({ code: "STEP_TIMEOUT", message: "step timed out after 30000 ms", details: { timeoutMs: 30000 } }).what).toBe(
      "30 秒以内に完了しませんでした",
    );
    expect(explainError({ code: "EXPR_UNDEFINED_VARIABLE", message: "undefined variable: total", details: { variable: "total" } }).what).toBe(
      "変数「total」がありません",
    );
    expect(explainError({ code: "HTTP_ERROR", message: "", details: { status: 404 } }).todo).toContain("アドレス");
    expect(explainError({ code: "SHEET_NOT_FOUND", message: "", details: { sheets: ["売上", "経費"] } }, step("excel.readRows", { sheet: "請求" }))).toMatchObject({
      what: "シート「請求」がありません",
      todo: "存在するシートは 売上、経費 です",
    });
  });

  it("prefers the file in the details, then the node's path", () => {
    const node = step("file.read", { path: "C:\\work\\a.csv" });
    expect(explainError({ code: "FILE_NOT_FOUND", message: "" }, node).what).toBe("ファイル「C:\\work\\a.csv」がありません");
    expect(explainError({ code: "FILE_NOT_FOUND", message: "", details: { path: "C:\\b.csv" } }, node).what).toContain("C:\\b.csv");
  });

  it("leaves out names it does not know rather than leaving a gap", () => {
    expect(explainError({ code: "WINDOW_NOT_FOUND", message: "" }).what).toBe("ウィンドウが開いていません");
    expect(explainError({ code: "NAVIGATION_FAILED", message: "" }, step("browser.open", { url: "{{ base }}/login" })).what).toBe(
      "ページを開けませんでした",
    );
  });

  it("speaks English when Writer does", () => {
    setLocale("en", false);
    expect(explainError({ code: "WINDOW_NOT_FOUND", message: "" }, step("desktop.click", { target: { window: { title: "Notepad" } } })).what).toBe(
      'The window "Notepad" is not open',
    );
  });

  it("keeps the message of codes it does not know and of control.fail", () => {
    expect(explainError({ code: "MY_PLUGIN_ERROR", message: "the plugin said no" })).toEqual({ what: "the plugin said no", todo: "", known: false });
    expect(explainError({ code: "INVALID_PARAMS", message: "請求書がありません" }, step("control.fail", { message: "請求書がありません", code: "INVALID_PARAMS" })).what).toBe(
      "請求書がありません",
    );
  });

  it("puts the code first in the run log", () => {
    expect(errorLine({ code: "CLIPBOARD_BUSY", message: "busy" })).toBe("クリップボードをほかのアプリが使っています");
  });
});

describe("error dictionaries", () => {
  it("word every entry in both languages without errors", () => {
    expect(Object.keys(errorsEn).sort()).toEqual(Object.keys(errorsJa).sort());
    for (const lang of ["ja", "en"] as const) {
      setLocale(lang, false);
      for (const code of Object.keys(errorsJa)) {
        const e = explainError({ code, message: "x" });
        expect(e.what, code).not.toMatch(/undefined|null|NaN|「」|""/);
        expect(e.todo, code).not.toBe("");
      }
    }
  });

  it("cover the codes the docs list for people", () => {
    for (const code of ["ELEMENT_NOT_FOUND", "WINDOW_NOT_FOUND", "FOREGROUND_DENIED", "SECRET_SITE_MISMATCH", "OAUTH_DENIED", "FILE_IN_USE", "HTTP_ERROR"]) {
      expect(errorsJa[code], code).toBeDefined();
    }
  });
});
