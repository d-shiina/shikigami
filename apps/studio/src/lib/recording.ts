// What the recorder ("記録") wrote down, and the nodes it becomes. The
// desktop adapter records clicks (with the target of what was clicked),
// each text field's final text and command keys (see `Op::Record`); here
// they become one node each, and a target used more than once becomes a
// named part. "AI に整えてもらう" hands the same recording to the AI.
import type { EditOp, Part, Step } from "@shikigami/schema";
import { t } from "./i18n";
import { newPartName } from "./parts";

export type RecordedAction = {
  kind: "click" | "setValue" | "press" | "drag";
  target?: Record<string, unknown>;
  how?: string;
  label?: string;
  window?: { title?: string; process?: string };
  button?: "left" | "right";
  double?: boolean;
  /** The field's text (setValue). */
  value?: string;
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

export type Skipped = { index: number; reason: "drag" | "failed" };

/** One node per action, in order; what cannot be a node is listed apart. */
export function recordedSteps(actions: readonly RecordedAction[], newId: () => string): { steps: Step[]; skipped: Skipped[] } {
  const steps: Step[] = [];
  const skipped: Skipped[] = [];
  actions.forEach((a, index) => {
    if (a.kind === "drag") return skipped.push({ index, reason: "drag" });
    if (a.failed || !a.target) return skipped.push({ index, reason: "failed" });
    const target = a.target;
    const step = (type: string, params: Record<string, unknown>, name?: string): Step => ({
      id: newId(),
      type,
      params: { target, ...params },
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
      case "setValue":
        if (a.password) steps.push(step("desktop.setValue", { value: "" }, t.recording.passwordName));
        else if (a.unread || a.value === undefined) steps.push(step("desktop.type", { text: "" }, t.recording.unreadName));
        else steps.push(step("desktop.setValue", { value: a.value }));
        break;
      case "press":
        steps.push(step("desktop.press", { key: a.key ?? "Enter" }));
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
  for (const [name, part] of Object.entries(parts)) if (part.app === "desktop") existing.set(key(part.target), name);
  const counts = new Map<string, number>();
  for (const s of steps) counts.set(key(s.params?.target), (counts.get(key(s.params?.target)) ?? 0) + 1);
  const taken = new Set(Object.keys(parts));
  const named = new Map(existing);
  for (const s of steps) {
    const target = s.params?.target as Record<string, unknown>;
    const k = key(target);
    if (named.has(k) || (counts.get(k) ?? 0) < 2) continue;
    const name = newPartName(target, taken);
    taken.add(name);
    named.set(k, name);
    const label = partLabel(target);
    ops.push({ op: "setPart", name, part: { app: "desktop", target: target as Part["target"], ...(label ? { label } : {}) } });
  }
  steps.forEach((s, i) => {
    const name = named.get(key(s.params?.target));
    const step: Step = name ? { ...s, params: { ...s.params, target: { part: name } } } : s;
    const at = typeof position.index === "number" ? { ...position, index: position.index + i } : position;
    ops.push({ op: "addStep", step, position: at });
  });
  return ops;
}

/** What the AI is asked when the person wants the recording tidied up. */
export function tidyRequest(recording: Recording, scenarioName: string, path: string | null, where: string): string {
  const lines = recording.actions.map((a, i) => `${i + 1}. ${JSON.stringify(a)}`);
  return [
    t.recording.askLead(scenarioName),
    where,
    path ? t.recording.askFile(path) : "",
    t.recording.askRules,
    ...lines,
  ]
    .filter((l) => l !== "")
    .join("\n");
}
