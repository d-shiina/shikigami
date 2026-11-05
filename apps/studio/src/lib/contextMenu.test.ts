import { afterEach, describe, expect, it } from "vitest";
import { closeMenu, menuFor, menuStore, openMenu, tidy, wantsBrowserMenu } from "./contextMenu";

afterEach(() => closeMenu());

const item = (label: string) => ({ label, run: () => {} });

function click(extra: Partial<{ shiftKey: boolean; target: EventTarget | null }> = {}) {
  const e = { clientX: 10, clientY: 20, shiftKey: false, target: null, prevented: false, stopped: false, ...extra };
  return Object.assign(e, {
    preventDefault() {
      e.prevented = true;
    },
    stopPropagation() {
      e.stopped = true;
    },
  });
}

describe("tidy", () => {
  it("drops left-out entries and stray separators", () => {
    const a = item("a");
    const b = item("b");
    expect(tidy(["-", a, false, "-", null, "-", b, undefined, "", "-"])).toEqual([a, "-", b]);
  });
});

describe("openMenu", () => {
  it("opens at the pointer instead of the browser's menu", () => {
    const e = click();
    openMenu(e, [item("a")]);
    expect(e.prevented).toBe(true);
    expect(menuStore.getState().menu).toMatchObject({ x: 10, y: 20 });
  });

  it("opens nothing, and still no browser menu, when nothing applies", () => {
    const e = click();
    openMenu(e, [false, "-"]);
    expect(e.prevented).toBe(true);
    expect(menuStore.getState().menu).toBeNull();
  });
});

describe("menuFor", () => {
  it("builds the place's menu when it is right-clicked", () => {
    const e = click();
    menuFor(() => [item("a")])(e);
    expect(e.stopped).toBe(true);
    expect(menuStore.getState().menu?.items).toHaveLength(1);
  });

  it("leaves Shift + right-click to the browser in a dev build only", () => {
    expect(wantsBrowserMenu({ shiftKey: true }, true)).toBe(true);
    expect(wantsBrowserMenu({ shiftKey: true }, false)).toBe(false);
    expect(wantsBrowserMenu({ shiftKey: false }, true)).toBe(false);
  });
});
