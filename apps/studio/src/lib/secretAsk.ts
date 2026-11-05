// What the login dialog asks for when an AI requests a secret
// (request_secret) or a run stops on one. Kept free of React so it can be
// tested on its own.
import type { SecretField, SecretInfo, SecretRequest } from "./api";

export type SecretAsk = {
  /** "ai": an AI called request_secret; "run": a run stopped on the secret. */
  source: "ai" | "run";
  name: string;
  /** The AI's own words, shown as a quote. */
  reason?: string;
  /** The run's error code (source "run"). */
  code?: string;
  /** The page the run stopped on, shown only (SECRET_SITE_MISMATCH). */
  page?: string;
  /** The saved secret, when there is one. */
  existing?: SecretInfo;
  /** Values the user types: only these fields are shown. */
  fields: SecretField[];
  /** Sites the save adds (already filled in, shown for confirmation). */
  sites: string[];
  /** No site is known: the user types one. */
  needsSite: boolean;
  /** False when only the full form can fix it (e.g. a site the run was refused on). */
  quick: boolean;
};

const LOGIN: SecretField[] = ["username", "password"];

/** The ask to show now: the oldest AI request first, then a failed run. */
export function nextSecretAsk(
  requests: SecretRequest[],
  fix: { name: string; code: string; site?: string; field?: SecretField } | null,
  secrets: SecretInfo[],
): SecretAsk | null {
  const request = requests[0];
  if (request) {
    const existing = secrets.find((s) => s.name === request.name);
    const sites = request.missing.sites;
    return {
      source: "ai",
      name: request.name,
      reason: request.reason || undefined,
      existing,
      fields: request.missing.fields,
      sites,
      needsSite: sites.length === 0 && !existing?.sites.length,
      quick: true,
    };
  }
  if (!fix) return null;
  const existing = secrets.find((s) => s.name === fix.name);
  const base = { source: "run" as const, name: fix.name, code: fix.code, existing, sites: [] as string[] };
  switch (fix.code) {
    case "SECRET_NOT_FOUND":
      return existing
        ? null // Registered since the run stopped.
        : { ...base, fields: LOGIN, needsSite: true, quick: true };
    case "SECRET_FIELD_EMPTY":
      // Without the field the run named, only the full form can tell.
      return fix.field
        ? { ...base, fields: [fix.field], needsSite: false, quick: true }
        : { ...base, fields: [], needsSite: false, quick: false };
    case "SECRET_SITE_NOT_SET":
      return { ...base, fields: [], needsSite: !existing?.sites.length, quick: !existing?.sites.length };
    default:
      return { ...base, page: fix.site, fields: [], needsSite: false, quick: false };
  }
}
