// Recording what the person does on the page (Studio's 「記録」 in the
// browser): clicks, what was typed into a field, choices, check boxes and
// Enter, and addresses typed into the address bar. Each becomes one action
// with a step target named as the picker names it (role + accessible name,
// `nth`, `frame`), so the recording turns into browser.* nodes as they are,
// or goes to the AI to be tidied up. Nothing is held back from the page:
// the person's clicks do what they always do.
//
// The page reports each action through a binding as it happens, with the
// element tagged; the element is then described from here. When it is
// already gone (the click opened another page), what the page said about it
// at the time is used instead.

import type { Frame as PageFrame, Page } from "playwright-core";

import { describeMarked, framePath, position } from "./pick.ts";
import { AdapterError, type Target } from "./targets.ts";

const HOST_ID = "__spellsheet_record";
const BINDING = "__spellsheetRecord";
const MARK = "data-spellsheet-recorded";
/** On the one element being described now. */
const NAMING = "data-spellsheet-naming";

/** One thing the person did, as Studio turns it into a node. */
export interface RecordedAction {
  app: "browser";
  kind: "open" | "click" | "fill" | "select" | "check" | "press" | "upload";
  target?: Target;
  /** open: the address. */
  url?: string;
  /** fill: the text typed; select: the chosen labels. */
  value?: string | string[];
  /** A password field: its text is not recorded. */
  password?: boolean;
  checked?: boolean;
  key?: string;
  button?: "right";
  double?: boolean;
  /** The element's own text, for the list Studio shows. */
  label?: string;
  /** The element could not be named (gone, or the page would not say). */
  failed?: { message: string };
}

export interface Recording {
  status: "stopped" | "timedOut";
  actions: RecordedAction[];
}

export interface RecordOptions {
  /** Banner text; `{n}` becomes the number of actions so far. */
  title?: string;
  hint?: string;
  lang?: string;
  timeoutMs: number;
}

/** What the page says about an element when it is used. */
interface Facts {
  role: string;
  name: string;
  label: string;
  placeholder: string;
  testId: string;
  text: string;
  id: string;
  tag: string;
}

interface Reported {
  kind: RecordedAction["kind"] | "stop";
  mark?: string;
  facts?: Facts;
  value?: string | string[];
  password?: boolean;
  checked?: boolean;
  key?: string;
  button?: "right";
  double?: boolean;
}

/** Who called the binding (Playwright's BindingSource). */
type Source = { frame: PageFrame };
type Listener = (source: Source, report: Reported) => void;

/** One binding per page (Playwright cannot take one back), told where to report. */
const listeners = new WeakMap<Page, { current?: Listener }>();

async function bind(page: Page): Promise<{ current?: Listener }> {
  let slot = listeners.get(page);
  if (!slot) {
    const created: { current?: Listener } = {};
    slot = created;
    listeners.set(page, created);
    await page.exposeBinding(BINDING, (source, report: Reported) => created.current?.(source, report));
  }
  return slot;
}

/** A step target from what the page said, when the element itself is gone. */
export function targetFromFacts(facts: Facts): Target | undefined {
  if (facts.role && facts.name) return { role: facts.role as Target["role"], name: facts.name, exact: true } as Target;
  if (facts.label) return { label: facts.label, exact: true };
  if (facts.placeholder) return { placeholder: facts.placeholder, exact: true };
  if (facts.testId) return { testId: facts.testId };
  if (facts.text && facts.text.length <= 40) return { text: facts.text, exact: true };
  if (facts.id && /^[A-Za-z][\w-]*$/.test(facts.id)) return { css: `#${facts.id}` };
  return undefined;
}

/**
 * Records until the person presses the banner's 終了 (or `timeoutMs`
 * passes). The first action opens the page the recording started on.
 */
