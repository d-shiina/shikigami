// The run window's form, made from a flow's input variables, so the
// author (person or AI) writes nothing for it: the label is the variable's
// description, the type picks the field, the default fills it in.
import type { Flow, Step, VariableDef } from "@shikigami/schema";
import { t } from "../lib/i18n";

export type FieldKind = "text" | "password" | "number" | "checkbox" | "lines" | "json" | "file" | "folder" | "date" | "month" | "select";

export interface Field {
  name: string;
  label: string;
  kind: FieldKind;
  /** No default: the run cannot start without it. */
  required: boolean;
  /** What the field starts with, as the person sees it (for `select`, the index of the choice). */
  initial: string | boolean;
  /** For `select`: the values to pick from, in the flow's order. */
  choices?: unknown[];
}

export const isInput = (v: VariableDef) => v.direction === "input" || v.direction === "inOut";
export const isOutput = (v: VariableDef) => v.direction === "output" || v.direction === "inOut";

function kindOf(v: VariableDef): FieldKind {
  if (v.secret) return "password";
  if ((v.choices ?? []).length > 0) return "select";
  // `format` marks what a text holds (validation keeps it on texts).
  if (v.format && (v.type === "string" || v.type === undefined || v.type === "any")) return v.format;
  switch (v.type) {
    case "number":
      return "number";
    case "boolean":
      return "checkbox";
    case "array":
      return "lines";
    case "object":
      return "json";
    default:
      return "text";
  }
}

function shown(kind: FieldKind, value: unknown): string | boolean {
  if (kind === "checkbox") return value === true;
  if (value === undefined || value === null) return "";
  // One per line only when it reads back the same: non-empty one-line texts.
  // Anything else (numbers, empty or multi-line texts) is shown as JSON.
  if (kind === "lines" && Array.isArray(value) && value.every((v) => typeof v === "string" && v.trim() === v && v !== "" && !v.includes("\n")))
    return value.join("\n");
  if (typeof value === "string") return value;
  if (kind === "json" || kind === "lines" || typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/** The label people read: the description's first line, else the name. */
export function labelOf(v: VariableDef): string {
  return (v.description ?? "").split("\n")[0]?.trim() || v.name;
}

export function fieldsOf(flow: Flow): Field[] {
  return (flow.variables ?? []).filter(isInput).map((v) => {
    const kind = kindOf(v);
    const required = v.default === undefined;
    if (kind === "select") {
      const choices = v.choices ?? [];
      const at = required ? -1 : choices.findIndex((c) => JSON.stringify(c) === JSON.stringify(v.default));
      return { name: v.name, label: labelOf(v), kind, required, initial: at < 0 ? "" : String(at), choices };
    }
    return { name: v.name, label: labelOf(v), kind, required, initial: shown(kind, v.default) };
  });
}

/** A choice as the list shows it. */
export const choiceLabel = (value: unknown): string => (typeof value === "string" ? value : formatValue(value));

export type Values = Record<string, string | boolean>;

export const initialValues = (fields: Field[]): Values => Object.fromEntries(fields.map((f) => [f.name, f.initial]));

/**
 * The inputs for the run, or what is wrong with each field. An empty field
 * with a default is left out, so the flow's default applies.
 */
export function collect(fields: Field[], values: Values): { inputs: Record<string, unknown>; errors: Record<string, string> } {
  const inputs: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const raw = values[f.name] ?? f.initial;
    if (f.kind === "checkbox") {
      inputs[f.name] = raw === true;
      continue;
    }
    const text = String(raw);
    if (text.trim() === "") {
      if (f.required) errors[f.name] = t.runner.required;
      continue;
    }
    switch (f.kind) {
      case "number": {
        const n = Number(text.replaceAll(",", "").trim());
        if (Number.isFinite(n)) inputs[f.name] = n;
        else errors[f.name] = t.runner.notNumber;
        break;
      }
      case "lines":
        if (text.trim().startsWith("[")) {
          try {
            const parsed: unknown = JSON.parse(text);
            if (Array.isArray(parsed)) {
              inputs[f.name] = parsed;
              break;
            }
          } catch {
            // One item per line, then.
          }
        }
        inputs[f.name] = text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        break;
      case "select": {
        const choices = f.choices ?? [];
        const at = Number(text);
        if (Number.isInteger(at) && at >= 0 && at < choices.length) inputs[f.name] = choices[at];
        else if (f.required) errors[f.name] = t.runner.required;
        break;
      }
      case "json":
        try {
          inputs[f.name] = JSON.parse(text);
        } catch {
          errors[f.name] = t.runner.notJson;
        }
        break;
      default:
        inputs[f.name] = text;
    }
  }
  return { inputs, errors };
}

/** The flow's top-level steps a run goes through (disabled ones are skipped). */
export const topSteps = (flow: Flow): Step[] => (flow.steps ?? []).filter((s) => !s.disabled);

/** Which top-level step each step is inside (itself for a top-level one). */
export function topOf(flow: Flow): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (steps: Step[], top: string) => {
    for (const s of steps) {
      if (s.id) map.set(s.id, top);
      for (const children of Object.values(s.blocks ?? {})) walk(children, top);
    }
  };
  for (const s of flow.steps ?? []) if (s.id) walk([s], s.id);
  return map;
}

/** An output value as a person reads it. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return value.toLocaleString(t.runner.numberLocale);
  if (typeof value === "boolean") return value ? t.runner.yes : t.runner.no;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return t.runner.items(value.length);
  return JSON.stringify(value);
}
