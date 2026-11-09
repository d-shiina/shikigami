// What the recorder ("記録") wrote down, and the nodes it becomes. The
// desktop adapter records clicks (with the target of what was clicked),
// each text field's final text and command keys (see `Op::Record`); the
// browser adapter records clicks, what was typed, choices, check boxes,
// Enter and addresses typed by hand (packages/browser-adapter/src/record.ts,
// `app: "browser"`). Here they become one node each, and a target used more
// than once becomes a named part. "AI に整えてもらう" hands the same
// recording to the AI.
import type { EditOp, Part, Step } from "@spellsheet/schema";
import { t } from "./i18n";
import { newPartName } from "./parts";

export type RecordedAction = {
  /** Set by the browser recorder; desktop actions have none. */
  app?: "browser";
  kind: "click" | "setValue" | "press" | "drag" | "open" | "fill" | "select" | "check" | "upload";
  target?: Record<string, unknown>;
  how?: string;
  label?: string;
  window?: { title?: string; process?: string };
  button?: "left" | "right";
  double?: boolean;
  /** The field's text (setValue, fill), the chosen labels (select). */
  value?: string | string[];
  /** open: the address. */
  url?: string;
  /** check: on or off. */
  checked?: boolean;
  /** A password field: its text is not recorded. */
  password?: boolean;
  /** The field's text could not be read. */
  unread?: boolean;
  key?: string;
  /** The screen could not be read where the user clicked. */
  failed?: { code?: string; message?: string };
};

export type Recording = {
  status: "stopped" | "timedOut";
  actions: RecordedAction[];
};

export type Skipped = { index: number; reason: "drag" | "failed" | "upload" | "opened" };

export type RecordedStepsOptions = {
  /** The browser context the nodes use (`context`), when not the default. */
  context?: string;
  /** The page is opened above where the nodes go: the first 「ページを開く」 is left out. */
  pageOpen?: boolean;
};

/** The browser nodes for one recorded browser action, or why there is none. */
function browserStep(a: RecordedAction, id: string, first: boolean, options: RecordedStepsOptions): Step | Skipped["reason"] {
  const context = options.context ? { context: options.context } : {};
  const step = (type: string, params: Record<string, unknown>, name?: string): Step => ({
    id,
    type,
    params: { ...(a.target ? { target: a.target } : {}), ...params, ...context },
    ...(name ? { name } : {}),
  });
  switch (a.kind) {
    case "open":
      if (first && options.pageOpen) return "opened";
      return step("browser.open", { url: a.url ?? "" });
    case "upload":
      return "upload";
  }
  if (a.failed || !a.target) return "failed";
  switch (a.kind) {
    case "click":
      return step("browser.click", { ...(a.button === "right" ? { button: "right" } : {}), ...(a.double ? { double: true } : {}) });
    case "fill":
      return a.password
        ? step("browser.fill", { value: "" }, t.recording.passwordName)
        : step("browser.fill", { value: typeof a.value === "string" ? a.value : "" });
    case "select":
      return step("browser.select", { value: a.value ?? "" });
    case "check":
      return step("browser.check", { checked: a.checked !== false });
    case "press":
      return step("browser.press", { key: a.key ?? "Enter" });
    default:
      return "failed";
  }
}

