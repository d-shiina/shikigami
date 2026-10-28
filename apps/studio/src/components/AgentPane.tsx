// The agent pane: ask the AI without leaving Studio. Messages go to the person's own
// agent (Claude Code by default) with Shikigami's MCP server; whatever it
// edits lands in 確認待ち like any other AI edit.
import { useEffect, useRef, useState } from "react";
import { type AgentPart, type ChatItem, useAgent } from "../agent";
import { agent } from "../lib/api";
import { useStudio } from "../context";
import { t, useKeptState } from "../lib/i18n";

const toolLabel = (name: string) => (t.agent.tools as Record<string, string>)[name] ?? name;

/** Header button that opens the pane. */
export function AgentButton() {
  const open = useAgent((s) => s.open);
  const setOpen = useAgent((s) => s.setOpen);
  const busy = useAgent((s) => s.turnId !== null || s.sending);
  const name = useAgent((s) => s.info?.name ?? "AI");
  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      title={`${name}（Ctrl+J）`}
      className={`flex h-8 items-center gap-1.5 rounded-[4px] px-2.5 text-[12px] font-semibold ${open ? "bg-ink text-sheet" : "text-slate-600 hover:bg-slate-100 hover:text-ink"}`}
    >
      {busy && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />}
      {name}
    </button>
  );
}

export function AgentPane() {
  const open = useAgent((s) => s.open);
  const setOpen = useAgent((s) => s.setOpen);
  const info = useAgent((s) => s.info);
  const items = useAgent((s) => s.items);
  const turnId = useAgent((s) => s.turnId);
  const sending = useAgent((s) => s.sending);
  const send = useAgent((s) => s.send);
  const stop = useAgent((s) => s.stop);
  const reset = useAgent((s) => s.reset);
  const scenario = useStudio((s) => s.scenario);
  const selection = useStudio((s) => s.selection);
  const [draft, setDraft] = useKeptState("agent.draft", "");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Newer WebView2 returns a promise here; an effect must not.
    void end.current?.scrollIntoView({ block: "end" });
  }, [items]);
  if (!open) return null;
  const stepId = selection?.kind === "step" ? selection.stepId : null;
  const submit = async () => {
    const ref = scenario ? { id: scenario.id, name: scenario.name, stepId } : null;
    const context = scenario ? `${scenario.name}${stepId ? ` ・ ${t.agent.selectedStep}` : ""}` : null;
    if (await send(draft, ref, context)) setDraft("");
  };
  return (
    <aside className="fixed top-10 right-0 bottom-7 z-30 flex w-[380px] flex-col border-l border-slate-200 bg-sheet shadow-lifted">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-2.5">
        <div className="min-w-0 flex-1 text-[13px] font-bold">{info?.name ?? "AI"}</div>
        <button
          type="button"
          onClick={reset}
          disabled={turnId !== null || sending || items.length === 0}
          className="grid h-6 w-6 place-items-center rounded-[4px] text-[15px] text-slate-500 enabled:hover:bg-slate-100 enabled:hover:text-ink disabled:text-slate-300"
          title={t.agent.newChat}
          aria-label={t.agent.newChat}
        >
          ＋
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="grid h-6 w-6 place-items-center rounded-[4px] text-slate-400 hover:bg-slate-100 hover:text-ink"
          aria-label={t.close}
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {info && !info.available && (
          <div className="rounded-[4px] border border-shu-100 bg-shu-50 px-3 py-2 text-[12px] leading-relaxed text-shu-600">{info.problem}</div>
        )}
        {items.length === 0 && info?.available && (
          <div className="grid h-full place-items-center">
            <img src="/mark.png" alt="" className="h-10 w-10 opacity-15 grayscale" />
          </div>
        )}
        {items.map((item) => (
          <Item key={item.id} item={item} />
        ))}
        <LoginBox name={info?.name ?? "AI"} />
        <div ref={end} />
      </div>
      <div className="border-t border-slate-200 p-3">
        {scenario && (
          <div className="mb-1.5 flex min-w-0 items-center gap-1 text-[10.5px] text-slate-500">
            <span className="truncate rounded-full bg-slate-100 px-2 py-0.5">{scenario.name}</span>
            {stepId && <span className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-brand-700">{t.agent.selectedStep}</span>}
          </div>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={3}
          disabled={!info?.available}
          placeholder={scenario ? t.agent.placeholderEdit : t.agent.placeholderNew}
          className="w-full resize-none rounded-[4px] border border-slate-300 bg-paper px-2.5 py-1.5 text-[13px] outline-none focus:border-brand-500 disabled:bg-slate-100"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-[10.5px] text-slate-400">{t.agent.sendHint}</span>
          {turnId ? (
            <button
              type="button"
              onClick={() => void stop()}
              className="ml-auto h-8 shrink-0 rounded-[4px] border border-slate-300 px-3 text-[12px] text-slate-600 hover:bg-slate-100"
            >
              {t.stop}
            </button>
          ) : (
            <button
              type="button"
              disabled={!info?.available || sending || draft.trim() === ""}
              onClick={() => void submit()}
              className="ml-auto h-8 shrink-0 rounded-[4px] bg-ink px-4 text-[12px] font-semibold text-sheet enabled:hover:bg-brand-700 disabled:bg-slate-200 disabled:text-slate-400"
            >
              {t.agent.send}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
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
      {item.status === "running" && (
        <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
          {t.agent.working}
        </div>
      )}
      {/* An expired login is explained by the sign-in box below instead. */}
      {item.status === "failed" && !item.needsLogin && (
        <div className="rounded-[4px] border border-shu-100 bg-shu-50 px-2.5 py-1.5 text-[12px] whitespace-pre-wrap text-shu-600">
          {item.message ?? t.agent.failed}
        </div>
      )}
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
    const last = s.items.at(-1);
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
