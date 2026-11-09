// Pointing at the page: the person shows which element they mean.
//
// `pick` draws a banner on the open page, outlines whatever the pointer is
// over and catches the next click before the page sees it (so picking the
// 「出荷」 button does not ship anything). The clicked element is turned
// into a flow Target (role + accessible name, as inspect_page lists
// them), with `nth` when the same target matches several elements and
// `frame` when it is inside an iframe (nested and cross-site ones too).
// `highlight` outlines targets for a moment so the person can see what a
// step is about to touch. Both are used by AI clients (ask_user_to_pick,
// test_step) and by Studio's picker for a node's target.

import type { ElementHandle, Frame as PageFrame, Locator, Page } from "playwright-core";

import { AdapterError, frameSelector, locate, type AriaRole, type Frame, type Target } from "./targets.ts";

const HOST_ID = "__spellsheet_pick";
const HIGHLIGHT_HOST_ID = "__spellsheet_highlight";
const PICKED = "data-spellsheet-picked";
const CANDIDATE = "data-spellsheet-candidate";
const HIGHLIGHT = "data-spellsheet-highlight";
/** On an iframe whose page has its own picker: the outer page stops covering it. */
const ARMED = "data-spellsheet-armed";
/** Briefly on the iframe being described, to find its position among the others. */
const THIS_FRAME = "data-spellsheet-this-frame";

export interface PickOptions {
  /** What to point at, shown in the banner (the AI's words). */
  message?: string;
  /** Targets the AI is torn between: outlined with numbers 1, 2, … */
  candidates?: Target[];
  /** Banner language: "ja" (default) or "en". */
  lang?: string;
  timeoutMs: number;
}

export interface Picked {
  status: "picked";
  /** The element as a step target, ready for browser.click and friends (with `frame` inside an iframe). */
  target: Target;
  /** How many elements `target` matches without `nth` (1: it is unique). */
  matches: number;
  /** Other ways to name the same element (label, placeholder, text). */
  alternatives: Target[];
  /** The element's own text (shortened). */
  text: string;
  /** The text of the table row or list item it sits in, when there is one. */
  row?: string;
  /** 1-based number of the candidate the person picked, when it is one. */
  candidate?: number;
  url: string;
}

export interface Cancelled {
  status: "cancelled";
  url: string;
}

/**
 * Waits for the person to click an element (or press わからない / Esc).
 *
 * Every frame of the page gets its own picker, cross-origin ones too
 * (Playwright reaches into them), since a frame's clicks never reach the
 * page around it. Only the top page shows the banner. A frame that has no
 * picker yet (still loading, or one Playwright cannot reach) stays covered
 * by its parent's picker, so a click there never reaches the page.
 */