/** One node per action, in order; what cannot be a node is listed apart. */
export function recordedSteps(
  actions: readonly RecordedAction[],
  newId: () => string,
  options: RecordedStepsOptions = {},
): { steps: Step[]; skipped: Skipped[] } {
  const steps: Step[] = [];
  const skipped: Skipped[] = [];
  actions.forEach((a, index) => {
    if (a.app === "browser") {
      const made = browserStep(a, newId(), index === 0, options);
      if (typeof made === "string") skipped.push({ index, reason: made });
      else steps.push(made);
      return;
    }
    if (a.kind === "drag") return skipped.push({ index, reason: "drag" });
    if (a.failed || !a.target) return skipped.push({ index, reason: "failed" });
    const target = a.target;
    // A place without a name (`point`) is for the mouse only: keys go to
    // the window, after clicking the place.
    const byPoint = "point" in target;
    const windowOnly = { window: target.window };
    const step = (type: string, params: Record<string, unknown>, name?: string, on: Record<string, unknown> = target): Step => ({
      id: newId(),
      type,
      params: { target: on, ...params },
      ...(name ? { name } : {}),
    });
    switch (a.kind) {
      case "click": {
        // Without the mouse where it can (sturdier, runs unattended); the
        // mouse for right / double clicks and places without a name.
        const mouse = a.button === "right" || a.double === true || a.how === "point";
        steps.push(
          mouse
            ? step("desktop.mouseClick", { ...(a.button === "right" ? { button: "right" } : {}), ...(a.double ? { double: true } : {}) })
            : step("desktop.click", {}),
        );
        break;
      }
      case "setValue": {
        const name = a.password ? t.recording.passwordName : a.unread || a.value === undefined ? t.recording.unreadName : undefined;
        const text = a.password || a.unread || typeof a.value !== "string" ? "" : a.value;
        if (byPoint) {
          steps.push(step("desktop.mouseClick", {}));
          steps.push(step("desktop.type", { text }, name, windowOnly));
        } else if (!a.password && (a.unread || a.value === undefined)) {
          steps.push(step("desktop.type", { text: "" }, name));
        } else {
          steps.push(step("desktop.setValue", { value: text }, name));
        }
        break;
      }
      case "press":
        steps.push(step("desktop.press", { key: a.key ?? "Enter" }, undefined, byPoint ? windowOnly : target));
        break;
    }
  });
  return { steps, skipped };
}

const key = (v: unknown) => JSON.stringify(sorted(v));
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sorted((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** A short name for a part: the element's name or id, else the window's title. */
export function partLabel(target: Record<string, unknown>): string {
  if (!("window" in target) && !("element" in target)) {
    // A page's element: role and name, label, placeholder, text.
    for (const v of [target.name, target.label, target.placeholder, target.text, target.testId]) {
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  }
  const element = (target.element ?? {}) as Record<string, unknown>;
  const window = (target.window ?? {}) as Record<string, unknown>;
  for (const v of [element.name, element.id, window.title, window.process]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

type Position = { parentId?: string | null; block?: string | null; index?: number | null };

/**
 * The edits that add `steps` at `position`, in order. A target used by two
 * nodes or more (or one an existing part already has) is named once in
 * `parts`. One batch, so one undo.
 */
export function recordingOps(steps: readonly Step[], parts: Readonly<Record<string, Part>>, position: Position): EditOp[] {
  const ops: EditOp[] = [];
  const existing = new Map<string, string>();
  const appOf = (s: Step) => (s.type.startsWith("browser.") ? "browser" : "desktop");
  for (const [name, part] of Object.entries(parts)) {
    if (part.app === "desktop" || part.app === "browser") existing.set(`${part.app}:${key(part.target)}`, name);
  }
  // Steps without a target (opening a page) have none to share.
  const keyOf = (s: Step) => (s.params?.target ? `${appOf(s)}:${key(s.params.target)}` : null);
  const counts = new Map<string, number>();
  for (const s of steps) {
    const k = keyOf(s);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const taken = new Set(Object.keys(parts));
  const named = new Map(existing);
  for (const s of steps) {
    const k = keyOf(s);
    if (!k || named.has(k) || (counts.get(k) ?? 0) < 2) continue;
    const target = s.params?.target as Record<string, unknown>;
    const name = newPartName(target, taken);
    taken.add(name);
    named.set(k, name);
    const label = partLabel(target);
    ops.push({ op: "setPart", name, part: { app: appOf(s), target: target as Part["target"], ...(label ? { label } : {}) } });
  }
  steps.forEach((s, i) => {
    const k = keyOf(s);
    const name = k ? named.get(k) : undefined;
    const step: Step = name ? { ...s, params: { ...s.params, target: { part: name } } } : s;
    const at = typeof position.index === "number" ? { ...position, index: position.index + i } : position;
    ops.push({ op: "addStep", step, position: at });
  });
  return ops;
}

/** What the AI is asked when the person wants the recording tidied up. */
export function tidyRequest(recording: Recording, flowName: string, path: string | null, where: string): string {
  const lines = recording.actions.map((a, i) => `${i + 1}. ${JSON.stringify(a)}`);
  const browser = recording.actions.some((a) => a.app === "browser");
  return [
    browser ? t.recording.askLeadBrowser(flowName) : t.recording.askLead(flowName),
    where,
    path ? t.recording.askFile(path) : "",
    browser ? t.recording.askRulesBrowser : t.recording.askRules,
    ...lines,
  ]
    .filter((l) => l !== "")
    .join("\n");
}
