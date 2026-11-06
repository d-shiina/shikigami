// The agent pane: ask the AI without leaving Studio. Messages go to the person's own
// agent (Claude Code by default) with Shikigami's MCP server; whatever it
// edits lands in 確認待ち like any other AI edit.
import { Check, ChevronDown, ClipboardPaste, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type AgentPart, type Chat, type ChatItem, currentChat, isBusy, flowBusy, useAgent, useAgentApi } from "../agent";
import { agent } from "../lib/api";
import { useStudio } from "../context";
import { t } from "../lib/i18n";

const toolLabel = (name: string) => (t.agent.tools as Record<string, string>)[name] ?? name;
const chatTitle = (c: Chat) => c.title || t.agent.untitled;

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
  const setPasteOpen = useStudio((s) => s.setPasteOpen);
  const selection = useStudio((s) => s.selection);
  // One draft per conversation, so switching does not carry text to another flow.
  const setDraft = useAgent((s) => s.setDraft);
  const getChats = useAgentApi().getState;
  const draft = chat.draft;
  const setDraftOf = (id: string, change: (now: string) => string) =>
    setDraft(id, change(getChats().chats.find((c) => c.id === id)?.draft ?? ""));
  const end = useRef<HTMLDivElement>(null);
  const { items } = chat;
  const busy = isBusy(chat);
  useEffect(() => {
    // Newer WebView2 returns a promise here; an effect must not.
    void end.current?.scrollIntoView({ block: "end" });
  }, [items, chat.id]);
  if (!open) return null;
  // The conversation may be about another flow than the one in the editor.
  const here = flow !== null && chat.flowId === flow.id;
  const stepId = here && selection?.kind === "step" ? selection.stepId : null;
  const submit = async () => {
    const ref = chat.flowId ? { id: chat.flowId, name: here ? flow.name : chat.title, stepId, empty: here && (flow.steps ?? []).length === 0 } : null;
    const context = chat.flowId ? `${ref!.name}${stepId ? ` ・ ${t.agent.selectedStep}` : ""}` : null;
    // Cleared as it is sent, like any chat; back again if it was not taken.
    const text = draft;
    const id = chat.id;
    setDraftOf(id, () => "");
    if (!(await sendIn(id, text, ref, context))) setDraftOf(id, (now) => now || text);
  };
  return (
    <aside style={{ width }} className="flex h-full min-h-0 shrink-0 flex-col border-r border-slate-200 bg-sheet">
      <div className="flex items-center gap-1 border-b border-slate-200 py-2 pr-3 pl-2">
        <ChatSwitcher chat={chat} />
        <button
          type="button"
          onClick={() => newChat(chat.flowId ? { id: chat.flowId, name: chat.title } : null)}
          disabled={items.length === 0 && !chat.sessionId}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-[4px] text-slate-500 enabled:hover:bg-slate-100 enabled:hover:text-ink disabled:text-slate-300"
          title={t.agent.newChat}
          aria-label={t.agent.newChat}
        >
          <Plus size={15} />
        </button>
        <button
          type="button"
          onClick={() => setPasteOpen(flow ? "into" : "new")}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-[4px] text-slate-500 hover:bg-slate-100 hover:text-ink"
          title={t.paste.title}
          aria-label={t.paste.title}
        >
          <ClipboardPaste size={15} />
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-[4px] text-slate-500 hover:bg-slate-100 hover:text-ink"
          aria-label={t.close}
        >
          <X size={15} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {info && !info.available && (
          <>
            <div className="rounded-[4px] border border-shu-100 bg-shu-50 px-3 py-2 text-[12px] leading-relaxed text-shu-600">{info.problem}</div>
            <div className="rounded-[4px] border border-slate-200 bg-paper px-3 py-2 text-[12px] leading-relaxed text-slate-700">
              {t.paste.other}
              <button
                type="button"
                onClick={() => setPasteOpen(flow ? "into" : "new")}
                className="mt-1.5 flex h-7 items-center gap-1.5 rounded-[4px] border border-slate-300 bg-sheet px-2.5 text-[12px] text-slate-700 hover:bg-slate-50"
              >
                <ClipboardPaste size={14} strokeWidth={1.75} aria-hidden="true" />
                {t.paste.title}
              </button>
            </div>
          </>
        )}
        {items.length === 0 && info?.available && (
          <div className="grid h-full place-items-center">
            <div className="flex flex-col items-center gap-2">
              <img src="/mark.png" alt="" className="h-10 w-10 opacity-15 grayscale" />
              {chat.sessionId && <div className="text-[11.5px] text-slate-500">{t.agent.continued}</div>}
            </div>
          </div>
        )}
        {items.map((item) => (
          <Item key={item.id} item={item} />
        ))}
        <LoginBox name={info?.name ?? "AI"} />
        <div ref={end} />
      </div>
      <div className="border-t border-slate-200 p-3">
        <div className="mb-1.5 flex min-w-0 items-center gap-1 text-[10.5px] text-slate-500">
          {chat.flowId === null ? (
            <span className="truncate rounded-full bg-brand-50 px-2 py-0.5 text-brand-700">{t.agent.newFlowChat}</span>
          ) : here ? (
            <span className="truncate rounded-full bg-slate-100 px-2 py-0.5">{flow.name}</span>
          ) : (
            <button
              type="button"
              onClick={() => void openFlow(chat.flowId!)}
              title={t.agent.openFlow}
              className="truncate rounded-full bg-slate-100 px-2 py-0.5 hover:bg-slate-200 hover:text-ink"
            >
              {chat.title} ↗
            </button>
          )}
          {stepId && <span className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-brand-700">{t.agent.selectedStep}</span>}
        </div>
        <textarea
          data-agent-input
          value={draft}
          onChange={(e) => setDraftOf(chat.id, () => e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={3}
          disabled={!info?.available}
          placeholder={chat.flowId ? t.agent.placeholderEdit : t.agent.placeholderNew}
          className="w-full resize-none rounded-[4px] border border-slate-300 bg-paper px-2.5 py-1.5 text-[13px] outline-none focus:border-brand-500 disabled:bg-slate-100"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <span className="min-w-0 truncate text-[10.5px] text-slate-500" title={busy ? t.agent.interruptHint : undefined}>
            {blockedElsewhere ? t.agent.busyElsewhere : chat.interrupting ? t.agent.interrupting : busy ? t.agent.interruptHint : t.agent.sendHint}
          </span>
          {chat.turnId && !chat.interrupting && (
            <button
              type="button"
              onClick={() => void stop(chat.id)}
              className="ml-auto h-8 shrink-0 rounded-[4px] border border-slate-300 px-3 text-[12px] text-slate-600 hover:bg-slate-100"
            >
              {t.stop}
            </button>
          )}
          <button
            type="button"
            disabled={!info?.available || chat.interrupting !== null || blockedElsewhere || draft.trim() === ""}
            onClick={() => void submit()}
            title={busy ? t.agent.interruptHint : undefined}
            className={`${chat.turnId && !chat.interrupting ? "" : "ml-auto "}h-8 shrink-0 rounded-[4px] bg-ink px-4 text-[12px] font-semibold text-sheet enabled:hover:bg-brand-700 disabled:bg-slate-200 disabled:text-slate-400`}
          >
            {busy ? t.agent.interrupt : t.agent.send}
          </button>
        </div>
      </div>
    </aside>
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
        className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-[4px] px-2 text-left hover:bg-slate-100"
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
          <div className="absolute top-8 left-0 z-50 w-[min(320px,calc(100vw-32px))] overflow-hidden rounded-[6px] border border-slate-200 bg-sheet py-1 shadow-lg">
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
                      className="grid h-5 w-5 shrink-0 place-items-center rounded-[4px] text-slate-400 opacity-0 group-hover:opacity-100 hover:bg-slate-200 hover:text-ink focus:opacity-100"
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
    if (text?.kind === "text") return text.text.trim().split("\n")[0] ?? "";
  }
  return c.sessionId ? t.agent.earlier : "";
}

function Item({ item }: { item: ChatItem }) {
  if (item.role === "person") {
    return (
      <div className="ml-8">
        {item.context && <div className="mb-0.5 truncate text-right text-[10px] text-slate-400">{item.context}</div>}
        <div className="rounded-[4px] rounded-tr-[2px] bg-ink px-3 py-2 text-[13px] whitespace-pre-wrap text-sheet">{item.text}</div>
      </div>
    );
  }
  return (
    <div className="mr-4 space-y-1.5">
      {item.parts.map((part, i) => (
        <Part key={i} part={part} />
      ))}
      {item.status === "running" && <Progress starting={item.turnId === ""} quiet={item.parts.length === 0} preparing={item.preparing} />}
      {item.status === "done" && item.message && <div className="text-[11px] text-slate-500">{item.message}</div>}
      {/* An expired login is explained by the sign-in box below instead. */}
      {item.status === "failed" && !item.needsLogin && (
        <div className="rounded-[4px] border border-shu-100 bg-shu-50 px-2.5 py-1.5 text-[12px] whitespace-pre-wrap text-shu-600">
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

function Part({ part }: { part: AgentPart }) {
  switch (part.kind) {
    case "text":
      return <div className="text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{part.text.trim()}</div>;
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

/** Signs the agent in without leaving the pane, after a turn failed on an expired login. */
function LoginBox({ name }: { name: string }) {
  const login = useAgent((s) => s.login);
  const needed = useAgent((s) => {
    const last = currentChat(s).items.at(-1);
    return last?.role === "ai" && last.needsLogin;
  });
  const start = useAgent((s) => s.startLogin);
  const submitCode = useAgent((s) => s.submitLoginCode);
  const cancel = useAgent((s) => s.cancelLogin);
  const [code, setCode] = useState("");
  if (!needed && login.phase === "idle") return null;
  const box = "space-y-2 rounded-[4px] border border-brand-100 bg-brand-50 px-3 py-2.5 text-[12px] text-ink";
  const primary =
    "h-8 rounded-[4px] bg-ink px-3 text-[12px] font-semibold text-sheet enabled:hover:bg-brand-700 disabled:bg-slate-200 disabled:text-slate-400";
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
            className="min-w-0 flex-1 rounded-[4px] border border-slate-300 bg-sheet px-2 text-[12px] outline-none focus:border-brand-500"
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