export async function pick(page: Page, options: PickOptions): Promise<Picked | Cancelled> {
  await page.bringToFront().catch(() => {});
  await clear(page);
  await mark(page, options.candidates ?? [], CANDIDATE);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let settle!: (answer: { frame: PageFrame; outcome: "picked" | "cancelled" }) => void;
  let fail!: (error: unknown) => void;
  const answer = new Promise<{ frame: PageFrame; outcome: "picked" | "cancelled" }>((ok, ko) => {
    settle = ok;
    fail = ko;
  });
  const main = page.mainFrame();
  const arm = async (frame: PageFrame) => {
    const top = frame === main;
    try {
      if (!top) await setOnFrameElement(frame, ARMED, false);
      await frame.evaluate(overlay, {
        hostId: HOST_ID,
        picked: PICKED,
        candidate: CANDIDATE,
        armed: ARMED,
        message: options.message ?? "",
        lang: options.lang ?? "ja",
        banner: top,
      });
      // The pick ended while this frame was being set up, maybe after the
      // final clear ran: take down what was just put up here.
      if (finished) {
        await frame.evaluate(removeOverlay, { hostId: HOST_ID, attrs: [PICKED, CANDIDATE] }).catch(() => {});
        return;
      }
      if (!top) await setOnFrameElement(frame, ARMED, true);
      if (finished) {
        await frame.evaluate(removeOverlay, { hostId: HOST_ID, attrs: [PICKED, CANDIDATE] }).catch(() => {});
        if (!top) await setOnFrameElement(frame, ARMED, false);
        return;
      }
      const outcome = await frame.evaluate(waitForOverlay, HOST_ID);
      if (!finished) settle({ frame, outcome });
    } catch (error) {
      if (finished) return;
      if (top) {
        fail(error);
        return;
      }
      // The frame's page went away (it navigated or was removed): cover it
      // again until its next page gets a picker.
      const waiting = await frame.evaluate((id) => Boolean(document.getElementById(id)), HOST_ID).catch(() => false);
      if (!waiting) await setOnFrameElement(frame, ARMED, false);
    }
  };
  const onNavigated = (frame: PageFrame) => {
    if (frame !== main && !finished) void arm(frame);
  };
  page.on("framenavigated", onNavigated);
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new AdapterError("HUMAN_TIMEOUT", `nobody pointed at anything within ${Math.round(options.timeoutMs / 1000)} s`, {
              details: { hint: "Ask the user in chat whether they are at the PC, then call it again." },
            }),
          ),
        options.timeoutMs,
      );
    });
    for (const frame of page.frames()) void arm(frame);
    let outcome: { frame: PageFrame; outcome: "picked" | "cancelled" };
    try {
      outcome = await Promise.race([answer, timeout]);
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      // The page navigated or closed while waiting.
      throw new AdapterError("PICK_INTERRUPTED", "the page changed before anything was picked", {
        details: { url: page.url(), hint: "Look at the page again (inspect_page) and ask once more if needed." },
      });
    } finally {
      finished = true;
      page.off("framenavigated", onNavigated);
    }
    if (outcome.outcome === "cancelled") return { status: "cancelled", url: page.url() };
    return await describeMarked(page, outcome.frame);
  } finally {
    finished = true;
    if (timer) clearTimeout(timer);
    await clear(page);
  }
}

/** Ends a waiting pick as if the person pressed わからない (Studio cancelled it). */
export async function cancelPick(page: Page): Promise<boolean> {
  return await page
    .evaluate((hostId) => {
      const button = document.getElementById(hostId)?.shadowRoot?.querySelector<HTMLButtonElement>(".bar button");
      button?.click();
      return Boolean(button);
    }, HOST_ID)
    .catch(() => false);
}

/**
 * Outlines every element `targets` match for `durationMs` (numbered when
 * `numbered`). Elements inside frames are outlined inside their frame.
 */
export async function highlight(
  page: Page,
  targets: Target[],
  options: { durationMs: number; label?: string; numbered?: boolean },
): Promise<number> {
  await everyFrame(page, (frame) => frame.evaluate(removeOverlay, { hostId: HIGHLIGHT_HOST_ID, attrs: [HIGHLIGHT] }));
  const count = await mark(page, targets, HIGHLIGHT, options.numbered ?? targets.length > 1);
  if (count === 0) return 0;
  await everyFrame(page, (frame) =>
    frame.evaluate(drawHighlights, { hostId: HIGHLIGHT_HOST_ID, attr: HIGHLIGHT, label: options.label ?? "", durationMs: options.durationMs }),
  );
  return count;
}

// ---------------------------------------------------------------------------

/** Runs `fn` on each frame of the page, ignoring frames it cannot reach. */
async function everyFrame(page: Page, fn: (frame: PageFrame) => Promise<unknown>): Promise<void> {
  await Promise.all(page.frames().map((frame) => fn(frame).catch(() => {})));
}

/** Sets (or removes) `attr` on the iframe element that holds `frame`, in its parent page. */
async function setOnFrameElement(frame: PageFrame, attr: string, on: boolean): Promise<void> {
  let handle: ElementHandle<Element> | undefined;
  try {
    handle = (await frame.frameElement()) as ElementHandle<Element>;
    await handle.evaluate((el, [a, set]) => (set ? el.setAttribute(a, "") : el.removeAttribute(a)), [attr, on] as const);
  } catch {
    // The frame is gone.
  } finally {
    await handle?.dispose().catch(() => {});
  }
}

/** Tags the elements of each target with `attr` = its 1-based number. */
async function mark(page: Page, targets: Target[], attr: string, numbered = true): Promise<number> {
  let count = 0;
  for (const [i, target] of targets.entries()) {
    let locator: Locator;
    try {
      locator = locate(page, target);
    } catch {
      continue;
    }
    count += await locator
      .evaluateAll((els, [a, n]) => {
        for (const el of els) el.setAttribute(a, n);
        return els.length;
      }, [attr, numbered ? String(i + 1) : ""] as const)
      .catch(() => 0);
  }
  return count;
}

