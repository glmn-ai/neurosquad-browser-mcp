// Background service worker: keeps a WebSocket connection open to the local
// WebMCP MCP server (spawned by opencode) and executes browser actions on
// its behalf using chrome.tabs / chrome.scripting.

const DEFAULT_PORT = 8765;

let ws = null;
let port = DEFAULT_PORT;
let reconnectTimer = null;

// Requests this extension sends TO the server (as opposed to `handlers`
// below, which answer requests the server sends to the extension). Used for
// local management actions like listing/installing MCP clients from the
// popup UI.
const pendingClientRequests = new Map();
const CLIENT_REQUEST_TIMEOUT_MS = 10_000;

function sendClientRequest(method, params = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Not connected to the WebMCP server."));
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingClientRequests.delete(id);
      reject(new Error(`Timed out waiting for server response to "${method}"`));
    }, CLIENT_REQUEST_TIMEOUT_MS);
    pendingClientRequests.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ type: "client-request", id, method, params }));
  });
}

async function loadPort() {
  const { webmcpPort } = await chrome.storage.local.get("webmcpPort");
  port = webmcpPort || DEFAULT_PORT;
  return port;
}

function scheduleReconnect(delayMs = 3000) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delayMs);
}

async function connect() {
  await loadPort();
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try {
    ws = new WebSocket(`ws://localhost:${port}`);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    console.log(`[webmcp] connected to server on port ${port}`);
  });

  ws.addEventListener("message", (event) => {
    handleServerMessage(event.data);
  });

  ws.addEventListener("close", () => {
    ws = null;
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // The WebSocket spec doesn't expose error details on this event; the
    // "close" listener above fires right after and schedules a reconnect.
    // Logged so `chrome://extensions` -> service worker console shows
    // *something* instead of silence when the server isn't reachable yet.
    console.log(`[webmcp] connection attempt to ws://localhost:${port} failed, will retry`);
  });
}

async function handleServerMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === "client-response") {
    const pending = pendingClientRequests.get(msg.id);
    if (!pending) return;
    pendingClientRequests.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new Error(msg.error || "Unknown server error"));
    return;
  }

  if (msg.type !== "request") return;

  const { id, method, params } = msg;
  const handler = handlers[method];

  if (!handler) {
    sendResponse(id, false, undefined, `Unknown method: ${method}`);
    return;
  }

  try {
    const result = await handler(params || {});
    sendResponse(id, true, result);
  } catch (err) {
    sendResponse(id, false, undefined, err?.message || String(err));
  }
}

function sendResponse(id, ok, result, error) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "response", id, ok, result, error }));
}

function sendEvent(name, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "event", name, data }));
}

// ---------------------------------------------------------------------------
// Handlers: one per MCP tool. Params come straight from the MCP server.
// ---------------------------------------------------------------------------

const handlers = {
  async listTabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.map((t) => ({
      id: t.id,
      windowId: t.windowId,
      title: t.title,
      url: t.url,
      active: t.active,
    }));
  },

  async getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) throw new Error("No active tab found.");
    return { id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url };
  },

  async getPageInfo({ tabId }) {
    const tab = await chrome.tabs.get(tabId);
    return { id: tab.id, title: tab.title, url: tab.url };
  },

  async getPageContent({ tabId, format }) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (format) => ({
        url: location.href,
        title: document.title,
        content:
          format === "html"
            ? document.documentElement.outerHTML
            : document.body
              ? document.body.innerText
              : "",
      }),
      args: [format],
    });
    return result;
  },

  async querySelector({ tabId, selector, limit }) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (selector, limit) => {
        const els = Array.from(document.querySelectorAll(selector)).slice(0, limit);
        return els.map((el, index) => ({
          index,
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          classes: typeof el.className === "string" && el.className ? el.className : undefined,
          text: (el.innerText || el.textContent || "").trim().slice(0, 300),
          attributes: Object.fromEntries(Array.from(el.attributes).map((a) => [a.name, a.value])),
        }));
      },
      args: [selector, limit],
    });
    return result;
  },

  async click({ tabId, selector }) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (selector) => {
        const el = document.querySelector(selector);
        if (!el) return { clicked: false, reason: "No element matched the selector." };
        el.scrollIntoView({ block: "center", inline: "center" });
        el.click();
        return { clicked: true };
      },
      args: [selector],
    });
    return result;
  },

  async fill({ tabId, selector, value }) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (selector, value) => {
        const el = document.querySelector(selector);
        if (!el) return { filled: false, reason: "No element matched the selector." };

        if (el.isContentEditable) {
          el.textContent = value;
        } else {
          const proto = Object.getPrototypeOf(el);
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, value);
          else el.value = value;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { filled: true };
      },
      args: [selector, value],
    });
    return result;
  },

  async navigate({ tabId, url }) {
    await chrome.tabs.update(tabId, { url });
    return { navigated: true, url };
  },

  async executeScript({ tabId, code }) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (code) => {
        // eslint-disable-next-line no-new-func
        const fn = new Function(`return (async () => { ${code} })()`);
        return fn();
      },
      args: [code],
    });
    return result;
  },

  async screenshot({ tabId }) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    return { dataUrl };
  },
};

// ---------------------------------------------------------------------------
// Messages from content scripts (console log mirroring) and the popup UI.
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponseFn) => {
  if (message?.type === "console-log") {
    const tabId = sender.tab?.id;
    if (typeof tabId === "number") {
      sendEvent("console", { tabId, level: message.level, text: message.text, timestamp: Date.now() });
    }
    return false;
  }

  if (message?.type === "get-status") {
    sendResponseFn({ connected: !!ws && ws.readyState === WebSocket.OPEN, port });
    return true;
  }

  if (message?.type === "set-port") {
    chrome.storage.local.set({ webmcpPort: message.port }).then(() => {
      if (ws) ws.close();
      connect();
      sendResponseFn({ ok: true });
    });
    return true;
  }

  if (message?.type === "reconnect") {
    if (ws) ws.close();
    connect();
    sendResponseFn({ ok: true });
    return true;
  }

  if (message?.type === "list-clients") {
    sendClientRequest("listClients")
      .then((clients) => sendResponseFn({ ok: true, clients }))
      .catch((err) => sendResponseFn({ ok: false, error: err.message }));
    return true;
  }

  if (message?.type === "install-client") {
    sendClientRequest("installClient", { id: message.id })
      .then((result) => sendResponseFn({ ok: true, result }))
      .catch((err) => sendResponseFn({ ok: false, error: err.message }));
    return true;
  }

  if (message?.type === "uninstall-client") {
    sendClientRequest("uninstallClient", { id: message.id })
      .then((result) => sendResponseFn({ ok: true, result }))
      .catch((err) => sendResponseFn({ ok: false, error: err.message }));
    return true;
  }

  return false;
});

// ---------------------------------------------------------------------------
// First-run onboarding: open the popup UI as a full tab right after install
// so the user immediately sees connection status and can one-click install
// the webmcp MCP server into any detected local MCP client.
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
  }
});

// ---------------------------------------------------------------------------
// Keep-alive: MV3 service workers can be suspended; an alarm periodically
// wakes us up so we can notice a dropped connection and reconnect.
// ---------------------------------------------------------------------------

chrome.alarms.create("webmcp-keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "webmcp-keepalive" && (!ws || ws.readyState === WebSocket.CLOSED)) {
    connect();
  }
});

chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());

connect();
