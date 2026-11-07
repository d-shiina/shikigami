import type { Flow, StepTypeDef, ValidationIssue } from "@shikigami/schema";
import { Check, ClipboardCopy, FolderOpen, KeyRound, MousePointerClick } from "lucide-react";
import { useState } from "react";
import { useStudio } from "../context";
import { stepLabel, t } from "../lib/i18n";
import { issueText } from "../lib/issueText";
import { authorIssues, PERSON_CODES, returnText, type Todo, todoTitle } from "../lib/todos";
import { useTodos } from "../lib/useTodos";
import { useProjectMaybe } from "../project";
import { findStep } from "../store";

/**
 * The flow's checks, in the order a person deals with them: what only they
 * can do (pick a part, register a login, put a file), then what the author
 * (an AI) got wrong, with the text to send back, then the rest.
 */
export function IssuesPanel() {
  const flow = useStudio((s) => s.flow);
  const validation = useStudio((s) => s.validation);
  const goTo = useStudio((s) => s.goTo);
  const todos = useTodos();
  const issues = validation?.issues ?? [];
  const forAi = authorIssues(validation);
  const rest = issues.filter((i) => i.severity !== "error" && !PERSON_CODES.has(i.code));
  if (todos.length === 0 && forAi.length === 0 && rest.length === 0) return <p className="p-4 text-sm text-moegi-500">✓ {t.noIssues}</p>;
  return (
    <div className="divide-y divide-slate-100">
      {todos.length > 0 && <TodoList todos={todos} />}
      {forAi.length > 0 && flow && <AiIssues issues={forAi} flow={flow} goTo={goTo} />}
      {rest.length > 0 && <IssueList issues={rest} goTo={goTo} />}
    </div>
  );
}

/** What a person does in Studio, one button each. */
export function TodoList({ todos, onAct }: { todos: Todo[]; onAct?: () => void }) {
  const select = useStudio((s) => s.select);
  const place = useStudio((s) => s.place);
  const setPlace = useStudio((s) => s.setPlace);
  const openSecretForm = useStudio((s) => s.openSecretForm);
  const openFolder = useProjectMaybe((s) => s.open, null);
  const setPanelOpen = useProjectMaybe((s) => s.setPanelOpen, null);
  const act = (todo: Todo) => {
    onAct?.();
    if (todo.kind === "pick") {
      // A part opens in the inspector, which review covers with its own panel.
      if (place === "review") setPlace("flows");
      select({ kind: "part", name: todo.part });
    }
    else if (todo.kind === "secret") openSecretForm({ name: todo.name, sites: [], fields: todo.fields });
    else {
      setPanelOpen?.(true);
      void openFolder?.(todo.path.split("/")[0] ?? "");
    }
  };
  return (
    <section aria-labelledby="todos-title" className="bg-amber-50/60">
      <div className="px-4 pt-2.5 pb-1">
        <h3 id="todos-title" className="flex items-center gap-1.5 text-xs font-semibold text-amber-700">
          <span className="rounded-[3px] bg-amber-500 px-1.5 text-[10px] leading-4 text-white">{todos.length}</span>
          {t.todos.title}
        </h3>
        <p className="mt-0.5 text-[12px] text-slate-600">{t.todos.lead}</p>
      </div>
      <ul className="pb-1.5">
        {todos.map((todo) => {
          const Icon = todo.kind === "pick" ? MousePointerClick : todo.kind === "secret" ? KeyRound : FolderOpen;
          const action = todo.kind === "pick" ? t.todos.pickAction : todo.kind === "secret" ? t.todos.secretAction : t.todos.fileAction;
          const help = todo.kind === "pick" ? t.todos.pickHelp : todo.kind === "secret" ? t.todos.secretHelp : t.todos.fileHelp;
          return (
            <li key={`${todo.kind}:${todo.kind === "pick" ? todo.part : todo.kind === "secret" ? todo.name : todo.path}`} className="flex items-center gap-2.5 px-4 py-1.5">
              <Icon size={15} strokeWidth={1.75} className="shrink-0 text-amber-700" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-ink">{todoTitle(todo)}</div>
                <div className="truncate text-[11px] text-slate-600">
                  {help}
                  {todo.kind === "pick" && ` · ${t.todos.nodes(todo.steps.length)}`}
                </div>
              </div>
              <button
                type="button"
                onClick={() => act(todo)}
                className="h-7 shrink-0 rounded-[4px] border border-amber-300 bg-sheet px-2.5 text-[12px] text-amber-700 hover:bg-amber-50"
              >
                {action}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A button that copies text for the AI chat and says so for a moment. */
export function CopyForAi({ text, label = t.todos.copyReturn, primary = false }: { text: string; label?: string; primary?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => void copy()}
        className={`flex h-7 shrink-0 items-center gap-1.5 rounded-[4px] px-2.5 text-[12px] ${
          primary ? "bg-ink text-paper hover:bg-ink/90" : "border border-slate-300 bg-sheet text-slate-700 hover:bg-slate-50"
        }`}
      >
        {copied ? <Check size={14} strokeWidth={1.75} aria-hidden="true" /> : <ClipboardCopy size={14} strokeWidth={1.75} aria-hidden="true" />}
        {label}
      </button>
      {copied && (
        <span role="status" className="text-[12px] text-moegi-600">
          {t.todos.copied}
        </span>
      )}
    </span>
  );
}

function AiIssues({ issues, flow, goTo }: { issues: ValidationIssue[]; flow: Flow; goTo: (id: string) => void }) {
  return (
    <section aria-labelledby="ai-issues-title">
      <div className="flex items-start gap-3 px-4 pt-2.5 pb-1">
        <div className="min-w-0 flex-1">
          <h3 id="ai-issues-title" className="text-xs font-semibold text-shu-600">
            {t.todos.fixTitle}
          </h3>
          <p className="mt-0.5 text-[12px] text-slate-600">{t.todos.fixLead}</p>
        </div>
        <CopyForAi text={returnText(issues, flow)} />
      </div>
      <IssueList issues={issues} goTo={goTo} />
    </section>
  );
}

function IssueList({ issues, goTo }: { issues: ValidationIssue[]; goTo: (id: string) => void }) {
  const flow = useStudio((s) => s.flow);
  const defs = useStudio((s) => s.stepTypes);
  return (
    <ul className="divide-y divide-slate-100">
      {issues.map((issue) => (
        <li key={`${issue.code}${issue.path}${issue.message}`}>
          <button
            type="button"
            className="w-full px-4 py-2 text-left hover:bg-slate-50"
            // Core's own words (for the AI) stay one hover away.
            title={[issue.code, issue.message, issue.hint].filter(Boolean).join("\n")}
            onClick={() => issue.stepId && goTo(issue.stepId)}
          >
            <div className={`text-xs font-semibold ${issue.severity === "error" ? "text-shu-600" : "text-amber-700"}`}>
              {issue.severity === "error" ? t.severity.error : t.severity.warning}
              {stepName(flow, defs, issue.stepId)}
            </div>
            <div className="text-sm">{issueText(issue, flow)}</div>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** " · 「行の読み取り」": which node an issue is on, by the name the chart shows. */
function stepName(flow: Flow | null, defs: StepTypeDef[], id: string | null | undefined): string {
  const step = flow && id ? findStep(flow.steps ?? [], id) : null;
  return step ? ` · ${t.quote(step.name || stepLabel(step.type, defs.find((d) => d.type === step.type)?.label))}` : "";
}
