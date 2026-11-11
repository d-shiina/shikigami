// A new flow asked of the AI, shown in the editor from the moment it is asked:
// the sheet of paper the flow will be written on, with what was asked at its
// top and the AI's work where the first step will stand, so the person watches
// it from the request on instead of a list. Once the AI creates the flow,
// Writer opens its sheet in this place; nothing here is a flow yet, so nothing
// on it can be changed or run.
import { MessageCircleQuestion, MessageSquareText } from "lucide-react";
import { useEffect, useState } from "react";
import { type Chat, isBusy, useAgent, waitsForChoice } from "../agent";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import { DESK, PAPER } from "./sheet/paper";

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

export function DraftingFlow() {
  const drafting = useStudio((s) => s.drafting);
  const chat = useAgent((s) => s.chats.find((c) => c.id === drafting?.chatId));
  const paneOpen = useAgent((s) => s.open);
  const setPaneOpen = useAgent((s) => s.setOpen);
  const elapsed = useElapsed();
  if (!drafting) return null;
  const asking = !isBusy(chat) && !!chat && waitsForChoice(chat.items);
  return (
    <main aria-label={t.drafting.making} aria-busy={!asking} className={`relative min-w-0 flex-1 overflow-auto px-5 py-7 ${DESK}`}>
      <article className={`@container mx-auto w-[980px] max-w-full ${PAPER}`}>
        <div className="px-6 pt-11 pb-16 @[52rem]:px-[72px]">
        <h1 className="text-[24px] leading-tight font-semibold tracking-[-0.01em] text-ink">{drafting.title || t.agent.untitled}</h1>
        {drafting.request && (
          <dl className="mt-6 grid grid-cols-[124px_minmax(0,1fr)] gap-x-4 border-y border-slate-200 py-5 text-[14px]">
            <dt className="flex items-center gap-2 self-start pt-px text-slate-500">
              <MessageSquareText size={15} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
              {t.drafting.asked}
            </dt>
            <dd className="line-clamp-6 min-w-0 leading-[1.7] whitespace-pre-wrap text-ink">{drafting.request}</dd>
          </dl>
        )}
        {/* Where the first step will stand: what the AI is doing now. */}
        <div className="mt-10 grid grid-cols-[28px_minmax(0,1fr)] py-2.5">
          <span className="pt-[3px] text-[12px] text-slate-400 tabular-nums">1</span>
          {asking ? (
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-[15px] leading-[1.6] font-semibold text-ink">
                <MessageCircleQuestion size={15} strokeWidth={1.75} className="shrink-0 text-slate-500" aria-hidden="true" />
                {t.drafting.question}
              </p>
              <p className="mt-0.5 text-[14px] leading-[1.8] text-slate-700">{t.drafting.questionHint}</p>
              {!paneOpen && (
                <button type="button" onClick={() => setPaneOpen(true)} className="mt-1 text-[13px] font-medium text-primary hover:underline">
                  {t.drafting.openChat}
                </button>
              )}
            </div>
          ) : (
            <div className="min-w-0">
              <p className="text-[15px] leading-[1.6] font-semibold text-ink">
                <span className="flow-chart-on">{t.drafting.making}</span>
              </p>
              <p className="mt-0.5 flex gap-3 text-[14px] leading-[1.8] text-slate-700" aria-live="polite">
                <span className="min-w-0 truncate">{doing(chat)}</span>
                <span className="shrink-0 text-slate-500 tabular-nums">{t.agent.elapsed(elapsed)}</span>
              </p>
              <div className="mt-3 space-y-2.5" aria-hidden="true">
                <div className="h-px w-[72%] bg-slate-200 motion-safe:animate-pulse" />
                <div className="h-px w-[48%] bg-slate-200 motion-safe:animate-pulse" />
              </div>
            </div>
          )}
        </div>
        <p className="mt-6 pl-7 text-[12.5px] leading-[1.7] text-slate-500">{t.drafting.grows}</p>
        </div>
      </article>
    </main>
  );
}
