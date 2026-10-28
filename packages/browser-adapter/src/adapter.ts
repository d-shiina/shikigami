// Browser operations behind the JSON-RPC methods.
//
// One adapter process serves every run of a Runtime. Pages live in browser
// contexts keyed by run and context name, so parallel branches (and
// concurrent runs) using different context names never share cookies or
// tabs. Waiting relies on Playwright's auto-waiting, never on fixed sleeps.

import { chromium } from "playwright-core";
import type { Browser, BrowserContext, BrowserContextOptions, LaunchOptions, Locator, Page } from "playwright-core";

import { AdapterError, describe, locate, type Target } from "./targets.ts";

export interface AdapterOptions {
  /** Browser channel, e.g. "msedge" or "chrome". */
  channel?: string;
  executablePath?: string;
  /** Forces headless mode regardless of the step params. */
  forceHeadless?: boolean;
  /** Milliseconds to wait between operations (makes demos easy to follow). */
  slowMo?: number;
  /** Upper bound for one operation. */
  timeoutMs?: number;
}

interface Common {
  runId?: string;
  context?: string;
}

type Params = Common & Record<string, unknown>;

interface Session {
  context: BrowserContext;
  page: Page;
  headless: boolean;
  /** Name the login state is saved under when the context closes (`session` of browser.open). */
  saveAs?: string;
  /** Secret values typed in this context: masked in everything the adapter returns. */
  secrets: Set<string>;
  /** Fields that received a secret: blacked out in screenshots. */
  secretFields: Locator[];
}

/** A registered secret resolved by the Runtime for browser.fill. */
interface SecretInfo {
  name: string;
  /** Origins it may be typed into, e.g. "https://example.com". */
  sites: string[];
  sensitive: boolean;
}

const MASK = "***";
const PASSWORD_FIELDS = 'input[type="password"]';

/** `https://example.com:443/login` → `https://example.com` (as the Runtime normalizes sites). */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

const SNAPSHOT_LIMIT = 4000;

interface SavedSession {
  name: string;
  state: unknown;
}

export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): AdapterOptions {
  const headlessEnv = env.SHIKIGAMI_BROWSER_HEADLESS;
  const noDisplay = process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
  return {
    channel: env.SHIKIGAMI_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined),
    executablePath: env.SHIKIGAMI_BROWSER_PATH || undefined,
    forceHeadless: headlessEnv === "1" || headlessEnv === "true" || noDisplay,
    slowMo: env.SHIKIGAMI_BROWSER_SLOWMO ? Number(env.SHIKIGAMI_BROWSER_SLOWMO) : undefined,
  };
}

export class Adapter {
  private readonly options: AdapterOptions;
  private readonly browsers = new Map<boolean, Promise<Browser>>();
  private readonly sessions = new Map<string, Session>();

  constructor(options: AdapterOptions = {}) {
    this.options = options;
  }

  /** Dispatches one JSON-RPC method. */
  async call(method: string, params: Params): Promise<unknown> {
    try {
      switch (method) {
        case "ping":
          return "pong";
        case "open":
          return await this.open(params);
        case "click":
          return await this.click(params);
        case "fill":
          return await this.fill(params);
        case "select":
          return await this.select(params);
        case "press":
          return await this.press(params);
        case "getText":
          return await this.getText(params);
        case "getTable":
          return await this.getTable(params);
        case "waitFor":
          return await this.waitFor(params);
        case "screenshot":
          return await this.screenshot(params);
        case "snapshot":
          return await this.snapshot(params);
        case "isVisible":
          return await this.isVisible(params);
        case "waitForHuman":
          return await this.waitForHuman(params);
        case "close":
          return await this.close(params);
        case "closeRun":
          return await this.closeRun(String(params.runId ?? ""));
        default:
          throw new AdapterError("UNKNOWN_METHOD", `unknown method '${method}'`);
      }
    } catch (error) {
      throw await this.translate(error, params);
    }
  }

  async shutdown(): Promise<void> {
    for (const browser of this.browsers.values()) {
      await (await browser).close().catch(() => {});
    }
    this.browsers.clear();
    this.sessions.clear();
  }

  // -------------------------------------------------------------------------

  private key(params: Params): string {
    return `${params.runId ?? "default"}/${params.context ?? "default"}`;
  }

  private get timeout(): number {
    return this.options.timeoutMs ?? 20_000;
  }

