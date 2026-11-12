// The agent pane: ask the AI without leaving Studio. Messages go to the person's own
// agent (Claude Code, Codex, Antigravity, Gemini CLI, GitHub Copilot or Cursor) with SpellSheet's MCP server; whatever it
// edits lands in 確認待ち like any other AI edit.
import { ArrowUp, ArrowUpRight, Check, ChevronDown, Clock, Download, ListChecks, Loader2, Plus, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type AgentPart, type Chat, type ChatItem, currentChat, isBusy, flowBusy, useAgent, useAgentApi } from "../agent";
import { type AgentChoice, type AgentKind, type InstallStep, agent } from "../lib/api";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import { plainLine } from "../lib/markdown";
import { Markdown } from "./Markdown";
import { ApiKeyBox } from "./AgentApiKey";
import { headline, summarize, purpose } from "../lib/review";
import { useReviewView } from "../lib/reviewView";
import { useInbox } from "./ReviewDesk";

const toolLabel = (name: string) => (t.agent.tools as Record<string, string>)[name] ?? name;
const chatTitle = (c: Chat) => c.title || t.agent.untitled;

/**
 * Asking the AI: a column of its own on the left of the work, the conversation above and the field at its foot
 * (asked on the left, looked at on the paper to the right). Its place is fixed; Ctrl+J and the window bar's button close and open it.
 */
