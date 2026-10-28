// Turns a scenario Target into a Playwright locator.
//
// Targets describe elements by meaning (role and accessible name, label,
// text) rather than by CSS, so scenarios survive layout changes and read
// well in Studio. `css` is the last resort.

import type { Locator, Page } from "playwright-core";

export type AriaRole = Parameters<Page["getByRole"]>[0];

export interface Target {
  role?: AriaRole;
  name?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  testId?: string;
  css?: string;
  /** Match `name` / `label` / `text` / `placeholder` exactly (default: substring, case-insensitive). */
  exact?: boolean;
  /** 0-based index when several elements match. */
  nth?: number;
}

export class AdapterError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, options: { retryable?: boolean; details?: Record<string, unknown> } = {}) {
    super(message);
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function locate(page: Page, target: Target | undefined): Locator {
  if (!target || typeof target !== "object") {
    throw new AdapterError("INVALID_PARAMS", "target is required, e.g. { \"role\": \"button\", \"name\": \"ログイン\" }");
  }
  const exact = target.exact ?? false;
  let locator: Locator;
  if (target.role) {
    locator = page.getByRole(target.role, target.name === undefined ? {} : { name: target.name, exact });
  } else if (target.label !== undefined) {
    locator = page.getByLabel(target.label, { exact });
  } else if (target.placeholder !== undefined) {
    locator = page.getByPlaceholder(target.placeholder, { exact });
  } else if (target.text !== undefined) {
    locator = page.getByText(target.text, { exact });
  } else if (target.testId !== undefined) {
    locator = page.getByTestId(target.testId);
  } else if (target.css !== undefined) {
    locator = page.locator(target.css);
  } else {
    throw new AdapterError("INVALID_PARAMS", "target needs one of role, label, placeholder, text, testId or css");
  }
  return target.nth === undefined ? locator : locator.nth(target.nth);
}

/** Human-readable form used in logs and error messages. */
export function describe(target: Target | undefined): string {
  if (!target) return "(no target)";
  const parts = Object.entries(target).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return parts.join(" ");
}
