// Browser operations behind the JSON-RPC methods.
//
// One adapter process serves every run of a Runtime. Pages live in browser
// contexts keyed by run and context name, so parallel branches (and
// concurrent runs) using different context names never share cookies or
// tabs. Waiting relies on Playwright's auto-waiting, never on fixed sleeps.

import { existsSync, mkdirSync, statSync } from "node:fs";
import { get as httpGet } from "node:http";
import { basename, dirname, join } from "node:path";

import { chromium } from "playwright-core";
import type { Browser, BrowserContext, BrowserContextOptions, CDPSession, Dialog, LaunchOptions, Locator, Page } from "playwright-core";

import { cancelPick, highlight, pick } from "./pick.ts";
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
  /** Tests: a script plays the person, so steps that need one run headless too. */
  scriptedHuman?: boolean;
}

interface Common {
  runId?: string;
  context?: string;
}

type Params = Common & Record<string, unknown>;

/** How the step that sets it answers the JS dialog (alert / confirm / prompt) it causes. */
interface DialogPlan {
  action: "accept" | "dismiss";
  promptText?: string;
}

interface DialogSeen {
  type: string;
  message: string;
}

interface Session {
  context: BrowserContext;
  /** The current tab: every step works on it (browser.switchTab changes it). */
  page: Page;
  /** Tabs in the order they became current, to go back when one closes. */
  history: Page[];
  /** The answer for dialogs while a step with `dialog` runs. */
  dialogPlan?: DialogPlan;
  /** Dialogs answered by the running step. */
  answered: DialogSeen[];
  /** Tells the running step that its dialog came. */
  onDialog?: () => void;
  /** Set when the context is a browser the person started (browser.attach): never closed, only let go. */
  attached?: Browser;
  /** The last dialog nobody asked for (dismissed); reported in the next failure. */
  unanswered?: DialogSeen;
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

/** Shown in place of the redirect URL's page; drops the code from the address bar. */
const SIGNED_IN_PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Shikigami</title>
<style>body{font-family:"Yu Gothic UI","Noto Sans JP",sans-serif;color:#1e2a4a;display:grid;place-items:center;height:90vh;margin:0}</style>
<script>history.replaceState(null, "", location.pathname)</script></head>
<body><p>サインインが終わりました。Shikigami が続きを進めます。<br>Signed in. Shikigami takes it from here.</p></body></html>`;

interface SavedSession {
  name: string;
  state: unknown;
}

/** The browser's DevTools WebSocket address from `/json/version` on 127.0.0.1. */
function debuggerUrl(port: number, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpGet({ host: "127.0.0.1", port, path: "/json/version", timeout }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => {
        try {
          const url = (JSON.parse(body) as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl;
          if (typeof url === "string") resolve(url);
          else reject(new Error("the answer on that port has no webSocketDebuggerUrl"));
        } catch {
          reject(new Error("the answer on that port is not a browser's"));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`no answer within ${timeout} ms`)));
    req.on("error", reject);
  });
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
        case "attach":
          return await this.attach(params);
        case "click":
          return await this.click(params);
        case "hover":
          return await this.hover(params);
        case "download":
          return await this.download(params);
        case "upload":
          return await this.upload(params);
        case "scroll":
          return await this.scroll(params);
        case "getAttribute":
          return await this.getAttribute(params);
        case "switchTab":
          return await this.switchTab(params);
        case "closeTab":
          return await this.closeTab(params);
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
        case "pick":
          return await this.pick(params);
        case "highlight":
          return await this.highlight(params);
        case "cancelPick":
          return await cancelPick(this.session(params).page);
        case "authorize":
          return await this.authorize(params);
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
    // The current tab closed itself (a popup that finished): go back to the one before it.
    if (session && session.page.isClosed()) this.backToOpenTab(session);
    if (!session || session.page.isClosed()) {
      throw new AdapterError("BROWSER_NOT_OPEN", `browser context '${params.context ?? "default"}' is not open`, {
        details: { hint: "Add a browser.open step (with the same `context`) before this step." },
      });
    }
    return session;
  }

  /**
   * The context's session; when none is open and `url` is given, a browser
   * opened on that page (Studio's 「画面から選ぶ」 with no run going).
   */
  private async sessionOrOpen(params: Params): Promise<Session> {
    const session = this.sessions.get(this.key(params));
    if ((!session || session.page.isClosed()) && typeof params.url === "string" && params.url) await this.open(params);
    return this.session(params);
  }

  /** The context's session, started (with a new window) on first use. */
  private async ensureSession(params: Params): Promise<Session> {
    const key = this.key(params);
    let session = this.sessions.get(key);
    if (!session || session.page.isClosed()) {
      const headless = this.options.forceHeadless || params.headless === true;
      const storageState = params.storageState as BrowserContextOptions["storageState"] | undefined;
      const context = await (await this.browser(headless)).newContext({ locale: "ja-JP", storageState });
      context.setDefaultTimeout(this.timeout);
      const page = await context.newPage();
      const created: Session = { context, page, headless, history: [page], answered: [], secrets: new Set(), secretFields: [] };
      context.on("page", (p) => this.watchTab(created, p));
      this.watchTab(created, page);
      session = created;
      this.sessions.set(key, session);
    }
    return session;
  }

  /** Every tab of a context answers its JS dialogs as the running step says. */
  private watchTab(session: Session, page: Page): void {
    page.on("dialog", (dialog: Dialog) => {
      // Secrets typed earlier may be quoted in the message (outputs and logs reach AI clients).
      const seen = { type: dialog.type(), message: this.mask(session, dialog.message()) };
      const plan = session.dialogPlan;
      if (plan) {
        session.answered.push(seen);
        const answer = plan.action === "accept" ? dialog.accept(plan.promptText) : dialog.dismiss();
        answer.catch(() => {});
        session.onDialog?.();
      } else {
        // Nobody asked for it: close it like the browser would without a
        // person (alert: OK, confirm / prompt: cancel) and tell the next failure.
        session.unanswered = seen;
        process.stderr.write(`dialog dismissed (no step answers it): ${seen.type} ${JSON.stringify(seen.message)}\n`);
        dialog.dismiss().catch(() => {});
      }
    });
  }

  private backToOpenTab(session: Session): void {
    session.history = session.history.filter((p) => !p.isClosed());
    const previous = session.history.at(-1) ?? session.context.pages().at(-1);
    if (previous) session.page = previous;
  }

  private makeCurrent(session: Session, page: Page): void {
    session.page = page;
    session.history = [...session.history.filter((p) => p !== page && !p.isClosed()), page];
  }

  /**
   * Runs an action that may raise a JS dialog. With `dialog` in the params the
   * step answers it (and waits for it when the action is done before the
   * dialog shows) and returns its message; without, any dialog is dismissed.
   */
  private async withDialog(session: Session, params: Params, action: () => Promise<unknown>): Promise<string | null> {
    const plan = this.dialogPlan(params);
    if (!plan) {
      await action();
      return null;
    }
    // One time budget for the action and the wait for its dialog, so the
    // step never outlives the Runtime's limit with an answer still armed.
    const deadline = Date.now() + this.limit(params);
    session.answered = [];
    session.dialogPlan = plan;
    const shown = new Promise<void>((resolve) => (session.onDialog = resolve));
    try {
      await action();
      if (session.answered.length === 0) {
        let timer: NodeJS.Timeout | undefined;
        const expired = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AdapterError("DIALOG_NOT_SHOWN", "no dialog (alert / confirm / prompt) appeared", {
                  details: {
                    hint: "The action ran but the page showed no JS dialog. Remove `dialog` if none is expected; a dialog drawn by the page itself (not alert / confirm / prompt) is an element: use browser.click on its button.",
                  },
                }),
              ),
            Math.max(deadline - Date.now(), 1),
          );
        });
        try {
          await Promise.race([shown, expired]);
        } finally {
          clearTimeout(timer);
        }
      }
      return session.answered[0]?.message ?? null;
    } finally {
      session.dialogPlan = undefined;
      session.onDialog = undefined;
    }
  }

  private dialogPlan(params: Params): DialogPlan | undefined {
    const dialog = params.dialog;
    if (dialog === undefined || dialog === null) return undefined;
    if (dialog === "accept" || dialog === "dismiss") return { action: dialog };
    if (typeof dialog === "object") {
      const d = dialog as Record<string, unknown>;
      if (d.action === "accept" || d.action === "dismiss") {
        return { action: d.action, promptText: typeof d.promptText === "string" ? d.promptText : undefined };
      }
    }
    throw new AdapterError("INVALID_PARAMS", 'dialog must be "accept", "dismiss" or { "action": "accept", "promptText": "…" }');
  }

  private async open(params: Params): Promise<unknown> {
    const url = String(params.url ?? "");
    if (!url) throw new AdapterError("INVALID_PARAMS", "url is required");
    const session = await this.ensureSession(params);
    if (typeof params.session === "string" && params.session) session.saveAs = params.session;
    let dialog: string | null = null;
    try {
      dialog = await this.withDialog(session, params, () => session.page.goto(url, { waitUntil: "load", timeout: this.limit(params) }));
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("NAVIGATION_FAILED", `could not open ${url}: ${(error as Error).message.split("\n")[0]}`, {
        retryable: true,
        details: { url },
      });
    }
    const opened: Record<string, unknown> = { url: session.page.url(), title: await session.page.title() };
    if (dialog !== null) opened.dialog = dialog;
    return opened;
  }

  /**
   * Takes over a browser the person started with a debugging port
   * (`msedge --remote-debugging-port=9222`): its tabs, logins and
   * extensions. Only this PC (127.0.0.1) is reached. The browser is never
   * closed; the run lets go of it when it ends.
   */
  private async attach(params: Params): Promise<unknown> {
    const port = params.port === undefined ? 9222 : Number(params.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AdapterError("INVALID_PARAMS", "port must be a port number such as 9222");
    const key = this.key(params);
    const existing = this.sessions.get(key);
    if (existing && !existing.attached) {
      throw new AdapterError("CONTEXT_IN_USE", `browser context '${params.context ?? "default"}' already has a browser opened by browser.open`, {
        details: { hint: "Give browser.attach its own `context` name, or close the other one first with browser.close." },
      });
    }
    let session = existing;
    if (!session || !session.attached?.isConnected()) {
      let browser: Browser;
      try {
        // Ask the browser for its address directly: a proxy set for the PC
        // (HTTP_PROXY) must never be asked to reach 127.0.0.1.
        const endpoint = await debuggerUrl(port, this.limit(params));
        browser = await chromium.connectOverCDP(endpoint, { timeout: this.limit(params) });
      } catch (error) {
        throw new AdapterError("BROWSER_NOT_RUNNING", `no browser is waiting on port ${port}: ${(error as Error).message.split("\n")[0]}`, {
          retryable: true,
          details: {
            port,
            hint: `Start Edge with a debugging port and its own profile folder, e.g. msedge.exe --remote-debugging-port=${port} --user-data-dir="%LOCALAPPDATA%\\Shikigami\\edge-profile" (Edge and Chrome ignore the port on their everyday profile), sign in there once, and leave it open. See docs/browser.md "Using a browser the person opened".`,
          },
        });
      }
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const pages = context.pages();
      const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? (await context.newPage());
      const created: Session = { context, page, headless: false, history: [page], answered: [], secrets: new Set(), secretFields: [], attached: browser };
      for (const p of pages) this.watchTab(created, p);
      context.on("page", (p) => this.watchTab(created, p));
      session = created;
      this.sessions.set(key, session);
    }
    if (params.title !== undefined || params.url !== undefined) {
      return await this.switchTab({ ...params, index: undefined });
    }
    return { url: session.page.url(), title: await session.page.title() };
  }

  private target(params: Params): { page: Page; locator: Locator } {
    const { page } = this.session(params);
    return { page, locator: locate(page, params.target as Target | undefined) };
  }

  private async click(params: Params): Promise<string | null> {
    const session = this.session(params);
    const { page, locator } = this.target(params);
    return await this.withDialog(session, params, () =>
      locator.click({ timeout: this.limit(params) }).catch((error: unknown) => {
        // A "閉じる" button of a popup closes its own tab while the click is
        // still being confirmed: the click did its work.
        if (page.isClosed()) return;
        throw error;
      }),
    );
  }

  /**
   * Clicks `target` and saves the file the page downloads: to `path`, or
   * into `folder` under the name the site gives it.
   */
  private async download(params: Params): Promise<{ path: string; fileName: string }> {
    const path = typeof params.path === "string" && params.path ? params.path : undefined;
    const folder = typeof params.folder === "string" && params.folder ? params.folder : undefined;
    if (!path === !folder) throw new AdapterError("INVALID_PARAMS", "give either `path` (the file to save) or `folder` (keep the site's file name)");
    const { page, locator } = this.target(params);
    const timeout = this.limit(params);
    // One deadline for the click, the transfer and the save, so a slow
    // download never writes the file after the Runtime gave up on the step.
    const deadline = Date.now() + timeout;
    const started = page.waitForEvent("download", { timeout });
    started.catch(() => {});
    await locator.click({ timeout });
    let download;
    try {
      download = await started;
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new AdapterError("DOWNLOAD_NOT_STARTED", "the click started no download", {
          details: {
            target: params.target,
            hint: "Check that `target` is the link or button that downloads the file. If it opens the file in a new tab (a PDF viewer), use browser.switchTab and browser.getAttribute href with http.request instead. A page that asks first (a JS confirm) needs browser.click with dialog before this.",
          },
        });
      }
      throw error;
    }
    const fileName = download.suggestedFilename();
    const target = path ?? join(folder!, basename(fileName) || "download");
    mkdirSync(dirname(target), { recursive: true });
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), Math.max(deadline - Date.now(), 1));
    });
    let failed: string | null | "expired";
    try {
      failed = await Promise.race([download.failure(), expired]);
    } finally {
      clearTimeout(timer);
    }
    if (failed === "expired") {
      await download.cancel().catch(() => {});
      throw new AdapterError("DOWNLOAD_FAILED", `the download did not finish within ${Math.round(timeout / 1000)} s`, {
        retryable: true,
        details: { fileName, hint: "Raise the step's timeoutMs for large files." },
      });
    }
    if (failed) {
      throw new AdapterError("DOWNLOAD_FAILED", `the download failed: ${failed}`, { retryable: true, details: { fileName } });
    }
    await download.saveAs(target);
    return { path: target, fileName };
  }

  /**
   * Gives the file input `target` the files `path` (one or a list). A button
   * that opens the file picker works too: the picker is answered without
   * showing it.
   */
  private async upload(params: Params): Promise<null> {
    const files = (Array.isArray(params.path) ? params.path : [params.path]).filter((f): f is string => typeof f === "string" && f !== "");
    if (files.length === 0) throw new AdapterError("INVALID_PARAMS", "path is required: the file to upload, or a list of files");
    for (const file of files) {
      if (!existsSync(file) || !statSync(file).isFile()) {
        throw new AdapterError("FILE_NOT_FOUND", `no file at ${file}`, {
          details: { path: file, hint: "Write the path relative to the flow folder (e.g. output/請求書.pdf) and check that an earlier step made the file." },
        });
      }
    }
    const { page, locator } = this.target(params);
    const timeout = this.limit(params);
    await locator.first().waitFor({ state: "attached", timeout });
    const isFileInput = await locator.evaluate((el) => el instanceof HTMLInputElement && el.type === "file", undefined, { timeout });
    if (isFileInput) {
      await locator.setInputFiles(files, { timeout });
      return null;
    }
    const chooser = page.waitForEvent("filechooser", { timeout });
    chooser.catch(() => {});
    await locator.click({ timeout });
    try {
      await (await chooser).setFiles(files, { timeout });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new AdapterError("FILE_CHOOSER_NOT_SHOWN", "clicking the target opened no file picker", {
          details: { target: params.target, hint: "Target the file input itself (inspect_page shows it as a button such as \"ファイルを選択\"), or the button that opens the picker." },
        });
      }
      throw error;
    }
    return null;
  }

  private async hover(params: Params): Promise<null> {
    await this.target(params).locator.hover({ timeout: this.limit(params) });
    return null;
  }

  /**
   * `target` alone: brings it into view. `to` alone: the page to its top or
   * bottom. Both: scrolls inside `target` (a list that scrolls by itself).
   */
  private async scroll(params: Params): Promise<null> {
    const to = params.to as "top" | "bottom" | undefined;
    if (to !== undefined && to !== "top" && to !== "bottom") throw new AdapterError("INVALID_PARAMS", 'to must be "top" or "bottom"');
    if (!params.target && !to) throw new AdapterError("INVALID_PARAMS", "give `target` (to bring it into view) or `to` (top / bottom)");
    const timeout = this.limit(params);
    if (!params.target) {
      await this.session(params).page.evaluate((bottom) => {
        const el = document.scrollingElement ?? document.documentElement;
        window.scrollTo(0, bottom ? el.scrollHeight : 0);
      }, to === "bottom");
      return null;
    }
    const { locator } = this.target(params);
    if (!to) {
      await locator.scrollIntoViewIfNeeded({ timeout });
      return null;
    }
    await locator.evaluate(
      (el, bottom) => {
        el.scrollTop = bottom ? el.scrollHeight : 0;
        el.dispatchEvent(new Event("scroll"));
      },
      to === "bottom",
      { timeout },
    );
    return null;
  }

  /** An attribute of `target` (`href` / `src` as full addresses); null when it has none. */
  private async getAttribute(params: Params): Promise<unknown> {
    const name = String(params.name ?? "");
    if (!name) throw new AdapterError("INVALID_PARAMS", "name is required, e.g. \"href\"");
    const session = this.session(params);
    const { locator } = this.target(params);
    const mask = (v: string | null) => (v === null ? null : this.mask(session, v));
    // Runs in the page (no closures): href / src / action as full addresses.
    const read = (el: Element, attr: string): string | null => {
      if (!el.hasAttribute(attr)) return null;
      const property = (el as unknown as Record<string, unknown>)[attr];
      return (attr === "href" || attr === "src" || attr === "action") && typeof property === "string" ? property : el.getAttribute(attr);
    };
    if (params.all === true) {
      await locator.first().waitFor({ state: "attached", timeout: this.limit(params) });
      const values: (string | null)[] = [];
      for (const el of await locator.all()) values.push(await el.evaluate(read, name));
      return values.map(mask);
    }
    return mask(await locator.evaluate(read, name, { timeout: this.limit(params) }));
  }

  /**
   * Makes another tab of the context current: the newest one whose title or
   * address contains `title` / `url`, or the `index`-th in opening order.
   * Waits for it to open (a popup a click just asked for).
   */
  private async switchTab(params: Params): Promise<unknown> {
    const session = this.session(params);
    const title = typeof params.title === "string" ? params.title : undefined;
    const url = typeof params.url === "string" ? params.url : undefined;
    const index = typeof params.index === "number" ? params.index : undefined;
    if (title === undefined && url === undefined && index === undefined) {
      throw new AdapterError("INVALID_PARAMS", "give `title`, `url` or `index` of the tab");
    }
    const deadline = Date.now() + this.limit(params);
    for (;;) {
      const pages = session.context.pages().filter((p) => !p.isClosed());
      let found: Page | undefined;
      if (index !== undefined) {
        found = pages[index];
      } else {
        for (const page of [...pages].reverse()) {
          const pageTitle = await page.title().catch(() => "");
          if ((title === undefined || pageTitle.includes(title)) && (url === undefined || page.url().includes(url))) {
            found = page;
            break;
          }
        }
      }
      if (found) {
        await found.waitForLoadState("load", { timeout: Math.max(deadline - Date.now(), 1) }).catch(() => {});
        this.makeCurrent(session, found);
        await found.bringToFront().catch(() => {});
        return { url: found.url(), title: await found.title(), index: pages.indexOf(found) };
      }
      if (Date.now() >= deadline) {
        throw new AdapterError("TAB_NOT_FOUND", `no tab matches ${JSON.stringify({ title, url, index })}`, {
          retryable: true,
          details: { tabs: await this.tabs(session), hint: "Pick the tab by `title` or `url` from `tabs` (part of it is enough), or by `index`." },
        });
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Closes the current tab and goes back to the one before it. */
  private async closeTab(params: Params): Promise<unknown> {
    const session = this.session(params);
    const open = session.context.pages().filter((p) => !p.isClosed());
    if (open.length <= 1) {
      throw new AdapterError("LAST_TAB", "this is the only tab of the context", {
        details: { hint: "Use browser.close to close the browser (or leave it: the run closes it at the end)." },
      });
    }
    await session.page.close();
    this.backToOpenTab(session);
    await session.page.bringToFront().catch(() => {});
    return { url: session.page.url(), title: await session.page.title() };
  }

  private async tabs(session: Session): Promise<{ index: number; title: string; url: string; current: boolean }[]> {
    const pages = session.context.pages().filter((p) => !p.isClosed());
    return Promise.all(
      pages.map(async (p, index) => ({ index, title: await p.title().catch(() => ""), url: p.url(), current: p === session.page })),
    );
  }

  /** The frames of the current tab (for finding elements inside them). */
  private async frames(session: Session): Promise<{ name: string; src: string; title?: string }[]> {
    const page = session.page;
    return page
      .locator("iframe, frame")
      .evaluateAll((els) =>
        els.map((el) => ({
          name: el.getAttribute("name") ?? el.id ?? "",
          src: el.getAttribute("src") ?? "",
          title: el.getAttribute("title") ?? undefined,
        })),
      )
      .catch(() => []);
  }

  private async fill(params: Params): Promise<null> {
    const session = this.session(params);
    const { locator } = this.target(params);
    const value = String(params.value ?? "");
    const secret = params.secret as SecretInfo | undefined;
    if (!secret) {
      await locator.fill(value, { timeout: this.limit(params) });
      return null;
    }
    // Never type a secret into a page it was not registered for (a
    // look-alike site, or a page an injected instruction led to). The check
    // and the typing use one element handle, so they are bound to the same
    // document: if the page navigates in between, the handle is detached and
    // fill fails instead of typing into the new page. The origin is the
    // element's own document, so a cross-origin iframe is checked too.
    const timeout = this.limit(params);
    const handle = await locator.elementHandle({ timeout });
    try {
      const origin = await handle.evaluate((el) => el.ownerDocument.location.origin);
      if (!secret.sites.includes(origin)) {
        throw new AdapterError("SECRET_SITE_MISMATCH", `secret '${secret.name}' may not be typed on ${origin}`, {
          details: {
            secret: secret.name,
            page: origin,
            sites: secret.sites,
            hint: "This page is not one of the secret's registered sites. Check that the URL is right; if it is, call request_secret with this name and the page's address so Studio asks the user to add it.",
          },
        });
      }
      if (secret.sensitive && value) {
        session.secrets.add(value);
        session.secretFields.push(locator);
      }
      await handle.fill(value, { timeout });
    } finally {
      await handle.dispose().catch(() => {});
    }
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

  private async press(params: Params): Promise<string | null> {
    const key = String(params.key ?? "");
    const session = this.session(params);
    if (params.target) {
      const { locator } = this.target(params);
      return await this.withDialog(session, params, () => locator.press(key, { timeout: this.limit(params) }));
    }
    return await this.withDialog(session, params, () => session.page.keyboard.press(key));
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

  /**
   * Lets the person at the PC point at an element: a banner shows `message`,
   * `candidates` are outlined with numbers, and the next click is caught
   * before the page sees it. Returns the element as a Target (with `nth`
   * when it repeats), or `{ status: "cancelled" }`.
   */
  private async pick(params: Params): Promise<unknown> {
    const session = await this.sessionOrOpen(params);
    if (session.headless && !this.options.scriptedHuman) {
      throw new AdapterError("HUMAN_REQUIRED", "pointing needs a person, but the browser runs without a window", {
        details: {
          hint: "Open the page with a visible browser (SHIKIGAMI_BROWSER_HEADLESS unset), or ask the user in chat to describe the element.",
        },
      });
    }
    const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 300_000;
    const candidates = Array.isArray(params.candidates) ? (params.candidates as Target[]) : [];
    const result = await pick(session.page, {
      message: typeof params.message === "string" ? params.message : undefined,
      candidates,
      lang: typeof params.lang === "string" ? params.lang : undefined,
      timeoutMs,
    });
    if (result.status === "picked") {
      // Review evidence: the page with the picked element still outlined.
      if (typeof params.screenshotPath === "string" && params.screenshotPath) {
        await highlight(session.page, [result.target], { durationMs: 1500, numbered: false });
        await this.capture(session, params.screenshotPath);
      }
    }
    return result;
  }

  /** Outlines `target` (or each of `targets`) for `durationMs`; waits `waitMs` so the person sees it. */
  private async highlight(params: Params): Promise<unknown> {
    const session = await this.sessionOrOpen(params);
    const targets = Array.isArray(params.targets)
      ? (params.targets as Target[])
      : params.target
        ? [params.target as Target]
        : [];
    if (session.headless) return { shown: 0 };
    const durationMs = typeof params.durationMs === "number" ? params.durationMs : 1500;
    const shown = await highlight(session.page, targets, {
      durationMs,
      label: typeof params.label === "string" ? params.label : undefined,
    });
    const waitMs = typeof params.waitMs === "number" ? Math.min(params.waitMs, durationMs) : 0;
    if (shown > 0 && waitMs > 0) await new Promise((ok) => setTimeout(ok, waitMs));
    return { shown };
  }

  /** The visible part of the page as JPEG, secrets blacked out; best effort. */
  private async capture(session: Session, path: string): Promise<void> {
    await session.page
      .screenshot({
        path,
        type: "jpeg",
        quality: 70,
        mask: [session.page.locator(PASSWORD_FIELDS), ...session.secretFields],
        maskColor: "#000",
        timeout: 10_000,
      })
      .catch(() => {});
  }

  /**
   * OAuth sign-in: opens the authorization page `url` and waits while the
   * person signs in and allows access. The provider then sends the browser
   * to `redirectUrl`; that request is caught inside the browser (Chromium's
   * Fetch domain, which also sees requests a redirect leads to, unlike
   * Playwright's routes) and answered with a local page, so the site behind
   * `redirectUrl` never loads or sees the code. Returns the caught URL.
   */
  private async authorize(params: Params): Promise<{ url: string }> {
    const url = String(params.url ?? "");
    let target: URL;
    try {
      target = new URL(String(params.redirectUrl ?? ""));
    } catch {
      throw new AdapterError("INVALID_PARAMS", "redirectUrl must be a URL");
    }
    const session = await this.ensureSession(params);
    if (session.headless && !this.options.scriptedHuman) {
      throw new AdapterError("HUMAN_REQUIRED", "signing in needs a person, but the browser runs without a window", {
        details: {
          hint: "Run once with a visible browser (SHIKIGAMI_BROWSER_HEADLESS unset) so the person can sign in. The tokens are kept, so later unattended runs need nobody.",
        },
      });
    }
    const matches = (candidate: string): boolean => {
      try {
        const u = new URL(candidate);
        return u.origin === target.origin && u.pathname === target.pathname;
      } catch {
        return false;
      }
    };
    let resolve!: (url: string) => void;
    const caught = new Promise<string>((r) => (resolve = r));
    const watched: CDPSession[] = [];
    const watch = async (page: Page): Promise<void> => {
      const cdp = await session.context.newCDPSession(page);
      watched.push(cdp);
      cdp.on("Fetch.requestPaused", (event: { requestId: string; request: { url: string } }) => {
        const answer = matches(event.request.url)
          ? cdp.send("Fetch.fulfillRequest", {
              requestId: event.requestId,
              responseCode: 200,
              responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
              body: Buffer.from(SIGNED_IN_PAGE).toString("base64"),
            })
          : cdp.send("Fetch.continueRequest", { requestId: event.requestId });
        if (matches(event.request.url)) resolve(event.request.url);
        answer.catch(() => {});
      });
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `${target.origin}/*`, requestStage: "Request" }] });
    };
    const onPage = (page: Page): void => {
      watch(page).catch(() => {});
    };
    session.context.on("page", onPage);
    const timeout = this.limit(params);
    let timer: NodeJS.Timeout | undefined;
    try {
      for (const page of session.context.pages()) await watch(page);
      await session.page.bringToFront().catch(() => {});
      // The provider may send the browser straight back (already allowed),
      // so the navigation and the catch race.
      const navigation: Promise<unknown> = session.page.goto(url, { waitUntil: "commit", timeout }).catch((error: Error) => {
        throw new AdapterError("NAVIGATION_FAILED", `could not open the sign-in page: ${error.message.split("\n")[0]}`, {
          retryable: true,
          details: { url: originOf(url) },
        });
      });
      navigation.catch(() => {});
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AdapterError("HUMAN_TIMEOUT", `nobody finished signing in within ${Math.round(timeout / 1000)} s`, {
                details: {
                  hint: "Raise the step's timeoutMs. If the person did finish, check that redirectUrl is exactly the redirect URI registered at the provider.",
                },
              }),
            ),
          timeout,
        );
      });
      await Promise.race([navigation, caught, expired]);
      return { url: await Promise.race([caught, expired]) };
    } finally {
      clearTimeout(timer);
      session.context.off("page", onPage);
      for (const cdp of watched) await cdp.detach().catch(() => {});
    }
  }

  /** Accessibility snapshot for AI clients choosing targets. */
  private async snapshot(params: Params): Promise<unknown> {
    if (params.url) await this.open(params);
    const session = this.session(params);
    const { page } = session;
    const root = params.target ? locate(page, params.target as Target) : page.locator("body");
    const snapshot = await this.redact(session, await root.ariaSnapshot());
    const result: Record<string, unknown> = { url: page.url(), title: await page.title(), snapshot };
    const frames = params.target ? [] : await this.frames(session);
    if (frames.length > 0) {
      result.frames = frames;
      result.framesHint =
        "The page has frames; their contents are not in `snapshot`. To see one, call again with target { css: \"body\", frame: { name: \"<name>\" } } (or title / src); steps reach elements inside it with the same `frame` in their target.";
    }
    const tabs = await this.tabs(session);
    if (tabs.length > 1) result.tabs = tabs;
    // Review evidence: the visible part of the page, secrets blacked out as in browser.screenshot.
    // Best effort: a page that cannot be captured still gets its tree.
    if (typeof params.screenshotPath === "string" && params.screenshotPath) {
      await this.capture(session, params.screenshotPath);
    }
    if (await page.locator(PASSWORD_FIELDS).first().isVisible().catch(() => false)) {
      result.login = {
        site: originOf(page.url()),
        hint: "This page asks for a login. Never ask the user for the password in chat: use a registered secret (list_secrets; browser.fill value { \"secret\": \"<name>\", \"field\": \"password\" }). If none fits, call request_secret with a name and this site so Studio asks the user to register one, or let the user log in by hand with browser.waitForHuman.",
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
    if (session.attached) {
      // The person's browser stays as it is: only the connection goes.
      session.context.removeAllListeners("page");
      for (const page of session.context.pages()) page.removeAllListeners("dialog");
      await session.attached.close().catch(() => {});
      return [];
    }
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
          hint: "Make the target more specific (role + exact name). If you cannot tell which one is meant, ask the user to point at it (MCP ask_user_to_pick) instead of guessing an `nth` (0-based).",
        },
      });
    }
    if (error instanceof Error && error.name === "TimeoutError") {
      const details: Record<string, unknown> = {
        target,
        url: this.currentUrl(params),
        page: await this.pageSnapshot(params),
        hint: "Pick the target from `page` (role and name as listed), or wait for the page with browser.waitFor.",
      };
      const session = this.sessions.get(this.key(params));
      if (session && !session.page.isClosed()) {
        const hints = [String(details.hint)];
        const frames = await this.frames(session);
        if (frames.length > 0 && !target?.frame) {
          details.frames = frames;
          hints.push("The page has frames: an element inside one needs `frame` in its target, e.g. { ..., \"frame\": { \"name\": \"main\" } }.");
        }
        const tabs = await this.tabs(session);
        if (tabs.length > 1) {
          details.tabs = tabs;
          hints.push("Several tabs are open: steps work on the current one; use browser.switchTab to move to another (e.g. a popup).");
        }
        if (session.unanswered) {
          details.dismissedDialog = session.unanswered;
          hints.push("A JS dialog was dismissed because no step answered it: add `dialog: \"accept\"` to the step that causes it.");
        }
        details.hint = hints.join(" ");
      }
      return new AdapterError("ELEMENT_NOT_FOUND", `no element matches ${describe(target)}`, { retryable: true, details });
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
