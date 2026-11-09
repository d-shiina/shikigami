// Pieces once held by the bar along the bottom, now shown where they belong:
// the workspace and the language and theme switches (Settings), the open
// flow's run (its title bar) and the selected node's place (the inspector).
// The window has no status bar: the app's menu at its top left holds the
// theme, language and version (ShellBar).
import type { Step } from "@shikigami/schema";
import { type ReactNode, useMemo, useState } from "react";
import { useStudio } from "../context";
import { outline } from "../lib/outline";
import { type Locale, setLocale, stepLabel, t, useLocale } from "../lib/i18n";
import { setTheme, type ThemeChoice, useTheme } from "../lib/theme";
import { SettingsGroup, SettingsRow, settingsInput, settingsPrimary } from "./settingsLayout";

const ITEM = "flex h-full shrink-0 items-center gap-1.5 px-2 whitespace-nowrap";
const BUTTON = `${ITEM} hover:bg-slate-100 hover:text-ink`;

/** Changes where flows are stored (e.g. a shared folder); Studio restarts on it. */
export function WorkspaceSection() {
  const workspace = useStudio((s) => s.workspace);
  const setWorkspace = useStudio((s) => s.setWorkspace);
  const [path, setPath] = useState(workspace?.root ?? "");
  const [shared, setShared] = useState(workspace?.shared ?? false);
  if (!workspace) return null;
  const unchanged = path.trim() === "" || (path.trim() === workspace.root && shared === workspace.shared);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (path.trim()) void setWorkspace(path.trim(), shared);
      }}
    >
      <SettingsGroup
        footer={
          <button type="submit" disabled={unchanged} className={settingsPrimary}>
            {t.workspaceApply}
          </button>
        }
      >
        <SettingsRow label={t.workspaceFolder} hint={t.workspaceFolderHint} htmlFor="settings-workspace-path">
          <input
            id="settings-workspace-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={t.workspacePath}
            className={`${settingsInput} font-mono text-[12px]`}
          />
        </SettingsRow>
        <SettingsRow label={t.workspaceShared}>
          <label className="flex items-center gap-2 text-slate-700">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            {t.workspaceSharedLabel}
          </label>
        </SettingsRow>
        <SettingsRow label={t.bar.localRecords} hint={t.workspaceLocalHint}>
          <code className="block font-mono text-[12px] break-all text-slate-600">{workspace.localRoot}</code>
        </SettingsRow>
      </SettingsGroup>
    </form>
  );
}

/** The open flow's run, in its title bar. While it runs the bar's Run control says so; this names the node and goes to it. */
export function RunStatus() {
  const run = useStudio((s) => s.run);
  const flowId = useStudio((s) => s.flow?.id);
  const steps = useStudio((s) => s.flow?.steps);
  const goTo = useStudio((s) => s.goTo);
  // It sits in the open flow's title bar, so a run of another flow says nothing here.
  if (!run || (run.flowId && run.flowId !== flowId)) return null;
  const current = run.status === "paused" ? run.pause?.stepId : run.status === "running" ? run.starts.at(-1)?.stepId : undefined;
  const name = current ? findName(steps ?? [], current) : undefined;
  const color =
    run.status === "running" ? "bg-accent-500 animate-pulse" : run.status === "paused" ? (run.pause?.reason === "error" ? "bg-shu-500" : "bg-mizu-500") : run.status === "succeeded" ? "bg-moegi-500" : run.status === "failed" ? "bg-shu-500" : "bg-slate-400";
  return (
    <button type="button" className={BUTTON} onClick={() => current && goTo(current)} title={current ? t.bar.goToRunning : undefined}>
      {!current && <span className={`h-2 w-2 rounded-full ${color}`} />}
      {!current && ((t.bar.run as Record<string, string>)[run.status] ?? run.status)}
      {name && <span className="max-w-[200px] truncate">{name}</span>}
    </button>
  );
}

function findName(steps: Step[], id: string): string | undefined {
  for (const step of steps) {
    if (step.id === id) return step.name || stepLabel(step.type);
    for (const inner of Object.values(step.blocks ?? {})) {
      const found = findName(inner, id);
      if (found) return found;
    }
  }
  return undefined;
}

/** "ノード 3 / 12" for the selected step, in reading order. */
export function Position() {
  const flow = useStudio((s) => s.flow);
  const stepTypes = useStudio((s) => s.stepTypes);
  const selection = useStudio((s) => s.selection);
  const ids = useMemo(() => {
    const defs = new Map(stepTypes.map((d) => [d.type, d] as const));
    return outline(flow?.steps ?? [], defs).map((i) => i.id);
  }, [flow, stepTypes]);
  if (!flow) return null;
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

/** Segmented switch frame: small in the bar, labelled in settings. */
const switchFrame = (labeled: boolean) =>
  `flex shrink-0 items-center rounded-md border border-slate-200 p-px ${labeled ? "" : "mx-1"}`;
const switchButton = (on: boolean, labeled: boolean) =>
  `${labeled ? "flex h-[26px] items-center gap-1.5 px-2.5 text-[13px]" : "grid h-[18px] place-items-center"} rounded-sm ${
    on ? "bg-slate-200 text-ink" : `${labeled ? "text-slate-600" : "text-slate-400"} hover:text-ink`
  }`;

/** ライト / ダーク / PCの設定, side by side as in VuePress's footer. `labeled` spells each out (settings). */
export function ThemeSwitch({ labeled = false }: { labeled?: boolean }) {
  const { choice } = useTheme();
  return (
    <div className={switchFrame(labeled)} role="radiogroup" aria-label={t.bar.theme}>
      {THEMES.map(([key, label, icon]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={choice === key}
          title={label()}
          onClick={() => setTheme(key)}
          className={`${switchButton(choice === key, labeled)} ${labeled ? "" : "w-[22px]"}`}
        >
          {icon}
          {labeled && label()}
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
export function LanguageSwitch({ labeled = false }: { labeled?: boolean }) {
  const { locale } = useLocale();
  return (
    <div className={switchFrame(labeled)} role="radiogroup" aria-label={t.bar.language}>
      {LANGUAGES.map(([key, short, name]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={locale === key}
          title={name}
          lang={key}
          onClick={() => setLocale(key)}
          className={`${switchButton(locale === key, labeled)} ${labeled ? "" : "px-1 text-[10px] font-semibold"}`}
        >
          {labeled ? name : short}
        </button>
      ))}
    </div>
  );
}
