// The values the last run left, for the result under an expression field
// and the columns a table offers. Display only. Large values are recorded as
// shortened previews; a table's preview still holds its first rows, which
// are recovered so the columns can be offered and a result shown, marked as
// computed from part of the value.
import type { RunState } from "../store";
import { t } from "./i18n";

export type RunScope = {
  values: Record<string, unknown>;
  /** Variables whose value is only part of what the run had. */
  partial: Set<string>;
  /** Columns known before a run (read from the file a repeat's table comes from), by variable. */
  columns?: Record<string, string[]>;
};

export const EMPTY_SCOPE: RunScope = { values: {}, partial: new Set() };

/** The complete leading elements of a JSON array cut short (`[{…},{…},{"a…`). */
export function leadingElements(preview: string): unknown[] | null {
  if (!preview.startsWith("[")) return null;
  let depth = 0;
  let inString = false;
  let lastEnd = -1;
  for (let i = 0; i < preview.length; i++) {
    const c = preview[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        // Text that only looks like a list (`[INFO] …`) is not one.
        try {
          return JSON.parse(preview.slice(0, i + 1)) as unknown[];
        } catch {
          return null;
        }
      }
    } else if (c === "," && depth === 1) lastEnd = i;
  }
  if (lastEnd < 0) return [];
  try {
    return JSON.parse(`${preview.slice(0, lastEnd)}]`) as unknown[];
  } catch {
    return null;
  }
}

/** Each variable's last value in the run of `flowId` (at the pause, when paused). */
export function runScope(run: RunState | null, flowId: string | undefined): RunScope {
  if (!run || !flowId || run.flowId !== flowId) return EMPTY_SCOPE;
  const values: Record<string, unknown> = {};
  const partial = new Set<string>();
  for (const change of run.changes) {
    if (change.secret) {
      delete values[change.variable];
      partial.add(change.variable);
      continue;
    }
    partial.delete(change.variable);
    if (change.truncated && typeof change.value === "string") {
      const rows = leadingElements(change.value);
      if (rows) values[change.variable] = rows;
      else if (change.value.startsWith("{")) delete values[change.variable];
      else values[change.variable] = change.value;
      partial.add(change.variable);
    } else values[change.variable] = change.value;
  }
  return { values, partial };
}

/** The columns of a table value: the keys of its first rows. */
export function columnsOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    const keys = new Set<string>();
    for (const row of value.slice(0, 20)) if (row && typeof row === "object" && !Array.isArray(row)) for (const k of Object.keys(row)) keys.add(k);
    return [...keys];
  }
  if (value && typeof value === "object") return Object.keys(value);
  return [];
}

/** A sample of a column, for the hint beside it. */
export function sampleOf(value: unknown, column: string): unknown {
  const row = Array.isArray(value) ? value.find((r) => r && typeof r === "object" && column in r) : value;
  return row && typeof row === "object" ? (row as Record<string, unknown>)[column] : undefined;
}

/** A value in one short line. */
export function shortValue(value: unknown, max = 40): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return t.exprField.items(value.length);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
