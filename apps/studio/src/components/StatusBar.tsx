// The bar along the bottom reports and never asks: what the AI and the runner
// are doing, where the selection is, then this PC's preferences (language,
// theme) and the version. What waits on the person has
// its badge on the control that answers it (確認待ち, シークレット), not here.
import type { HistoryEntry, Step } from "@shikigami/schema";
import { type ReactNode, useMemo, useState } from "react";
import { useStudio } from "../context";
import { actorLabel, relativeTime } from "../lib/changes";
import { outline } from "../lib/outline";
import { type Locale, setLocale, t, useLocale } from "../lib/i18n";
import { setTheme, type ThemeChoice, useTheme } from "../lib/theme";
import { useAppVersion, useUpdate } from "./AppMenu";

const ITEM = "flex h-full shrink-0 items-center gap-1.5 px-2 whitespace-nowrap";
const BUTTON = `${ITEM} hover:bg-slate-100 hover:text-ink`;

/** Changes where scenarios are stored (e.g. a shared folder); Studio restarts on it. */
export function WorkspaceSection() {
  const workspace = useStudio((s) => s.workspace);
  const setWorkspace = useStudio((s) => s.setWorkspace);
  const [path, setPath] = useState(workspace?.root ?? "");
  const [shared, setShared] = useState(workspace?.shared ?? false);
  if (!workspace) return null;
  return (
    <form
      className="space-y-2 text-[13px] text-slate-600"
      onSubmit={(e) => {
        e.preventDefault();
        if (path.trim()) void setWorkspace(path.trim(), shared);
      }}
    >
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
      <div className="text-[11px] text-slate-400">
        {t.bar.localRecords}
        {t.colon}
        {workspace.localRoot}
      </div>
      <button
        type="submit"
        disabled={path.trim() === "" || (path.trim() === workspace.root && shared === workspace.shared)}
        className="rounded-[4px] bg-ink px-3 py-1 text-paper hover:bg-slate-700 disabled:bg-slate-300"
      >
        {t.workspaceApply}
      </button>
    </form>
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
    <span className={ITEM} title={t.bar.aiEditedTitle}>
      <span className="bg-brand-500 h-2 w-2 rounded-full" />
      {t.bar.aiEdited(actorLabel(latest), relativeTime(latest.at))}
    </span>
  );
}

function RunStatus() {
  const run = useStudio((s) => s.run);
  const steps = useStudio((s) => s.scenario?.steps);
  const goTo = useStudio((s) => s.goTo);
  if (!run) return null;
  const current = run.status === "paused" ? run.pause?.stepId : run.status === "running" ? run.starts.at(-1)?.stepId : undefined;
  const name = current ? findName(steps ?? [], current) : undefined;
  const color =
    run.status === "running" ? "bg-accent-500 animate-pulse" : run.status === "paused" ? (run.pause?.reason === "error" ? "bg-shu-500" : "bg-mizu-500") : run.status === "succeeded" ? "bg-moegi-500" : run.status === "failed" ? "bg-shu-500" : "bg-slate-400";
  return (
    <button type="button" className={BUTTON} onClick={() => current && goTo(current)} title={current ? t.bar.goToRunning : undefined}>
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {(t.bar.run as Record<string, string>)[run.status] ?? run.status}
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
    <span className={ITEM} title={t.bar.positionTitle}>
      {at >= 0 ? t.bar.position(at + 1, ids.length) : t.bar.steps(ids.length)}
    </span>
  );
}

const THEMES: [ThemeChoice, () => string, ReactNode][] = [
  [
    "system",
    () => t.bar.themeSystem,
    <svg key="s" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 14h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>,
  ],
  [
    "light",
    () => t.bar.themeLight,
    <svg key="l" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3" fill="currentColor" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M3 13l1.4-1.4M11.6 4.4 13 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>,
  ],
  [
    "dark",
    () => t.bar.themeDark,
    <svg key="d" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7Z" fill="currentColor" />
    </svg>,
  ],
];

/** ライト / ダーク / PCの設定, side by side as in VuePress's footer. */
export function ThemeSwitch() {
  const { choice } = useTheme();
  return (
    <div className="mx-1 flex shrink-0 items-center rounded-[3px] border border-slate-200 p-px" role="radiogroup" aria-label={t.bar.theme}>
      {THEMES.map(([key, label, icon]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={choice === key}
          title={label()}
          onClick={() => setTheme(key)}
          className={`grid h-[18px] w-[22px] place-items-center rounded-[2px] ${choice === key ? "bg-ink text-paper" : "text-slate-400 hover:text-ink"}`}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}

const LANGUAGES: [Locale, string, string][] = [
  ["ja", "JA", "日本語"],
  ["en", "EN", "English"],
];

/** 日本語 / English, next to the theme. */
export function LanguageSwitch() {
  const { locale } = useLocale();
  return (
    <div className="mx-1 flex shrink-0 items-center rounded-[3px] border border-slate-200 p-px" role="radiogroup" aria-label={t.bar.language}>
      {LANGUAGES.map(([key, short, name]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={locale === key}
          title={name}
          lang={key}
          onClick={() => setLocale(key)}
          className={`grid h-[18px] place-items-center rounded-[2px] px-1 text-[10px] font-semibold ${locale === key ? "bg-ink text-paper" : "text-slate-400 hover:text-ink"}`}
        >
          {short}
        </button>
      ))}
    </div>
  );
}

/** The version; brand blue while an update waits. Opens Settings. */
function Version() {
  const version = useAppVersion();
  const update = useUpdate();
  const setPlace = useStudio((s) => s.setPlace);
  if (!version) return null;
  return (
    <button type="button" className={`${BUTTON} ${update ? "font-semibold text-brand-600" : ""}`} onClick={() => setPlace("settings")} title={t.shell.openSettings}>
      {update ? `${t.updateAvailable} v${update}` : `v${version}`}
    </button>
  );
}

export function StatusBar() {
  return (
    <footer className="col-span-full flex h-7 min-w-0 items-center border-t border-slate-200 bg-sheet px-2 text-[11px] text-slate-500">
      <AiActivity />
      <span className="flex-1" />
      <RunStatus />
      <Position />
      <LanguageSwitch />
      <ThemeSwitch />
      <Version />
    </footer>
  );
}