async function clear(page: Page): Promise<void> {
  await everyFrame(page, (frame) => frame.evaluate(removeOverlay, { hostId: HOST_ID, attrs: [PICKED, CANDIDATE, ARMED] }));
}

/**
 * Turns the element tagged `attr` (PICKED) in `frame` into a Target (with
 * `frame` when it is not the top page). The recorder names what was clicked
 * or typed into the same way.
 */
export async function describeMarked(page: Page, frame: PageFrame, attr: string = PICKED, timeoutMs = 30_000): Promise<Picked> {
  const el = frame.locator(`[${attr}]`).first();
  const facts = await el.evaluate(
    (node, attr) => {
      const short = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
      const row = node.closest("tr, [role=row], li, [role=listitem], [role=option]");
      const input = node as HTMLInputElement;
      let label = "";
      if (input.labels && input.labels.length > 0) label = short(input.labels[0]?.textContent, 80);
      const candidate = node.closest(`[${attr}]`)?.getAttribute(attr) ?? "";
      return {
        text: short((node as HTMLElement).innerText ?? node.textContent, 100),
        row: row && row !== node ? short((row as HTMLElement).innerText, 200) : "",
        label,
        placeholder: node.getAttribute("placeholder") ?? "",
        testId: node.getAttribute("data-testid") ?? "",
        id: node.id,
        tag: node.tagName.toLowerCase(),
        candidate,
      };
    },
    CANDIDATE,
    { timeout: timeoutMs },
  );
  const aria = parseAria(await el.ariaSnapshot({ timeout: Math.min(2000, timeoutMs) }).catch(() => ""));
  const where = await framePath(frame);
  const inFrame = (t: Target): Target => (where ? { ...t, frame: where } : t);

  const alternatives: Target[] = [];
  if (facts.label) alternatives.push({ label: facts.label, exact: true });
  if (facts.placeholder) alternatives.push({ placeholder: facts.placeholder, exact: true });
  if (facts.testId) alternatives.push({ testId: facts.testId });
  if (facts.text && facts.text.length <= 40) alternatives.push({ text: facts.text, exact: true });

  let base: Target;
  if (aria && aria.name) base = { role: aria.role as AriaRole, name: aria.name, exact: true };
  else if (alternatives[0]) base = alternatives.shift()!;
  else if (facts.id && /^[A-Za-z][\w-]*$/.test(facts.id)) base = { css: `#${facts.id}` };
  else if (aria) base = { role: aria.role as AriaRole };
  else base = { css: facts.tag };

  const { matches, index } = await position(page, inFrame(base), attr);
  const target = inFrame(matches > 1 && index >= 0 ? { ...base, nth: index } : base);
  const result: Picked = {
    status: "picked",
    target,
    matches,
    alternatives: alternatives.map(inFrame),
    text: facts.text,
    url: page.url(),
  };
  if (facts.row) result.row = facts.row;
  if (facts.candidate) result.candidate = Number(facts.candidate);
  return result;
}

/**
 * How a step target names `frame` (outermost frame innermost in the
 * object, as `target.frame.frame`), or undefined for the top page.
 */
export async function framePath(frame: PageFrame): Promise<Frame | undefined> {
  const parent = frame.parentFrame();
  if (!parent) return undefined;
  const outer = await framePath(parent);
  const handle = (await frame.frameElement()) as ElementHandle<Element>;
  try {
    const own = await nameFrame(parent, handle);
    return outer ? { ...own, frame: outer } : own;
  } finally {
    await handle.dispose().catch(() => {});
  }
}

