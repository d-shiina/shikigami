// Shared contract between the Rust core and every TypeScript client
// (Studio today, the Playwright adapter later). Types are generated; this
// file only adds a few helpers that mirror stable Rust constants.
export type * from "./generated";

import type { ErrorPayload } from "./generated";

/** Current scenario file format version (`shikigami_core::SCHEMA_VERSION`). */
export const SCHEMA_VERSION = 1;

/** Stable error codes shared by Core, Runtime, MCP tools and Studio. */
export type CoreErrorCode =
  | "SCENARIO_NOT_FOUND"
  | "SCENARIO_ALREADY_EXISTS"
  | "INVALID_SCENARIO_ID"
  | "STEP_NOT_FOUND"
  | "DUPLICATE_STEP_ID"
  | "REVISION_CONFLICT"
  | "VERSION_NOT_FOUND"
  | "IMPORT_CONFLICT"
  | "OBSERVATION_NOT_FOUND"
  | "INVALID_EDIT"
  | "NOTHING_TO_UNDO_OR_REDO"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "VALIDATION_FAILED"
  | "PARSE_ERROR"
  | "STORAGE_ERROR";

export function isErrorPayload(value: unknown): value is ErrorPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ErrorPayload).code === "string" &&
    typeof (value as ErrorPayload).message === "string"
  );
}
