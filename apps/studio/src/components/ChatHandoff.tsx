// The paste way in the AI pane (lib/aiWay.ts): a request copied for an AI
// chat that cannot reach SpellSheet, and the way its answer comes back.
// The card says what to do in the chat, finds the answer on the clipboard
// when the person returns, takes it in, and then shows what changed, what is
// left for the person, and what goes back to the AI, as one more request.
import { Check, ChevronDown, ChevronRight, ClipboardCheck, ClipboardCopy, ExternalLink, FileDown, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type Chat, type ChatItem, type Handoff, useAgent } from "../agent";
import { useStudio, useStudioApi } from "../context";
import { chatAi, useAiWay } from "../lib/aiWay";
import { agent, api, type AnswerProblem } from "../lib/api";
import { describe } from "../lib/changes";
import { readClipboardText } from "../lib/clipboard";
import { joinParts, looksLikeAnswer } from "../lib/handoff";
import { t } from "../lib/i18n";
import { answerProblemText } from "../lib/problemText";
import { authorIssues, personTodos, returnText } from "../lib/todos";
import { issueText } from "../lib/issueText";
import { useProjectMaybe } from "../project";
import { TodoList, Written } from "./IssuesPanel";
import { Lines } from "./Timeline";

type AiItem = Extract<ChatItem, { role: "ai" }> & { handoff: Handoff };

const button =
  "flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 bg-sheet px-2.5 text-[12px] text-slate-700 enabled:hover:bg-slate-50 disabled:opacity-50";
const primary =
  "flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-semibold text-on-primary enabled:hover:bg-primary-hover disabled:bg-slate-200 disabled:text-slate-400";

/** Shown changes before "ほか n 件". */
const SHOWN_CHANGES = 8;

export function HandoffCard({ chat, item, latest }: { chat: Chat; item: AiItem; latest: boolean }) {
  const { handoff } = item;
  if (handoff.result?.kind === "taken") return <Taken chat={chat} result={handoff.result} latest={latest} />;
  return (
    <div className="space-y-2">
      {handoff.prompt && <Steps chat={chat} item={item} latest={latest && !handoff.result} />}
      {handoff.result?.kind === "problems" ? (
        <Problems chat={chat} problems={handoff.result.problems} partial={handoff.partial} latest={latest} />
      ) : (
        latest && <AnswerBox chat={chat} item={item} />
      )}
    </div>
  );
}

