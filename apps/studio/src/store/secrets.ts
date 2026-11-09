// Logins (secrets): the list, the requests from the AI, and the errors a
// person fixes by registering one.
import type { SecretField, SecretKind } from "../lib/api";

export type SecretPrefill = { name: string; sites: string[]; fields: SecretField[]; kind?: SecretKind };

export type SecretFix = { name: string; code: string; site?: string; field?: SecretField };

/** Step errors the user fixes by registering or editing a secret. */
export const SECRET_FIX_CODES = [
  "SECRET_NOT_FOUND",
  "SECRET_FIELD_EMPTY",
  "SECRET_SITE_NOT_SET",
  "SECRET_SITE_MISMATCH",
  "SECRET_APP_NOT_SET",
];

/** The secret a failed step asks the user to fix, from the error's details. */
export function secretFixOf(error: { code: string; details?: unknown } | null | undefined): SecretFix | null {
  if (!error || !SECRET_FIX_CODES.includes(error.code)) return null;
  const details = (error.details ?? {}) as { secret?: unknown; page?: unknown; field?: unknown };
  if (typeof details.secret !== "string" || !details.secret) return null;
  const site = typeof details.page === "string" && details.page ? details.page : undefined;
  const field = (["username", "password", "totp"] as const).find((f) => f === details.field);
  return { name: details.secret, code: error.code, site, ...(field ? { field } : {}) };
}
