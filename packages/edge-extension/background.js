// SpellSheet extension: lets a SpellSheet run drive tabs of this Edge, with
// the person's own sign-ins (SSO, certificates, extensions).
//
// The browser adapter starts a relay on 127.0.0.1 and opens connect.html with
// its address. The relay speaks the Chrome DevTools Protocol to Playwright on
// one side and this small protocol to the extension on the other:
//   relay → extension  { id, method, params }  (chrome.debugger.* / chrome.tabs.*)
//   extension → relay  { id, result } | { id, error }  and events { method, params }
// Modeled on the Playwright MCP extension (Apache-2.0, Microsoft).
//
// Only tabs of the run are reached: tabs it creates, tabs opened from them,
// and the one tab the flow names by title / address. The person approves
// SpellSheet once; the approval is kept as the token SpellSheet sent.

const RELAY = /^ws:\/\/127\.0\.0\.1:\d{1,5}\/extension\/[0-9a-f-]{36}$/;
const KEEPALIVE_MS = 20000;

/** The connection to the running SpellSheet, one at a time. */
let session = null;

class Session {
  constructor(ws) {
    this.ws = ws;
    /** Tab ids the run may drive. */
    this.tabs = new Set();
    /** Tab ids the debugger is attached to. */
    this.attached = new Set();
    this.keepalive = setInterval(() => this.emit("keepalive", []), KEEPALIVE_MS);
    ws.onmessage = (event) => void this.onMessage(event.data);
    ws.onclose = () => this.end();
  }

  emit(method, params) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ method, params }));
  }

  share(tab) {
    if (tab.id === undefined || this.tabs.has(tab.id)) return;
    this.tabs.add(tab.id);
    this.emit("chrome.tabs.onCreated", [tab]);
  }

  async onMessage(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      this.ws.close(1003, "malformed message");
      return;
    }
    const { id, method, params = [] } = message;
    try {
      const result = await this.handle(method, params);
      this.ws.send(JSON.stringify({ id, result }));
    } catch (error) {
      this.ws.send(JSON.stringify({ id, error: String(error?.message ?? error) }));
    }
  }

  ownTab(target) {
    const tabId = target?.tabId;
    if (!this.tabs.has(tabId)) throw new Error(`tab ${tabId} is not one of this run's tabs`);
    return tabId;
  }

  async handle(method, params) {
    switch (method) {
      case "chrome.debugger.attach": {
        const tabId = this.ownTab(params[0]);
        if (!this.attached.has(tabId)) {
          await chrome.debugger.attach({ tabId }, params[1] ?? "1.3");
          this.attached.add(tabId);
        }
        return {};
      }
      case "chrome.debugger.sendCommand": {
        const target = params[0];
        this.ownTab(target);
        return await chrome.debugger.sendCommand(target, params[1], params[2]);
      }
      case "chrome.tabs.create": {
        const tab = await chrome.tabs.create({ url: params[0]?.url || "about:blank", active: true });
        this.tabs.add(tab.id);
        return tab;
      }
      case "chrome.tabs.remove": {
        const tabId = this.ownTab({ tabId: params[0] });
        await chrome.tabs.remove(tabId);
        return {};
      }
      default:
        throw new Error(`unknown method ${method}`);
    }
  }

  /** Lets go of every tab; the tabs themselves stay open for the person. */
  end() {
    clearInterval(this.keepalive);
    for (const tabId of this.attached) chrome.debugger.detach({ tabId }).catch(() => {});
    this.attached.clear();
    this.tabs.clear();
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, "ended");
    if (session === this) session = null;
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (session?.tabs.has(source.tabId)) session.emit("chrome.debugger.onEvent", [source, method, params]);
});

chrome.debugger.onDetach.addListener((source) => {
  if (!session?.attached.has(source.tabId)) return;
  // Also when the person closes the yellow bar: the run cannot go on in that tab.
  session.attached.delete(source.tabId);
  session.emit("chrome.debugger.onDetach", [source]);
});

chrome.tabs.onCreated.addListener((tab) => {
  // A popup or a link opened in a new tab from one of the run's tabs.
  if (session && tab.openerTabId !== undefined && session.tabs.has(tab.openerTabId)) session.share(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!session?.tabs.has(tabId)) return;
  session.tabs.delete(tabId);
  session.attached.delete(tabId);
  session.emit("chrome.tabs.onRemoved", [tabId]);
});

/** The tab the flow names by part of its title or address, if it is open. */
async function namedTab(title, url) {
  if (!title && !url) return undefined;
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => (!title || (t.title ?? "").includes(title)) && (!url || (t.url ?? "").includes(url)));
}

async function start(request) {
  const ws = new WebSocket(request.relay);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("SpellSheet is no longer waiting"));
  });
  session?.end();
  session = new Session(ws);
  const tab = await namedTab(request.title, request.url);
  if (tab) session.share(tab);
  session.emit("extension.initialized", [{ version: chrome.runtime.getManifest().version }]);
}

async function approved(token) {
  const { tokens = [] } = await chrome.storage.local.get("tokens");
  return tokens.includes(token);
}

chrome.runtime.onMessage.addListener((request, sender, reply) => {
  // Only connect.html of this extension talks to the worker.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("connect.html"))) return false;
  void (async () => {
    try {
      if (typeof request.relay !== "string" || !RELAY.test(request.relay)) throw new Error("not a SpellSheet address");
      if (typeof request.token !== "string" || request.token.length < 32) throw new Error("no token");
      if (request.type === "approve") {
        const { tokens = [] } = await chrome.storage.local.get("tokens");
        if (!tokens.includes(request.token)) await chrome.storage.local.set({ tokens: [...tokens, request.token].slice(-5) });
      } else if (!(await approved(request.token))) {
        reply({ needApproval: true });
        return;
      }
      await start(request);
      reply({ ok: true });
    } catch (error) {
      reply({ error: String(error?.message ?? error) });
    }
  })();
  return true;
});
