// A new flow asked of the AI, shown in the editor from the moment it is asked:
// the empty chart (start, a node being made, end) where the flow will grow,
// so the person watches it from the request on instead of a list. Once the
// AI creates the flow, Writer opens it here and pans to each node it adds
// (lib/followAi.ts); nothing on this screen is a flow yet, so nothing on it
// can be edited or run.
import { MessageCircleQuestion } from "lucide-react";
import { useEffect, useState } from "react";
import { type Chat, isBusy, useAgent, waitsForChoice } from "../agent";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import { NODE_W, TERMINAL_H } from "../flow/layout";

/** What the AI is doing in the conversation, as one line under the node. */
function doing(chat: Chat | undefined): string {
  const reply = chat?.items.at(-1);
  if (!chat || reply?.role !== "ai" || !reply.turnId) return t.drafting.starting;
  const tool = reply.preparing ?? [...reply.parts].reverse().find((p) => p.kind === "tool")?.name ?? null;
  if (!tool) return t.drafting.thinking;
  const label = (t.agent.tools as Record<string, string>)[tool];
  return label ? t.drafting.doing(label) : t.drafting.thinking;
}

/** Seconds since the screen opened, as the pane counts a turn. */
function useElapsed(): number {
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(since);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return Math.floor((now - since) / 1000);
}

function Terminal({ label }: { label: string }) {
  return (
    <div
      style={{ height: TERMINAL_H }}
      className="flex items-center rounded-full border border-slate-300 bg-sheet px-3.5 text-[12.5px] font-semibold tracking-wide whitespace-nowrap text-ink shadow-sm"
    >
      {label}
    </div>
  );
}

const Line = () => <div className="h-10 w-[1.5px] bg-[var(--flow-edge)]" aria-hidden="true" />;

export function DraftingFlow() {
  const drafting = useStudio((s) => s.drafting);
  const chat = useAgent((s) => s.chats.find((c) => c.id === drafting?.chatId));
  const paneOpen = useAgent((s) => s.open);
  const setPaneOpen = useAgent((s) => s.setOpen);
  const elapsed = useElapsed();
  if (!drafting) return null;
  const asking = !isBusy(chat) && !!chat && waitsForChoice(chat.items);
  return (
    <main
      aria-label={t.drafting.making}
      aria-busy={!asking}
      className="canvas-bg relative min-w-0 flex-1 overflow-auto bg-[radial-gradient(var(--color-slate-200)_1.2px,transparent_1.2px)] bg-[length:24px_24px]"
    >
      <div className="flex min-h-full flex-col items-center px-4 pt-[12vh] pb-10">
        <Terminal label={t.flow.start} />
        <Line />
        <div
          style={{ width: NODE_W }}
          className={`rounded-lg border bg-sheet px-3.5 py-3 ${asking ? "border-slate-300" : "border-brand-500 shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-brand-500)_12%,transparent)]"}`}
        >
          {asking ? (
            <>
              <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                <MessageCircleQuestion size={15} strokeWidth={1.75} className="shrink-0 text-slate-500" aria-hidden="true" />
                {t.drafting.question}
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-slate-500">{t.drafting.questionHint}</p>
              {!paneOpen && (
                <button
                  type="button"
                  onClick={() => setPaneOpen(true)}
                  className="mt-2 h-7 rounded-lg border border-slate-300 bg-sheet px-2.5 text-[12px] text-slate-700 hover:bg-slate-50"
                >
                  {t.drafting.openChat}
                </button>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                <span className="h-[10px] w-[10px] shrink-0 rounded-full bg-brand-500 motion-safe:animate-pulse" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{t.drafting.making}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[12px] text-slate-500" aria-live="polite">
                <span className="min-w-0 flex-1 truncate">{doing(chat)}</span>
                <span className="shrink-0 tabular-nums">{t.agent.elapsed(elapsed)}</span>
              </div>
              <div className="mt-3 space-y-1.5" aria-hidden="true">
                <div className="h-2 w-[72%] rounded-full bg-slate-100 motion-safe:animate-pulse" />
                <div className="h-2 w-[48%] rounded-full bg-slate-100 motion-safe:animate-pulse" />
              </div>
            </>
          )}
        </div>
        <Line />
        <Terminal label={t.flow.end} />
        <p className="mt-4 text-[12px] text-slate-500">{t.drafting.grows}</p>
        {drafting.request && (
          <figure className="mt-8 w-full max-w-[440px] border-l-2 border-slate-200 pl-3">
            <figcaption className="text-[11px] text-slate-500">{t.drafting.asked}</figcaption>
            <blockquote className="mt-0.5 line-clamp-4 text-[12.5px] leading-relaxed whitespace-pre-wrap text-slate-700">{drafting.request}</blockquote>
          </figure>
        )}
      </div>
    </main>
  );
}
