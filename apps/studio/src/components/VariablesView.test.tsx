// @vitest-environment jsdom
import type { VariableDef } from "@spellsheet/schema";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InitialCell } from "./VariablesView";

afterEach(cleanup);

const field = (name: string) => screen.getByLabelText(new RegExp(`^${name} `)) as HTMLInputElement | HTMLTextAreaElement;

describe("the 変数 table's starting value cell", () => {
  it("keeps what was typed on Enter", () => {
    const onSet = vi.fn();
    render(<InitialCell variable={{ name: "会社", type: "string" }} onSet={onSet} />);
    fireEvent.change(field("会社"), { target: { value: "株式会社まるちゃ" } });
    fireEvent.keyDown(field("会社"), { key: "Enter" });
    fireEvent.blur(field("会社"));
    expect(onSet).toHaveBeenCalledWith({ name: "会社", type: "string", default: "株式会社まるちゃ" });
  });

  it.each<[string, VariableDef, string]>([
    ["one line", { name: "会社", type: "string", default: "前" }, "後"],
    ["a list", { name: "一覧", type: "array", default: ["a"] }, '["b"]'],
  ])("puts %s back on Esc without saving it", (_, variable, typed) => {
    const onSet = vi.fn();
    render(<InitialCell variable={variable} onSet={onSet} />);
    const el = field(variable.name);
    el.focus();
    fireEvent.change(el, { target: { value: typed } });
    fireEvent.keyDown(el, { key: "Escape" });
    fireEvent.blur(el);
    expect(onSet).not.toHaveBeenCalled();
  });
});
