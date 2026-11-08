// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chooseAsk, confirmAsk, textAsk, useAsk } from "../lib/ask";
import { AskDialog } from "./AskDialog";

afterEach(() => {
  act(() => useAsk.setState({ queue: [] }));
  cleanup();
});

describe("AskDialog", () => {
  it("answers yes with the main button and no with Esc", async () => {
    render(<AskDialog />);
    let yes = act(() => confirmAsk({ title: "「受注」をアンインストールしますか？", body: "検証エラーになります。", confirm: "アンインストール", danger: true }));
    const main = await screen.findByRole("button", { name: "アンインストール" });
    expect(screen.getByRole("alertdialog", { name: "「受注」をアンインストールしますか？" })).toBeTruthy();
    expect(document.activeElement).toBe(main);
    fireEvent.click(main);
    expect(await yes).toBe(true);
    expect(screen.queryByRole("alertdialog")).toBeNull();

    yes = act(() => confirmAsk({ title: "削除しますか？", confirm: "削除" }));
    fireEvent.keyDown(await screen.findByRole("alertdialog"), { key: "Escape" });
    expect(await yes).toBe(false);
  });

  it("keeps the window's keys from reaching the flow while it is open", async () => {
    render(<AskDialog />);
    const seen: string[] = [];
    const onKey = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener("keydown", onKey);
    const answer = act(() => confirmAsk({ title: "削除しますか？", confirm: "削除" }));
    fireEvent.keyDown(await screen.findByRole("alertdialog"), { key: "Delete" });
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    await answer;
    window.removeEventListener("keydown", onKey);
    expect(seen).toEqual([]);
  });

  it("offers a second way through", async () => {
    render(<AskDialog />);
    const answer = act(() => chooseAsk({ title: "変更を保存しますか？", confirm: "保存", other: "保存しない" }));
    fireEvent.click(await screen.findByRole("button", { name: "保存しない" }));
    expect(await answer).toBe("other");
  });

  it("asks for a name, checks it as it is typed, and sends it with Enter", async () => {
    render(<AskDialog />);
    const name = act(() =>
      textAsk({ title: "名前を変更", value: "orders.csv", confirm: "名前を変更", check: (v) => (v.includes("/") ? "使えません" : null) }),
    );
    const input = (await screen.findByRole("textbox")) as HTMLInputElement;
    expect(input.value).toBe("orders.csv");
    fireEvent.change(input, { target: { value: "a/b.csv" } });
    expect(screen.getByText("使えません")).toBeTruthy();
    expect((screen.getByRole("button", { name: "名前を変更" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: " 注文.csv " } });
    fireEvent.submit(input.closest("form")!);
    expect(await name).toBe("注文.csv");
  });

  it("shows one question at a time, in the order asked", async () => {
    render(<AskDialog />);
    const first = act(() => confirmAsk({ title: "一つ目", confirm: "はい" }));
    const second = act(() => confirmAsk({ title: "二つ目", confirm: "はい" }));
    expect((await screen.findByRole("alertdialog")).textContent).toContain("一つ目");
    fireEvent.click(screen.getByRole("button", { name: "はい" }));
    expect(await first).toBe(true);
    expect((await screen.findByRole("alertdialog")).textContent).toContain("二つ目");
    fireEvent.click(screen.getByRole("button", { name: /キャンセル|Cancel/ }));
    expect(await second).toBe(false);
  });
});

// The WebView's own boxes (window.alert / confirm / prompt) come up as a bare
// browser dialog at the top of the window; every question goes through
// lib/ask.ts instead. The repository has no ESLint, so this stands in for its
// no-alert rule and runs with the other tests in CI.
describe("no browser dialogs", () => {
  const root = join(__dirname, "..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });

  it("leaves window.alert, confirm and prompt unused", () => {
    const named = /\b(?:window|globalThis|self)\??\.(?:alert|confirm|prompt)\b|@tauri-apps\/plugin-dialog/;
    const offenders = files(root)
      .flatMap((path) => {
        const text = readFileSync(path, "utf8");
        // A bare call is the browser's one unless the file has its own function of that name.
        const own = (name: string) => new RegExp(`(?:const|let|function)\\s+${name}\\b`).test(text);
        const bare = ["alert", "confirm", "prompt"].filter((name) => !own(name));
        const call = bare.length ? new RegExp(`(?<![\\w.])(?:${bare.join("|")})\\s*\\(`) : null;
        return text
          .split("\n")
          .map((line, i) => ({ path, line, at: i + 1 }))
          .filter(({ line }) => !/^\s*(\/\/|\*)/.test(line) && (named.test(line) || !!call?.test(line)));
      })
      .map(({ path, line, at }) => `${path.slice(root.length + 1)}:${at}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });
});
