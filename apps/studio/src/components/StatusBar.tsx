// The bar along the bottom: where the data lives, what the AI and the runner
// are doing, what waits on the person, and the theme and version at the end.
import type { HistoryEntry, Step } from "@shikigami/schema";
import { type ReactNode, useMemo, useState } from "react";
import { useStudio } from "../context";
import { actorLabel, relativeTime } from "../lib/changes";
import { t } from "../lib/i18n";
import { outline } from "../lib/outline";
import { setTheme, type ThemeChoice, useTheme } from "../lib/theme";
import { AppMenu } from "./AppMenu";
import { useInbox } from "./ReviewDesk";

const ITEM = "flex h-full shrink-0 items-center gap-1.5 px-2 whitespace-nowrap";
const BUTTON = `${ITEM} hover:bg-slate-100 hover:text-ink`;

/** Where scenarios are stored; click to switch to another (e.g. shared) folder. */
function Workspace() {
  const workspace = useStudio((s) => s.workspace);
  const setWorkspace = useStudio((s) => s.setWorkspace);
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [shared, setShared] = useState(false);
  if (!workspace) return null;
  return (
    <div className="relative flex h-full min-w-0 shrink">
      <button
        type="button"
        className={`${BUTTON} min-w-0 shrink`}
        title={`シナリオの保存先：${workspace.root}\nこのPCの履歴・実行記録：${workspace.localRoot}\nクリックで${t.changeWorkspace}`}
        onClick={() => {
          setPath(workspace.root);
          setShared(workspace.shared);
          setOpen(!open);
        }}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" className="shrink-0" aria-hidden="true">
          <path d="M1.5 3.5h5l1.5 1.5h6.5v8.5h-13z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
        <span className="truncate">{workspace.root}</span>
        {workspace.shared && <span className="shrink-0 rounded-[2px] bg-mizu-100 px-1 text-[10px] text-mizu-500">{t.workspaceShared}</span>}
      </button>
      {open && (
        <form
          className="absolute bottom-full left-0 z-30 mb-2 w-[420px] space-y-2 rounded-[4px] border border-slate-200 bg-sheet p-3 text-[12px] text-slate-600 shadow-lifted"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) void setWorkspace(path.trim(), shared).then(() => setOpen(false));
          }}
        >
          <div className="font-bold text-ink">{t.workspace}</div>
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={t.workspacePath}
            className="w-full rounded-[3px] border border-slate-300 bg-sheet px-2 py-1 font-mono text-[12px] text-ink focus:border-ink focus:outline-none"
          />
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            {t.workspaceSharedLabel}
          </label>
          <div className="text-[11px] text-slate-400">このPCの履歴・実行記録：{workspace.localRoot}</div>
          <div className="flex justify-end gap-2">
            <button type="button" className="rounded-[3px] px-3 py-1 hover:bg-slate-100" onClick={() => setOpen(false)}>
              閉じる
            </button>
            <button type="submit" className="rounded-[3px] bg-ink px-3 py-1 text-paper hover:bg-slate-700">
              {t.workspaceApply}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** The latest edit an AI made through MCP, in any scenario loaded so far. */
function AiActivity() {
  const histories = useStudio((s) => s.histories);
  const latest = useMemo(() => {
    let found: HistoryEntry | null = null;
    for (const entries of Object.values(histories)) {
      for (const e of entries) if (e.actor.kind === "mcp" && (!found || e.at > found.at)) found = e;
    }
    return found;
  }, [histories]);
  if (!latest) return null;
  return (
    <span className={ITEM} title="AI（MCP）が最後に編集した時刻">
      <span className="bg-brand-500 h-2 w-2 rounded-full" />
      {actorLabel(latest)}・{relativeTime(latest.at)}に編集
    </span>
  );
}

function Waiting() {
  const inbox = useInbox().filter((i) => !i.waiting);
  const asks = useStudio((s) => s.secretRequests.length);
  const setReviewing = useStudio((s) => s.setReviewing);
  const setSecretsOpen = useStudio((s) => s.setSecretsOpen);
  return (
    <>
      {inbox.length > 0 && (
        <button type="button" className={BUTTON} onClick={() => setReviewing(true)} title="AIの変更が確認を待っています">
          <span className="rounded-[3px] bg-shu-500 px-1.5 text-[10px] leading-4 font-bold text-white">{inbox.length}</span>
          確認待ち
        </button>
      )}
      {asks > 0 && (
        <button type="button" className={BUTTON} onClick={() => setSecretsOpen(true)} title="AIがログイン情報の登録を頼んでいます">
          <span className="rounded-[3px] bg-accent-500 px-1.5 text-[10px] leading-4 font-bold text-white">{asks}</span>
          ログインの登録依頼
        </button>
      )}
    </>
  );
}

const RUN_LABEL: Record<string, string> = {
  pending: "実行待ち",
  running: "実行中",
  succeeded: "実行：成功",
  failed: "実行：失敗",
  cancelled: "実行：停止",
};

function RunStatus() {
  const run = useStudio((s) => s.run);
  const steps = useStudio((s) => s.scenario?.steps);
  const goTo = useStudio((s) => s.goTo);
  if (!run) return null;
  const current = run.status === "running" ? run.starts.at(-1)?.stepId : undefined;
  const name = current ? findName(steps ?? [], current) : undefined;
  const color =
    run.status === "running" ? "bg-accent-500 animate-pulse" : run.status === "succeeded" ? "bg-moegi-500" : run.status === "failed" ? "bg-shu-500" : "bg-slate-400";
  return (
    <button type="button" className={BUTTON} onClick={() => current && goTo(current)} title={current ? "実行中の手順へ移動" : undefined}>
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {RUN_LABEL[run.status] ?? run.status}
      {name && <span className="max-w-[200px] truncate text-slate-400">{name}</span>}
    </button>
  );
}

function findName(steps: Step[], id: string): string | undefined {
  for (const step of steps) {
    if (step.id === id) return step.name || step.type;
    for (const inner of Object.values(step.blocks ?? {})) {
      const found = findName(inner, id);
      if (found) return found;
    }
  }
  return undefined;
}

/** "手順 3 / 12" for the selected step, in reading order. */
function Position() {
  const scenario = useStudio((s) => s.scenario);
  const stepTypes = useStudio((s) => s.stepTypes);
  const selection = useStudio((s) => s.selection);
  const ids = useMemo(() => {
    const defs = new Map(stepTypes.map((d) => [d.type, d] as const));
    return outline(scenario?.steps ?? [], defs).map((i) => i.id);
  }, [scenario, stepTypes]);
  if (!scenario) return null;
  const at = selection?.kind === "step" ? ids.indexOf(selection.stepId) : -1;
  return (
    <span className={ITEM} title="↑↓ で前後の手順へ">
      {at >= 0 ? `手順 ${at + 1} / ${ids.length}` : `手順 ${ids.length}`}
    </span>
  );
}

const THEMES: [ThemeChoice, string, ReactNode][] = [
  [
    "system",
    "PCの設定に合わせる",
    <svg key="s" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 14h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>,
  ],
  [
    "light",
    "ライト",
    <svg key="l" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3" fill="currentColor" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M3 13l1.4-1.4M11.6 4.4 13 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>,
  ],
  [
    "dark",
    "ダーク",
    <svg key="d" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7Z" fill="currentColor" />
    </svg>,
  ],
];

/** ライト / ダーク / PCの設定, side by side as in VuePress's footer. */
function ThemeSwitch() {
  const { choice } = useTheme();
  return (
    <div className="mx-1 flex shrink-0 items-center rounded-[3px] border border-slate-200 p-px" role="radiogroup" aria-label="表示テーマ">
      {THEMES.map(([key, label, icon]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={choice === key}
          title={label}
          onClick={() => setTheme(key)}
          className={`grid h-[18px] w-[22px] place-items-center rounded-[2px] ${choice === key ? "bg-ink text-paper" : "text-slate-400 hover:text-ink"}`}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}

export function StatusBar() {
  return (
    <footer className="col-span-3 flex h-7 min-w-0 items-center border-t border-slate-200 bg-sheet px-2 text-[11px] text-slate-500">
      <Workspace />
      <AiActivity />
      <Waiting />
      <span className="flex-1" />
      <RunStatus />
      <Position />
      <ThemeSwitch />
      <AppMenu />
    </footer>
  );
}