/** The steadiest way to name the iframe `handle` among the frames of `parent`: name, title, src, then its tag. */
async function nameFrame(parent: PageFrame, handle: ElementHandle<Element>): Promise<Frame> {
  const attrs = await handle.evaluate((el) => ({
    name: el.getAttribute("name") || el.id || "",
    title: el.getAttribute("title") ?? "",
    src: el.getAttribute("src") ?? "",
    tag: el.tagName.toLowerCase(),
  }));
  const ways: Frame[] = [];
  if (attrs.name) ways.push({ name: attrs.name });
  if (attrs.title) ways.push({ title: attrs.title });
  // A data: or javascript: address is the page itself, not a place.
  if (attrs.src && /^(https?:|\/|\.|[\w-]+(\/|\.|$))/i.test(attrs.src)) ways.push({ src: attrs.src });
  ways.push({ css: attrs.tag });
  await handle.evaluate((el, a) => el.setAttribute(a, ""), THIS_FRAME);
  try {
    let repeated: Frame | undefined;
    for (const way of ways) {
      const { count, index } = await parent
        .locator(frameSelector(way))
        .evaluateAll((els, a) => ({ count: els.length, index: els.findIndex((e) => e.hasAttribute(a)) }), THIS_FRAME)
        .catch(() => ({ count: 0, index: -1 }));
      if (index < 0) continue;
      if (count === 1) return way;
      repeated ??= { ...way, nth: index };
    }
    return repeated ?? { css: attrs.tag };
  } finally {
    await handle.evaluate((el, a) => el.removeAttribute(a), THIS_FRAME).catch(() => {});
  }
}

/** How many elements `target` matches, and which of them is the picked one. */
export async function position(page: Page, target: Target, attr: string): Promise<{ matches: number; index: number }> {
  try {
    return await locate(page, target).evaluateAll(
      (els, a) => ({ matches: els.length, index: els.findIndex((e) => e.hasAttribute(a)) }),
      attr,
    );
  } catch {
    return { matches: 0, index: -1 };
  }
}

/** `- button "A-1001 を出荷"` → { role: "button", name: "A-1001 を出荷" } (the first line only). */
export function parseAria(snapshot: string): { role: string; name: string } | undefined {
  const first = snapshot.split("\n")[0] ?? "";
  const m = /^\s*- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?/.exec(first);
  if (!m || !m[1] || m[1] === "text") return undefined;
  let name = "";
  if (m[2] !== undefined) {
    try {
      name = JSON.parse(`"${m[2]}"`) as string;
    } catch {
      name = m[2];
    }
  }
  return { role: m[1], name };
}

// ---------------------------------------------------------------------------
// In-page code (runs in the browser; must not use anything from this module).

interface OverlayArgs {
  hostId: string;
  picked: string;
  candidate: string;
  armed: string;
  message: string;
  lang: string;
  /** Show the banner (the top page only; frames just catch their clicks). */
  banner: boolean;
}

