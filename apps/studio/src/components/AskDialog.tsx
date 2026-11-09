// The app's own dialog for questions that stop the work (lib/ask.ts):
// a sheet in the middle of the window over a light veil, the question as
// its title, what it means below, and the buttons at the right end with
// the main one last (ui-principles.md 5: one filled button; vermilion when
// it removes something, as Linear, Notion and VS Code do).
// Enter presses the focused button (the main one at first) or sends the
// field, Esc cancels, Tab stays inside the dialog, and focus goes back to
// where it was. Nothing moves, so there is nothing to reduce for
// "reduce motion".
import { useId, useLayoutEffect, useRef, useState } from "react";
import { settle, useAsk } from "../lib/ask";
import { t } from "../lib/i18n";

const base = "h-8 rounded-md px-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const primary = `${base} bg-primary text-on-primary hover:bg-primary-hover disabled:opacity-50 disabled:hover:bg-primary`;
const danger = `${base} bg-shu-600 text-on-primary hover:bg-shu-500 focus-visible:outline-shu-600 disabled:opacity-40 disabled:hover:bg-shu-600`;
const secondary = `${base} border border-slate-300 bg-sheet text-slate-700 hover:bg-slate-50`;
const quiet = `${base} text-slate-600 hover:bg-slate-100`;

export function AskDialog() {
  const ask = useAsk((s) => s.queue[0]);
  const boxRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);

  // Focus returns to what had it (the row, the button) once the last question is answered.
  // A layout effect declared before the one below, so it reads the focus before the dialog takes it.
  const opened = !!ask;
  useLayoutEffect(() => {
    if (!opened) return;
    const before = document.activeElement as HTMLElement | null;
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, [opened]);

  // Each question starts from its own text; focus goes to the field or the main button.
  useLayoutEffect(() => {
    if (!ask) return;
    setTouched(false);
    if (ask.kind === "text") {
      setValue(ask.value);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        const [from, to] = ask.select ?? [0, ask.value.length];
        input.setSelectionRange(from, to);
      });
    } else {
      mainRef.current?.focus();
    }
  }, [ask]);

  if (!ask) return null;

  const cancel = () => {
    settle(ask);
    if (ask.kind === "text") ask.answer(null);
    else ask.answer("cancel");
  };
  const expected = ask.kind === "text" && ask.expect !== undefined;
  const problem = ask.kind === "text" && !expected ? (ask.check?.(value) ?? (value.trim() === "" ? t.ask.empty : null)) : null;
  // Typed exactly (spaces at the ends aside), or nothing called wrong yet.
  const ready = ask.kind === "text" && expected ? value.trim() === ask.expect!.trim() : !(touched && problem);
  const send = () => {
    if (ask.kind !== "text") return;
    setTouched(true);
    if (problem || !ready) return;
    settle(ask);
    ask.answer(value.trim());
  };
  const pick = (answer: "confirm" | "other") => {
    if (ask.kind !== "confirm") return;
    settle(ask);
    ask.answer(answer);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The window's own keys (Delete removes a node, Ctrl+S saves…) wait until the question is answered.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Tab") {
      const items = [...(boxRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input") ?? [])];
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === items.length - 1 ? 0 : at + 1;
      e.preventDefault();
      items[next]?.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-ink/30 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && cancel()}
      onKeyDown={onKeyDown}
    >
      <div
        ref={boxRef}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={ask.body ? bodyId : undefined}
        className="w-[440px] max-w-full rounded-lg border border-slate-200 bg-sheet p-5 shadow-dialog outline-none"
      >
        <h2 id={titleId} className="text-[15px] leading-snug font-semibold text-ink">
          {ask.title}
        </h2>
        {ask.body && (
          <p id={bodyId} className="mt-2 text-[13px] leading-relaxed text-slate-600">
            {ask.body}
          </p>
        )}
        {ask.kind === "text" ? (
          <form
            className="mt-4"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            {ask.items && ask.items.length > 0 && (
              <ul className="mb-3 max-h-32 overflow-y-auto rounded border border-slate-200 bg-paper px-3 py-1.5 text-[13px] text-ink">
                {ask.items.map((item, i) => (
                  <li key={`${i}-${item}`} className="truncate py-0.5">
                    {item}
                  </li>
                ))}
              </ul>
            )}
            <label className="block space-y-1">
              {ask.label && <span className="text-xs font-medium text-slate-600">{ask.label}</span>}
              <input
                ref={inputRef}
                aria-label={ask.label ?? ask.title}
                aria-invalid={touched && !!problem}
                className={`h-8 w-full rounded border bg-sheet px-2 text-[13px] text-ink focus:outline-none dark:bg-paper ${
                  touched && problem ? "border-shu-500 focus:border-shu-500" : "border-slate-300 focus:border-primary"
                }`}
                value={value}
                placeholder={ask.expect}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => {
                  setValue(e.target.value);
                  setTouched(true);
                }}
              />
            </label>
            {expected ? (
              <div className="h-1" />
            ) : (
            <p className={`mt-1 min-h-[18px] text-xs ${touched && problem ? "text-shu-600" : "text-transparent"}`} role="status">
              {touched && problem ? problem : " "}
            </p>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" className={quiet} onClick={cancel}>
                {ask.cancel ?? t.cancel}
              </button>
              <button type="submit" className={ask.danger ? danger : primary} disabled={!ready}>
                {ask.confirm}
              </button>
            </div>
          </form>
        ) : (
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className={quiet} onClick={cancel}>
              {ask.cancel ?? t.cancel}
            </button>
            {ask.other && (
              <button type="button" className={secondary} onClick={() => pick("other")}>
                {ask.other}
              </button>
            )}
            <button ref={mainRef} type="button" className={ask.danger ? danger : primary} onClick={() => pick("confirm")}>
              {ask.confirm}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
