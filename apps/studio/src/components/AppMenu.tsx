// Studio's version and online updates (and the MCP setup row shown in the AI
// section): a section of
// the settings place. Like VS Code: the check runs once per launch (or from
// "check again"), a new version downloads in the background, and it is
// installed silently on "restart to update" or when Studio is closed. The
// rail shows a dot on Settings while a new version waits.
import { useEffect, useState } from "react";
import { create } from "zustand";
import { useAgent } from "../agent";
import { type AgentKind, type AppInfo, type UpdateInfo, updates } from "../lib/api";
import { t } from "../lib/i18n";
import { releaseNotes } from "../lib/releaseNotes";
import { Markdown } from "./Markdown";
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

/** The AI clients the MCP registration can be shown for. */
export type McpClient = Exclude<AgentKind, "command"> | "cursor";
export const MCP_CLIENTS: { kind: McpClient; name: string }[] = [
  { kind: "claudeCode", name: "Claude Code" },
  { kind: "codex", name: "Codex" },
  { kind: "cursor", name: "Cursor" },
  { kind: "gemini", name: "Gemini CLI" },
  { kind: "copilot", name: "GitHub Copilot" },
];

/** MCP registration for an AI client, pointing at the CLI installed with Studio. */
export function mcpCommand(kind: McpClient, cliPath: string): string {
  switch (kind) {
    case "codex":
      return `codex mcp add spellsheet -- "${cliPath}" mcp`;
    case "gemini":
      return `gemini mcp add --scope user spellsheet "${cliPath}" mcp`;
    case "copilot":
      return `copilot mcp add spellsheet -- "${cliPath}" mcp`;
    case "cursor":
      // What goes in ~/.cursor/mcp.json when the "add" link cannot be used.
      return JSON.stringify({ mcpServers: { spellsheet: { command: cliPath, args: ["mcp"] } } }, null, 2);
    default:
      return `claude mcp add --scope user spellsheet -- "${cliPath}" mcp`;
  }
}

/**
 * The settings row for registering the MCP server with an AI client, in the
 * AI section: the CLI's place comes from the installed Studio.
 */
export function McpSetupRow() {
  useEffect(start, []);
  const info = useApp((s) => s.info);
  const agentInfo = useAgent((s) => s.info);
  // A `command` agent registers SpellSheet its own way; start on Claude Code's.
  const agentKind = agentInfo && agentInfo.kind !== "command" ? agentInfo.kind : "claudeCode";
  return (
    <SettingsRow label={t.mcpSetup} hint={t.mcpSetupHint} align="start">
      {info?.cliPath ? (
        <McpSetup cliPath={info.cliPath} initial={agentKind} />
      ) : (
        <p className="text-[12px] text-slate-500">{info ? t.mcpNoCli : t.loading}</p>
      )}
    </SettingsRow>
  );
}

/** The registration for one AI client: pick it, then a button (Cursor) or a command to copy. */
function McpSetup({ cliPath, initial }: { cliPath: string; initial: McpClient }) {
  const [kind, setKind] = useState<McpClient>(initial);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const text = mcpCommand(kind, cliPath);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div>
      <div role="radiogroup" aria-label={t.mcpClient} className="mb-2 flex flex-wrap gap-1">
        {MCP_CLIENTS.map((c) => (
          <button
            key={c.kind}
            type="button"
            role="radio"
            aria-checked={kind === c.kind}
            onClick={() => {
              setKind(c.kind);
              setProblem(null);
            }}
            className={`rounded-md border px-2 py-0.5 text-xs ${kind === c.kind ? "border-brand-500 bg-brand-50 font-medium text-brand-700" : "border-slate-300 text-slate-600 hover:bg-slate-100"}`}
          >
            {c.name}
          </button>
        ))}
      </div>
      {kind === "cursor" && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void updates.addToCursor().catch((e: unknown) => setProblem(message(e)))}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-100"
          >
            {t.mcpAddToCursor}
          </button>
          <span className="text-[11.5px] text-slate-500">{t.mcpCursorHint}</span>
        </div>
      )}
      {problem && <p className="mb-2 text-xs text-shu-600">{problem}</p>}
      <p className="mb-1 text-[11.5px] text-slate-500">{kind === "cursor" ? t.mcpCursorFile : t.mcpRunOnce}</p>
      <div className="flex items-start gap-2">
        <code className="block min-w-0 flex-1 rounded-md bg-slate-100 px-2 py-1.5 font-mono text-[11px] break-all whitespace-pre-wrap">{text}</code>
        <button type="button" onClick={() => void copy()} className="shrink-0 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100">
          {copied ? t.copied : t.copy}
        </button>
      </div>
    </div>
  );
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
            <div className="mb-2 max-h-48 overflow-y-auto pr-1">
              <Markdown text={releaseNotes(state.info.notes)} className="text-xs text-slate-700" />
            </div>
          )}
          <button type="button" onClick={() => void install(state.info)} className={settingsPrimary}>
            {t.updateInstall}
          </button>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}