  /** The Runtime sends each step's limit (slightly under its timeoutMs). */
  private limit(params: Params): number {
    const ms = Number(params.timeoutMs);
    return Number.isFinite(ms) && ms > 0 ? ms : this.timeout;
  }

  private browser(headless: boolean): Promise<Browser> {
    let browser = this.browsers.get(headless);
    if (!browser) {
      const launch: LaunchOptions = {
        headless,
        channel: this.options.channel,
        executablePath: this.options.executablePath,
        slowMo: this.options.slowMo,
      };
      browser = chromium.launch(launch).catch((error: Error) => {
        this.browsers.delete(headless);
        throw new AdapterError("BROWSER_LAUNCH_FAILED", `could not start the browser: ${error.message}`, {
          details: {
            channel: this.options.channel ?? "chromium",
            hint: "Install Microsoft Edge / Google Chrome, or set SHIKIGAMI_BROWSER_CHANNEL (msedge, chrome) or SHIKIGAMI_BROWSER_PATH.",
          },
        });
      });
      this.browsers.set(headless, browser);
    }
    return browser;
  }

  private session(params: Params): Session {
    const session = this.sessions.get(this.key(params));
    if (!session || session.page.isClosed()) {
      throw new AdapterError("BROWSER_NOT_OPEN", `browser context '${params.context ?? "default"}' is not open`, {
        details: { hint: "Add a browser.open step (with the same `context`) before this step." },
      });
    }
    return session;
  }

  private async open(params: Params): Promise<unknown> {
    const url = String(params.url ?? "");
    if (!url) throw new AdapterError("INVALID_PARAMS", "url is required");
    const key = this.key(params);
    let session = this.sessions.get(key);
    if (!session || session.page.isClosed()) {
      const headless = this.options.forceHeadless || params.headless === true;
      const storageState = params.storageState as BrowserContextOptions["storageState"] | undefined;
      const context = await (await this.browser(headless)).newContext({ locale: "ja-JP", storageState });
      context.setDefaultTimeout(this.timeout);
      const page = await context.newPage();
      session = { context, page, headless, secrets: new Set(), secretFields: [] };
      this.sessions.set(key, session);
    }
    if (typeof params.session === "string" && params.session) session.saveAs = params.session;
    try {
      await session.page.goto(url, { waitUntil: "load", timeout: this.limit(params) });
    } catch (error) {
      throw new AdapterError("NAVIGATION_FAILED", `could not open ${url}: ${(error as Error).message.split("\n")[0]}`, {
        retryable: true,
        details: { url },
      });
    }
    return { url: session.page.url(), title: await session.page.title() };
  }

  private target(params: Params): { page: Page; locator: Locator } {
    const { page } = this.session(params);
    return { page, locator: locate(page, params.target as Target | undefined) };
  }

  private async click({ ...params }: Params): Promise<null> {
    await this.target(params).locator.click({ timeout: this.limit(params) });
    return null;
  }

  private async fill(params: Params): Promise<null> {
    const session = this.session(params);
    const { page, locator } = this.target(params);
    const value = String(params.value ?? "");
    const secret = params.secret as SecretInfo | undefined;
    if (secret) {
      // Never type a secret into a page it was not registered for (a
      // look-alike site, or a page an injected instruction led to).
      const origin = originOf(page.url());
      if (!secret.sites.includes(origin)) {
        throw new AdapterError("SECRET_SITE_MISMATCH", `secret '${secret.name}' may not be typed on ${origin}`, {
          details: {
            page: origin,
            sites: secret.sites,
            hint: "This page is not one of the secret's registered sites. Check that the URL is right; if it is, ask the user to add it to the secret in Studio (シークレット).",
          },
        });
      }
      if (secret.sensitive && value) {
        session.secrets.add(value);
        session.secretFields.push(locator);
      }
    }
    await locator.fill(value, { timeout: this.limit(params) });
    return null;
  }

  private async select(params: Params): Promise<unknown> {
    const value = params.value;
    const wanted = Array.isArray(value) ? value.map(String) : [String(value ?? "")];
    const { locator } = this.target(params);
    const timeout = this.limit(params);
    // Match each value against the visible labels first (what a person
    // sees), then option values, without waiting on a mode that cannot match.
    await locator.waitFor({ timeout });
    const options = await locator.locator("option").evaluateAll((els) =>
      els.map((el) => ({ label: (el as HTMLOptionElement).label.trim(), value: (el as HTMLOptionElement).value })),
    );
    const choices = wanted.map((w) => {
      if (options.some((o) => o.label === w)) return { label: w };
      if (options.some((o) => o.value === w)) return { value: w };
      throw new AdapterError("OPTION_NOT_FOUND", `no option labelled or valued ${JSON.stringify(w)}`, {
        details: { options: options.map((o) => o.label), hint: "Use one of the option labels listed in `options`." },
      });
    });
    return await locator.selectOption(choices, { timeout });
  }

