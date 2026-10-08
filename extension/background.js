// Background service worker: keeps a WebSocket connection open to the local
// WebMCP MCP server (spawned by opencode) and executes browser actions on
// its behalf using chrome.tabs / chrome.scripting.

const DEFAULT_PORT = 47615;
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

// Reconnect with exponential backoff (+ jitter). Kept short at the top end
// because the server side fails over between several webmcp processes (hub +
// peers): when the hub exits, another process takes over the port within a
// second and we should find it quickly.
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5000;
// While connected, ping the hub every 20 s. WebSocket traffic keeps the MV3
// service worker alive (Chrome 116+), and a missing pong reveals a dead
// connection that never delivered a close event.
const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 10_000;

let ws = null;
let port = DEFAULT_PORT;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_MIN_MS;
let pingTimer = null;
let lastPongAt = 0;
let hubStatus = null; // last {type:"hub-status"} from a v2 hub (peers, hubPid, ...)

// Requests this extension sends TO the server (as opposed to `handlers`
// below, which answer requests the server sends to the extension). Used for
// local management actions like listing/installing MCP clients from the
// popup UI.
const pendingClientRequests = new Map();
const CLIENT_REQUEST_TIMEOUT_MS = 10_000;

function sendClientRequest(method, params = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Not connected to the NeuroSquad Browser MCP server."));
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

function failPendingClientRequests(reason) {
  for (const [id, p] of pendingClientRequests) {
    clearTimeout(p.timer);
    pendingClientRequests.delete(id);
    p.reject(new Error(reason));
  }
}

async function loadPort() {
  const { webmcpPort } = await chrome.storage.local.get("webmcpPort");
  // 8765 was the old default and is also NeuroSquad's remote-access port: a
  // saved 8765 sent the extension to the wrong server. Forget it.
  if (webmcpPort === 8765) await chrome.storage.local.remove("webmcpPort");
  port = webmcpPort && webmcpPort !== 8765 ? webmcpPort : DEFAULT_PORT;
  return port;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.round(reconnectDelay * (0.75 + Math.random() * 0.5));
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function stopPing() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

function startPing(socket) {
  stopPing();
  lastPongAt = Date.now();
  pingTimer = setInterval(() => {
    if (socket !== ws || socket.readyState !== WebSocket.OPEN) {
      stopPing();
      return;
    }
    // Only v2 hubs answer pings; old servers ignore them, so only enforce
    // the pong deadline once we know we're talking to a v2 hub.
    if (hubStatus && Date.now() - lastPongAt > PING_INTERVAL_MS + PONG_TIMEOUT_MS) {
      console.log("[webmcp] hub stopped answering pings; reconnecting");
      socket.close();
      return;
    }
    socket.send(JSON.stringify({ type: "ping" }));
  }, PING_INTERVAL_MS);
}

async function connect() {
  await loadPort();
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  let socket;
  try {
    // 127.0.0.1, not "localhost": the server only listens on IPv4 loopback.
    socket = new WebSocket(`ws://127.0.0.1:${port}/`);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.addEventListener("open", () => {
    if (socket !== ws) return;
    console.log(`[webmcp] connected to server on port ${port}`);
    reconnectDelay = RECONNECT_MIN_MS;
    hubStatus = null;
    socket.send(JSON.stringify({ type: "hello", role: "extension", version: EXTENSION_VERSION }));
    startPing(socket);
  });

  socket.addEventListener("message", (event) => {
    if (socket !== ws) return;
    handleServerMessage(event.data);
  });

  socket.addEventListener("close", () => {
    if (socket !== ws) return;
    ws = null;
    hubStatus = null;
    stopPing();
    failPendingClientRequests("Connection to the NeuroSquad Browser MCP server was lost.");
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    // The WebSocket spec doesn't expose error details on this event; the
    // "close" listener above fires right after and schedules a reconnect.
    console.log(`[webmcp] connection attempt to ws://127.0.0.1:${port} failed, will retry`);
  });
}

function reconnectNow() {
  reconnectDelay = RECONNECT_MIN_MS;
  const old = ws;
  ws = null;
  stopPing();
  if (old) {
    try {
      old.close();
    } catch {
      /* ignore */
    }
  }
  failPendingClientRequests("Reconnecting to the NeuroSquad Browser MCP server.");
  connect();
}

async function handleServerMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === "pong") {
    lastPongAt = Date.now();
    return;
  }
  if (msg.type === "hub-status") {
    hubStatus = msg;
    lastPongAt = Date.now();
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

  const glowTab = Number.isInteger(params?.tabId) ? params.tabId : undefined;
  if (glowTab !== undefined && method !== "screenshot") glowOn(glowTab, method);
  try {
    const result = await handler(params || {});
    sendResponse(id, true, result);
  } catch (err) {
    sendResponse(id, false, undefined, err?.message || String(err));
  } finally {
    if (glowTab !== undefined && method !== "screenshot") glowOff(glowTab);
  }
}

// ---- "WebMCP is working here": an animated green glow around the page ------
// Shown while a request runs in a tab and for GLOW_LINGER_MS after the last
// one, so a burst of calls reads as one stretch of work. Injected into the
// ISOLATED world as a function (not a code string), so page CSP doesn't
// matter; pointer-events: none, it never blocks the page. Skipped for
// screenshots so it doesn't end up in them.
const GLOW_LINGER_MS = 1800;
const glowActive = new Map(); // tabId -> running requests
const glowTimers = new Map();

// What the island says the agent is doing, per request method.
const ACTION_LABELS = {
  navigate: ["Opening a page", "Открывает страницу"],
  click: ["Clicking", "Нажимает"],
  fill: ["Typing", "Вводит текст"],
  uploadFiles: ["Attaching files", "Прикрепляет файлы"],
  getPageContent: ["Reading the page", "Читает страницу"],
  querySelector: ["Looking at the page", "Смотрит страницу"],
  getPageInfo: ["Looking at the page", "Смотрит страницу"],
  executeScript: ["Running a script", "Выполняет скрипт"],
};

function glowOn(tabId, method) {
  glowActive.set(tabId, (glowActive.get(tabId) || 0) + 1);
  clearTimeout(glowTimers.get(tabId));
  glowTimers.delete(tabId);
  const label = ACTION_LABELS[method] || ["Working", "Работает"];
  chrome.scripting
    .executeScript({ target: { tabId, frameIds: [0] }, world: "ISOLATED", func: showGlow, args: [label] })
    .catch(() => {});
}

function glowOff(tabId) {
  const left = Math.max(0, (glowActive.get(tabId) || 1) - 1);
  glowActive.set(tabId, left);
  if (left > 0) return;
  clearTimeout(glowTimers.get(tabId));
  glowTimers.set(
    tabId,
    setTimeout(() => {
      glowTimers.delete(tabId);
      if (glowActive.get(tabId)) return;
      chrome.scripting
        .executeScript({ target: { tabId, frameIds: [0] }, world: "ISOLATED", func: hideGlow })
        .catch(() => {});
    }, GLOW_LINGER_MS)
  );
}

function showGlow(label) {
  const ID = "__webmcp_glow__";
  const ru = /^ru\b/i.test(navigator.language || "");
  const action = Array.isArray(label) ? label[ru ? 1 : 0] : "";
  let host = document.getElementById(ID);
  if (!host) {
    host = document.createElement("div");
    host.id = ID;
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      :host { all: initial; }
      /* One shape, one colour: a solid frame whose inner edge is a rounded
         rectangle (the frame also runs past the window, so the blur has
         colour to sample beyond the edge), blurred as a whole. Edges and
         corners are the same blurred frame — identical colour by
         construction — and the inner edge stays rounded. */
      .ring {
        position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
        overflow: hidden;
        opacity: 0; transition: opacity .6s ease;
        animation: hue 4.5s ease-in-out infinite;
      }
      .ring.on { opacity: 1; }
      .breath {
        position: absolute; inset: 0; animation: inhale 3.2s ease-in-out infinite;
        /* A blurred frame is brighter in the corners (colour on three sides
           of the point instead of one): measured ~20% at the tip. Each corner
           is dimmed by a soft radial mask so it matches the edges. */
        --dim: radial-gradient(circle closest-side, rgba(0,0,0,.2), rgba(0,0,0,.1) 45%, transparent 100%);
        /* top layer: solid; below: the four corner dims (added together).
           "subtract" = the solid minus whatever the dims cover. */
        mask:
          linear-gradient(#000, #000),
          var(--dim) -140px -140px / 280px 280px no-repeat,
          var(--dim) calc(100% + 140px) -140px / 280px 280px no-repeat,
          var(--dim) -140px calc(100% + 140px) / 280px 280px no-repeat,
          var(--dim) calc(100% + 140px) calc(100% + 140px) / 280px 280px no-repeat;
        mask-composite: subtract, add, add, add, add;
      }
      .layer { position: absolute; inset: 0; }
      .hole { position: absolute; border-radius: 40px; }
      /* wide, soft halo */
      .wide { filter: blur(34px); opacity: .33; }
      .wide .hole { inset: 26px; box-shadow: 0 0 0 400px #10d090; }
      /* bright band close to the edge */
      .near { filter: blur(9px); opacity: .5; }
      .near .hole { inset: 7px; border-radius: 30px; box-shadow: 0 0 0 400px #22f5a8; }
      @keyframes hue {
        0%, 100% { filter: hue-rotate(0deg); }
        33% { filter: hue-rotate(30deg); }   /* towards teal */
        66% { filter: hue-rotate(-40deg); }  /* towards lime */
      }
      @keyframes inhale {
        0%, 100% { filter: brightness(.72) saturate(.9); }
        50% { filter: brightness(1.2) saturate(1.15); }
      }
      /* The island: a small dark pill at the bottom centre — "NeuroSquad MCP
         is working" plus what it is doing right now. Never takes clicks. */
      .island {
        position: fixed; left: 50%; bottom: 18px; z-index: 2147483647; pointer-events: none;
        transform: translate(-50%, 14px) scale(.96); opacity: 0;
        transition: opacity .35s ease, transform .45s cubic-bezier(.2, .9, .25, 1.15);
        display: flex; align-items: center; gap: 10px;
        padding: 8px 14px 8px 10px; border-radius: 999px;
        background: rgba(12, 13, 13, .86);
        border: 1px solid rgba(163, 230, 53, .28);
        box-shadow: 0 10px 34px rgba(0, 0, 0, .45), 0 0 22px rgba(16, 185, 129, .22);
        backdrop-filter: blur(14px) saturate(1.3); -webkit-backdrop-filter: blur(14px) saturate(1.3);
        font: 500 13px/1.2 Inter, "Segoe UI", system-ui, -apple-system, sans-serif;
        color: #f4f4f5; letter-spacing: .01em; white-space: nowrap;
      }
      .island.on { opacity: 1; transform: translate(-50%, 0) scale(1); }
      .mark { width: 26px; height: 18px; flex: none; }
      .title { font-weight: 650; }
      .sep { width: 1px; height: 14px; background: rgba(255, 255, 255, .16); }
      .action { color: #a1a1aa; display: flex; align-items: center; gap: 7px; }
      .action:empty { display: none; }
      .dot {
        width: 7px; height: 7px; border-radius: 50%; flex: none;
        background: #22f5a8; box-shadow: 0 0 0 0 rgba(34, 245, 168, .6);
        animation: ping 1.6s ease-out infinite;
      }
      .shine {
        background: linear-gradient(90deg, #a3e635, #10b981 40%, #f4f4f5 50%, #10b981 60%, #a3e635);
        background-size: 250% 100%; -webkit-background-clip: text; background-clip: text; color: transparent;
        animation: shine 3.2s linear infinite;
      }
      @keyframes ping {
        0% { box-shadow: 0 0 0 0 rgba(34, 245, 168, .55); }
        80%, 100% { box-shadow: 0 0 0 8px rgba(34, 245, 168, 0); }
      }
      @keyframes shine { from { background-position: 100% 0; } to { background-position: -150% 0; } }
      @media (prefers-reduced-motion: reduce) {
        .ring, .breath, .dot, .shine { animation: none; }
        .island { transition: opacity .2s ease; transform: translate(-50%, 0); }
      }
    </style>
    <div class="ring"><div class="breath">
      <div class="layer wide"><div class="hole"></div></div>
      <div class="layer near"><div class="hole"></div></div>
    </div></div>
    <div class="island" role="status" aria-live="polite">
      <svg class="mark" viewBox="0 0 120 80" aria-hidden="true">
        <defs><linearGradient id="g" x1="4" y1="0" x2="116" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#a3e635"/><stop offset="1" stop-color="#10b981"/></linearGradient></defs>
        <g transform="translate(6,-4) skewX(-11)">
          <polyline points="14,22 32,42 14,62" fill="none" stroke="url(#g)" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
        </g>
        <g transform="translate(40,4) scale(.72) translate(9,0) skewX(-11)">
          <polyline points="86,10 32,10 32,41 80,41 80,74 24,74" fill="none" stroke="url(#g)" stroke-width="15" stroke-linejoin="miter"/>
        </g>
      </svg>
      <span class="title shine"></span>
      <span class="sep"></span>
      <span class="action"><span class="dot"></span><span class="label"></span></span>
    </div>`;
    (document.documentElement || document.body).appendChild(host);
    host.__ring = root.querySelector(".ring");
    host.__island = root.querySelector(".island");
    host.__label = root.querySelector(".label");
    root.querySelector(".title").textContent = ru ? "NeuroSquad MCP работает" : "NeuroSquad MCP is working";
    host.__label.textContent = action;
    requestAnimationFrame(() => {
      host.__ring.classList.add("on");
      host.__island.classList.add("on");
    });
  } else if (host.__ring) {
    clearTimeout(host.__hideTimer);
    host.style.visibility = "";
    host.__ring.classList.add("on");
    if (host.__island) host.__island.classList.add("on");
    if (host.__label && action) host.__label.textContent = action;
  }
}

function hideGlow() {
  const host = document.getElementById("__webmcp_glow__");
  if (!host) return;
  if (host.__ring) host.__ring.classList.remove("on");
  if (host.__island) host.__island.classList.remove("on");
  host.__hideTimer = setTimeout(() => host.remove(), 450);
}

// Screenshots must show the page, not our overlay: hide it for the capture.
function setGlowHidden(hidden) {
  const host = document.getElementById("__webmcp_glow__");
  if (host) host.style.visibility = hidden ? "hidden" : "";
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
        try {
          // eslint-disable-next-line no-new-func
          const fn = new Function(`return (async () => { ${code} })()`);
          return fn();
        } catch (err) {
          // A strict page CSP (no 'unsafe-eval': x.com, github.com…) forbids
          // building code from a string here.
          if (err instanceof EvalError) return { __webmcpCspBlocked: true };
          throw err;
        }
      },
      args: [code],
    });
    if (result && result.__webmcpCspBlocked) return cdpEvaluate(tabId, code);
    return result;
  },

  // Puts local files into an <input type=file> (CDP DOM.setFileInputFiles) —
  // the only way to attach files: a page script can't read the disk.
  async uploadFiles({ tabId, selector, paths }) {
    return withDebugger(tabId, async (target) => {
      const found = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(selector)})`,
      });
      const objectId = found?.result?.objectId;
      if (!objectId) throw new Error(`No element matches ${selector}`);
      await chrome.debugger.sendCommand(target, "DOM.setFileInputFiles", { files: paths, objectId });
      return { uploaded: paths.length, selector };
    });
  },

  async screenshot({ tabId }) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const toggle = (hidden) =>
      chrome.scripting
        .executeScript({ target: { tabId, frameIds: [0] }, world: "ISOLATED", func: setGlowHidden, args: [hidden] })
        .catch(() => {});
    await toggle(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { dataUrl };
    } finally {
      await toggle(false);
    }
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
    sendResponseFn({
      connected: !!ws && ws.readyState === WebSocket.OPEN,
      port,
      peers: hubStatus?.peers,
      hubPid: hubStatus?.hubPid,
      hubVersion: hubStatus?.version,
    });
    return true;
  }

  if (message?.type === "set-port") {
    chrome.storage.local.set({ webmcpPort: message.port }).then(() => {
      reconnectNow();
      sendResponseFn({ ok: true });
    });
    return true;
  }

  if (message?.type === "reconnect") {
    reconnectNow();
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
// Keep-alive: MV3 service workers can be suspended. The 20 s ping above
// keeps the worker alive while connected; while disconnected, this alarm
// (30 s is Chrome's minimum period) wakes the worker so the reconnect loop
// survives suspension.
// ---------------------------------------------------------------------------

chrome.alarms.create("webmcp-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "webmcp-keepalive") return;
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    ws = null;
    connect();
  }
});

chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());

connect();

// chrome.debugger (CDP) for what the page's CSP or the sandbox forbids:
// evaluating a code string, setting files on a file input. Attaches only for
// the call; Chrome shows its "started debugging this browser" bar meanwhile.
async function withDebugger(tabId, run) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    return await run(target);
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function cdpEvaluate(tabId, code) {
  return withDebugger(tabId, async (target) => {
    const r = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `(async () => { ${code} })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result?.value;
  });
}
