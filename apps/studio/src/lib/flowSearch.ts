// Searching the open flow (Ctrl+F): nodes by their name, kind, what they
// do, their memo, the variable they keep their result in and the values of
// their settings, so a variable's name finds every node that uses it.
import type { Step, StepTypeDef } from "@shikigami/schema";
import { t } from "./i18n";
import { paramLabel } from "./nodeRows";
import { outline } from "./outline";
import { plain, sentence, typeTitle } from "./sentence";

export type SearchHit = {
  id: string;
  step: Step;
  /** How deep in blocks the node is (0: the flow's own line). */
  depth: number;
  /** Where it matched: "名前", the setting's name… */
  field: string;
  /** The matched text around the match, and where the match is in it. */
  text: string;
  start: number;
  length: number;
  /** Other places in the same node that match too. */
  more: number;
};

/** Folded for matching: full-width letters and digits as half-width, lower case. */
export const fold = (text: string) => text.normalize("NFKC").toLowerCase();

const SNIPPET = 48;

/** Text of a setting's value, nested values joined. */
function valueTexts(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number" || typeof value === "boolean") out.push(String(value));
  else if (Array.isArray(value)) value.forEach((v) => valueTexts(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => valueTexts(v, out));
  return out;
}

/** `text` cut to about SNIPPET characters around [start, start + length). */
function around(text: string, start: number, length: number): Pick<SearchHit, "text" | "start" | "length"> {
  const line = text.replace(/\s+/g, " ");
  if (line.length <= SNIPPET) return { text: line, start, length };
  const from = Math.max(0, Math.min(start - 16, line.length - SNIPPET));
  const head = from > 0 ? "…" : "";
  const tail = from + SNIPPET < line.length ? "…" : "";
  return { text: head + line.slice(from, from + SNIPPET) + tail, start: start - from + head.length, length };
}

/**
 * The nodes of `steps` (inside blocks too, in the chart's order) that match
 * `query`, one row per node at its first matching place.
 */
export function searchFlow(steps: Step[], defs: Map<string, StepTypeDef>, query: string): SearchHit[] {
  const q = fold(query.trim());
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const { id, step, depth } of outline(steps, defs)) {
    const def = defs.get(step.type);
    const places: [string, string][] = [];
    if (step.name) places.push([t.search.name, step.name]);
    places.push([t.search.kind, typeTitle(step, def)]);
    places.push([t.search.does, plain(sentence(step, def))]);
    if (step.description) places.push([t.memo, step.description]);
    if (step.saveAs) places.push([t.search.result, step.saveAs]);
    for (const [key, value] of Object.entries(step.params ?? {})) {
      for (const text of valueTexts(value)) places.push([paramLabel(key, step.type), text]);
    }
    let first: SearchHit | null = null;
    let more = 0;
    for (const [field, text] of places) {
      // NFKC keeps the length of what people type in nodes (kana, letters).
      const at = fold(text).indexOf(q);
      if (at < 0) continue;
      if (first) more += 1;
      else first = { id, step, depth, field, ...around(text, at, q.length), more: 0 };
    }
    if (first) hits.push({ ...first, more });
  }
  return hits;
}
