// The run window's bridge to the backend (src-tauri/src/runner.rs).
import { isErrorPayload, type ProjectFiles, type RunEventEnvelope, type RunReport, type RunStatus, type Scenario } from "@shikigami/schema";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ApiError, type RunRecord } from "../lib/api";

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    if (isErrorPayload(e)) throw new ApiError(e);
    throw new ApiError({ code: "IPC_ERROR", message: String(e) });
  }
}

/** A published scenario: what the run window lists and runs. */
export interface RunnerItem {
  /** The published version's content. */
  scenario: Scenario;
  version: number;
  publishedAt: string;
  lastRun: { runId: string; status: RunStatus; finishedAt: string } | null;
}

export const runnerApi = {
  list: () => call<RunnerItem[]>("runner_list"),
  /** Runs the published version; events arrive through `onEvent`. */
  run: (id: string, inputs: Record<string, unknown>) => call<string>("runner_run", { id, inputs }),
  stop: (runId: string) => call<void>("stop_run", { runId }),
  report: async (runId: string): Promise<RunReport | null> => (await call<RunRecord>("run_record", { runId })).report,
  files: (id: string) => call<ProjectFiles>("project_files", { id }),
  /** With its app, or the folder (`""`) in Explorer. */
  open: (id: string, path: string) => call<void>("open_project_file", { id, path, reveal: false }),
  /** Opens the run window (from Studio). */
  openWindow: () => call<void>("open_runner"),
  onEvent: (handler: (event: RunEventEnvelope) => void): Promise<UnlistenFn> =>
    listen<RunEventEnvelope>("runner-event", (e) => handler(e.payload)),
};

export type RunnerApi = typeof runnerApi;
