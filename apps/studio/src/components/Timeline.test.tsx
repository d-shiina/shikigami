// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import type { ActorKind, HistoryEntry } from "@spellsheet/schema";
import { afterEach, describe, expect, it } from "vitest";
import { ActorMark } from "./Timeline";

afterEach(cleanup);

const entry = (kind: ActorKind): HistoryEntry => ({ kind: "edit", revision: 1, actor: { kind }, at: "2026-11-09T00:00:00Z", label: "" }) as HistoryEntry;

describe("ActorMark", () => {
  it.each<ActorKind>(["mcp", "chat", "studio", "cli", "system"])("shows who changed it (%s) as an icon inside the circle, not letters", (kind) => {
    const { container } = render(<ActorMark entry={entry(kind)} size={16} />);
    const mark = container.firstElementChild as HTMLElement;
    expect(mark.textContent).toBe("");
    const icon = mark.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(Number(icon?.getAttribute("width"))).toBeLessThan(16);
  });
});
