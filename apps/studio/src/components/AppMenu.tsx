// Studio's version, online updates and the MCP setup command: a section of
// the settings place. The update check runs once per launch; the rail shows
// a dot on Settings while a new version waits.
import { useEffect, useState } from "react";
import { create } from "zustand";
import { type AppInfo, type UpdateInfo, updates } from "../lib/api";
import { t } from "../lib/i18n";

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "installing"; info: UpdateInfo; percent: number | null }
  | { kind: "error"; message: string };

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** MCP registration for Claude Code, pointing at the CLI installed with Studio. */
function mcpCommand(cliPath: string): string {
  return `claude mcp add --scope user shikigami -- "${cliPath}" mcp`;
}

const useApp = create<{ info: AppInfo | null; state: UpdateState; started: boolean }>(() => ({
  info: null,
  state: { kind: "idle" },
  started: false,
}));

async function check() {
  useApp.setState({ state: { kind: "checking" } });
  try {
    const found = await updates.check();
    useApp.setState({ state: found ? { kind: "available", info: found } : { kind: "latest" } });
  } catch (e) {
    useApp.setState({ state: { kind: "error", message: message(e) } });
  }
}

/** Reads the app info and quietly looks for a new version, once. */
function start() {
  if (useApp.getState().started) return;
  useApp.setState({ started: true });
  void updates
    .appInfo()
    .then((info) => {
      useApp.setState({ info });
      if (info.updatesEnabled) void check();
    })
    .catch(() => {});
  void updates.onProgress((p) => {
    const s = useApp.getState().state;
    if (s.kind === "installing") {
      useApp.setState({ state: { ...s, percent: p.total ? Math.floor((p.downloaded / p.total) * 100) : null } });
    }
  });
}

async function install(info: UpdateInfo) {
  useApp.setState({ state: { kind: "installing", info, percent: 0 } });
  try {
    await updates.install();
  } catch (e) {
    useApp.setState({ state: { kind: "error", message: message(e) } });
  }
}

/** The new version waiting to be installed, if any. */
export function useUpdate(): string | null {
  useEffect(start, []);
  const state = useApp((s) => s.state);
  return state.kind === "available" || state.kind === "installing" ? state.info.version : null;
}

export function useAppVersion(): string | null {
  useEffect(start, []);
  return useApp((s) => s.info?.version ?? null);
}

export function AboutSection() {
  useEffect(start, []);
  const info = useApp((s) => s.info);
  const state = useApp((s) => s.state);
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  if (!info) return null;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold">{t.appName}</span>
        <span className="text-xs text-slate-500">v{info.version}</span>
      </div>
      {!info.updatesEnabled && <p className="text-xs text-slate-500">{t.updatesDisabled}</p>}
      {info.updatesEnabled && state.kind === "checking" && <p className="text-slate-500">{t.updateChecking}</p>}
      {info.updatesEnabled && state.kind === "latest" && <p className="text-moegi-500">{t.updateLatest}</p>}
      {state.kind === "error" && <p className="break-all text-shu-600">{state.message}</p>}
      {state.kind === "available" && (
        <div>
          <p>
            v{state.info.version} {t.updateReady}
          </p>
          {state.info.notes && <p className="mt-1 max-h-32 overflow-y-auto text-xs whitespace-pre-wrap text-slate-600">{state.info.notes}</p>}
          <button type="button" onClick={() => void install(state.info)} className="mt-2 rounded-[4px] bg-ink px-3 py-1.5 font-medium text-paper hover:bg-slate-700">
            {t.updateInstall}
          </button>
        </div>
      )}
      {state.kind === "installing" && (
        <p className="text-slate-600">
          {t.updateInstalling}
          {state.percent !== null && ` ${state.percent}%`}
        </p>
      )}
      {info.updatesEnabled && (state.kind === "latest" || state.kind === "error") && (
        <button type="button" onClick={() => void check()} className="text-xs text-brand-600 hover:underline">
          {t.updateCheck}
        </button>
      )}
      {info.cliPath && (
        <div className="border-t border-slate-200 pt-3">
          <p className="text-xs text-slate-500">{t.mcpSetup}</p>
          <code className="mt-1 block rounded-[3px] bg-slate-100 p-2 font-mono text-[11px] break-all">{mcpCommand(info.cliPath)}</code>
          <button type="button" onClick={() => void copy(mcpCommand(info.cliPath ?? ""))} className="mt-1 text-xs text-brand-600 hover:underline">
            {copied ? t.copied : t.copy}
          </button>
        </div>
      )}
    </div>
  );
}
