// A run error in the person's language. The Runtime's `message` is English
// for the AI (and `code` is fixed by contract), so Studio words the error
// itself from `code`, `details` and the node's params (competitive-gaps.md #7).
import type { Step } from "@shikigami/schema";
import { FAIL } from "./stepTypes";
import { locale, t } from "./i18n";
import { targetText } from "./sentence";

/** What an entry gets to word the error with. */
export interface ErrorContext {
  /** A string from `details` ("" when absent). */
  str(key: string): string;
  /** A number from `details`. */
  num(key: string): number | undefined;
  /** `details[key]` in whole seconds. */
  seconds(key: string): string;
  /** A list of strings from `details`. */
  list(key: string): string[];
  /** A string param of the node ("" when absent or an expression). */
  p(key: string): string;
  /** The node's target in words ("" when it has none). */
  target: string;
  /** The window a desktop node aims at. */
  window: string;
  /** The text an OCR target looks for. */
  ocrText: string;
  /** The file the error is about: `details.path`, else the node's `path`. */
  path: string;
  /** The secret the error is about. */
  secret: string;
  /** Quotes a name the way the language does; "" stays "". */
  q(text: string): string;
}

type Text = string | ((c: ErrorContext) => string);
export interface ErrorText {
  what: Text;
  todo: Text;
}

export interface ErrorLike {
  code: string;
  message: string;
  details?: unknown;
}

export interface Explained {
  /** What happened, in the person's language. */
  what: string;
  /** What to do about it ("" when nothing is known). */
  todo: string;
  /** Whether Studio knew the code; otherwise `what` is the original message. */
  known: boolean;
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const plainString = (v: unknown) => (typeof v === "string" && !v.includes("{{") ? v.trim() : "");

/** The name a secret param refers to: `{ secret: "name" }` anywhere in the params. */
function secretIn(params: Record<string, unknown>): string {
  for (const value of Object.values(params)) {
    const ref = record(value);
    if (typeof ref.secret === "string") return ref.secret;
  }
  return "";
}

function context(details: Record<string, unknown>, step: Step | null | undefined): ErrorContext {
  const params = record(step?.params);
  const target = record(params.target);
  const win = record(target.window);
  const ja = locale === "ja";
  const str = (key: string) => (typeof details[key] === "string" ? (details[key] as string) : "");
  const num = (key: string) => (typeof details[key] === "number" && Number.isFinite(details[key]) ? (details[key] as number) : undefined);
  return {
    str,
    num,
    seconds: (key) => String(Math.round(((num(key) ?? 0) / 1000) * 10) / 10),
    list: (key) =>
      Array.isArray(details[key])
        ? (details[key] as unknown[]).map((v) => (typeof v === "string" ? v : typeof record(v).label === "string" ? String(record(v).label) : "")).filter(Boolean)
        : [],
    p: (key) => plainString(params[key]),
    target: Object.keys(target).length > 0 ? targetText(target) : "",
    window: plainString(win.title) || plainString(win.process) || plainString(win.className),
    ocrText: plainString(record(target.ocr).text),
    path: str("path") || plainString(params.path) || plainString(params.file),
    secret: str("secret") || secretIn(params),
    q: (text) => (!text ? "" : ja ? `「${text}」` : `"${text}"`),
  };
}

const say = (text: Text, c: ErrorContext) => (typeof text === "function" ? text(c) : text);

/**
 * Words `error` for people. Codes Studio does not know (a plugin's, or a
 * `control.fail` code the flow chose) keep their own message, which the
 * flow's author wrote for people anyway.
 */
export function explainError(error: ErrorLike, step?: Step | null): Explained {
  const entry = step?.type === FAIL ? undefined : t.runErrors[error.code];
  if (!entry) return { what: error.message, todo: "", known: false };
  const c = context(record(error.details), step);
  return { what: say(entry.what, c), todo: say(entry.todo, c), known: true };
}

/**
 * One line for the run log: the words only. The code is for AI clients
 * and stays in the run record (no English codes on screen, wording.md).
 */
export function errorLine(error: ErrorLike, step?: Step | null): string {
  return explainError(error, step).what;
}