/** Sets up the picker in this document; `waitForOverlay` then waits for its answer. */
function overlay({ hostId, picked, candidate, armed, message, lang, banner }: OverlayArgs): void {
  // Already waiting here (a frame armed twice while it loaded).
  if (document.getElementById(hostId)) return;
  const words = lang !== "en"
    ? { title: "SpellSheet：クリックして教えてください", unsure: "わからない", hint: "Esc でやめる", frame: "ここは選べません" }
    : { title: "SpellSheet: click to show it", unsure: "Not sure", hint: "Esc to cancel", frame: "Cannot pick here" };
  const host = document.createElement("div");
  host.id = hostId;
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    *{box-sizing:border-box;font-family:"Yu Gothic UI","Meiryo UI","Noto Sans JP",sans-serif}
    .bar{position:fixed;top:12px;left:50%;transform:translateX(-50%);max-width:min(720px,calc(100vw - 24px));
      display:flex;gap:12px;align-items:center;padding:10px 12px 10px 16px;border-radius:8px;
      background:#fff;color:#1e2a4a;border:2px solid #2b7bd6;box-shadow:0 6px 24px rgba(20,40,80,.25);pointer-events:auto}
    .bar b{display:block;font-size:13px}
    .bar span{display:block;font-size:14px;margin-top:2px;white-space:pre-wrap}
    .bar small{color:#4a5670;font-size:12px;white-space:nowrap}
    .bar button{font-size:13px;padding:6px 12px;border-radius:6px;border:1px solid #9aa6bd;background:#f4f6fa;color:#1e2a4a;cursor:pointer;white-space:nowrap}
    .box{position:fixed;border:2px solid #2b7bd6;background:rgba(43,123,214,.12);border-radius:4px;pointer-events:none;display:none}
    .shield{position:fixed;pointer-events:auto;cursor:not-allowed;background:repeating-linear-gradient(45deg,rgba(74,86,112,.10) 0 8px,rgba(74,86,112,.18) 8px 16px);
      border:1px dashed #4a5670;display:flex;align-items:flex-start;justify-content:flex-end}
    .shield em{margin:4px;padding:2px 8px;border-radius:4px;background:#4a5670;color:#fff;font:600 12px/18px "Yu Gothic UI","Meiryo UI","Noto Sans JP",sans-serif;font-style:normal}
    .cand{position:fixed;border:2px dashed #e8862a;border-radius:4px;pointer-events:none}
    .cand i{position:absolute;top:-11px;left:-11px;width:22px;height:22px;border-radius:11px;background:#e8862a;color:#fff;
      font:700 12px/22px sans-serif;text-align:center;font-style:normal}
  </style>
  <div class="bar"><div style="flex:1"><b></b><span></span></div><small></small><button type="button"></button></div>
  <div class="box"></div>`;
  if (!banner) (root.querySelector(".bar") as HTMLElement).style.display = "none";
  (root.querySelector(".bar b") as HTMLElement).textContent = words.title;
  (root.querySelector(".bar span") as HTMLElement).textContent = message;
  (root.querySelector(".bar small") as HTMLElement).textContent = words.hint;
  const unsure = root.querySelector(".bar button") as HTMLButtonElement;
  unsure.textContent = words.unsure;
  const bar = root.querySelector(".bar") as HTMLElement;
  const box = root.querySelector(".box") as HTMLElement;
  document.documentElement.appendChild(host);

  const cands = Array.from(document.querySelectorAll(`[${candidate}]`)).map((el) => {
    const d = document.createElement("div");
    d.className = "cand";
    const n = el.getAttribute(candidate);
    if (n) {
      const i = document.createElement("i");
      i.textContent = n;
      d.appendChild(i);
    }
    root.appendChild(d);
    return { el, d };
  });

  // What a click on `node` means: the control it belongs to, not the icon or span inside it.
  const meaningful = (node: Element): Element =>
    node.closest(
      "button, a[href], input, select, textarea, label, summary, option, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [role=combobox], [role=textbox], [role=cell], [role=gridcell], td, th, [onclick], [tabindex]",
    ) ?? node;
  const under = (x: number, y: number): Element | null => {
    const el = document.elementFromPoint(x, y);
    // A frame with its own picker answers for what is inside it.
    if (!el || el === host || el.hasAttribute(armed)) return null;
    return meaningful(el);
  };
  const place = (d: HTMLElement, el: Element) => {
    const r = el.getBoundingClientRect();
    d.style.left = `${r.left - 3}px`;
    d.style.top = `${r.top - 3}px`;
    d.style.width = `${r.width + 6}px`;
    d.style.height = `${r.height + 6}px`;
  };
  // Frames get their own events, which these listeners never see. A frame
  // with its own picker (marked `armed`) catches its clicks itself; cover
  // the others (still loading, out of reach, plug-ins) so a click there
  // cannot reach the control inside.
  const shields = new Map<Element, HTMLElement>();
  const shieldFrames = () => {
    const frames = new Set(
      Array.from(document.querySelectorAll("iframe, frame, embed, object")).filter((el) => !el.hasAttribute(armed)),
    );
    for (const [el, d] of shields) {
      if (!frames.has(el) || !el.isConnected) {
        d.remove();
        shields.delete(el);
      }
    }
    for (const el of frames) {
      let d = shields.get(el);
      if (!d) {
        d = document.createElement("div");
        d.className = "shield";
        const note = document.createElement("em");
        note.textContent = words.frame;
        d.appendChild(note);
        root.insertBefore(d, bar);
        shields.set(el, d);
      }
      const r = el.getBoundingClientRect();
      d.style.left = `${r.left}px`;
      d.style.top = `${r.top}px`;
      d.style.width = `${r.width}px`;
      d.style.height = `${r.height}px`;
    }
  };
  shieldFrames();
  let current: Element | null = null;
  let raf = 0;
  const tick = () => {
    shieldFrames();
    for (const c of cands) place(c.d, c.el);
    if (current) place(box, current);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  (host as HostWithStop).__spellsheetWait = new Promise((resolve) => {
    const onBar = (e: Event) => banner && e.composedPath().includes(bar);
    const swallow = (e: Event) => {
      if (onBar(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    const move = (e: MouseEvent) => {
      if (onBar(e)) {
        box.style.display = "none";
        current = null;
        return;
      }
      current = under(e.clientX, e.clientY);
      box.style.display = current ? "block" : "none";
    };
    // Leaving this page (into a frame, or out of a frame): its box goes.
    const out = (e: MouseEvent) => {
      const to = e.relatedTarget as Element | null;
      if (!to || to.matches?.("iframe, frame")) {
        box.style.display = "none";
        current = null;
      }
    };
    const done = (outcome: "picked" | "cancelled") => {
      cancelAnimationFrame(raf);
      delete (host as HostWithStop).__spellsheetStop;
      for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "auxclick", "contextmenu"]) {
        window.removeEventListener(t, swallow, true);
      }
      window.removeEventListener("click", click, true);
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseout", out, true);
      window.removeEventListener("keydown", key, true);
      resolve(outcome);
    };
    const click = (e: MouseEvent) => {
      if (onBar(e)) return;
      swallow(e);
      // Over a covered frame (or nothing): keep waiting.
      const el = under(e.clientX, e.clientY);
      if (!el) return;
      el.setAttribute(picked, "");
      box.style.display = "block";
      place(box, el);
      done("picked");
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        swallow(e);
        done("cancelled");
      }
    };
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "auxclick", "contextmenu"]) {
      window.addEventListener(t, swallow, true);
    }
    window.addEventListener("click", click, true);
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseout", out, true);
    window.addEventListener("keydown", key, true);
    unsure.addEventListener("click", () => done("cancelled"));
    // A timeout or a new pick ends this one from outside (removeOverlay).
    (host as HostWithStop).__spellsheetStop = () => done("cancelled");
  });
}

type HostWithStop = HTMLElement & { __spellsheetStop?: () => void; __spellsheetWait?: Promise<"picked" | "cancelled"> };

/** The answer of the picker `overlay` set up in this document. */
function waitForOverlay(hostId: string): Promise<"picked" | "cancelled"> {
  const wait = (document.getElementById(hostId) as HostWithStop | null)?.__spellsheetWait;
  if (!wait) throw new Error("the picker is gone");
  return wait;
}

function removeOverlay({ hostId, attrs }: { hostId: string; attrs: string[] }): void {
  const host = document.getElementById(hostId) as (HTMLElement & { __spellsheetStop?: () => void }) | null;
  // Stop a waiting picker first: its listeners live on window, not in the host.
  host?.__spellsheetStop?.();
  host?.remove();
  for (const a of attrs) for (const el of Array.from(document.querySelectorAll(`[${a}]`))) el.removeAttribute(a);
}

function drawHighlights({ hostId, attr, label, durationMs }: { hostId: string; attr: string; label: string; durationMs: number }): void {
  const host = document.createElement("div");
  host.id = hostId;
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    .hl{position:fixed;border:3px solid #2b7bd6;background:rgba(43,123,214,.10);border-radius:4px;box-shadow:0 0 0 4px rgba(43,123,214,.25)}
    .hl i{position:absolute;top:-24px;left:-3px;padding:2px 8px;border-radius:4px;background:#2b7bd6;color:#fff;white-space:nowrap;
      font:600 12px/18px "Yu Gothic UI","Meiryo UI","Noto Sans JP",sans-serif;font-style:normal}
  </style>`;
  const items = Array.from(document.querySelectorAll(`[${attr}]`)).map((el) => {
    const d = document.createElement("div");
    d.className = "hl";
    const n = el.getAttribute(attr);
    const text = [n, label].filter(Boolean).join(" ");
    if (text) {
      const i = document.createElement("i");
      i.textContent = text;
      d.appendChild(i);
    }
    root.appendChild(d);
    return { el, d };
  });
  // Nothing of this page is outlined (it is in another frame).
  if (items.length === 0) return;
  document.documentElement.appendChild(host);
  let raf = 0;
  const tick = () => {
    for (const { el, d } of items) {
      const r = el.getBoundingClientRect();
      d.style.left = `${r.left - 4}px`;
      d.style.top = `${r.top - 4}px`;
      d.style.width = `${r.width + 8}px`;
      d.style.height = `${r.height + 8}px`;
    }
    raf = requestAnimationFrame(tick);
  };
  tick();
  setTimeout(() => {
    cancelAnimationFrame(raf);
    if (host.isConnected) host.remove();
    for (const el of Array.from(document.querySelectorAll(`[${attr}]`))) el.removeAttribute(attr);
  }, durationMs);
}
