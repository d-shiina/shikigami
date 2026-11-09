// Building a flow with an AI that has no MCP (Microsoft Copilot, a chat
// window): give it the guide, paste its answer, and see at once what is left
// for the person (pick the screen parts, register logins, put files) apart
// from what the AI must fix, which goes back to the chat as text.
import type { EditOutcome, ProjectFiles } from "@spellsheet/schema";
import { ExternalLink, FileDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStudio } from "../context";
import { agent, api, type AnswerProblem } from "../lib/api";
import { locale, t } from "../lib/i18n";
import { issueText } from "../lib/issueText";
import { DOCS_URL } from "../lib/repo";
import { answerProblemText, writtenAt } from "../lib/problemText";
import { authorIssues, handOffText, personTodos, returnText } from "../lib/todos";
import { useProjectMaybe } from "../project";
import { CopyForAi, TodoList, Written } from "./IssuesPanel";

const GUIDE_URL = `${DOCS_URL}${locale === "ja" ? "ja/" : ""}ai-chat.md`;

type Result = { kind: "problems"; problems: AnswerProblem[] } | { kind: "done"; outcome: EditOutcome };

export function AiPasteDialog() {
  const mode = useStudio((s) => s.pasteOpen);
  const setMode = useStudio((s) => s.setPasteOpen);
  const flow = useStudio((s) => s.flow);
  const pasteAnswer = useStudio((s) => s.pasteAnswer);
  const setBottom = useStudio((s) => s.setBottom);
  const setPlace = useStudio((s) => s.setPlace);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [intoOpen, setIntoOpen] = useState(false);
  const into = intoOpen && flow !== null;

  useEffect(() => {
    setIntoOpen(mode === "into");
    if (!mode) {
      setText("");
      setResult(null);
      setSaved(null);
      setSaveError(null);
    }
  }, [mode]);
  useEffect(() => {
    if (!mode) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMode(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, setMode]);

  if (!mode) return null;
  const close = () => setMode(null);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const res = await pasteAnswer(text, into);
      if (!res) return;
      setResult(res.outcome ? { kind: "done", outcome: res.outcome } : { kind: "problems", problems: res.problems });
    } finally {
      setBusy(false);
    }
  };
  const saveGuide = async () => {
    try {
      setSaved(await api.saveAiGuide());
      setSaveError(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };
  const openFlow = () => {
    setPlace("flows");
    setBottom("issues");
    close();
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-ink/30" onClick={close}>
      <div
        role="dialog"
        aria-label={t.paste.title}
        className="flex max-h-[86vh] w-[640px] flex-col overflow-hidden rounded-lg border border-slate-200 bg-sheet shadow-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-slate-200 px-4">
          <span className="text-[13px] font-bold">{t.paste.title}</span>
          <button type="button" onClick={() => void agent.openUrl(GUIDE_URL).catch(() => {})} className="flex items-center gap-1 text-[12px] text-brand-600 hover:underline">
            {t.paste.howTo}
            <ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ml-auto grid h-7 w-7 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-ink"
            onClick={close}
            aria-label={t.close}
            title={`${t.close} (Esc)`}
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {result?.kind === "done" ? (
            <Done outcome={result.outcome} fresh={!into} onAct={openFlow} />
          ) : (
            <div className="space-y-4 px-4 py-3">
              <p className="text-[13px] text-slate-700">{t.paste.lead}</p>
              <section>
                <h3 className="text-[12px] font-semibold text-ink">1. {t.paste.step1}</h3>
                <p className="mt-0.5 text-[12px] text-slate-600">{t.paste.step1Lead}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void saveGuide()}
                    className="flex h-7 items-center gap-1.5 rounded-lg border border-slate-300 bg-sheet px-2.5 text-[12px] text-slate-700 hover:bg-slate-50"
                  >
                    <FileDown size={14} strokeWidth={1.75} aria-hidden="true" />
                    {t.paste.saveGuide}
                  </button>
                  {into && flow && <CopyForAi text={handOffText(flow)} label={t.paste.copyFlow} />}
                </div>
                {saved && <p className="mt-1 text-[12px] break-all text-moegi-600">{t.paste.savedGuide(saved)}</p>}
                {saveError && <p className="mt-1 text-[12px] text-shu-600">{saveError}</p>}
              </section>
              <section>
                <h3 className="text-[12px] font-semibold text-ink">2. {t.paste.step2}</h3>
                <p className="mt-0.5 text-[12px] text-slate-600">{t.paste.step2Lead}</p>
                <textarea
                  autoFocus
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    if (result) setResult(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
                  }}
                  placeholder={t.paste.placeholder}
                  spellCheck={false}
                  className="mt-1.5 h-48 w-full resize-y rounded-lg border border-slate-300 bg-paper px-2.5 py-2 font-mono text-[12px] leading-relaxed focus:border-primary focus:outline-none"
                />
                {flow ? (
                  <div className="mt-1.5 space-y-1" role="radiogroup" aria-label={t.paste.where}>
                    {[true, false].map((value) => (
                      <label key={String(value)} className="flex items-start gap-2 text-[12px] text-slate-700">
                        <input type="radio" className="mt-0.5" checked={into === value} onChange={() => setIntoOpen(value)} />
                        {value ? t.paste.intoNote(flow.name) : t.paste.newNote}
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-[12px] text-slate-600">{t.paste.newNote}</p>
                )}
              </section>
              {result?.kind === "problems" && <Problems problems={result.problems} />}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-200 px-4 py-2.5">
          {result?.kind === "done" ? (
            <button type="button" onClick={openFlow} className="h-8 rounded-lg bg-primary px-3.5 text-[13px] font-semibold text-on-primary hover:bg-primary-hover">
              {t.paste.open}
            </button>
          ) : (
            <>
              <button type="button" onClick={close} className="h-8 px-3 text-[13px] text-slate-600 hover:text-ink">
                {t.cancel}
              </button>
              <button
                type="button"
                disabled={!text.trim() || busy}
                onClick={() => void submit()}
                className="h-8 rounded-lg bg-primary px-3.5 text-[13px] font-semibold text-on-primary hover:bg-primary-hover disabled:bg-slate-300"
              >
                {t.paste.submit}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Problems({ problems }: { problems: AnswerProblem[] }) {
  return (
    <section role="alert" className="rounded-lg border border-shu-200 bg-shu-50/60 px-3 py-2.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold text-shu-600">{t.paste.problemsTitle}</h3>
          <p className="mt-0.5 text-[12px] text-slate-700">{t.paste.problemsLead}</p>
        </div>
        <CopyForAi text={returnText(problems)} primary />
      </div>
      <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[12px] text-ink">
        {problems.map((p, i) => (
          // The AI's own words (English, with the place in its JSON) stay one hover away.
          <li key={i} title={[p.path, p.message].filter(Boolean).join("\n")}>
            {p.step && <span className="mr-1 font-semibold">{t.quote(p.step)}</span>}
            {answerProblemText(p)}
            {p.found && <Written text={p.found} />}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** What was taken in: the person's to-dos first, then what goes back to the AI. */
function Done({ outcome, fresh, onAct }: { outcome: EditOutcome; fresh: boolean; onAct: () => void }) {
  const stepTypes = useStudio((s) => s.stepTypes);
  const secrets = useStudio((s) => s.secrets);
  const secretsLoaded = useStudio((s) => s.secretsLoaded);
  const history = useStudio((s) => s.history);
  const folder = useProjectMaybe((s) => (s.flowId === outcome.flow.id ? s.files : null), null);
  const { flow, validation } = outcome;
  // A new flow's folder is still empty.
  const files: ProjectFiles | null = fresh ? { flowId: flow.id, dir: "", folders: [], files: [] } : folder;
  const todos = useMemo(
    () =>
      personTodos(
        flow,
        new Map(stepTypes.map((d) => [d.type, d] as const)),
        secretsLoaded ? new Set(secrets.map((s) => s.name)) : null,
        files,
      ),
    [flow, stepTypes, secrets, secretsLoaded, files],
  );
  const forAi = authorIssues(validation);
  const names = useMemo(() => {
    const map = new Map<string, string>();
    const visit = (steps: typeof flow.steps) => {
      for (const s of steps ?? []) {
        if (s.id && s.name) map.set(s.id, s.name);
        for (const b of Object.values(s.blocks ?? {})) visit(b);
      }
    };
    visit(flow.steps);
    return map;
  }, [flow]);
  const checks = history.find((e) => e.revision === flow.revision)?.checks?.length ?? 0;
  return (
    <div className="space-y-3 py-3">
      <div className="px-4">
        <h3 className="text-[14px] font-semibold text-ink">{t.paste.doneTitle(flow.name)}</h3>
        <p className="mt-0.5 text-[12px] text-slate-600">{t.paste.doneLead}</p>
        {checks > 0 && <p className="mt-1 text-[12px] text-ink">{t.paste.checks(checks)}</p>}
      </div>
      {todos.length > 0 ? (
        <div className="border-y border-amber-200">
          <TodoList todos={todos} onAct={onAct} />
        </div>
      ) : (
        forAi.length === 0 && <p className="px-4 text-[13px] text-moegi-600">✓ {t.paste.noTodos}</p>
      )}
      {forAi.length > 0 && (
        <section className="mx-4 rounded-lg border border-shu-200 bg-shu-50/60 px-3 py-2.5">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="text-[13px] font-semibold text-shu-600">{t.todos.aiTitle}</h3>
              <p className="mt-0.5 text-[12px] text-slate-700">{t.todos.aiLead}</p>
            </div>
            <CopyForAi text={returnText(forAi, flow)} />
          </div>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[12px] text-ink">
            {forAi.map((issue, i) => {
              const written = writtenAt(flow, issue);
              return (
                // Core's own words for the AI (English, with how to fix it) stay one hover away.
                <li key={i} title={[issue.message, issue.hint].filter(Boolean).join("\n")}>
                  {issue.stepId && names.get(issue.stepId) && <span className="mr-1 font-semibold">{t.quote(names.get(issue.stepId) ?? "")}</span>}
                  {issueText(issue, flow)}
                  {written && <Written text={written} />}
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}
