// The run band's bridge to the backend (src-tauri/src/run_band.rs).
import type { DebugCommand, Flow, RunEventEnvelope, StepTypeDef } from "@spellsheet/schema";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { RunRecord } from "../lib/api";

/** The run the band shows. */
export type BandRun = { runId: string; flowId: string };

export const bandApi = {
  current: () => invoke<BandRun | null>("run_band_current"),
  /** A new run to show (the band is made once and kept). */
  onRun: (handler: (run: BandRun) => void): Promise<UnlistenFn> => listen<BandRun>("run-band", (e) => handler(e.payload)),
  onEvent: (handler: (event: RunEventEnvelope) => void): Promise<UnlistenFn> =>
    listen<RunEventEnvelope>("run-event", (e) => handler(e.payload)),
  flow: (id: string) => invoke<Flow>("get_flow", { id }),
  stepTypes: () => invoke<StepTypeDef[]>("list_step_types"),
  /** What the run did before the band opened. */
  record: (runId: string) => invoke<RunRecord>("run_record", { runId }),
  stepTimes: (id: string) => invoke<Record<string, number>>("step_times", { id }),
  pause: (runId: string) => invoke("debug_run", { runId, command: { action: "pause" } satisfies DebugCommand }),
  stop: (runId: string) => invoke<void>("stop_run", { runId }),
  writer: () => invoke<void>("run_band_writer"),
  close: () => invoke<void>("run_band_close"),
};
