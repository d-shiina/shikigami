// Searching the open flow (Ctrl+F): nodes by their name, kind, what they
// do, their memo, the variable they keep their result in and the values of
// their settings, so a variable's name finds every node that uses it.
import type { Step, StepTypeDef } from "@spellsheet/schema";
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

/**
 * `text` as a row shows it (runs of white space as one space), folded for
 * matching, with where each folded code unit came from in the shown text.
 * A character is folded with the marks after it (ｶﾞ → ガ), so a match
 * found in the folded text covers whole shown characters.
 */
function foldShown(text: string): { shown: string; folded: string; from: number[]; to: number[] } {
  let shown = "";
  let folded = "";
  const from: number[] = [];
  const to: number[] = [];
  for (const [piece] of text.matchAll(/\s+|.(?:[\uFF9E\uFF9F]|\p{M})*/gsu)) {
    const visible = /^\s/u.test(piece) ? " " : piece;
    const f = fold(visible);
    for (let i = 0; i < f.length; i++) {
      from.push(shown.length);
      to.push(shown.length + visible.length);
    }
    shown += visible;
    folded += f;
  }
  return { shown, folded, from, to };
}

/** Where `q` (folded) is in `text`, as a cut of the shown text around it. */
function match(text: string, q: string): Pick<SearchHit, "text" | "start" | "length"> | null {
  const { shown, folded, from, to } = foldShown(text);
  const at = folded.indexOf(q);
  if (at < 0) return null;
  const start = from[at]!;
  const length = to[at + q.length - 1]! - start;
  if (shown.length <= SNIPPET) return { text: shown, start, length };
  const cut = Math.max(0, Math.min(start - 16, shown.length - SNIPPET));
  const head = cut > 0 ? "…" : "";
  const end = Math.max(cut + SNIPPET, start + length);
  const tail = end < shown.length ? "…" : "";
  return { text: head + shown.slice(cut, end) + tail, start: start - cut + head.length, length };
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
      const found = match(text, q);
      if (!found) continue;
      if (first) more += 1;
      else first = { id, step, depth, field, ...found, more: 0 };
    }
    if (first) hits.push({ ...first, more });
  }
  return hits;
}
