// The everyday Edge, reached through the SpellSheet extension.
//
// Edge ignores the debugging port on the person's everyday profile, so the
// SpellSheet extension (packages/edge-extension) drives tabs with
// chrome.debugger instead. This relay listens on 127.0.0.1: the extension
// connects to one path, Playwright (connectOverCDP) to another, and the relay
// turns Playwright's browser-level commands into tabs and debugger sessions.
// Modeled on the relay of the Playwright MCP extension (Apache-2.0, Microsoft).

import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { dirname } from "node:path";

/** The parts of the `ws` package (bundled in playwright-core) used here. */
interface WsSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
}
interface WsServer {
  handleUpgrade(req: unknown, socket: unknown, head: unknown, done: (conn: WsSocket) => void): void;
}

const require = createRequire(import.meta.url);
const { ws, wsServer } = require("playwright-core/lib/utilsBundle") as { ws: { OPEN: number }; wsServer: new (options: { noServer: boolean }) => WsServer };

/** The extension's ID (fixed by the key in its manifest). Edge Add-ons gives the store copy its own ID: add it here. */
export const EXTENSION_IDS = ["gpjoohbkfaajeljllopcaolljioanfhb"];

interface Tab {
  id?: number;
  openerTabId?: number;
}

interface TabSession {
  tabId: number;
  sessionId: string;
  targetInfo?: { targetId?: string } & Record<string, unknown>;
  /** Sessions of iframes and workers inside the tab (flattened CDP). */
  children: Set<string>;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** The token SpellSheet sends with each connection: the person approves it once in the extension. */
export function extensionToken(file: string): string {
  try {
    const token = readFileSync(file, "utf8").trim();
    if (token.length >= 32) return token;
  } catch {
    // made below
  }
  const token = randomBytes(24).toString("hex");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

export class ExtensionRelay {
  private readonly server: Server;
  private readonly wss: WsServer;
  private readonly id = randomUUID();
  private port = 0;
  private extension?: WsSocket;
  private playwright?: WsSocket;
  private lastId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly known = new Map<number, Tab>();
  private readonly tabs = new Map<number, TabSession>();
  private autoAttach = false;
  private nextSession = 1;
  private initialized?: () => void;
  private readonly ready: Promise<void>;
  private failed?: (error: Error) => void;
  /** Called when the extension goes away (the person closed Edge, or the yellow bar). */
  onClose?: () => void;

  constructor() {
    this.ready = new Promise((resolve, reject) => {
      this.initialized = resolve;
      this.failed = reject;
    });
    this.ready.catch(() => {});
    this.wss = new wsServer({ noServer: true });
    this.server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    this.server.on("upgrade", (req, socket, head) => {
      const path = req.url ?? "";
      const which = path === `/extension/${this.id}` ? "extension" : path === `/cdp/${this.id}` ? "cdp" : undefined;
      // Only this PC, and only the two paths of this run.
      if (!which || req.socket.remoteAddress !== "127.0.0.1") {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (conn) => (which === "extension" ? this.onExtension(conn) : this.onPlaywright(conn)));
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  get extensionUrl(): string {
    return `ws://127.0.0.1:${this.port}/extension/${this.id}`;
  }

  get cdpUrl(): string {
    return `ws://127.0.0.1:${this.port}/cdp/${this.id}`;
  }

  /** Resolves when the extension has connected and shared its tabs; rejects after `timeout` ms. */
  async waitForExtension(timeout: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeout)));
    try {
      return await Promise.race([this.ready.then(() => true), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  stop(): void {
    this.extension?.close(1000, "SpellSheet let go");
    this.playwright?.close(1000, "SpellSheet let go");
    this.server.close();
  }

  // --- extension side ------------------------------------------------------

  private onExtension(conn: WsSocket): void {
    if (this.extension) {
      conn.close(1000, "already connected");
      return;
    }
    this.extension = conn;
    conn.on("message", (data: unknown) => this.fromExtension(String(data)));
    conn.on("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("the SpellSheet extension disconnected"));
      this.pending.clear();
      this.failed?.(new Error("the SpellSheet extension disconnected"));
      this.playwright?.close(1000, "extension disconnected");
      this.onClose?.();
    });
  }

  private fromExtension(data: string): void {
    let message: { id?: number; result?: unknown; error?: string; method?: string; params?: unknown[] };
    try {
      message = JSON.parse(data);
    } catch {
      this.extension?.close(1003, "malformed message");
      return;
    }
    if (message.id !== undefined) {
      const p = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error !== undefined) p?.reject(new Error(message.error));
      else p?.resolve(message.result);
      return;
    }
    const params = message.params ?? [];
    switch (message.method) {
      case "extension.initialized":
        this.initialized?.();
        break;
      case "chrome.tabs.onCreated": {
        const tab = params[0] as Tab;
        if (tab?.id === undefined) break;
        this.known.set(tab.id, tab);
        if (this.autoAttach) void this.attachTab(tab.id).catch(() => {});
        break;
      }
      case "chrome.tabs.onRemoved":
        this.known.delete(params[0] as number);
        this.detachTab(params[0] as number);
        break;
      case "chrome.debugger.onDetach":
        this.detachTab((params[0] as { tabId: number }).tabId);
        break;
      case "chrome.debugger.onEvent": {
        const [source, method, eventParams] = params as [{ tabId: number; sessionId?: string }, string, { sessionId?: string } | undefined];
        const tab = this.tabs.get(source.tabId);
        if (!tab) break;
        const child = eventParams?.sessionId;
        if (method === "Target.attachedToTarget" && child) tab.children.add(child);
        else if (method === "Target.detachedFromTarget" && child) tab.children.delete(child);
        this.toPlaywright({ sessionId: source.sessionId || tab.sessionId, method, params: eventParams });
        break;
      }
    }
  }

  private send(method: string, params: unknown[]): Promise<unknown> {
    const conn = this.extension;
    if (!conn || conn.readyState !== ws.OPEN) return Promise.reject(new Error("the SpellSheet extension is not connected"));
    const id = ++this.lastId;
    conn.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  // --- Playwright side -----------------------------------------------------

  private onPlaywright(conn: WsSocket): void {
    if (!this.extension || this.playwright) {
      conn.close(1000, "not available");
      return;
    }
    this.playwright = conn;
    conn.on("message", (data: unknown) => void this.fromPlaywright(String(data)));
    conn.on("close", () => this.extension?.close(1000, "SpellSheet let go"));
  }

  private toPlaywright(message: Record<string, unknown>): void {
    if (this.playwright?.readyState === ws.OPEN) this.playwright.send(JSON.stringify(message));
  }

  private async fromPlaywright(data: string): Promise<void> {
    const { id, sessionId, method, params } = JSON.parse(data) as { id: number; sessionId?: string; method: string; params?: Record<string, unknown> };
    try {
      const result = await this.command(method, params ?? {}, sessionId);
      this.toPlaywright({ id, sessionId, result });
    } catch (error) {
      this.toPlaywright({ id, sessionId, error: { message: (error as Error).message } });
    }
  }

  private async command(method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    if (!sessionId) {
      switch (method) {
        case "Browser.getVersion":
          return { protocolVersion: "1.3", product: "Edge/SpellSheet-Extension", userAgent: "SpellSheet", jsVersion: "" };
        case "Browser.setDownloadBehavior":
          return {};
        case "Target.setAutoAttach":
          this.autoAttach = true;
          await Promise.all([...this.known.keys()].map((tabId) => this.attachTab(tabId).catch(() => {})));
          return {};
        case "Target.createTarget": {
          const tab = (await this.send("chrome.tabs.create", [{ url: params.url }])) as Tab;
          if (tab?.id === undefined) throw new Error("could not open a tab");
          this.known.set(tab.id, tab);
          const session = await this.attachTab(tab.id);
          return { targetId: session.targetInfo?.targetId };
        }
        case "Target.closeTarget": {
          const session = [...this.tabs.values()].find((s) => s.targetInfo?.targetId === params.targetId);
          if (!session) return { success: false };
          await this.send("chrome.tabs.remove", [session.tabId]);
          return { success: true };
        }
      }
      // Browser-level commands go through any tab of the run; with none yet there is nothing to change.
      const any = this.tabs.values().next().value as TabSession | undefined;
      if (!any) return {};
      return await this.send("chrome.debugger.sendCommand", [{ tabId: any.tabId }, method, params]);
    }
    if (method === "Target.getTargetInfo") {
      return { targetInfo: [...this.tabs.values()].find((s) => s.sessionId === sessionId)?.targetInfo };
    }
    const own = [...this.tabs.values()].find((s) => s.sessionId === sessionId);
    if (own) return await this.send("chrome.debugger.sendCommand", [{ tabId: own.tabId }, method, params]);
    const parent = [...this.tabs.values()].find((s) => s.children.has(sessionId));
    if (!parent) throw new Error(`no tab for session ${sessionId}`);
    return await this.send("chrome.debugger.sendCommand", [{ tabId: parent.tabId, sessionId }, method, params]);
  }

  private async attachTab(tabId: number): Promise<TabSession> {
    const existing = this.tabs.get(tabId);
    if (existing) return existing;
    await this.send("chrome.debugger.attach", [{ tabId }, "1.3"]);
    const info = (await this.send("chrome.debugger.sendCommand", [{ tabId }, "Target.getTargetInfo", {}])) as { targetInfo?: TabSession["targetInfo"] };
    const session: TabSession = { tabId, sessionId: `spellsheet-tab-${this.nextSession++}`, targetInfo: info?.targetInfo, children: new Set() };
    this.tabs.set(tabId, session);
    this.toPlaywright({ method: "Target.attachedToTarget", params: { sessionId: session.sessionId, targetInfo: { ...session.targetInfo, attached: true }, waitingForDebugger: false } });
    return session;
  }

  private detachTab(tabId: number): void {
    const session = this.tabs.get(tabId);
    if (!session) return;
    this.tabs.delete(tabId);
    this.toPlaywright({ method: "Target.detachedFromTarget", params: { sessionId: session.sessionId, targetId: session.targetInfo?.targetId } });
  }
}