/** What to do in the AI chat with what Writer copied. */
function Steps({ chat, item, latest }: { chat: Chat; item: AiItem; latest: boolean }) {
  const way = useAiWay((s) => s.chat);
  const ai = chatAi(way);
  const name = ai.name;
  // The reference goes once per chat conversation: with the first request here.
  const first = chat.items.find((i) => i.role === "ai" && i.handoff?.prompt)?.id === item.id;
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.handoff.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const saveGuide = async () => {
    try {
      setSaved(await api.saveAiGuide());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const open = () => ai.url && void agentOpen(ai.url);
  if (!latest) {
    return (
      <div className="flex items-center gap-1.5 text-[11.5px] text-slate-500">
        <ClipboardCheck size={13} aria-hidden="true" />
        {t.aiChat.copied}
        <RequestToggle shown={shown} setShown={setShown} />
        {shown && <Request prompt={item.handoff.prompt} />}
      </div>
    );
  }
  let n = 0;
  return (
    <div className="space-y-2 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2.5 text-[12px] text-ink">
      <div className="flex items-center gap-1.5 font-semibold" role="status">
        <ClipboardCheck size={14} className="text-brand-600" aria-hidden="true" />
        {t.aiChat.copied}
      </div>
      <ol className="space-y-2">
        {first && (
          <li>
            <Num n={++n} />
            {t.aiChat.steps.attach(name)}
            <div className="mt-1 ml-5">
              <button type="button" onClick={() => void saveGuide()} className={button}>
                <FileDown size={13} strokeWidth={1.75} aria-hidden="true" />
                {t.aiChat.steps.attachButton}
              </button>
              {saved && <div className="mt-1 text-[11px] break-all text-slate-600">{t.aiChat.steps.attached(saved)}</div>}
            </div>
          </li>
        )}
        <li>
          <Num n={++n} />
          {t.aiChat.steps.paste(name)}
          <div className="mt-1 ml-5 flex flex-wrap items-center gap-1.5">
            {ai.url && (
              <button type="button" onClick={open} className={button}>
                <ExternalLink size={13} strokeWidth={1.75} aria-hidden="true" />
                {t.aiChat.open(name)}
              </button>
            )}
            <button type="button" onClick={() => void copy()} className={button}>
              {copied ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <ClipboardCopy size={13} strokeWidth={1.75} aria-hidden="true" />}
              {copied ? t.aiChat.copiedAgain : t.aiChat.copyAgain}
            </button>
            <RequestToggle shown={shown} setShown={setShown} />
          </div>
          {shown && <Request prompt={item.handoff.prompt} />}
        </li>
        <li>
          <Num n={++n} />
          {t.aiChat.steps.back(name)}
        </li>
      </ol>
      {error && <div className="text-shu-600">{error}</div>}
    </div>
  );
}

const agentOpen = (url: string) => agent.openUrl(url).catch(() => {});

function Num({ n }: { n: number }) {
  return <span className="mr-1.5 inline-block w-3.5 text-slate-500 tabular-nums">{n}.</span>;
}

function RequestToggle({ shown, setShown }: { shown: boolean; setShown: (on: boolean) => void }) {
  return (
    <button type="button" onClick={() => setShown(!shown)} aria-expanded={shown} className="flex items-center gap-0.5 text-[11.5px] text-slate-500 hover:text-ink">
      {shown ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
      {t.aiChat.showRequest}
    </button>
  );
}

function Request({ prompt }: { prompt: string }) {
  return (
    <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-slate-200 bg-sheet px-2 py-1.5 font-mono text-[10.5px] leading-snug whitespace-pre-wrap text-slate-600">
      {prompt}
    </pre>
  );
}

/**
 * Where the answer comes back: found on the clipboard when the person
 * returns to Writer (only while waiting, and only when allowed), or pasted.
 */
function AnswerBox({ chat, item }: { chat: Chat; item: AiItem }) {
  const autoRead = useAiWay((s) => s.autoRead);
  const take = useTakeIn(chat, item);
  const [text, setText] = useState("");
  const [found, setFound] = useState<string | null>(null);
  const look = useCallback(async () => {
    try {
      const now = await readClipboardText();
      setFound(looksLikeAnswer(now) ? now : null);
    } catch {
      setFound(null);
    }
  }, []);
  useEffect(() => {
    if (!autoRead) return;
    void look();
    const onFocus = () => void look();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [autoRead, look]);
  const submit = (answer: string) => void take.run(answer);
  return (
    <div className="space-y-1.5 rounded-lg border border-slate-200 bg-sheet px-3 py-2.5 text-[12px]">
      <div className="font-semibold text-ink">{t.aiChat.answer}</div>
      {item.handoff.partial && <div className="leading-relaxed text-slate-600">{t.aiChat.cutLead}</div>}
      {found && !text ? (
        <div className="flex flex-wrap items-center gap-2" role="status">
          <span className="text-moegi-600">{t.aiChat.found}</span>
          <button type="button" disabled={take.busy} onClick={() => submit(found)} className={primary}>
            {take.busy && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
            {take.busy ? t.aiChat.taking : t.aiChat.takeInFound}
          </button>
        </div>
      ) : (
        <div className="leading-relaxed text-slate-600">{t.aiChat.answerLead}</div>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim()) {
            e.preventDefault();
            submit(text);
          }
        }}
        rows={found && !text ? 2 : 4}
        placeholder={t.aiChat.placeholder}
        spellCheck={false}
        aria-label={t.aiChat.answer}
        className="w-full resize-y rounded-lg border border-slate-300 bg-paper px-2 py-1.5 font-mono text-[11.5px] leading-relaxed outline-none focus:border-primary"
      />
      <div className="flex items-center gap-2">
        {take.error && <span className="min-w-0 text-shu-600">{take.error}</span>}
        <button type="button" disabled={!text.trim() || take.busy} onClick={() => submit(text)} className={`ml-auto ${primary}`}>
          {take.busy && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
          {take.busy ? t.aiChat.taking : t.aiChat.takeIn}
        </button>
      </div>
    </div>
  );
}

/** Takes the answer into the conversation's flow (opened first), or as a new flow. */
function useTakeIn(chat: Chat, item: AiItem) {
  const studio = useStudioApi();
  const settle = useAgent((s) => s.settleHandoff);
  const adopt = useAgent((s) => s.adoptFlow);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (answer: string) => {
    setBusy(true);
    setError(null);
    try {
      if (chat.flowId && studio.getState().flow?.id !== chat.flowId) await studio.getState().open(chat.flowId);
      const s = studio.getState();
      const into = chat.flowId !== null && s.flow?.id === chat.flowId;
      if (chat.flowId && !into) {
        setError(s.error ?? t.aiChat.problemsTitle);
        return;
      }
      const text = item.handoff.partial ? joinParts(item.handoff.partial, answer) : answer;
      const res = await s.pasteAnswer(text, into);
      if (!res) {
        setError(studio.getState().error ?? t.aiChat.problemsTitle);
        return;
      }
      if (!res.outcome) {
        // Kept whole so the next part can be put after it.
        settle(chat.id, item.id, { result: { kind: "problems", problems: res.problems }, partial: text });
        return;
      }
      const { flow, validation } = res.outcome;
      const after = studio.getState();
      const defs = new Map(after.stepTypes.map((d) => [d.type, d] as const));
      const entry = after.history.find((e) => e.revision === flow.revision);
      const changes = entry ? describe(entry, flow, defs) : [];
      settle(chat.id, item.id, {
        partial: undefined,
        result: {
          kind: "taken",
          flowId: flow.id,
          name: flow.name,
          isNew: !into,
          revision: flow.revision ?? 0,
          changes,
          forAi: authorIssues(validation),
          checks: entry?.checks?.length ?? 0,
        },
      });
      if (!into) adopt(chat.id, { id: flow.id, name: flow.name });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error };
}

/** Not taken in: what the AI must fix, or the rest of an answer cut short. */
function Problems({ chat, problems, partial, latest }: { chat: Chat; problems: AnswerProblem[]; partial?: string; latest: boolean }) {
  const handOffAs = useAgent((s) => s.handOffAs);
  const cut = problems.some((p) => p.cut);
  const go = () =>
    cut
      ? void handOffAs(chat.id, t.aiChat.goOnLabel, returnText(problems), partial)
      : void handOffAs(chat.id, t.aiChat.fixLabel, returnText(problems));
  return (
    <section role="alert" className="rounded-lg border border-shu-200 bg-shu-50/60 px-3 py-2.5 text-[12px]">
      <h3 className="text-[13px] font-semibold text-shu-600">{cut ? t.aiChat.cutTitle : t.aiChat.problemsTitle}</h3>
      <p className="mt-0.5 leading-relaxed text-slate-700">{cut ? t.aiChat.cutLead : t.aiChat.problemsLead}</p>
      {!cut && (
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-ink">
          {problems.map((p, i) => (
            // The AI's own words (English, with the place in its JSON) stay one hover away.
            <li key={i} title={[p.path, p.message].filter(Boolean).join("\n")}>
              {p.step && <span className="mr-1 font-semibold">{t.quote(p.step)}</span>}
              {answerProblemText(p)}
              {p.found && <Written text={p.found} />}
            </li>
          ))}
        </ol>
      )}
      {latest && (
        <button type="button" onClick={go} className={`mt-2 ${primary}`}>
          <ClipboardCopy size={13} strokeWidth={1.75} aria-hidden="true" />
          {cut ? t.aiChat.goOn : t.aiChat.fix}
        </button>
      )}
    </section>
  );
}

/** Taken in: what changed, what is left for the person, and what goes back to the AI. */
function Taken({ chat, result, latest }: { chat: Chat; result: Extract<NonNullable<Handoff["result"]>, { kind: "taken" }>; latest: boolean }) {
  const flow = useStudio((s) => s.flow);
  const openFlow = useStudio((s) => s.open);
  const stepTypes = useStudio((s) => s.stepTypes);
  const secrets = useStudio((s) => s.secrets);
  const secretsLoaded = useStudio((s) => s.secretsLoaded);
  const handOffAs = useAgent((s) => s.handOffAs);
  const shown = flow?.id === result.flowId ? flow : null;
  const files = useProjectMaybe((s) => (shown && s.flowId === shown.id ? s.files : null), null);
  // What is left now, not when it was taken in: the person may have done some already.
  const todos = useMemo(
    () =>
      shown && latest
        ? personTodos(shown, new Map(stepTypes.map((d) => [d.type, d] as const)), secretsLoaded ? new Set(secrets.map((s) => s.name)) : null, files)
        : [],
    [shown, latest, stepTypes, secrets, secretsLoaded, files],
  );
  const [all, setAll] = useState(false);
  const changes = all ? result.changes : result.changes.slice(0, SHOWN_CHANGES);
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-sheet py-2.5 text-[12px]">
      <div className="px-3">
        <div className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
          <Check size={14} strokeWidth={2} className="shrink-0 text-moegi-600" aria-hidden="true" />
          <span className="min-w-0">{result.isNew ? t.aiChat.takenNew(result.name) : t.aiChat.taken(result.name)}</span>
        </div>
        <p className="mt-0.5 leading-relaxed text-slate-600">{t.aiChat.takenLead}</p>
        {result.checks > 0 && <p className="mt-1 text-ink">{t.aiChat.checks(result.checks)}</p>}
        {!shown && (
          <button type="button" onClick={() => void openFlow(result.flowId)} className={`mt-1.5 ${button}`}>
            {t.aiChat.openFlow}
          </button>
        )}
      </div>
      {result.changes.length > 0 && (
        <section className="px-3">
          <h3 className="mb-1 font-semibold text-ink">{t.aiChat.changes}</h3>
          <Lines lines={changes} detailed={false} />
          {!all && result.changes.length > SHOWN_CHANGES && (
            <button type="button" onClick={() => setAll(true)} className="mt-1 text-[11.5px] text-brand-600 hover:underline">
              {t.aiChat.moreChanges(result.changes.length - SHOWN_CHANGES)}
            </button>
          )}
        </section>
      )}
      {todos.length > 0 && (
        <section>
          <h3 className="mb-1 px-3 font-semibold text-ink">{t.aiChat.todos}</h3>
          <div className="border-y border-amber-200">
            <TodoList todos={todos} />
          </div>
        </section>
      )}
      {result.forAi.length > 0 && (
        <section className="mx-3 rounded-lg border border-shu-200 bg-shu-50/60 px-3 py-2.5">
          <h3 className="font-semibold text-shu-600">{t.aiChat.forAi}</h3>
          <p className="mt-0.5 text-slate-700">{t.aiChat.forAiLead}</p>
          <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-ink">
            {result.forAi.map((issue, i) => (
              <li key={i} title={[issue.message, issue.hint].filter(Boolean).join("\n")}>
                {shown ? issueText(issue, shown) : issue.message}
              </li>
            ))}
          </ol>
          {latest && (
            <button
              type="button"
              onClick={() => void handOffAs(chat.id, t.aiChat.fixLabel, returnText(result.forAi, shown ?? undefined))}
              className={`mt-2 ${primary}`}
            >
              <ClipboardCopy size={13} strokeWidth={1.75} aria-hidden="true" />
              {t.aiChat.fix}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
