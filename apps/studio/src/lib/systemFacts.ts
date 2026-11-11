// What the system does at each step, beyond the step's own name: where it
// connects, which program it starts, which part of the screen it works on,
// which file it reads or writes, which secret it uses, how long it
// waits and how often it tries again, and which values it takes from earlier
// steps and hands to later ones. The chart shows these under each row, so the
// person can see what really happens on the PC. Only what the flow itself
// says for certain is listed: nothing is guessed.
import type { Flow, Step, StepTypeDef } from "@spellsheet/schema";
import { secretName, targetInWindow } from "./sentence";
import { variableUsage } from "./variableUsage";

export type Fact =
  | /** A site or server it connects to. */ { kind: "connect"; host: string }
  | /** A program it starts. */ { kind: "launch"; path: string }
  | /** The part of the screen it works on, in words. */ { kind: "target"; words: string }
  | /** A file it only reads, or one it writes or changes. */ { kind: "read" | "write"; path: string }
  | { kind: "secret"; name: string }
  | /** The longest it waits, in seconds. */ { kind: "wait"; seconds: number }
  | /** How many times it runs at the most when it fails. */ { kind: "retry"; attempts: number }
  | /** A value from an earlier step (`from`), or one the person gives when the flow starts (`from` null). */ { kind: "take"; variable: string; from: string | null }
  | /** A value later steps (`to`) use; `out` when the flow gives it back at its end. */ { kind: "give"; variable: string; to: string[]; out: boolean };

const FILE_KEYS = ["path", "file", "workbook", "document", "source", "savePath", "folder"];
const literal = (v: unknown) => (typeof v === "string" && v && !v.includes("{{") ? v : null);

function host(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** The facts of every step that has any, by step id. */
export function systemFacts(flow: Flow, defs: ReadonlyMap<string, StepTypeDef>): Map<string, Fact[]> {
  const facts = new Map<string, Fact[]>();
  const usage = variableUsage(flow.steps ?? [], flow.variables);
  // The order the steps stand in, to tell an earlier writer from a later one.
  const order = new Map<string, number>();
  const walkOrder = (steps: Step[]) => {
    for (const step of steps) {
      if (step.id) order.set(step.id, order.size);
      for (const inner of Object.values(step.blocks ?? {})) walkOrder(inner);
    }
  };
  walkOrder(flow.steps ?? []);

  const walk = (steps: Step[]) => {
    for (const step of steps) {
      for (const inner of Object.values(step.blocks ?? {})) walk(inner);
      if (!step.id || step.disabled) continue;
      const id = step.id;
      const at = order.get(id) ?? 0;
      const list: Fact[] = [];
      const p = (step.params ?? {}) as Record<string, unknown>;
      const [adapter] = step.type.split(".");

      const site = host(literal(p.url));
      if (site) list.push({ kind: "connect", host: site });
      if (step.type === "desktop.launch" && literal(p.path)) list.push({ kind: "launch", path: literal(p.path)! });
      if (adapter === "desktop" || adapter === "browser") {
        const words = targetInWindow(p.target);
        if (words) list.push({ kind: "target", words });
      }
      if (adapter === "excel" || adapter === "word" || adapter === "file" || adapter === "pdf") {
        const reads = defs.get(step.type)?.risk === "safe";
        for (const key of FILE_KEYS) {
          const path = literal(p[key]);
          if (path) list.push({ kind: reads ? "read" : "write", path });
        }
      }
      const secrets = new Set<string>();
      const findSecrets = (value: unknown) => {
        const name = secretName(value);
        if (name) secrets.add(name);
        else if (value && typeof value === "object") for (const inner of Object.values(value)) findSecrets(inner);
      };
      findSecrets(p);
      if (typeof p.session === "string" && step.type === "browser.open") secrets.add(p.session);
      for (const name of secrets) list.push({ kind: "secret", name });
      if (typeof step.timeoutMs === "number" && step.timeoutMs > 0) list.push({ kind: "wait", seconds: Math.round(step.timeoutMs / 100) / 10 });
      if (step.retry && step.retry.maxAttempts > 1) list.push({ kind: "retry", attempts: step.retry.maxAttempts });

      for (const u of usage) {
        if (u.readers.includes(id)) {
          // The last step before this one that writes it; none means the value comes with the flow's start.
          const writer = [...u.writers].filter((w) => w !== id && (order.get(w) ?? 0) < at).pop();
          if (writer) list.push({ kind: "take", variable: u.name, from: writer });
          else if (u.direction === "input" || u.direction === "inOut") list.push({ kind: "take", variable: u.name, from: null });
        }
        if (u.writers.includes(id)) {
          const to = u.readers.filter((r) => r !== id);
          const out = u.direction === "output" || u.direction === "inOut";
          if (to.length > 0 || out) list.push({ kind: "give", variable: u.name, to, out });
        }
      }
      if (list.length > 0) facts.set(id, list);
    }
  };
  walk(flow.steps ?? []);
  return facts;
}
