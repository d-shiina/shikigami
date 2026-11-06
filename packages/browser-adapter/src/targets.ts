// Turns a flow Target into a Playwright locator.
//
// Targets describe elements by meaning (role and accessible name, label,
// text) rather than by CSS, so flows survive layout changes and read
// well in Studio. `css` is the last resort.

import type { FrameLocator, Locator, Page } from "playwright-core";

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
  /** The iframe (or frameset frame) the element is in. */
  frame?: Frame;
}

/**
 * An iframe or a `<frame>` of a frameset, by its attributes. `frame` is the
 * frame it is in, for frames inside frames.
 */
export interface Frame {
  /** The `name` (or `id`) attribute. */
  name?: string;
  /** Part of the `title` attribute. */
  title?: string;
  /** Part of the `src` address. */
  src?: string;
  css?: string;
  nth?: number;
  frame?: Frame;
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

/** CSS for a frame described by its attributes. */
function frameSelector(frame: Frame): string {
  const tags = ["iframe", "frame"];
  const quote = (v: string) => JSON.stringify(v);
  if (frame.css !== undefined) return frame.css;
  if (frame.name !== undefined) return tags.flatMap((t) => [`${t}[name=${quote(frame.name!)}]`, `${t}[id=${quote(frame.name!)}]`]).join(", ");
  if (frame.title !== undefined) return tags.map((t) => `${t}[title*=${quote(frame.title!)}]`).join(", ");
  if (frame.src !== undefined) return tags.map((t) => `${t}[src*=${quote(frame.src!)}]`).join(", ");
  throw new AdapterError("INVALID_PARAMS", "frame needs one of name, title, src or css, e.g. { \"name\": \"main\" }");
}

/** The page, or the frame `frame` names inside it (outer frames first). */
export function scope(page: Page, frame: Frame | undefined): Page | FrameLocator {
  if (!frame) return page;
  if (typeof frame !== "object") throw new AdapterError("INVALID_PARAMS", "frame must be an object, e.g. { \"name\": \"main\" }");
  const outer = scope(page, frame.frame);
  const element = outer.locator(frameSelector(frame));
  return (frame.nth === undefined ? element.first() : element.nth(frame.nth)).contentFrame();
}

export function locate(page: Page, target: Target | undefined): Locator {
  if (!target || typeof target !== "object") {
    throw new AdapterError("INVALID_PARAMS", "target is required, e.g. { \"role\": \"button\", \"name\": \"ログイン\" }");
  }
  const root = scope(page, target.frame);
  const exact = target.exact ?? false;
  let locator: Locator;
  if (target.role) {
    locator = root.getByRole(target.role, target.name === undefined ? {} : { name: target.name, exact });
  } else if (target.label !== undefined) {
    locator = root.getByLabel(target.label, { exact });
  } else if (target.placeholder !== undefined) {
    locator = root.getByPlaceholder(target.placeholder, { exact });
  } else if (target.text !== undefined) {
    locator = root.getByText(target.text, { exact });
  } else if (target.testId !== undefined) {
    locator = root.getByTestId(target.testId);
  } else if (target.css !== undefined) {
    locator = root.locator(target.css);
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
