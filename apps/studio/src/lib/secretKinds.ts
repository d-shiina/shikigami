// How each kind of secret names its fields and which ones a person fills in.
// The vault keeps every kind the same way; only the words differ.
import type { SecretField, SecretKind } from "./api";
import { t } from "./i18n";

export const SECRET_KINDS: SecretKind[] = ["login", "apiKey", "oauth"];

/** Fields a person fills in for each kind, in form order. */
export const KIND_FIELDS: Record<SecretKind, SecretField[]> = {
  login: ["username", "password", "totp"],
  apiKey: ["password"],
  oauth: ["username", "password"],
};

/** The name of a field as the kind calls it, e.g. the password of an API key is "API key". */
export function fieldLabel(kind: SecretKind | undefined, field: SecretField): string {
  const own = t.secretKindField[kind ?? "login"] as Partial<Record<SecretField, string>>;
  return own[field] ?? t.secretField[field];
}