export async function record(page: Page, options: RecordOptions): Promise<Recording> {
  await page.bringToFront().catch(() => {});
  const actions: RecordedAction[] = [{ app: "browser", kind: "open", url: page.url() }];
  const slot = await bind(page);
  let finished = false;
  let stop!: (status: Recording["status"]) => void;
  const stopped = new Promise<Recording["status"]>((ok) => (stop = ok));
  // Handled one at a time, in the order the page told them.
  let queue: Promise<void> = Promise.resolve();
  let lastAction = 0;
  const main = page.mainFrame();

  const arm = async (frame: PageFrame) => {
    if (finished) return;
    await frame
      .evaluate(install, {
        hostId: HOST_ID,
        binding: BINDING,
        mark: MARK,
        banner: frame === main,
        title: options.title ?? (options.lang === "en" ? "Recording ({n})  Click here to finish" : "記録中（{n} 件）　ここをクリックして終了"),
        hint: options.hint ?? "",
        count: actions.length - 1,
      })
      .catch(() => {});
  };

  const describe = async (frame: PageFrame, report: Reported): Promise<Pick<RecordedAction, "target" | "label" | "failed">> => {
    const mark = report.mark;
    if (mark) {
      try {
        const found = await frame.evaluate(
          ({ mark: m, id, naming }) => {
            for (const el of Array.from(document.querySelectorAll(`[${naming}]`))) el.removeAttribute(naming);
            const el = document.querySelector(`[${m}="${id}"]`);
            if (!el) return false;
            el.removeAttribute(m);
            el.setAttribute(naming, "");
            return true;
          },
          { mark: MARK, id: mark, naming: NAMING },
        );
        if (found) {
          try {
            const named = await describeMarked(page, frame, NAMING, 1500);
            return { target: await asItWas(frame, report.facts, named.target), label: report.facts?.text || named.text || undefined };
          } finally {
            await frame.evaluate((a) => document.querySelector(`[${a}]`)?.removeAttribute(a), NAMING).catch(() => {});
          }
        }
      } catch {
        // Gone while it was being described: what the page said will do.
      }
    }
    const facts = report.facts;
    const found = facts ? targetFromFacts(facts) : undefined;
    if (!found) return { failed: { message: "the element was gone before it could be named" } };
    // Still in the frame it was used in.
    const where = await framePath(frame).catch(() => undefined);
    const target: Target = where ? { ...found, frame: where } : found;
    return { target, label: facts?.text || facts?.name || undefined };
  };

  // The element may have changed since it was used (a button that says
  // 「検索しました」 once clicked): the name it had then wins, as long as it
  // still points at this element or at nothing now.
  const asItWas = async (frame: PageFrame, facts: Facts | undefined, now: Target): Promise<Target> => {
    const then = facts ? targetFromFacts(facts) : undefined;
    if (!then) return now;
    const where = await framePath(frame).catch(() => undefined);
    const placed: Target = where ? { ...then, frame: where } : then;
    const { matches, index } = await position(page, placed, NAMING);
    if (index >= 0) return matches > 1 ? { ...placed, nth: index } : placed;
    return matches === 0 ? placed : now;
  };

  const onReport: Listener = (source, report) => {
    if (finished) return;
    if (report.kind === "stop") return stop("stopped");
    lastAction = Date.now();
    const frame = source.frame;
    queue = queue.then(async () => {
      const action: RecordedAction = { app: "browser", kind: report.kind as RecordedAction["kind"] };
      Object.assign(action, await describe(frame, report));
      if (report.value !== undefined) action.value = report.value;
      if (report.password) action.password = true;
      if (report.checked !== undefined) action.checked = report.checked;
      if (report.key) action.key = report.key;
      if (report.button) action.button = report.button;
      if (report.double) action.double = true;
      // A double click comes as two clicks and then the double one.
      if (action.double) {
        const same = (a: RecordedAction | undefined) => a?.kind === "click" && !a.double && JSON.stringify(a.target) === JSON.stringify(action.target);
        while (same(actions.at(-1))) actions.pop();
      }
      actions.push(action);
      await main.evaluate(setCount, { hostId: HOST_ID, count: actions.length - 1 }).catch(() => {});
    });
  };
  slot.current = onReport;

  // A new page in a frame (or the whole tab) gets the recorder again. The
  // tab going somewhere nobody clicked toward is an address typed by hand.
  const onNavigated = (frame: PageFrame) => {
    if (finished) return;
    // A frame's new page (the tab's own gets it on domcontentloaded).
    if (frame !== main) void frame.waitForLoadState("domcontentloaded").then(() => arm(frame)).catch(() => {});
    if (frame === main && Date.now() - lastAction > 3000 && frame.url() !== actions.at(-1)?.url) {
      queue = queue.then(() => {
        actions.push({ app: "browser", kind: "open", url: frame.url() });
      });
    }
  };
  const onReady = () => void arm(main);
  const onAttached = (frame: PageFrame) => void frame.waitForLoadState("domcontentloaded").then(() => arm(frame)).catch(() => {});
  const onLoad = () => {
    for (const frame of page.frames()) void arm(frame);
  };
  page.on("framenavigated", onNavigated);
  page.on("domcontentloaded", onReady);
  page.on("frameattached", onAttached);
  page.on("load", onLoad);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (const frame of page.frames()) await arm(frame);
    if (page.isClosed()) throw new AdapterError("PAGE_CLOSED", "the page was closed before recording started");
    timer = setTimeout(() => stop("timedOut"), options.timeoutMs);
    const status = await Promise.race([stopped, page.waitForEvent("close", { timeout: 0 }).then(() => "stopped" as const)]);
    await queue;
    return { status, actions };
  } finally {
    finished = true;
    if (timer) clearTimeout(timer);
    slot.current = undefined;
    page.off("framenavigated", onNavigated);
    page.off("domcontentloaded", onReady);
    page.off("frameattached", onAttached);
    page.off("load", onLoad);
    await Promise.all(page.frames().map((f) => f.evaluate(uninstall, HOST_ID).catch(() => {})));
  }
}

