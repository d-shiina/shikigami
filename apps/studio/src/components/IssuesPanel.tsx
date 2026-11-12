import type { Flow, StepTypeDef, ValidationIssue } from "@spellsheet/schema";
import { useContext } from "react";
import { Check, FileInput, KeyRound, MousePointerClick, Sparkles } from "lucide-react";
import { flowBusy, openAsk, useAgentApiMaybe, useAgentMaybe } from "../agent";
import { useStudio } from "../context";
import { stepLabel, t } from "../lib/i18n";
import { issueText } from "../lib/issueText";
import { writtenAt } from "../lib/problemText";
import { authorIssues, fixText, PERSON_CODES, type Todo, todoTitle } from "../lib/todos";
import { useTodos } from "../lib/useTodos";
import { ProjectContext } from "../project";
import { findStep } from "../store";
import { putIntoFlow } from "./FilePlaces";

/**
 * The flow's checks, in the order a person deals with them: what only they
 * can do (pick a part, register a login, put a file), then what the author
 * (an AI) got wrong, to send back to it, then the rest.
 */
export function IssuesPanel() {
  const flow = useStudio((s) => s.flow);
  const validation = useStudio((s) => s.validation);
  const goTo = useStudio((s) => s.goTo);
  const todos = useTodos();
  const issues = validation?.issues ?? [];
  const forAi = authorIssues(validation);
  const rest = issues.filter((i) => i.severity !== "error" && !PERSON_CODES.has(i.code) && !forAi.includes(i));
  if (todos.length === 0 && forAi.length === 0 && rest.length === 0) return (
      <p className="flex items-center gap-1.5 p-4 text-sm text-moegi-500">
        <Check size={14} strokeWidth={2} aria-hidden="true" />
        {t.noIssues}
      </p>
    );
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
  const flowId = useStudio((s) => s.flow?.id);
  const project = useContext(ProjectContext);
  const act = (todo: Todo) => {
    onAct?.();
    if (todo.kind === "pick") {
      // A part opens in the inspector, which review covers with its own panel.
      if (place === "review") setPlace("flows");
      select({ kind: "part", name: todo.part });
    }
    else if (todo.kind === "secret") openSecretForm({ name: todo.name, sites: [], fields: todo.fields });
    // The file is copied into the flow's folder under the name the flow reads.
    else if (project && flowId) void putIntoFlow(project, flowId, todo.path);
  };
  return (
    <section aria-labelledby="todos-title" className="bg-amber-50/60">
      <div className="px-4 pt-2.5 pb-1">
        <h3 id="todos-title" className="flex items-center gap-1.5 text-xs font-semibold text-amber-700">
          <span className="rounded-md bg-amber-500 px-1.5 text-[10px] leading-4 text-white">{todos.length}</span>
          {t.todos.title}
        </h3>
        <p className="mt-0.5 text-[12px] text-slate-600">{t.todos.lead}</p>
      </div>
      <ul className="pb-1.5">
        {todos.map((todo) => {
          const Icon = todo.kind === "pick" ? MousePointerClick : todo.kind === "secret" ? KeyRound : FileInput;
          const action = todo.kind === "pick" ? t.todos.pickAction : todo.kind === "secret" ? t.todos.secretAction : t.todos.fileAction;
          const help = todo.kind === "pick" ? (todo.image ? t.todos.snipHelp : t.todos.pickHelp) : todo.kind === "secret" ? t.todos.secretHelp : t.todos.fileHelp;
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
                className="h-7 shrink-0 rounded-lg border border-amber-300 bg-sheet px-2.5 text-[12px] text-amber-700 hover:bg-amber-50"
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

/** Sends the flow's problems to the AI to fix; with no AI set up yet, the AI pane shows how. */
function AskAiFix({ issues, flow }: { issues: ValidationIssue[]; flow: Flow }) {
  const agent = useAgentApiMaybe();
  const name = useAgentMaybe((a) => a.info?.name ?? "AI", "AI");
  const busy = useAgentMaybe((a) => flowBusy(a, flow.id), false);
  if (!agent) return null;
  const ask = () => {
    const a = agent.getState();
    if (!a.info?.available) {
      openAsk(agent, { about: { id: flow.id, name: flow.name } });
      return;
    }
    void a.send(fixText(issues, flow), { id: flow.id, name: flow.name }, `${flow.name} ・ ${t.todos.fixTitle}`);
  };
  return (
    <button
      type="button"
      disabled={busy}
      onClick={ask}
      title={busy ? t.pause.agentBusy(name) : undefined}
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 bg-sheet px-2.5 text-[12px] text-slate-700 enabled:hover:bg-slate-50 disabled:opacity-50"
    >
      <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
      {t.todos.askFix(name)}
    </button>
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
        <AskAiFix issues={issues} flow={flow} />
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
            {flow && (() => {
              const written = writtenAt(flow, issue);
              return written ? <Written text={written} /> : null;
            })()}
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

/** What the AI wrote where the problem is, as it wrote it. */
export function Written({ text }: { text: string }) {
  return (
    <div className="mt-0.5 flex min-w-0 items-baseline gap-1 text-[11px] text-slate-600">
      <span className="shrink-0">{t.todos.writtenShort}</span>
      <code className="min-w-0 truncate rounded bg-sheet px-1 font-mono text-ink" title={text}>
        {text}
      </code>
    </div>
  );
}
