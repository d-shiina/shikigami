// Typed bridge to the Rust backend. Every call maps 1:1 to a Tauri command,
// which in turn is a thin wrapper over ScenarioService / Runtime. The
// frontend never edits scenario documents itself; it only sends EditOps.
import type {
  EditOp,
  EditOutcome,
  ErrorPayload,
  Evidence,
  ExtractOutcome,
  HistoryEntry,
  ImportConflict,
  ImportOutcome,
  NewReview,
  NewScenario,
  NewVersion,
  ObservationContent,
  ReviewTimeline,
  RunEventEnvelope,
  RunSnapshot,
  Scenario,
  ScenarioDiff,
  ScenarioSummary,
  StepTypeDef,
  ValidationReport,
  VersionSummary,
  WorkspaceInfo,
} from "@shikigami/schema";
import { isErrorPayload } from "@shikigami/schema";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SecretField = "username" | "password" | "totp";

/** A registered secret as Studio lists it: never the password or TOTP key. */
export type SecretInfo = {
  name: string;
  username: string;
  sites: string[];
  fields: SecretField[];
  description?: string;
  updatedAt: string;
};

/** Registers or updates a secret; fields left out keep their stored value. */
export type SecretInput = {
  name: string;
  username?: string;
  password?: string;
  totp?: string;
  sites?: string[];
  description?: string;
};

/** A login an AI asked the user for (request_secret): names and sites only. */
export type SecretRequest = {
  name: string;
  sites: string[];
  fields: SecretField[];
  /** Written by the AI: shown as its words. */
  reason?: string;
  requestedAt: string;
  /** What the registered secret (if any) still lacks. */
  missing: { registered: boolean; fields: SecretField[]; sites: string[] };
};

export class ApiError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(payload: ErrorPayload) {
    super(payload.message);
    this.name = "ApiError";
    this.code = payload.code;
    this.details = payload.details;
  }
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    if (isErrorPayload(e)) throw new ApiError(e);
    throw new ApiError({ code: "IPC_ERROR", message: String(e) });
  }
}

export const api = {
  workspaceInfo: () => call<WorkspaceInfo>("workspace_info"),
  /** Saves the default workspace and restarts Studio on it. */
  setWorkspace: (path: string, shared: boolean) => call<void>("set_workspace", { path, shared }),
  listVersions: (id: string) => call<VersionSummary[]>("list_versions", { id }),
  createVersion: (id: string, expectedRevision: number, input: NewVersion) =>
    call<VersionSummary>("create_version", { id, expectedRevision, input }),
  /** `from` / `to` are version numbers; omitted means the current content. */
  diffVersions: (id: string, from?: number, to?: number) =>
    call<ScenarioDiff>("diff_versions", { id, from, to }),
  restoreVersion: (id: string, number: number, expectedRevision: number) =>
    call<EditOutcome>("restore_version", { id, number, expectedRevision }),
  /** Writes a bundle to the Downloads folder; returns its path. */
  exportScenario: (id: string) => call<string>("export_scenario", { id }),
  importScenario: (contents: string, onConflict?: ImportConflict) =>
    call<ImportOutcome>("import_scenario", { contents, onConflict }),
  listScenarios: () => call<ScenarioSummary[]>("list_scenarios"),
  getScenario: (id: string) => call<Scenario>("get_scenario", { id }),
  createScenario: (input: NewScenario) => call<EditOutcome>("create_scenario", { input }),
  duplicateScenario: (id: string, name?: string) =>
    call<EditOutcome>("duplicate_scenario", { id, name }),
  deleteScenario: (id: string, expectedRevision?: number) =>
    call<void>("delete_scenario", { id, expectedRevision }),
  edit: (id: string, expectedRevision: number, ops: EditOp[]) =>
    call<EditOutcome>("edit_scenario", { id, expectedRevision, ops }),
  /** Moves neighbouring steps into a new scenario and calls it from where they were. */
  extractSubscenario: (id: string, expectedRevision: number, stepIds: string[], name: string) =>
    call<ExtractOutcome>("extract_subscenario", { id, expectedRevision, stepIds, name }),
  undo: (id: string, expectedRevision: number) =>
    call<EditOutcome>("undo", { id, expectedRevision }),
  redo: (id: string, expectedRevision: number) =>
    call<EditOutcome>("redo", { id, expectedRevision }),
  undoState: (id: string) => call<{ canUndo: boolean; canRedo: boolean }>("undo_state", { id }),
  validate: (id: string) => call<ValidationReport>("validate_scenario", { id }),
  listStepTypes: () => call<StepTypeDef[]>("list_step_types"),
  history: (id: string, limit = 100) => call<HistoryEntry[]>("scenario_history", { id, limit }),
  reviewTimeline: (id: string, since?: number) => call<ReviewTimeline>("review_timeline", { id, since }),
  submitReview: (id: string, input: NewReview) => call<Evidence>("submit_review", { id, input }),
  getObservation: (id: string) => call<ObservationContent>("get_observation", { id }),
  run: (id: string, inputs?: Record<string, unknown>) =>
    call<string>("run_scenario", { id, inputs }),
  stopRun: (runId: string) => call<void>("stop_run", { runId }),
  runStatus: (runId: string) => call<RunSnapshot | null>("run_status", { runId }),
  listSecrets: () => call<{ secrets: SecretInfo[]; keyLocation: string; keyMissing: boolean }>("list_secrets"),
  setSecret: (input: SecretInput) => call<SecretInfo>("set_secret", { input }),
  removeSecret: (name: string) => call<void>("remove_secret", { name }),
  resetSecrets: () => call<number>("reset_secrets"),
  forgetLogin: (session: string) => call<boolean>("forget_login", { session }),
  listSecretRequests: () => call<SecretRequest[]>("list_secret_requests"),
  dismissSecretRequest: (name: string) => call<boolean>("dismiss_secret_request", { name }),
};

export interface AppInfo {
  version: string;
  /** False in development builds. */
  updatesEnabled: boolean;
  /** The bundled CLI (MCP server), when Studio was installed. */
  cliPath: string | null;
}

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string | null;
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

// Kept apart from `api` so the scenario store and its test doubles stay
// unaware of app updates.
export const updates = {
  appInfo: () => call<AppInfo>("app_info"),
  check: () => call<UpdateInfo | null>("check_update"),
  /** Never resolves on success: the installer restarts Studio. */
  install: () => call<void>("install_update"),
  onProgress: (handler: (p: UpdateProgress) => void): Promise<UnlistenFn> =>
    listen<UpdateProgress>("update-progress", (e) => handler(e.payload)),
};

export type Api = typeof api;

export const events = {
  onScenarioChanged: (handler: (scenarioId: string) => void): Promise<UnlistenFn> =>
    listen<{ scenarioId: string }>("scenario-changed", (e) => handler(e.payload.scenarioId)),
  onRunEvent: (handler: (event: RunEventEnvelope) => void): Promise<UnlistenFn> =>
    listen<RunEventEnvelope>("run-event", (e) => handler(e.payload)),
  /** An AI asked for a login, or a request was answered or dismissed (any process). */
  onSecretRequestsChanged: (handler: () => void): Promise<UnlistenFn> =>
    listen("secret-requests-changed", () => handler()),
};