/** Ends a recording from outside (Studio closed the list), as if 終了 were pressed. */
export async function stopRecording(page: Page): Promise<boolean> {
  return await page
    .evaluate((hostId) => {
      const bar = document.getElementById(hostId)?.shadowRoot?.querySelector<HTMLElement>(".bar");
      bar?.click();
      return Boolean(bar);
    }, HOST_ID)
    .catch(() => false);
}

// ---------------------------------------------------------------------------
// In-page code (runs in the browser; must not use anything from this module).

interface InstallArgs {
  hostId: string;
  binding: string;
  mark: string;
  banner: boolean;
  title: string;
  hint: string;
  count: number;
}

type Report = (r: Record<string, unknown>) => void;

function install({ hostId, binding, mark, banner, title, hint, count }: InstallArgs): void {
  if (document.getElementById(hostId)) return;
  const send = (window as unknown as Record<string, Report>)[binding];
  if (!send) return;
  const host = document.createElement("div");
  host.id = hostId;
  host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    *{box-sizing:border-box;font-family:"Yu Gothic UI","Meiryo UI","Noto Sans JP",sans-serif}
    .bar{position:fixed;top:8px;left:50%;transform:translateX(-50%);max-width:min(720px,calc(100vw - 24px));
      padding:8px 14px;border-radius:8px;background:#fff;color:#1e2a4a;border:2px solid #d64545;
      box-shadow:0 6px 24px rgba(20,40,80,.25);cursor:pointer;user-select:none}
    .bar b{display:block;font-size:13px;color:#b42318}
    .bar b::before{content:"";display:inline-block;width:8px;height:8px;margin-right:6px;border-radius:50%;background:#d64545;vertical-align:1px}
    .bar span{display:block;font-size:12px;color:#4a5670;margin-top:2px}
  </style><div class="bar" role="button"><b></b><span></span></div>`;
  const bar = root.querySelector(".bar") as HTMLElement;
  if (!banner) bar.style.display = "none";
  (root.querySelector(".bar span") as HTMLElement).textContent = hint;
  (host as unknown as { __title: string }).__title = title;
  (root.querySelector(".bar b") as HTMLElement).textContent = title.replace("{n}", String(count));
  bar.addEventListener("click", (e) => {
    e.stopPropagation();
    send({ kind: "stop" });
  });
  document.documentElement.appendChild(host);

  let seq = 0;
  const short = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const textLike = (el: Element): el is HTMLInputElement | HTMLTextAreaElement => {
    if (el instanceof HTMLTextAreaElement) return true;
    if (!(el instanceof HTMLInputElement)) return false;
    return !["checkbox", "radio", "file", "submit", "button", "reset", "image", "range", "color", "hidden"].includes(el.type);
  };
  const implicitRole = (el: Element): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0] ?? "";
    const tag = el.tagName.toLowerCase();
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "select") return (el as HTMLSelectElement).multiple ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "option") return "option";
    if (tag === "input") {
      const type = (el as HTMLInputElement).type;
      if (["submit", "button", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "search") return "searchbox";
      if (type === "number") return "spinbutton";
      // A password field has no role: its label names it.
      if (type === "password") return "";
      return "textbox";
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "td") return "cell";
    if (tag === "th") return "columnheader";
    return "";
  };
  // A label's own words, without the text of the control inside it (a
  // <select>'s options).
  const labelText = (el: Element): string => {
    const label = (el as HTMLInputElement).labels?.[0];
    if (!label) return "";
    const copy = label.cloneNode(true) as Element;
    for (const c of Array.from(copy.querySelectorAll("select, textarea, input, option"))) c.remove();
    return short(copy.textContent, 80);
  };
  const accessibleName = (el: Element): string => {
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled) {
      const text = labelled
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (short(text, 80)) return short(text, 80);
    }
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return short(aria, 80);
    const input = el as HTMLInputElement;
    if (input.labels && input.labels.length > 0) return labelText(el);
    if (el instanceof HTMLInputElement && ["submit", "button", "reset"].includes(el.type)) return short(el.value, 80);
    if (el instanceof HTMLInputElement && el.type === "image") return short(el.alt, 80);
    if (textLike(el) || el instanceof HTMLSelectElement) return short(el.getAttribute("title") || el.getAttribute("placeholder"), 80);
    const text = short((el as HTMLElement).innerText ?? el.textContent, 80);
    if (text) return text;
    const img = el.querySelector("img[alt]");
    return short(img?.getAttribute("alt") || el.getAttribute("title"), 80);
  };
  const facts = (el: Element) => {
    const input = el as HTMLInputElement;
    return {
      role: implicitRole(el),
      name: accessibleName(el),
      label: input.labels && input.labels.length > 0 ? labelText(el) : "",
      placeholder: el.getAttribute("placeholder") ?? "",
      testId: el.getAttribute("data-testid") ?? "",
      text: el instanceof HTMLSelectElement ? "" : short((el as HTMLElement).innerText ?? el.textContent, 100),
      id: el.id,
      tag: el.tagName.toLowerCase(),
    };
  };
  const report = (kind: string, el: Element, extra: Record<string, unknown> = {}) => {
    const id = `${Date.now()}-${++seq}`;
    el.setAttribute(mark, id);
    send({ kind, mark: id, facts: facts(el), ...extra });
  };
  // What a click means: the control it belongs to, not the icon inside it.
  const meaningful = (node: Element): Element =>
    node.closest(
      "button, a[href], input, select, textarea, label, summary, option, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [role=combobox], [role=textbox], [role=cell], [role=gridcell], td, th, [onclick], [tabindex]",
    ) ?? node;
  const onBar = (e: Event) => e.composedPath().includes(host);
  // The text a field had when it was last recorded, so Enter and leaving
  // the field do not record it twice.
  const recorded = new WeakMap<Element, string>();
  const fill = (el: HTMLInputElement | HTMLTextAreaElement) => {
    if ((recorded.get(el) ?? el.defaultValue) === el.value) return;
    recorded.set(el, el.value);
    const password = el instanceof HTMLInputElement && el.type === "password";
    report("fill", el, password ? { value: "", password: true } : { value: el.value });
  };
  const owns = (label: Element): Element | null => {
    const control = (label as HTMLLabelElement).control;
    return control ?? null;
  };

  const onClick = (e: MouseEvent) => {
    if (!e.isTrusted || onBar(e) || e.button !== 0) return;
    const target = e.target instanceof Element ? meaningful(e.target) : null;
    if (!target) return;
    // Fields, lists and boxes are recorded by what changed in them.
    if (textLike(target) || target instanceof HTMLSelectElement || target instanceof HTMLOptionElement) return;
    if (target instanceof HTMLInputElement && ["checkbox", "radio", "file"].includes(target.type)) return;
    if (target instanceof HTMLLabelElement && owns(target)) return;
    if ((target as HTMLElement).isContentEditable) return;
    report("click", target);
  };
  const onDouble = (e: MouseEvent) => {
    if (!e.isTrusted || onBar(e)) return;
    const target = e.target instanceof Element ? meaningful(e.target) : null;
    if (target && !textLike(target)) report("click", target, { double: true });
  };
  const onContext = (e: MouseEvent) => {
    if (!e.isTrusted || onBar(e)) return;
    const target = e.target instanceof Element ? meaningful(e.target) : null;
    if (target) report("click", target, { button: "right" });
  };
  const onChange = (e: Event) => {
    if (!e.isTrusted) return;
    const el = e.target;
    if (el instanceof HTMLSelectElement) {
      const labels = Array.from(el.selectedOptions).map((o) => o.label || o.text);
      report("select", el, { value: el.multiple ? labels : (labels[0] ?? "") });
    } else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      report("check", el, { checked: el.checked });
    } else if (el instanceof HTMLInputElement && el.type === "file") {
      report("upload", el);
    } else if (el instanceof Element && textLike(el)) {
      fill(el);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (!e.isTrusted || onBar(e) || e.isComposing) return;
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;
    if (e.key === "Enter" && el instanceof HTMLInputElement && textLike(el)) {
      fill(el);
      report("press", el, { key: "Enter" });
    } else if (e.key === "Escape") {
      report("press", el === document.body ? document.documentElement : el, { key: "Escape" });
    }
  };
  window.addEventListener("click", onClick, true);
  window.addEventListener("dblclick", onDouble, true);
  window.addEventListener("contextmenu", onContext, true);
  window.addEventListener("change", onChange, true);
  window.addEventListener("keydown", onKey, true);
  (host as unknown as { __stop: () => void }).__stop = () => {
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("dblclick", onDouble, true);
    window.removeEventListener("contextmenu", onContext, true);
    window.removeEventListener("change", onChange, true);
    window.removeEventListener("keydown", onKey, true);
    host.remove();
  };
}

function setCount({ hostId, count }: { hostId: string; count: number }): void {
  const host = document.getElementById(hostId) as (HTMLElement & { __title?: string }) | null;
  const b = host?.shadowRoot?.querySelector(".bar b");
  if (b && host?.__title) b.textContent = host.__title.replace("{n}", String(count));
}

function uninstall(hostId: string): void {
  const host = document.getElementById(hostId) as (HTMLElement & { __stop?: () => void }) | null;
  host?.__stop?.();
  host?.remove();
  for (const a of ["data-spellsheet-recorded", "data-spellsheet-naming"]) {
    for (const el of Array.from(document.querySelectorAll(`[${a}]`))) el.removeAttribute(a);
  }
}
