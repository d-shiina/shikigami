// Questions that stop the work until the user answers them: "delete this?",
// "close without saving?", "what name?". Shown by <AskDialog />, a dialog in
// the app's own look, never the WebView's window.confirm / window.prompt
// (those come up as a bare browser box at the top of the window).
//
// Call sites read like the browser ones did, only awaited:
//   if (await confirmAsk({ title, body, confirm: "削除", danger: true })) remove();
//   const name = await textAsk({ title, value: old, confirm: "変更" });
import { create } from "zustand";
import { t } from "./i18n";

/** What the user picked: the main button, the other button, or neither (Esc, Cancel, outside). */
export type AskAnswer = "confirm" | "other" | "cancel";

export interface ConfirmAsk {
  kind: "confirm";
  /** The question, as a sentence that names what happens: 「拡張機能「X」をアンインストールしますか？」 */
  title: string;
  /** What it means for the user's work, in one or two sentences. */
  body?: string;
  /** The main button: the verb of what happens (「アンインストール」), never 「OK」. */
  confirm: string;
  /** The main button removes or throws away something (shown in vermilion). */
  danger?: boolean;
  /** A second way through, left of the main button (「保存しない」). */
  other?: string;
  /** The cancel button's label; 「キャンセル」 when left out. */
  cancel?: string;
}

export interface TextAsk {
  kind: "text";
  title: string;
  body?: string;
  /** The field's label, when the title does not already say what to type. */
  label?: string;
  /** The text the field starts with. */
  value: string;
  /** How much of the start value is selected at first (a file's name without its extension); all of it when left out. */
  select?: [number, number];
  confirm: string;
  cancel?: string;
  /** Why the typed text cannot be used, or null when it can; checked as the user types. */
  check?: (value: string) => string | null;
}

type Pending = (ConfirmAsk & { answer: (a: AskAnswer) => void }) | (TextAsk & { answer: (value: string | null) => void });

interface AskState {
  /** The question on screen; the next ones wait their turn. */
  queue: Pending[];
}

export const useAsk = create<AskState>(() => ({ queue: [] }));

function push(p: Pending) {
  useAsk.setState((s) => ({ queue: [...s.queue, p] }));
}

/** Takes the question on screen away, so the next one (if any) shows. */
export function settle(p: Pending) {
  useAsk.setState((s) => ({ queue: s.queue.filter((q) => q !== p) }));
}

/** Asks a yes/no question; true when the user pressed the main button. */
export function confirmAsk(ask: Omit<ConfirmAsk, "kind" | "other">): Promise<boolean> {
  return chooseAsk(ask).then((a) => a === "confirm");
}

/** Asks with a main button, an optional second one, and cancel. */
export function chooseAsk(ask: Omit<ConfirmAsk, "kind">): Promise<AskAnswer> {
  return new Promise((resolve) => push({ ...ask, kind: "confirm", answer: resolve }));
}

/** Asks for a line of text; null when cancelled. */
export function textAsk(ask: Omit<TextAsk, "kind">): Promise<string | null> {
  return new Promise((resolve) => push({ ...ask, kind: "text", answer: resolve }));
}

/** The part of a file name before its extension, for selecting just that when renaming. */
export function baseNameRange(name: string): [number, number] {
  const dot = name.lastIndexOf(".");
  return [0, dot > 0 ? dot : name.length];
}

/** Before hand-edited text in a project file is left: save it, drop it, or stay. */
export function unsavedAsk(path: string): Promise<AskAnswer> {
  const ask = t.project.sheet.closeAsk;
  return chooseAsk({ title: ask.title(path.split("/").pop() ?? path), body: ask.body, confirm: ask.save, other: ask.dontSave });
}
