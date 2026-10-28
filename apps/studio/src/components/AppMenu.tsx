import { useEffect, useState } from "react";
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

/** Version, online update and MCP setup, at the right end of the status bar. */
export function AppMenu() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const check = async () => {
    setState({ kind: "checking" });
    try {
      const found = await updates.check();
      setState(found ? { kind: "available", info: found } : { kind: "latest" });
    } catch (e) {
      setState({ kind: "error", message: message(e) });
    }
  };

  useEffect(() => {
    void updates.appInfo().then((i) => {
      setInfo(i);
      // Quietly look for a new version once per launch.
      if (i.updatesEnabled) void check();
    });
    const off = updates.onProgress((p) =>
      setState((s) =>
        s.kind === "installing"
          ? { ...s, percent: p.total ? Math.floor((p.downloaded / p.total) * 100) : null }
          : s,
      ),
    );
    return () => void off.then((f) => f());
  }, []);

  const install = async (update: UpdateInfo) => {
    setState({ kind: "installing", info: update, percent: 0 });
    try {
      await updates.install();
    } catch (e) {
      setState({ kind: "error", message: message(e) });
    }
  };

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (!info) return null;
  const available = state.kind === "available" || state.kind === "installing" ? state.info : null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`rounded-[3px] px-2 text-[11px] leading-5 font-medium ${
          available ? "bg-brand-500 text-white hover:bg-brand-600" : "text-slate-500 hover:bg-slate-100"
        }`}
      >
        {available ? `${t.updateAvailable} v${available.version}` : `v${info.version}`}
      </button>
      {open && (
        <div className="absolute right-0 bottom-full z-30 mb-2 w-96 rounded-[4px] border border-slate-200 bg-sheet p-4 text-sm shadow-lifted">
          <div className="flex items-baseline justify-between">
            <span className="font-serif font-semibold">{t.appName}</span>
            <span className="text-xs text-slate-500">v{info.version}</span>
          </div>

          <section className="mt-3 border-t border-slate-200 pt-3">
            {!info.updatesEnabled && <p className="text-xs text-slate-500">{t.updatesDisabled}</p>}
            {info.updatesEnabled && state.kind === "checking" && <p className="text-slate-500">{t.updateChecking}</p>}
            {info.updatesEnabled && state.kind === "latest" && <p className="text-moegi-500">{t.updateLatest}</p>}
            {state.kind === "error" && <p className="break-all text-shu-600">{state.message}</p>}
            {state.kind === "available" && (
              <>
                <p>
                  v{state.info.version} {t.updateReady}
                </p>
                {state.info.notes && (
                  <p className="mt-1 max-h-32 overflow-y-auto text-xs whitespace-pre-wrap text-slate-600">
                    {state.info.notes}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => void install(state.info)}
                  className="mt-2 w-full rounded-[4px] bg-brand-500 py-1.5 font-medium text-white hover:bg-brand-600"
                >
                  {t.updateInstall}
                </button>
              </>
            )}
            {state.kind === "installing" && (
              <p className="text-slate-600">
                {t.updateInstalling}
                {state.percent !== null && ` ${state.percent}%`}
              </p>
            )}
            {info.updatesEnabled && (state.kind === "latest" || state.kind === "error") && (
              <button
                type="button"
                onClick={() => void check()}
                className="mt-2 text-xs text-brand-600 hover:underline"
              >
                {t.updateCheck}
              </button>
            )}
          </section>

          {info.cliPath && (
            <section className="mt-3 border-t border-slate-200 pt-3">
              <p className="text-xs text-slate-500">{t.mcpSetup}</p>
              <code className="mt-1 block rounded bg-slate-100 p-2 text-[11px] break-all">{mcpCommand(info.cliPath)}</code>
              <button
                type="button"
                onClick={() => void copy(mcpCommand(info.cliPath ?? ""))}
                className="mt-1 text-xs text-brand-600 hover:underline"
              >
                {copied ? t.copied : t.copy}
              </button>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
