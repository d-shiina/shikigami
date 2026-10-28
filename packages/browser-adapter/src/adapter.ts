// Browser operations behind the JSON-RPC methods.
//
// One adapter process serves every run of a Runtime. Pages live in browser
// contexts keyed by run and context name, so parallel branches (and
// concurrent runs) using different context names never share cookies or
// tabs. Waiting relies on Playwright's auto-waiting, never on fixed sleeps.

import { chromium } from "playwright-core";
import type { Browser, BrowserContext, LaunchOptions, Locator, Page } from "playwright-core";

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
}

const SNAPSHOT_LIMIT = 4000;

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
      const context = await (await this.browser(headless)).newContext({ locale: "ja-JP" });
      context.setDefaultTimeout(this.timeout);
      const page = await context.newPage();
      session = { context, page };
      this.sessions.set(key, session);
    }
    try {
      await session.page.goto(url, { waitUntil: "load" });
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
    await this.target(params).locator.click();
    return null;
  }

  private async fill(params: Params): Promise<null> {
    await this.target(params).locator.fill(String(params.value ?? ""));
    return null;
  }

  private async select(params: Params): Promise<unknown> {
    const value = params.value;
    const values = Array.isArray(value) ? value.map(String) : [String(value ?? "")];
    // Match option labels first (what a person sees), then values.
    const { locator } = this.target(params);
    try {
      return await locator.selectOption(values.map((label) => ({ label })));
    } catch {
      return await locator.selectOption(values);
    }
  }

  private async press(params: Params): Promise<null> {
    const key = String(params.key ?? "");
    if (params.target) {
      await this.target(params).locator.press(key);
    } else {
      await this.session(params).page.keyboard.press(key);
    }
    return null;
  }

  private async getText(params: Params): Promise<unknown> {
    const { locator } = this.target(params);
    if (params.all === true) {
      await locator.first().waitFor();
      return (await locator.allInnerTexts()).map((t) => t.trim());
    }
    return (await locator.innerText()).trim();
  }

  /** Reads an HTML table into objects keyed by its header cells. */
  private async getTable(params: Params): Promise<unknown> {
    const { page } = this.session(params);
    const table = params.target ? locate(page, params.target as Target) : page.getByRole("table").first();
    await table.waitFor();
    return await table.evaluate((el) => {
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
  }

  private async waitFor(params: Params): Promise<null> {
    const state = (params.state as "visible" | "hidden" | "attached" | "detached" | undefined) ?? "visible";
    await this.target(params).locator.first().waitFor({ state });
    return null;
  }

  private async screenshot(params: Params): Promise<unknown> {
    const path = String(params.path ?? "");
    if (!path) throw new AdapterError("INVALID_PARAMS", "path is required");
    const { page } = this.session(params);
    await page.screenshot({ path, fullPage: params.fullPage === true });
    return path;
  }

  /** Accessibility snapshot for AI clients choosing targets. */
  private async snapshot(params: Params): Promise<unknown> {
    if (params.url) await this.open(params);
    const { page } = this.session(params);
    const root = params.target ? locate(page, params.target as Target) : page.locator("body");
    return { url: page.url(), title: await page.title(), snapshot: await root.ariaSnapshot() };
  }

  private async close(params: Params): Promise<null> {
    const key = this.key(params);
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    await session?.context.close().catch(() => {});
    return null;
  }

  private async closeRun(runId: string): Promise<null> {
    for (const [key, session] of [...this.sessions]) {
      if (key.startsWith(`${runId}/`)) {
        this.sessions.delete(key);
        await session.context.close().catch(() => {});
      }
    }
    return null;
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
    const page = this.sessions.get(this.key(params))?.page;
    if (!page || page.isClosed()) return undefined;
    try {
      const text = await page.locator("body").ariaSnapshot({ timeout: 2000 });
      return text.length > SNAPSHOT_LIMIT ? `${text.slice(0, SNAPSHOT_LIMIT)}\n…` : text;
    } catch {
      return undefined;
    }
  }
}
