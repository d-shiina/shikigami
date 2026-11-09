// Where the values on a page are, for the 手順書 to blur: input fields,
// table cells, and the value side of "label  value" rows that pages build
// from <div>s (a 申込内容の確認 screen, a profile card). Runs in the page
// (`page.evaluate`), so it must not use anything from outside the function.

export type Region = { x: number; y: number; width: number; height: number };

/**
 * The places on the visible part of the page that may show someone's data.
 * Labels stay readable so the 手順書 still says what each place is.
 */
export function fieldRegions(max: number): Region[] {
  const out: Region[] = [];
  const seen = new Set<Element>();
  const push = (el: Element) => {
    if (out.length >= max || seen.has(el)) return;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return;
    out.push({ x: r.left, y: r.top, width: r.width, height: r.height });
  };
  const text = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? "").trim();

  // Fields, cells and description values: whatever their layout.
  const fields = document.querySelectorAll(
    [
      "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image])",
      "textarea",
      "select",
      "[contenteditable='']",
      "[contenteditable=true]",
      "td",
      "dd",
      "output",
      "[role=cell]",
      "[role=gridcell]",
      "[role=textbox]",
      "[role=combobox]",
    ].join(", "),
  );
  for (const el of fields) push(el);

  // "label  value" rows made of <div>s: a row of 2 to 4 boxes side by side
  // (flex, grid or a table row), the first one a short label, the others
  // with text. One such row could be anything (a header with a logo and a
  // menu), so rows count only when the page repeats them (same tag, class
  // and number of boxes), as a list of items does.
  const LABEL_MAX = 30;
  const rows = new Map<string, { values: Element[] }[]>();
  const all = document.body ? document.body.getElementsByTagName("*") : [];
  const limit = Math.min(all.length, 30_000);
  for (let i = 0; i < limit; i++) {
    const row = all[i];
    if (!row) continue;
    const boxes = Array.from(row.children).filter((c) => !["SCRIPT", "STYLE", "TEMPLATE", "BR"].includes(c.tagName));
    if (boxes.length < 2 || boxes.length > 4) continue;
    const display = getComputedStyle(row).display;
    if (!/flex|grid|table-row/.test(display)) continue;
    const [label, ...rest] = boxes;
    if (!label) continue;
    const name = text(label);
    if (!name || name.length > LABEL_MAX || name.includes("\n")) continue;
    if (label.querySelector("input, select, textarea, button, a[href]") || label.matches("button, a[href], [role=button]")) continue;
    // Side by side, not stacked: a column of cards (a short heading over its
    // text) is flex or grid too, but its text is not a value.
    const at = label.getBoundingClientRect();
    const beside = (v: Element) => {
      const r = v.getBoundingClientRect();
      return r.left >= at.right - 2 && r.top < at.bottom && r.bottom > at.top;
    };
    const values = rest.filter(
      (v) =>
        text(v) !== "" &&
        beside(v) &&
        !v.matches("button, [role=button], input[type=submit], input[type=button]") &&
        !/^h[1-6]$/i.test(v.tagName),
    );
    if (values.length === 0) continue;
    const kind = `${row.tagName}|${typeof row.className === "string" ? row.className : ""}|${boxes.length}`;
    const list = rows.get(kind) ?? [];
    list.push({ values });
    rows.set(kind, list);
  }
  for (const list of rows.values()) {
    if (list.length < 2) continue;
    for (const { values } of list) for (const v of values) push(v);
  }
  return out;
}