export function AgentPane({ width }: { width: number }) {
  const open = useAgent((s) => s.open);
  const setOpen = useAgent((s) => s.setOpen);
  const info = useAgent((s) => s.info);
  const chat = useAgent(currentChat);
  const blockedElsewhere = useAgent((s) => flowBusy(s, currentChat(s).flowId, s.current));
  const sendIn = useAgent((s) => s.sendIn);
  const stop = useAgent((s) => s.stop);
  const newChat = useAgent((s) => s.newChat);
  const flow = useStudio((s) => s.flow);
  const openFlow = useStudio((s) => s.open);
  const selection = useStudio((s) => s.selection);
  // One draft per conversation, so switching does not carry text to another flow.
  const setDraft = useAgent((s) => s.setDraft);
  const getChats = useAgentApi().getState;
  const draft = chat.draft;
  const setDraftOf = (id: string, change: (now: string) => string) => setDraft(id, change(getChats().chats.find((c) => c.id === id)?.draft ?? ""));
  const end = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const { items } = chat;
  const busy = isBusy(chat);
  useEffect(() => {
    // Newer WebView2 returns a promise here; an effect must not.
    if (open) void end.current?.scrollIntoView({ block: "end" });
  }, [items, chat.id, open]);
  // The field is one line until more is written, then as high as its words (up to a few lines).
  useEffect(() => {
    const box = field.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 132)}px`;
  }, [draft, chat.id]);
  const available = info?.available === true;
  // The conversation may be about another flow than the one in the editor.
  const here = flow !== null && chat.flowId === flow.id;
  const stepId = here && selection?.kind === "step" ? selection.stepId : null;
  const submit = async (answer?: string) => {
    const ref = chat.flowId
      ? {
          id: chat.flowId,
          name: here ? flow.name : chat.title,
          stepId,
          empty: here && (flow.steps ?? []).length === 0,
        }
      : null;
    const context = chat.flowId ? `${ref!.name}${stepId ? ` ・ ${t.agent.selectedStep}` : ""}` : null;
    const id = chat.id;
    // A pressed answer leaves what the person was writing alone.
    if (answer !== undefined) {
      await sendIn(id, answer, ref, context);
      return;
    }
    // Cleared as it is sent, like any chat; back again if it was not taken.
    const text = draft;
    setDraftOf(id, () => "");
    if (!(await sendIn(id, text, ref, context))) setDraftOf(id, (now) => now || text);
  };
  // Only the last reply's card can still be answered, and not while the AI works.
  const canChoose = !busy && !blockedElsewhere && available;
  const CARD = "rounded-[8px] bg-sheet shadow-[0_0_0_1px_var(--color-slate-300),0_8px_24px_-8px_rgb(16_24_40/0.25)]";
  // Closed, the column draws nothing (what was being written is kept with the conversation).
  if (!open || width === 0) return null;
  return (
    <div className="flex h-full shrink-0 flex-col bg-sheet" style={{ width }} data-agent-dock>
      <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-10 shrink-0 items-center gap-1 border-b border-slate-200 pr-2 pl-2">
              <ChatSwitcher chat={chat} />
              <button
                type="button"
                onClick={() => newChat(chat.flowId ? { id: chat.flowId, name: chat.title } : null)}
                disabled={items.length === 0 && !chat.sessionId}
                className="grid h-6 w-6 shrink-0 place-items-center rounded-lg text-slate-500 enabled:hover:bg-slate-100 enabled:hover:text-ink disabled:text-slate-300"
                title={t.agent.newChat}
                aria-label={t.agent.newChat}
              >
                <Plus size={15} />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="grid h-6 w-6 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-ink"
                title={`${t.agent.closeTalk}（Ctrl+J）`}
                aria-label={t.agent.closeTalk}
              >
                <X size={15} />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
              {info && !available && (
                <>
                  {info.installable ? (
                    <SetupCard />
                  ) : (
                    <div className="rounded-lg border border-shu-100 bg-shu-50 px-3 py-2 text-[12px] leading-relaxed text-shu-600">{info.problem}</div>
                  )}
                </>
              )}
              {info?.usesApiKey && !info.hasApiKey && <ApiKeyBox />}
              {items.length === 0 && available && !(info.usesApiKey && !info.hasApiKey) && (
                <p className="py-6 text-center text-[12px] text-slate-500">{chat.sessionId ? t.agent.continued : t.agent.noTalk}</p>
              )}
              {items.map((item, i) => (
                <Item key={item.id} item={item} onChoose={canChoose && i === items.length - 1 ? (answer) => void submit(answer) : null} />
              ))}
              {!busy && items.at(-1)?.role === "ai" && <ReportCard flowId={chat.flowId} />}
              <LoginBox name={info?.name ?? "AI"} />
              {info?.hasApiKey && <ApiKeyBox />}
              <div ref={end} />
            </div>
          </div>
          <div className={`${CARD} m-3 mt-0 px-3 pt-2 pb-2 focus-within:shadow-[0_0_0_1px_var(--color-primary),0_8px_24px_-8px_rgb(16_24_40/0.25)]`}>
            <div className="flex items-end gap-2">
              <textarea
                ref={field}
                data-agent-input
                value={draft}
                onChange={(e) => setDraftOf(chat.id, () => e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                rows={1}
                disabled={!available}
                aria-label={chat.flowId ? t.agent.askEdit : t.agent.askNew}
                placeholder={!available ? t.agent.needsSetup : chat.flowId ? t.agent.placeholderEdit : t.agent.placeholderNew}
                className="min-h-[28px] min-w-0 flex-1 resize-none bg-transparent py-1 text-[13.5px] leading-[1.5] text-ink outline-none placeholder:text-slate-400 disabled:text-slate-400"
              />
              {chat.turnId && (
                <button
                  type="button"
                  onClick={() => void stop(chat.id)}
                  className="flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] border border-slate-300 px-2.5 text-[12px] text-slate-600 hover:bg-slate-100"
                >
                  <Square size={11} aria-hidden="true" />
                  {t.stop}
                </button>
              )}
              <button
                type="button"
                disabled={!available || blockedElsewhere || draft.trim() === ""}
                onClick={() => void submit()}
                title={blockedElsewhere ? t.agent.busyElsewhere : busy ? t.agent.noteHint : `${t.agent.send}（${t.agent.sendHint}）`}
                aria-label={t.agent.send}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary text-on-primary enabled:hover:bg-primary-hover disabled:bg-slate-200 disabled:text-slate-400"
              >
                <ArrowUp size={15} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-1 text-[10.5px] text-slate-500">
              {chat.flowId === null ? (
                <span className="truncate rounded-full bg-brand-50 px-2 py-0.5 text-brand-700">{t.agent.newFlowChat}</span>
              ) : here ? (
                <span className="truncate rounded-full bg-slate-100 px-2 py-0.5">{flow.name}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => void openFlow(chat.flowId!)}
                  title={t.agent.openFlow}
                  className="flex min-w-0 items-center gap-0.5 rounded-full bg-slate-100 px-2 py-0.5 hover:bg-slate-200 hover:text-ink"
                >
                  <span className="truncate">{chat.title}</span>
                  <ArrowUpRight size={12} className="shrink-0" aria-hidden="true" />
                </button>
              )}
              {stepId && <span className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-brand-700">{t.agent.selectedStep}</span>}
              <span className="ml-auto shrink-0 truncate">{blockedElsewhere ? t.agent.busyElsewhere : busy ? t.agent.noteHint : t.agent.sendHint}</span>
            </div>
          </div>
      </div>
    </div>
  );
}

/**
 * After the AI's turn, when its edits wait for review: the way to the report.
 * It is not opened by itself, so watching the AI build is never cut short.
 */
function ReportCard({ flowId }: { flowId: string | null }) {
  const item = useInbox().find((i) => i.flowId === flowId && !i.waiting);
  const place = useStudio((s) => s.place);
  const openFlow = useStudio((s) => s.open);
  const setPlace = useStudio((s) => s.setPlace);
  const shownId = useStudio((s) => s.flow?.id);
  const view = useReviewView((s) => s.view);
  const setView = useReviewView((s) => s.setView);
  if (!item) return null;
  // Already on the report it would open.
  if (place === "review" && shownId === item.flowId && view === "report") return null;
  const oldestFirst = [...item.entries].reverse();
  const summary = summarize(oldestFirst);
  return (
    <div className="rounded-lg border border-brand-500/60 bg-sheet px-3 py-2.5">
      <div className="text-[12.5px] font-bold">{t.agent.reportReady}</div>
      <div className="mt-0.5 text-[11.5px] leading-relaxed text-slate-500">
        {purpose(oldestFirst, summary)} ・ {headline(summary)}
      </div>
      <button
        type="button"
        onClick={() => {
          setView("report");
          setPlace("review");
          if (shownId !== item.flowId) void openFlow(item.flowId);
        }}
        className="mt-2 h-7 rounded-lg bg-primary px-3 text-[12px] font-semibold text-on-primary hover:bg-primary-hover"
      >
        {t.agent.openReport}
      </button>
    </div>
  );
}

/** Where a conversation is: working, finished while out of sight, or stopped. */
function ChatDot({ chat }: { chat: Chat }) {
  const last = chat.items.at(-1);
  if (isBusy(chat)) return <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-brand-500" title={t.agent.chatWorking} />;
  if (chat.unread && last?.role === "ai" && last.status === "failed")
    return <span className="h-2 w-2 shrink-0 rounded-full bg-shu-500" title={t.agent.chatFailed} />;
  if (chat.unread) return <span className="h-2 w-2 shrink-0 rounded-full bg-brand-500" title={t.agent.chatDone} />;
  return <span className="h-2 w-2 shrink-0" />;
}

/**
 * The pane's title: the conversation shown, and the others the AI is
 * working on or has finished, so several flows can be under way at once.
 */
function ChatSwitcher({ chat }: { chat: Chat }) {
  const chats = useAgent((s) => s.chats);
  const select = useAgent((s) => s.select);
  const remove = useAgent((s) => s.remove);
  const newChat = useAgent((s) => s.newChat);
  const flow = useStudio((s) => s.flow);
  const [open, setOpen] = useState(false);
  const others = chats.filter((c) => c.id !== chat.id);
  const working = others.filter(isBusy).length;
  const news = others.filter((c) => c.unread).length;
  // The empty conversation the editor's flow starts with is not worth a row.
  const listed = [...chats]
    .filter((c) => c.id === chat.id || c.items.length > 0 || c.sessionId || isBusy(c) || c.draft.trim())
    .sort((a, b) => Number(isBusy(b)) - Number(isBusy(a)) || b.updatedAt - a.updatedAt);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  const pick = (id: string) => {
    select(id);
    setOpen(false);
  };
  return (
    <div className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={t.agent.chats}
        className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-lg px-2 text-left hover:bg-slate-100"
      >
        <span className="min-w-0 truncate text-[13px] font-bold text-ink">{chatTitle(chat)}</span>
        <ChevronDown size={14} className="shrink-0 text-slate-500" />
        {(working > 0 || news > 0) && (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[10.5px] text-slate-500">
            <span className={`h-1.5 w-1.5 rounded-full bg-brand-500 ${working > 0 ? "animate-pulse" : ""}`} />
            {working > 0 ? t.agent.otherWorking(working) : t.agent.otherDone(news)}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-8 left-0 z-50 w-[min(320px,calc(100vw-32px))] overflow-hidden rounded-lg border border-slate-200 bg-sheet py-1 shadow-lg">
            <div className="max-h-[50vh] overflow-y-auto">
              {listed.map((c) => (
                <div key={c.id} className={`group flex items-center gap-2 px-3 py-1.5 ${c.id === chat.id ? "bg-slate-100" : "hover:bg-slate-50"}`}>
                  <ChatDot chat={c} />
                  <button type="button" onClick={() => pick(c.id)} className="min-w-0 flex-1 text-left">
                    <div className="truncate text-[12.5px] text-ink">{chatTitle(c)}</div>
                    <div className="truncate text-[10.5px] text-slate-500">
                      {isBusy(c) ? t.agent.chatWorking : c.flowId === null ? t.agent.newFlowChat : lastWords(c)}
                    </div>
                  </button>
                  {c.id === chat.id && <Check size={14} className="shrink-0 text-brand-600" />}
                  {!isBusy(c) && c.id !== chat.id && (
                    <button
                      type="button"
                      onClick={() => remove(c.id)}
                      className="grid h-5 w-5 shrink-0 place-items-center rounded-lg text-slate-400 opacity-0 group-hover:opacity-100 hover:bg-slate-200 hover:text-ink focus:opacity-100"
                      title={t.agent.removeChat}
                      aria-label={t.agent.removeChat}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-1 border-t border-slate-200 pt-1">
              {flow && (
                <button
                  type="button"
                  onClick={() => {
                    newChat({ id: flow.id, name: flow.name });
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-slate-600 hover:bg-slate-50 hover:text-ink"
                >
                  <Plus size={14} className="shrink-0" />
                  <span className="truncate">{t.agent.newChatAbout(flow.name)}</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  newChat(null);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-slate-600 hover:bg-slate-50 hover:text-ink"
              >
                <Plus size={14} className="shrink-0" />
                {t.agent.newFlowChat}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** The conversation's last words, to tell conversations about one flow apart. */
function lastWords(c: Chat): string {
  for (let i = c.items.length - 1; i >= 0; i--) {
    const item = c.items[i]!;
    if (item.role === "person") return item.text.split("\n")[0] ?? "";
    const text = [...item.parts].reverse().find((p) => p.kind === "text");
    if (text?.kind === "text") return plainLine(text.text);
  }
  return c.sessionId ? t.agent.earlier : "";
}

function Item({ item, onChoose }: { item: ChatItem; onChoose: ((answer: string) => void) | null }) {
  if (item.role === "person") {
    if (item.answers) return null;
    return (
      <div className="ml-8">
        {item.context && <div className="mb-0.5 truncate text-right text-[10px] text-slate-400">{item.context}</div>}
        <div className="rounded-lg rounded-tr-sm bg-slate-100 px-3 py-2 text-[13px] whitespace-pre-wrap text-ink">{item.text}</div>
        {item.note && (
          <div className={`mt-0.5 flex items-center justify-end gap-1 text-[10.5px] ${item.note === "heard" ? "text-slate-500" : "text-brand-700"}`}>
            {item.note === "heard" ? <Check size={12} aria-hidden="true" /> : <Clock size={12} aria-hidden="true" />}
            {item.note === "heard" ? t.agent.noteHeard : t.agent.noteWaiting}
          </div>
        )}
        {item.refused && <div className="mt-0.5 text-right text-[10.5px] text-shu-600">{item.refused}</div>}
      </div>
    );
  }
  return (
    <div className="mr-4 space-y-1.5">
      {item.parts.map((part, i) => (
        <Part key={i} part={part} onChoose={onChoose} />
      ))}
      {item.status === "running" && <Progress starting={item.turnId === ""} quiet={item.parts.length === 0} preparing={item.preparing} />}
      {item.status === "done" && item.message && <div className="text-[11px] text-slate-500">{item.message}</div>}
      {/* An expired login is explained by the sign-in box below instead. */}
      {item.status === "failed" && !item.needsLogin && (
        <div className="rounded-lg border border-shu-100 bg-shu-50 px-2.5 py-1.5 text-[12px] whitespace-pre-wrap text-shu-600">
          {item.message ?? t.agent.failed}
        </div>
      )}
    </div>
  );
}

/**
 * What a running reply is doing, with the seconds since it began so a long
 * wait still visibly moves: starting the agent, thinking before it has said
 * or done anything, writing a tool call (a large edit takes a while), then working.
 */
function Progress({ starting, quiet, preparing }: { starting: boolean; quiet: boolean; preparing: string | null }) {
  const [began] = useState(() => Date.now());
  const [now, setNow] = useState(began);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.floor((now - began) / 1000);
  const label = starting
    ? t.agent.starting
    : preparing
      ? t.agent.preparing(toolLabel(preparing))
      : quiet
        ? t.agent.thinking
        : t.agent.working;
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
      {label}
      {seconds >= 2 && <span className="text-slate-400 tabular-nums">{t.agent.elapsed(seconds)}</span>}
    </div>
  );
}

function Part({ part, onChoose }: { part: AgentPart; onChoose: ((answer: string) => void) | null }) {
  switch (part.kind) {
    case "choice":
      return <ChoiceCard part={part} onChoose={onChoose} />;
    case "text":
      return <Markdown text={part.text.trim()} />;
    case "tool":
      return (
        <div className="flex items-start gap-1.5 text-[11.5px] text-slate-500">
          <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
          <span>
            {toolLabel(part.name)}
            {part.detail && <span className="text-slate-400">：{part.detail}</span>}
          </span>
        </div>
      );
    case "toolFailed":
      return <div className="pl-3 text-[11px] text-shu-600">{t.agent.toolFailed}{part.message}</div>;
  }
}

/**
 * The AI asks the person to choose (ask_user_to_choose). Pressing an answer
 * sends it as the next message; writing something else in the box answers
 * too. Once answered, only the question and the answer stay, in one line.
 */
function ChoiceCard({ part, onChoose }: { part: Extract<AgentPart, { kind: "choice" }>; onChoose: ((answer: string) => void) | null }) {
  if (part.answer !== null) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 text-[12px] text-slate-500">
        <Check size={14} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
        <span className="min-w-0 whitespace-pre-wrap">
          {t.agent.choice.answered(part.question)}
          {/* A pressed answer is one of the options; a written one is the person's own words. */}
          <span className={part.options.some((o) => o.label === part.answer) ? "font-semibold text-ink" : "text-ink"}>{part.answer}</span>
        </span>
      </div>
    );
  }
  return (
    <div role="group" aria-label={part.question} className="rounded-lg border border-slate-200 bg-sheet p-3 shadow-raised">
      <div className="mb-2.5 flex items-start gap-2 text-[13px] leading-snug font-bold text-ink">
        <ListChecks size={16} className="mt-0.5 shrink-0 text-brand-500" aria-hidden="true" />
        <span>{part.question}</span>
      </div>
      <div className="space-y-1.5">
        {part.options.map((option, i) => (
          <button
            key={option.label}
            type="button"
            disabled={!onChoose}
            onClick={() => onChoose?.(option.label)}
            className="block w-full rounded-md border border-slate-200 px-2.5 py-2 text-left enabled:hover:border-brand-500 enabled:hover:bg-brand-50 focus-visible:border-brand-500 focus-visible:outline-none disabled:opacity-60"
          >
            <span className="flex items-center gap-2 text-[13px] font-semibold text-ink">
              <span className="w-3 shrink-0 text-[11px] font-normal text-slate-400 tabular-nums">{i + 1}</span>
              <span className="min-w-0">{option.label}</span>
              {part.recommended === i && (
                <span className="ml-auto shrink-0 rounded border border-brand-100 px-1.5 text-[11px] font-medium text-brand-600">
                  {t.agent.choice.recommended}
                </span>
              )}
            </span>
            {option.description && <span className="mt-0.5 block pl-5 text-[12px] leading-relaxed text-slate-500">{option.description}</span>}
          </button>
        ))}
      </div>
      {part.reason && part.recommended !== null && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-slate-500">{t.agent.choice.reason(part.reason)}</p>
      )}
      <p className="mt-1 text-[11.5px] text-slate-500">{t.agent.choice.other}</p>
    </div>
  );
}

/** The agents Studio can run, before the list from this PC arrives. */
const FALLBACK_CHOICES: AgentChoice[] = [
  { kind: "claudeCode", name: "Claude Code", maker: "Anthropic", installed: false, selected: false },
  { kind: "codex", name: "Codex", maker: "OpenAI", installed: false, selected: false },
  { kind: "antigravity", name: "Antigravity", maker: "Google", installed: false, selected: false },
  { kind: "gemini", name: "Gemini CLI", maker: "Google", installed: false, selected: false },
  { kind: "copilot", name: "GitHub Copilot", maker: "GitHub", installed: false, selected: false },
  { kind: "cursor", name: "Cursor", maker: "Cursor", installed: false, selected: false },
];

/** The one to take when unsure: the AI SpellSheet is checked with most. */
const RECOMMENDED: AgentKind = "claudeCode";

/** Picks which AI Studio uses, marking the ones on this PC. */
export function AgentPicker({ id, disabled }: { id?: string; disabled?: boolean }) {
  const info = useAgent((s) => s.info);
  const choices = useAgent((s) => s.choices);
  const choose = useAgent((s) => s.chooseAgent);
  const [error, setError] = useState<string | null>(null);
  const list = choices && choices.length > 0 ? choices : FALLBACK_CHOICES;
  // A `command` agent from config.json is not in the list; keep it showing.
  const custom = info?.kind === "command";
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <select
        id={id}
        disabled={disabled}
        className="h-7 min-w-0 rounded-lg border border-slate-300 bg-sheet px-1.5 text-[12px] disabled:opacity-60"
        value={info?.kind ?? "claudeCode"}
        onChange={(e) => {
          setError(null);
          choose(e.target.value as AgentKind).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
        }}
      >
        {custom && <option value="command">{info?.name}</option>}
        {list.map((c) => (
          <option key={c.kind} value={c.kind}>
            {`${c.name}${c.kind === RECOMMENDED ? t.agent.setup.recommendedTag : ""}${c.installed ? t.agent.setup.installedTag : ""}`}
          </option>
        ))}
      </select>
      {error && <span className="text-[11.5px] text-shu-600">{error}</span>}
    </span>
  );
}

/** Installs the agent and signs in, in one go, without a terminal. */
function SetupCard() {
  const info = useAgent((s) => s.info);
  const install = useAgent((s) => s.install);
  const login = useAgent((s) => s.login);
  const start = useAgent((s) => s.startInstall);
  const cancel = useAgent((s) => s.cancelInstall);
  const kind = info?.kind ?? "claudeCode";
  const name = info?.name ?? "AI";
  const busy = install.phase === "running" || install.phase === "stopping";
  const primary =
    "flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-semibold text-on-primary enabled:hover:bg-primary-hover disabled:bg-slate-200 disabled:text-slate-400";
  // The sign-in box takes over once the installer has done its part.
  if (login.phase !== "idle") return null;
  return (
    <div className="space-y-2 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2.5 text-[12px] text-ink">
      <div className="font-semibold">{t.agent.setup.title}</div>
      <div className="leading-relaxed text-slate-700">{t.agent.setup.lead}</div>
      <label className="flex items-center gap-2">
        <span className="shrink-0 text-slate-600">{t.agent.setup.which}</span>
        <AgentPicker disabled={busy} />
      </label>
      <div className="leading-relaxed text-slate-600">{t.agent.setup.note[kind === "command" ? "claudeCode" : kind]}</div>
      {!busy && install.phase !== "failed" && <div className="text-[11.5px] leading-relaxed text-slate-500">{t.agent.setup.unsure}</div>}
      {busy ? (
        <>
          <div className="flex items-start gap-1.5 text-slate-700" role="status">
            <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin" aria-hidden="true" />
            <span className="leading-relaxed">{install.phase === "stopping" ? t.agent.setup.stopping : installStepText(install.step, name)}</span>
          </div>
          {install.phase === "running" && <InstallClock startedAt={install.startedAt} lastAt={install.lastAt} />}
          {install.phase === "running" && install.lines.length > 0 && (
            <pre className="max-h-24 overflow-y-auto rounded-md bg-sheet px-2 py-1 font-mono text-[10.5px] leading-snug whitespace-pre-wrap text-slate-600">{install.lines.slice(-6).join("\n")}</pre>
          )}
          <button type="button" disabled={install.phase === "stopping"} onClick={() => void cancel()} className="text-slate-500 enabled:hover:text-ink disabled:opacity-50">
            {t.cancel}
          </button>
        </>
      ) : (
        <>
          {install.phase === "failed" && (
            <div className="space-y-0.5 text-shu-600" role="alert">
              <div className="font-semibold">{t.agent.installFailed}</div>
              {install.message !== t.agent.installFailed && <div className="font-mono text-[11px] leading-snug whitespace-pre-wrap break-all">{install.message}</div>}
            </div>
          )}
          <button type="button" onClick={() => void start(kind)} className={primary}>
            <Download size={13} strokeWidth={2} aria-hidden="true" />
            {install.phase === "failed" ? t.agent.setup.retry : t.agent.setup.install(name)}
          </button>
          <div className="text-[11px] leading-relaxed text-slate-500">{kind === "claudeCode" || kind === "cursor" || kind === "antigravity" ? t.agent.setup.whatHappens : t.agent.setup.whatHappensNpm}</div>
        </>
      )}
    </div>
  );
}

/** What the installer is doing now, in words. */
function installStepText(step: InstallStep | null, name: string): string {
  const steps = t.agent.setup.steps;
  switch (step) {
    case null:
      return t.agent.setup.installing;
    case "node":
      return steps.node;
    case "package":
      return steps.package(name);
    case "installer":
      return steps.installer(name);
    case "check":
      return steps.check;
  }
}

/** How long the install has taken, and a word when it has gone quiet: npm prints nothing for minutes while it unpacks. */
function InstallClock({ startedAt, lastAt }: { startedAt: number; lastAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const quiet = now - lastAt >= QUIET_MS;
  return (
    <div className="space-y-1 text-[11px] leading-relaxed text-slate-500">
      <div className="tabular-nums">{t.agent.setup.elapsed(Math.max(0, Math.floor((now - startedAt) / 1000)))}</div>
      {quiet && <div>{t.agent.setup.quiet}</div>}
    </div>
  );
}

/** No new line for this long, and the pane says it has not stopped. */
const QUIET_MS = 60_000;

/** Signs the agent in without leaving the pane, after a turn failed on an expired login. */
function LoginBox({ name }: { name: string }) {
  const login = useAgent((s) => s.login);
  // An AI that runs on an API key asks for the key instead (ApiKeyBox).
  const usesApiKey = useAgent((s) => s.info?.usesApiKey ?? false);
  const needed = useAgent((s) => {
    const last = currentChat(s).items.at(-1);
    return last?.role === "ai" && last.needsLogin;
  });
  const start = useAgent((s) => s.startLogin);
  const submitCode = useAgent((s) => s.submitLoginCode);
  const cancel = useAgent((s) => s.cancelLogin);
  const [code, setCode] = useState("");
  if (usesApiKey || (!needed && login.phase === "idle")) return null;
  const box = "space-y-2 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2.5 text-[12px] text-ink";
  const primary =
    "h-8 rounded-lg bg-primary px-3 text-[12px] font-semibold text-on-primary enabled:hover:bg-primary-hover disabled:bg-slate-200 disabled:text-slate-400";
  if (login.phase === "waiting") {
    return (
      <div className={box}>
        <div className="font-semibold">{t.agent.signIn}</div>
        {login.url ? (
          <button type="button" onClick={() => void agent.openUrl(login.url!)} className="text-brand-600 underline-offset-2 hover:underline">
            {t.agent.openBrowser}
          </button>
        ) : (
          <div className="text-slate-500">{t.agent.opening}</div>
        )}
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void submitCode(code).then((ok) => ok && setCode(""));
          }}
        >
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t.agent.pasteCode}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-sheet px-2 text-[12px] outline-none focus:border-primary"
          />
          <button type="submit" disabled={!code.trim() || login.sendingCode} className={primary}>
            {t.agent.send}
          </button>
        </form>
        <button type="button" onClick={() => void cancel()} className="text-slate-500 hover:text-ink">
          {t.cancel}
        </button>
      </div>
    );
  }
  return (
    <div className={box}>
      <div className="font-semibold">{t.agent.loginExpired(name)}</div>
      {login.phase === "failed" && <div className="whitespace-pre-wrap text-shu-600">{login.message}</div>}
      <button type="button" onClick={() => void start()} className={primary}>
        {t.agent.login}
      </button>
    </div>
  );
}