  private async press(params: Params): Promise<null> {
    const key = String(params.key ?? "");
    if (params.target) {
      await this.target(params).locator.press(key, { timeout: this.limit(params) });
    } else {
      await this.session(params).page.keyboard.press(key);
    }
    return null;
  }

  private async getText(params: Params): Promise<unknown> {
    const session = this.session(params);
    const { locator } = this.target(params);
    if (params.all === true) {
      await locator.first().waitFor({ timeout: this.limit(params) });
      return (await locator.allInnerTexts()).map((t) => this.mask(session, t.trim()));
    }
    return this.mask(session, (await locator.innerText({ timeout: this.limit(params) })).trim());
  }

  /** Reads an HTML table into objects keyed by its header cells. */
  private async getTable(params: Params): Promise<unknown> {
    const { page } = this.session(params);
    const table = params.target ? locate(page, params.target as Target) : page.getByRole("table").first();
    await table.waitFor({ timeout: this.limit(params) });
    const session = this.session(params);
    const rows = await table.evaluate((el) => {
      const text = (cell: Element) => (cell as HTMLElement).innerText.trim();
      const rows = Array.from(el.querySelectorAll("tr"));
      const headerRow = el.querySelector("thead tr") ?? rows.find((r) => r.querySelector("th")) ?? rows[0];
      if (!headerRow) return [];
      const headers = Array.from(headerRow.children).map((c, i) => text(c) || `列${i + 1}`);
      return rows
        .filter((r) => r !== headerRow && r.children.length > 0)
        .map((r) => {
          const record: Record<string, string> = {};
          Array.from(r.children).forEach((c, i) => {
            record[headers[i] ?? `列${i + 1}`] = text(c);
          });
          return record;
        });
    });
    return rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, this.mask(session, v)])));
  }

  private async waitFor(params: Params): Promise<null> {
    const state = (params.state as "visible" | "hidden" | "attached" | "detached" | undefined) ?? "visible";
    await this.target(params).locator.first().waitFor({ state, timeout: this.limit(params) });
    return null;
  }

  private async screenshot(params: Params): Promise<unknown> {
    const path = String(params.path ?? "");
    if (!path) throw new AdapterError("INVALID_PARAMS", "path is required");
    const session = this.session(params);
    // Password fields and fields that received a secret are blacked out.
    const mask = [session.page.locator(PASSWORD_FIELDS), ...session.secretFields];
    await session.page.screenshot({
      path,
      fullPage: params.fullPage === true,
      mask,
      maskColor: "#000",
      timeout: this.limit(params),
    });
    return path;
  }

  /** True when `target` is (or becomes, within `waitMs`) visible; never throws for a missing element. */
  private async isVisible(params: Params): Promise<boolean> {
    const { locator } = this.target(params);
    const waitMs = typeof params.waitMs === "number" ? params.waitMs : 2000;
    try {
      await locator.first().waitFor({ state: "visible", timeout: Math.max(waitMs, 1) });
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") return false;
      throw error;
    }
  }

  /**
   * Waits for the person at the PC to finish something in the browser window
   * (log in, approve MFA): done when `until` is visible. The Runtime shows the
   * message; this brings the window to the front.
   */
  private async waitForHuman(params: Params): Promise<null> {
    const session = this.session(params);
    if (session.headless) {
      throw new AdapterError("HUMAN_REQUIRED", "this step needs a person, but the browser runs without a window", {
        details: {
          hint: "Run with a visible browser (no `headless`, SHIKIGAMI_BROWSER_HEADLESS unset), or keep the login with browser.open `session` so unattended runs skip it.",
        },
      });
    }
    await session.page.bringToFront().catch(() => {});
    const timeout = typeof params.timeoutMs === "number" ? params.timeoutMs : 300_000;
    try {
      await locate(session.page, params.until as Target | undefined)
        .first()
        .waitFor({ state: "visible", timeout });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new AdapterError("HUMAN_TIMEOUT", `nobody finished it within ${Math.round(timeout / 1000)} s`, {
          retryable: false,
          details: { until: params.until, hint: "Raise the step's timeoutMs, or check that `until` names what the page shows afterwards." },
        });
      }
      throw error;
    }
    return null;
  }

  /** Accessibility snapshot for AI clients choosing targets. */
  private async snapshot(params: Params): Promise<unknown> {
    if (params.url) await this.open(params);
    const session = this.session(params);
    const { page } = session;
    const root = params.target ? locate(page, params.target as Target) : page.locator("body");
    const snapshot = await this.redact(session, await root.ariaSnapshot());
    const result: Record<string, unknown> = { url: page.url(), title: await page.title(), snapshot };
    if (await page.locator(PASSWORD_FIELDS).first().isVisible().catch(() => false)) {
      result.login = {
        site: originOf(page.url()),
        hint: "This page asks for a login. Never ask the user for the password in chat: use a registered secret (list_secrets; browser.fill value { \"secret\": \"<name>\", \"field\": \"password\" }) or let the user log in by hand with browser.waitForHuman.",
      };
    }
    return result;
  }

  /** Replaces secret values (and whatever is typed in password fields, even by hand) with ***. */
  private async redact(session: Session, text: string): Promise<string> {
    const typed = await session.page
      .locator(PASSWORD_FIELDS)
      .evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value))
      .catch(() => [] as string[]);
    return this.mask(session, text, typed);
  }

  private mask(session: Session, text: string, extra: string[] = []): string {
    const values = [...session.secrets, ...extra].filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
    return values.reduce((acc, v) => acc.split(v).join(MASK), text);
  }

  /** Closes a context. Returns the login state to save when it was opened with `session`. */
  private async close(params: Params): Promise<{ sessions: SavedSession[] }> {
    const key = this.key(params);
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    return { sessions: session ? await this.closeSession(session) : [] };
  }

  private async closeRun(runId: string): Promise<{ sessions: SavedSession[] }> {
    const saved: SavedSession[] = [];
    for (const [key, session] of [...this.sessions]) {
      if (key.startsWith(`${runId}/`)) {
        this.sessions.delete(key);
        saved.push(...(await this.closeSession(session)));
      }
    }
    return { sessions: saved };
  }

  private async closeSession(session: Session): Promise<SavedSession[]> {
    let saved: SavedSession[] = [];
    if (session.saveAs) {
      const state = await session.context.storageState().catch(() => undefined);
      if (state) saved = [{ name: session.saveAs, state }];
    }
    await session.context.close().catch(() => {});
    return saved;
  }

  /** Maps Playwright failures to stable error codes with repair hints. */
  private async translate(error: unknown, params: Params): Promise<AdapterError> {
    if (error instanceof AdapterError) return error;
    const message = error instanceof Error ? error.message : String(error);
    const target = params.target as Target | undefined;
    const firstLine = message.split("\n")[0] ?? message;
    if (message.includes("strict mode violation")) {
      const count = /resolved to (\d+) elements/.exec(message)?.[1];
      return new AdapterError("ELEMENT_AMBIGUOUS", `${count ?? "several"} elements match ${describe(target)}`, {
        details: {
          target,
          hint: "Make the target more specific (role + exact name), or add `nth` (0-based) to pick one.",
        },
      });
    }
    if (error instanceof Error && error.name === "TimeoutError") {
      return new AdapterError("ELEMENT_NOT_FOUND", `no element matches ${describe(target)}`, {
        retryable: true,
        details: {
          target,
          url: this.currentUrl(params),
          page: await this.pageSnapshot(params),
          hint: "Pick the target from `page` (role and name as listed), or wait for the page with browser.waitFor.",
        },
      });
    }
    return new AdapterError("BROWSER_ERROR", firstLine, { details: { target } });
  }

  private currentUrl(params: Params): string | undefined {
    return this.sessions.get(this.key(params))?.page.url();
  }

  private async pageSnapshot(params: Params): Promise<string | undefined> {
    const session = this.sessions.get(this.key(params));
    const page = session?.page;
    if (!session || !page || page.isClosed()) return undefined;
    try {
      const text = await this.redact(session, await page.locator("body").ariaSnapshot({ timeout: 2000 }));
      return text.length > SNAPSHOT_LIMIT ? `${text.slice(0, SNAPSHOT_LIMIT)}\n…` : text;
    } catch {
      return undefined;
    }
  }
}
