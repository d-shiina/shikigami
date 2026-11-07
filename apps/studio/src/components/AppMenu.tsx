// Studio's version, online updates and the MCP setup command: a section of
// the settings place. Like VS Code: the check runs once per launch (or from
// "check again"), a new version downloads in the background, and it is
// installed silently on "restart to update" or when Studio is closed. The
// rail shows a dot on Settings while a new version waits.
import { useEffect, useState } from "react";
import { create } from "zustand";
import { useAgent } from "../agent";
import { type AgentKind, type AppInfo, type UpdateInfo, updates } from "../lib/api";
import { t } from "../lib/i18n";
import { SettingsGroup, SettingsRow, settingsPrimary } from "./settingsLayout";

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "downloading"; info: UpdateInfo; percent: number | null }
  | { kind: "ready"; info: UpdateInfo }
  | { kind: "installing"; info: UpdateInfo }
  | { kind: "error"; message: string };

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** MCP registration for the AI in use, pointing at the CLI installed with Studio. */
export function mcpCommand(kind: AgentKind, cliPath: string): string {
  switch (kind) {
    case "codex":
      return `codex mcp add shikigami -- "${cliPath}" mcp`;
    case "gemini":
      return `gemini mcp add --scope user shikigami "${cliPath}" mcp`;
    case "copilot":
      return `copilot mcp add shikigami -- "${cliPath}" mcp`;
    default:
      return `claude mcp add --scope user shikigami -- "${cliPath}" mcp`;
  }
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
    if (!found) {
      useApp.setState({ state: { kind: "latest" } });
      return;
    }
    useApp.setState({ state: { kind: "downloading", info: found, percent: null } });
    await updates.download();
    useApp.setState({ state: { kind: "ready", info: found } });
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
    if (s.kind === "downloading") {
      useApp.setState({ state: { ...s, percent: p.total ? Math.floor((p.downloaded / p.total) * 100) : null } });
    }
  });
}

async function install(info: UpdateInfo) {
  useApp.setState({ state: { kind: "installing", info } });
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
  return state.kind === "downloading" || state.kind === "ready" || state.kind === "installing" ? state.info.version : null;
}

export function useAppVersion(): string | null {
  useEffect(start, []);
  return useApp((s) => s.info?.version ?? null);
}

export function AboutSection() {
  useEffect(start, []);
  const info = useApp((s) => s.info);
  const state = useApp((s) => s.state);
  const agentInfo = useAgent((s) => s.info);
  // A `command` agent registers Shikigami its own way; show Claude Code's.
  const agentKind = agentInfo && agentInfo.kind !== "command" ? agentInfo.kind : "claudeCode";
  const agentName = agentKind === "claudeCode" ? "Claude Code" : (agentInfo?.name ?? "AI");
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  if (!info) return null;
  return (
    <SettingsGroup>
      <SettingsRow label={t.appVersion} hint={!info.updatesEnabled ? t.updatesDisabled : undefined}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            <span className="font-semibold">{t.appName}</span> <span className="text-slate-500">v{info.version}</span>
          </span>
          {info.updatesEnabled && state.kind === "checking" && <span className="text-slate-500">{t.updateChecking}</span>}
          {info.updatesEnabled && state.kind === "latest" && <span className="text-moegi-500">{t.updateLatest}</span>}
          {state.kind === "downloading" && (
            <span className="text-slate-600">
              v{state.info.version} {t.updateDownloading}
              {state.percent !== null && ` ${state.percent}%`}
            </span>
          )}
          {state.kind === "installing" && <span className="text-slate-600">{t.updateInstalling}</span>}
          {info.updatesEnabled && (state.kind === "latest" || state.kind === "error") && (
            <button type="button" onClick={() => void check()} className="text-brand-600 hover:underline">
              {t.updateCheck}
            </button>
          )}
        </div>
        {state.kind === "error" && <p className="mt-1 break-all text-shu-600">{state.message}</p>}
      </SettingsRow>
      {state.kind === "ready" && (
        <SettingsRow label={`v${state.info.version} ${t.updateReady}`} hint={t.updateOnClose} align="start">
          {state.info.notes && (
            <p className="mb-2 max-h-32 overflow-y-auto text-xs whitespace-pre-wrap text-slate-600">{state.info.notes}</p>
          )}
          <button type="button" onClick={() => void install(state.info)} className={settingsPrimary}>
            {t.updateInstall}
          </button>
        </SettingsRow>
      )}
      {info.cliPath && (
        <SettingsRow label={t.mcpSetup} hint={t.mcpSetupHint(agentName)} align="start">
          <div className="flex items-start gap-2">
            <code className="block min-w-0 flex-1 rounded-[3px] bg-slate-100 px-2 py-1.5 font-mono text-[11px] break-all">
              {mcpCommand(agentKind, info.cliPath)}
            </code>
            <button
              type="button"
              onClick={() => void copy(mcpCommand(agentKind, info.cliPath ?? ""))}
              className="shrink-0 rounded-[3px] border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
            >
              {copied ? t.copied : t.copy}
            </button>
          </div>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}
