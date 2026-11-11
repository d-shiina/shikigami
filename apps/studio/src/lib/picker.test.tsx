// @vitest-environment jsdom
// One file or folder dialog at a time (lib/picker.ts): the dialog is a
// process of its own, so a second click on 「参照…」 opened a second one.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FieldRow } from "../runner/FieldRow";
import type { Field } from "../runner/form";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { pickPath, pickerOpen, resetPicker } = await import("./picker");

/** A dialog that stays open until `close` is called with what was picked. */
function openDialog() {
  let close!: (picked: string | null) => void;
  invoke.mockImplementationOnce(() => new Promise((resolve) => (close = resolve)));
  return (picked: string | null) => close(picked);
}

beforeEach(() => {
  invoke.mockReset();
  resetPicker();
});
afterEach(cleanup);

describe("pickPath", () => {
  it("opens one dialog however often it is asked while one is open", async () => {
    const close = openDialog();
    const first = pickPath("folder", "C:\\work");
    expect(pickerOpen()).toBe(true);
    expect(await pickPath("folder", "C:\\work")).toBeNull();
    expect(await pickPath("file")).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("runner_pick", { kind: "folder", start: "C:\\work" });
    close("C:\\work\\受注");
    expect(await first).toBe("C:\\work\\受注");
    expect(pickerOpen()).toBe(false);
  });

  it("opens again once the dialog is closed, cancelled or failed", async () => {
    invoke.mockResolvedValueOnce(null);
    expect(await pickPath("file", "")).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith("runner_pick", { kind: "file", start: null });
    invoke.mockRejectedValueOnce({ code: "PICKER_OPEN", message: "open already" });
    expect(await pickPath("file")).toBeNull();
    expect(pickerOpen()).toBe(false);
    invoke.mockResolvedValueOnce("C:\\a.xlsx");
    expect(await pickPath("file")).toBe("C:\\a.xlsx");
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});

describe("「参照…」 button", () => {
  const field: Field = { name: "folder", label: "フォルダー", kind: "folder", required: false, initial: "" };

  it("is off while the dialog is open, and picks once for a double click", async () => {
    const close = openDialog();
    const onChange = vi.fn();
    render(<FieldRow field={field} value="" onChange={onChange} onPick={pickPath} />);
    const browse = screen.getByRole("button", { name: /参照/ });
    expect((browse as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(browse);
    fireEvent.click(browse);
    fireEvent.click(browse);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect((browse as HTMLButtonElement).disabled).toBe(true);
    await act(async () => close("C:\\in"));
    expect(onChange).toHaveBeenCalledWith("C:\\in");
    expect((browse as HTMLButtonElement).disabled).toBe(false);
  });

  it("is off too while another 「参照…」 has the dialog open", async () => {
    const close = openDialog();
    render(<FieldRow field={field} value="" onChange={() => {}} onPick={pickPath} />);
    const browse = screen.getByRole("button", { name: /参照/ }) as HTMLButtonElement;
    let other!: Promise<string | null>;
    act(() => {
      other = pickPath("file");
    });
    expect(browse.disabled).toBe(true);
    await act(async () => {
      close(null);
      await other;
    });
    expect(browse.disabled).toBe(false);
  });

  it("picks once for a double click even with a backend of its own", async () => {
    let close!: (picked: string | null) => void;
    const onPick = vi.fn(() => new Promise<string | null>((resolve) => (close = resolve)));
    render(<FieldRow field={{ ...field, kind: "file" }} value="" onChange={() => {}} onPick={onPick} />);
    const browse = screen.getByRole("button", { name: /参照/ }) as HTMLButtonElement;
    fireEvent.click(browse);
    fireEvent.click(browse);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(browse.disabled).toBe(true);
    await act(async () => close(null));
    expect(browse.disabled).toBe(false);
  });
});

describe("file and folder dialogs", () => {
  const root = join(__dirname, "..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });

  it("are opened only through pickPath, so every 「参照…」 button waits for the open one", () => {
    const offenders = files(root)
      .filter((path) => !path.endsWith(join("lib", "picker.ts")))
      .filter((path) => readFileSync(path, "utf8").includes('"runner_pick"'))
      .map((path) => path.slice(root.length + 1));
    expect(offenders).toEqual([]);
  });
});
