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
  try {
    await settingsReady;
    // Site policy first: a blocked site gets no glow, no injection, nothing.
    await enforcePolicy(method, params || {});
  } catch (err) {
    sendResponse(id, false, undefined, err?.message || String(err));
    return;
  }
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

// ---- Page helper (page.js) -------------------------------------------------
// The overlay (glow, island, element highlight, agent cursor), element refs
// and the page-side halves of the tools live in page.js, injected on demand
// into the ISOLATED world of the top frame. Injected as a file, so page CSP
// doesn't matter. pageCall() injects it the first time a document needs it.
async function pageCall(tabId, name, ...args) {
  const target = { tabId, frameIds: [0] };
  const run = async () => {
    const [res] = await chrome.scripting.executeScript({
      target,
      world: "ISOLATED",
      func: (name, args) => (globalThis.__nsPage ? globalThis.__nsPage.call(name, args) : { __nsMissing: true }),
      args: [name, args],
    });
    return res?.result;
  };
  let result = await run();
  if (result && result.__nsMissing) {
    await chrome.scripting.executeScript({ target, world: "ISOLATED", files: ["page.js"] });
    result = await run();
  }
  if (result && result.__nsError) throw new Error(result.__nsError);
  return result;
}

const pageCallQuiet = (tabId, name, ...args) => pageCall(tabId, name, ...args).catch(() => null);

// ---- "NeuroSquad MCP is working here": an animated green glow around the page
// Shown while a request runs in a tab and for GLOW_LINGER_MS after the last
// one, so a burst of calls reads as one stretch of work. pointer-events: none,
// it never blocks the page. Skipped for screenshots so it doesn't end up in them.
const GLOW_LINGER_MS = 1800;
const glowActive = new Map(); // tabId -> running requests
const glowTimers = new Map();

// What the island (and the element highlight) says the agent is doing.
const ACTION_LABELS = {
  navigate: ["Opening a page", "Открывает страницу"],
  openTab: ["Opening a tab", "Открывает вкладку"],
  click: ["Clicking", "Нажимает"],
  fill: ["Typing", "Вводит текст"],
  type: ["Typing", "Вводит текст"],
  pressKey: ["Pressing keys", "Нажимает клавиши"],
  uploadFiles: ["Attaching files", "Прикрепляет файлы"],
  getPageContent: ["Reading the page", "Читает страницу"],
  snapshot: ["Reading the page", "Читает страницу"],
  querySelector: ["Looking at the page", "Смотрит страницу"],
  getPageInfo: ["Looking at the page", "Смотрит страницу"],
  executeScript: ["Running a script", "Выполняет скрипт"],
  waitFor: ["Waiting", "Ждёт"],
  scroll: ["Scrolling", "Прокручивает"],
  fetch: ["Sending a request", "Отправляет запрос"],
  screenshot: ["Capturing", "Снимает"],
};
const FOUND_LABEL = ["Found", "Нашёл"];

function glowOn(tabId, method) {
  glowActive.set(tabId, (glowActive.get(tabId) || 0) + 1);
  clearTimeout(glowTimers.get(tabId));
  glowTimers.delete(tabId);
  pageCallQuiet(tabId, "glowShow", ACTION_LABELS[method] || ["Working", "Работает"]);
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
      pageCallQuiet(tabId, "glowHide");
    }, GLOW_LINGER_MS)
  );
}

// Screenshots must show the page, not our overlay: hide it for the capture.
async function setOverlayHidden(tabId, hidden) {
  await pageCallQuiet(tabId, "setHidden", hidden);
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

// Tabs opened through browser_open_tab, kept in session storage so the list
// survives the service worker going to sleep.
async function openedTabs() {
  const { openedTabs: ids } = await chrome.storage.session.get("openedTabs");
  return Array.isArray(ids) ? ids : [];
}

// Every change goes through one queue, so overlapping opens/closes can't
// overwrite each other's snapshot of the list.
let openedTabsQueue = Promise.resolve();
function updateOpenedTabs(change) {
  const next = openedTabsQueue.then(async () => {
    const ids = await openedTabs();
    await chrome.storage.session.set({ openedTabs: change(ids) });
  });
  openedTabsQueue = next.catch(() => {});
  return next;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  updateOpenedTabs((ids) => ids.filter((id) => id !== tabId)).catch(() => {});
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Element target of a tool call: a CSS selector or a ref from browser_snapshot.
function targetOf({ selector, ref }) {
  if (ref) return { ref };
  if (selector) return { selector };
  return null;
}

// Input on one tab happens one action at a time, so two clicks can't
// interleave their cursor glides and mouse events.
const tabQueues = new Map();
function inTabQueue(tabId, run) {
  const next = (tabQueues.get(tabId) || Promise.resolve()).then(run);
  const tail = next.catch(() => {});
  tabQueues.set(tabId, tail);
  tail.then(() => {
    if (tabQueues.get(tabId) === tail) tabQueues.delete(tabId);
  });
  return next;
}

const handlers = {
  async listTabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.map((t) => ({
      id: t.id,
      windowId: t.windowId,
      title: t.title,
      url: t.url,
      active: t.active,
      groupId: t.groupId >= 0 ? t.groupId : undefined,
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

  // Real (trusted) click through the DevTools protocol by default: the page
  // gets isTrusted mouse events at the element's centre, after the agent
  // cursor glides there. trusted: false keeps the old element.click().
  async click({ tabId, selector, ref, x, y, trusted = true, button = "left", clickCount = 1 }) {
    const target = targetOf({ selector, ref });
    if (!target && !(Number.isFinite(x) && Number.isFinite(y))) {
      throw new Error("Pass a selector, a ref, or x and y coordinates.");
    }
    if (trusted === false) {
      if (!target) throw new Error("trusted: false needs a selector or a ref (coordinates are clicked with real input only).");
      try {
        return await pageCall(tabId, "syntheticClick", target, ACTION_LABELS.click);
      } catch (err) {
        if (/^No element matches|stale/.test(err.message)) return { clicked: false, reason: err.message };
        throw err;
      } finally {
        pageCallQuiet(tabId, "highlightDone");
      }
    }
    return inTabQueue(tabId, async () => {
      let info;
      try {
        info = target
          ? await pageCall(tabId, "prepare", target, { label: ACTION_LABELS.click })
          : { ...(await pageCall(tabId, "viewport")), x, y };
      } catch (err) {
        if (/^No element matches|stale/.test(err.message)) return { clicked: false, reason: err.message };
        throw err;
      }
      try {
        return await withDebugger(tabId, async (dbg) => {
          const point = { x: info.x, y: info.y };
          await glideTo(tabId, dbg, point, info);
          if (cursorShown(info)) pageCallQuiet(tabId, "cursorPress", point.x, point.y);
          await mouseClick(dbg, point, button, clickCount);
          return {
            clicked: true,
            trusted: true,
            x: point.x,
            y: point.y,
            button,
            clickCount,
            element: info.element,
            warning: info.covered ? `Another element (${info.covered}) is on top of the target at that point; it received the click.` : undefined,
          };
        });
      } finally {
        if (target) pageCallQuiet(tabId, "highlightDone");
      }
    });
  },

  // Real keyboard input: focuses the field (cursor glides to it), then
  // Input.insertText, or one key event per character when delay is set.
  async type({ tabId, selector, ref, text, delay = 0, clear = false }) {
    const target = targetOf({ selector, ref });
    return inTabQueue(tabId, async () => {
      try {
        return await withDebugger(tabId, async (dbg) => {
          let info = null;
          if (target) {
            info = await pageCall(tabId, "prepare", target, { label: ACTION_LABELS.type });
            await glideTo(tabId, dbg, { x: info.x, y: info.y }, info);
            const field = await pageCall(tabId, "focusField", target, { clear });
            if (clear && field?.hasContent) await pressCombo(dbg, "Backspace");
          } else if (clear) {
            await pressCombo(dbg, isMac ? "Meta+A" : "Control+A");
            await pressCombo(dbg, "Backspace");
          }
          if (info && cursorShown(info)) pageCallQuiet(tabId, "cursorTyping", true);
          if (!delay) {
            if (text) await chrome.debugger.sendCommand(dbg, "Input.insertText", { text });
          } else {
            for (const ch of text) {
              if (ch === "\n") await pressCombo(dbg, "Enter");
              else if (ch === "\t") await pressCombo(dbg, "Tab");
              else await typeChar(dbg, ch);
              await sleep(delay);
            }
          }
          if (info && cursorShown(info)) pageCallQuiet(tabId, "cursorTyping", false);
          const after = await pageCallQuiet(tabId, "activeValue", target);
          return { typed: [...text].length, cleared: clear || undefined, element: after?.element, value: after?.value };
        });
      } finally {
        if (target) pageCallQuiet(tabId, "highlightDone");
      }
    });
  },

  // Key presses and combos ("Enter", "Control+A", "Shift+Tab") as real key
  // events. With a selector/ref the element is focused first.
  async pressKey({ tabId, key, selector, ref, repeat = 1 }) {
    const target = targetOf({ selector, ref });
    const combo = parseCombo(key); // validate before touching the page
    return inTabQueue(tabId, async () => {
      try {
        return await withDebugger(tabId, async (dbg) => {
          if (target) {
            const info = await pageCall(tabId, "prepare", target, { label: ACTION_LABELS.pressKey });
            await glideTo(tabId, dbg, { x: info.x, y: info.y }, info);
            await pageCall(tabId, "focusOnly", target);
          }
          for (let i = 0; i < repeat; i++) await pressParsed(dbg, combo);
          return { pressed: key, repeat };
        });
      } finally {
        if (target) pageCallQuiet(tabId, "highlightDone");
      }
    });
  },

  async fill({ tabId, selector, ref, value }) {
    try {
      return await pageCall(tabId, "fill", targetOf({ selector, ref }), value, ACTION_LABELS.fill);
    } catch (err) {
      if (/^No element matches|stale/.test(err.message)) return { filled: false, reason: err.message };
      throw err;
    } finally {
      pageCallQuiet(tabId, "highlightDone");
    }
  },

  async navigate({ tabId, url }) {
    await chrome.tabs.update(tabId, { url });
    return { navigated: true, url };
  },

  async openTab({ url, active }) {
    const tab = await chrome.tabs.create({ url, active: active === true });
    try {
      await updateOpenedTabs((ids) => [...ids, tab.id]);
    } catch (err) {
      // Untracked, the agent could never close it: don't leave it behind.
      await chrome.tabs.remove(tab.id).catch(() => {});
      throw err;
    }
    const groupId = await addToAgentGroup(tab).catch(() => undefined);
    return { id: tab.id, windowId: tab.windowId, url, groupId };
  },

  // Only tabs this extension opened: an agent never closes the user's tabs.
  async closeTab({ tabId }) {
    await openedTabsQueue;
    if (!(await openedTabs()).includes(tabId)) {
      throw new Error("This tab wasn't opened by browser_open_tab, so it can't be closed.");
    }
    await chrome.tabs.remove(tabId);
    await updateOpenedTabs((ids) => ids.filter((id) => id !== tabId));
    return { closed: true, tabId };
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
  async uploadFiles({ tabId, selector, ref, paths }) {
    const token = crypto.randomUUID();
    const element = await pageCall(tabId, "markTarget", targetOf({ selector, ref }), token, ACTION_LABELS.uploadFiles);
    try {
      return await withDebugger(tabId, async (target) => {
        const found = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
          expression: `document.querySelector('[data-webmcp-target="${token}"]')`,
        });
        const objectId = found?.result?.objectId;
        if (!objectId) throw new Error(`No element matches ${selector || ref}`);
        await chrome.debugger.sendCommand(target, "DOM.setFileInputFiles", { files: paths, objectId });
        return { uploaded: paths.length, selector, ref, element };
      });
    } finally {
      pageCallQuiet(tabId, "unmark", token);
      pageCallQuiet(tabId, "highlightDone");
    }
  },

  // Visible area of the active tab: captureVisibleTab (no debugger bar).
  // A background tab, an element or the full page: Page.captureScreenshot,
  // which doesn't need the tab activated. Falls back to activate + capture.
  async screenshot({ tabId, selector, ref, fullPage }) {
    const tab = await chrome.tabs.get(tabId);
    const target = targetOf({ selector, ref });
    let rect = null;
    if (target) rect = await pageCall(tabId, "captureRect", target, ACTION_LABELS.screenshot);
    await setOverlayHidden(tabId, true);
    try {
      if (!target && !fullPage && tab.active) {
        await sleep(60);
        return { dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }) };
      }
      try {
        const dataUrl = await cdpScreenshot(tabId, { clip: rect?.page, fullPage });
        return { dataUrl, element: rect?.element, method: "cdp" };
      } catch (err) {
        console.log(`[webmcp] Page.captureScreenshot failed (${err.message}); activating the tab instead`);
      }
      // Briefly switch to the tab, then give the user their tab back.
      let previous = null;
      if (!tab.active) {
        [previous] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
        await chrome.tabs.update(tabId, { active: true });
        await sleep(150);
      }
      try {
        await sleep(60);
        let dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        if (rect) {
          // The element was scrolled into view: crop the visible capture to it.
          const fresh = await pageCall(tabId, "captureRect", target, null);
          dataUrl = await cropDataUrl(dataUrl, fresh.viewport, fresh.dpr);
        }
        return { dataUrl, element: rect?.element, method: "visible-tab", note: fullPage ? "Full page capture failed; this is the visible area." : undefined };
      } finally {
        if (previous && previous.id !== tabId) await chrome.tabs.update(previous.id, { active: true }).catch(() => {});
      }
    } finally {
      await setOverlayHidden(tabId, false);
      if (target) pageCallQuiet(tabId, "highlightDone", 300);
    }
  },

  // Compact accessibility-style outline of the page with refs.
  async snapshot({ tabId, selector, maxNodes, maxLength }) {
    return pageCall(tabId, "snapshot", { selector, maxNodes, maxLength });
  },

  async scroll({ tabId, selector, ref, x = 0, y = 0, to, within, waitMs }) {
    const target = targetOf({ selector, ref });
    if (!target && !to && !x && !y) throw new Error("Pass pixels (x/y), to: \"top\"/\"bottom\", or an element (selector/ref).");
    return inTabQueue(tabId, async () => {
      try {
        return await pageCall(tabId, "scroll", { target, dx: x, dy: y, to, within, waitMs, label: ACTION_LABELS.scroll });
      } finally {
        if (target) pageCallQuiet(tabId, "highlightDone");
      }
    });
  },

  async waitFor({ tabId, selector, ref, state = "visible", text, url, loadState, timeout = 10_000 }) {
    const target = targetOf({ selector, ref });
    if (!target && !text && !url && !loadState) throw new Error("Pass a selector, ref, text, url or loadState to wait for.");
    const limit = Math.min(Math.max(Number(timeout) || 10_000, 100), 60_000);
    const started = Date.now();
    const urlMatch = url ? urlMatcher(url) : null;
    let lastResources = -1;
    let quietSince = Date.now();
    let last = "";
    for (;;) {
      let ok = true;
      const tab = await chrome.tabs.get(tabId);
      if (urlMatch && !urlMatch(tab.url || tab.pendingUrl || "")) {
        ok = false;
        last = `url is ${tab.url}`;
      }
      let check = null;
      if (ok && (loadState || target || text)) {
        check = await pageCall(tabId, "waitCheck", { target, state, text, label: FOUND_LABEL }).catch((err) => {
          if (/stale|Invalid CSS selector|Pass a selector/.test(err.message)) throw err;
          return null; // navigating: the document isn't there yet
        });
        if (!check) {
          ok = false;
          last = "page is loading";
        } else {
          if (loadState) {
            if (tab.status !== "complete" || check.readyState !== "complete") {
              ok = false;
              last = `page is ${check.readyState}`;
              lastResources = -1;
            } else if (loadState === "networkidle") {
              if (check.resources !== lastResources) {
                lastResources = check.resources;
                quietSince = Date.now();
              }
              if (Date.now() - quietSince < 500) {
                ok = false;
                last = "network is busy";
              }
            }
          }
          if (ok && (target || text) && !check.matched) {
            ok = false;
            last = target ? `element is not ${state}` : "text not found";
          }
        }
      }
      if (ok) {
        if (check?.element || check?.textElement) pageCallQuiet(tabId, "highlightDone");
        return { matched: true, waitedMs: Date.now() - started, url: tab.url, element: check?.element, textElement: check?.textElement };
      }
      if (Date.now() - started >= limit) {
        const what = [
          target && `${selector || ref} to be ${state}`,
          text && `text ${JSON.stringify(text)}`,
          url && `url ${url}`,
          loadState && `load state "${loadState}"`,
        ].filter(Boolean).join(", ");
        throw new Error(`Timed out after ${limit} ms waiting for ${what} (${last}).`);
      }
      await sleep(150);
    }
  },

  // fetch() from the page: its origin, its cookies, its CORS rules.
  async fetch({ tabId, url, method = "GET", headers, body, responseType, maxLength }) {
    return pageCall(tabId, "pageFetch", { url, method: String(method).toUpperCase(), headers, body, responseType, maxLength });
  },
};

// String or /regex/ (with flags) -> predicate on a URL. A plain string
// matches as a substring, or as a glob when it contains "*".
function urlMatcher(pattern) {
  const re = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (re) {
    const rx = new RegExp(re[1], re[2]);
    return (u) => rx.test(u);
  }
  if (pattern.includes("*")) {
    const rx = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    return (u) => rx.test(u);
  }
  return (u) => u.includes(pattern);
}

// ---------------------------------------------------------------------------
// Tab group: tabs opened by browser_open_tab go into one "NeuroSquad" group
// per window. Only those tabs: the user's own tabs are never regrouped.
// ---------------------------------------------------------------------------
const AGENT_GROUP_TITLE = "NeuroSquad";
let groupQueue = Promise.resolve();

function addToAgentGroup(tab) {
  if (!chrome.tabGroups || !chrome.tabs.group) return Promise.resolve(undefined);
  const next = groupQueue.then(async () => {
    const { agentGroups = {} } = await chrome.storage.session.get("agentGroups");
    let groupId = agentGroups[tab.windowId];
    if (Number.isInteger(groupId)) {
      const group = await chrome.tabGroups.get(groupId).catch(() => null);
      if (!group || group.windowId !== tab.windowId || group.title !== AGENT_GROUP_TITLE) groupId = undefined;
    } else groupId = undefined;
    if (groupId === undefined) {
      groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
      await chrome.tabGroups.update(groupId, { title: AGENT_GROUP_TITLE, color: "green", collapsed: false });
      await chrome.storage.session.set({ agentGroups: { ...agentGroups, [tab.windowId]: groupId } });
    } else {
      await chrome.tabs.group({ groupId, tabIds: [tab.id] });
      // Adding a tab must not hide it.
      await chrome.tabGroups.update(groupId, { collapsed: false }).catch(() => {});
    }
    return groupId;
  });
  groupQueue = next.catch(() => {});
  return next;
}

// ---------------------------------------------------------------------------
// Settings from the popup (chrome.storage.local): the cursor/highlight toggle
// and the site policy.
// ---------------------------------------------------------------------------
const settings = { showCursor: true, sitePolicy: [] };

function applySettings(s) {
  if ("showCursor" in s) settings.showCursor = s.showCursor !== false;
  if ("sitePolicy" in s) settings.sitePolicy = Array.isArray(s.sitePolicy) ? s.sitePolicy : [];
}

const settingsReady = chrome.storage.local
  .get(["showCursor", "sitePolicy"])
  .then(applySettings)
  .catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const s = {};
  for (const key of ["showCursor", "sitePolicy"]) if (key in changes) s[key] = changes[key].newValue;
  applySettings(s);
});

// ---- Site policy ----------------------------------------------------------
// Rules: [{ pattern: "x.com" | "*.example.com" | "*", mode: "full"|"read-only"|"blocked" }].
// "example.com" also covers its subdomains; the most specific match wins;
// unlisted sites are "full" (the behaviour before policies existed).
const POLICY_MODES = ["full", "read-only", "blocked"];
const ALWAYS_ALLOWED = new Set(["listTabs", "getActiveTab"]);
const WRITE_METHODS = new Set(["click", "type", "pressKey", "fill", "uploadFiles", "executeScript"]);
const TOOL_NAMES = {
  click: "browser_click",
  type: "browser_type",
  pressKey: "browser_press_key",
  fill: "browser_fill",
  uploadFiles: "browser_upload_files",
  executeScript: "browser_execute_script",
  fetch: "browser_fetch",
  navigate: "browser_navigate",
  openTab: "browser_open_tab",
  closeTab: "browser_close_tab",
  getPageInfo: "browser_get_page_info",
  getPageContent: "browser_get_page_content",
  querySelector: "browser_query_selector",
  screenshot: "browser_screenshot",
  snapshot: "browser_snapshot",
  scroll: "browser_scroll",
  waitFor: "browser_wait_for",
};

function normalizePattern(p) {
  let s = String(p || "").trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");
  if (s.startsWith("*.")) s = s.slice(2);
  if (s && s !== "*") {
    try {
      s = new URL(`http://${s}`).hostname.replace(/^\[|\]$/g, ""); // IDN -> punycode, like tab URLs
    } catch {
      return "";
    }
  }
  return s;
}

function policyFor(url) {
  let host;
  try {
    const u = new URL(url);
    if (!/^(https?|wss?|ftp|file):$/.test(u.protocol)) return { mode: "full" };
    host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return { mode: "full" };
  }
  let best = null;
  let bestLen = -1;
  for (const rule of settings.sitePolicy) {
    if (!rule || !POLICY_MODES.includes(rule.mode)) continue;
    const p = normalizePattern(rule.pattern);
    if (!p) continue;
    const hit = p === "*" ? 0 : host === p || host.endsWith("." + p) ? p.length : -1;
    if (hit > bestLen) {
      best = rule;
      bestLen = hit;
    }
  }
  return best ? { mode: best.mode, pattern: best.pattern, host } : { mode: "full", host };
}

function policyError(method, url, pol) {
  const tool = TOOL_NAMES[method] || method;
  const where = pol.host || url;
  return new Error(
    `Site policy: ${where} is ${pol.mode === "blocked" ? "blocked" : "read-only"} (rule "${pol.pattern}"), so ${tool} is not allowed there. ` +
      "The user can change this in the NeuroSquad Browser MCP popup (Site access)."
  );
}

async function enforcePolicy(method, params) {
  if (ALWAYS_ALLOWED.has(method) || !settings.sitePolicy.length) return;
  const check = (url, write) => {
    const pol = policyFor(url);
    if (pol.mode === "blocked" || (write && pol.mode === "read-only")) throw policyError(method, url, pol);
  };
  if (method === "openTab") return check(params.url, false);
  if (!Number.isInteger(params.tabId)) return;
  const tab = await chrome.tabs.get(params.tabId);
  const write =
    WRITE_METHODS.has(method) || (method === "fetch" && !["GET", "HEAD"].includes(String(params.method || "GET").toUpperCase()));
  // Both the committed and the pending URL: a navigation to a blocked site
  // in progress must not slip through on the old URL.
  check(tab.url || "", write);
  if (tab.pendingUrl) check(tab.pendingUrl, write);
  if (method === "navigate") check(params.url, false);
}

// ---------------------------------------------------------------------------
// DevTools protocol session (chrome.debugger), shared by a burst of actions:
// attached on first use, detached after DEBUGGER_IDLE_MS without calls, so
// Chrome's "started debugging this browser" bar doesn't flash on every call.
// ---------------------------------------------------------------------------
const DEBUGGER_IDLE_MS = 5000;
const debuggerSessions = new Map(); // tabId -> { ready, busy, timer }
const debuggerCancelled = new Map(); // tabId -> time the user detached it

function debuggerSession(tabId) {
  let s = debuggerSessions.get(tabId);
  if (s) {
    clearTimeout(s.timer);
    s.timer = null;
    return s;
  }
  s = { busy: 0, timer: null, ready: null };
  s.ready = chrome.debugger.attach({ tabId }, "1.3").catch((err) => {
    // Still attached from before a service worker restart: reuse it.
    if (/already attached/i.test(err.message || "")) return;
    if (debuggerSessions.get(tabId) === s) debuggerSessions.delete(tabId);
    throw err;
  });
  debuggerSessions.set(tabId, s);
  return s;
}

async function withDebugger(tabId, run) {
  const s = debuggerSession(tabId);
  s.busy++;
  try {
    await s.ready;
    return await run({ tabId });
  } catch (err) {
    const at = debuggerCancelled.get(tabId);
    if (at && Date.now() - at < 30_000 && /not attached|detached/i.test(err.message || "")) {
      throw new Error("Chrome's debugging session was cancelled (the infobar's Cancel button), so the action stopped. Call the tool again to retry.", { cause: err });
    }
    throw err;
  } finally {
    s.busy--;
    if (!s.busy && debuggerSessions.get(tabId) === s) {
      clearTimeout(s.timer);
      s.timer = setTimeout(() => {
        if (debuggerSessions.get(tabId) !== s || s.busy) return;
        debuggerSessions.delete(tabId);
        chrome.debugger.detach({ tabId }).catch(() => {});
      }, DEBUGGER_IDLE_MS);
    }
  }
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!Number.isInteger(source.tabId)) return;
  const s = debuggerSessions.get(source.tabId);
  if (s) clearTimeout(s.timer);
  debuggerSessions.delete(source.tabId);
  if (reason === "canceled_by_user") debuggerCancelled.set(source.tabId, Date.now());
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const s = debuggerSessions.get(tabId);
  if (s) clearTimeout(s.timer);
  debuggerSessions.delete(tabId);
  debuggerCancelled.delete(tabId);
  cursorPos.delete(tabId);
});

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

const CDP_SCREENSHOT_TIMEOUT_MS = 5000;
const MAX_FULL_PAGE_HEIGHT = 16_384;

async function cdpScreenshot(tabId, { clip, fullPage }) {
  // Page.captureScreenshot clips are in device-independent pixels; page CSS
  // pixels are scaled by the browser zoom (checked at 125% by scripts/e2e.mjs).
  const zoom = await chrome.tabs.getZoom(tabId).catch(() => 1);
  return withDebugger(tabId, async (target) => {
    const params = { format: "png", fromSurface: true };
    if (clip) {
      const z = zoom || 1;
      params.clip = { x: clip.x * z, y: clip.y * z, width: Math.max(1, clip.width * z), height: Math.max(1, clip.height * z), scale: 1 };
      params.captureBeyondViewport = true;
    } else if (fullPage) {
      const m = await chrome.debugger.sendCommand(target, "Page.getLayoutMetrics");
      const size = m.cssContentSize || m.contentSize;
      const z = m.cssContentSize ? zoom || 1 : 1;
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width * z), height: Math.min(Math.ceil(size.height * z), MAX_FULL_PAGE_HEIGHT), scale: 1 };
      params.captureBeyondViewport = true;
    }
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), CDP_SCREENSHOT_TIMEOUT_MS);
    });
    try {
      const shot = await Promise.race([chrome.debugger.sendCommand(target, "Page.captureScreenshot", params), timeout]);
      return `data:image/png;base64,${shot.data}`;
    } finally {
      clearTimeout(timer);
    }
  });
}

async function cropDataUrl(dataUrl, r, dpr) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const sx = Math.max(0, Math.round(r.x * dpr));
  const sy = Math.max(0, Math.round(r.y * dpr));
  const sw = Math.max(1, Math.min(bmp.width - sx, Math.round(r.width * dpr)));
  const sh = Math.max(1, Math.min(bmp.height - sy, Math.round(r.height * dpr)));
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext("2d").drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  const out = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await out.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}

// ---------------------------------------------------------------------------
// Real mouse input and the agent cursor
// ---------------------------------------------------------------------------
// CDP Input coordinates are page CSS pixels relative to the viewport, the same
// as getBoundingClientRect(): Chrome applies the browser zoom and the
// display's devicePixelRatio itself (checked at 125% zoom by scripts/e2e.mjs).
const BUTTON_MASK = { left: 1, right: 2, middle: 4, back: 8, forward: 16 };
const cursorPos = new Map(); // tabId -> last cursor point (CSS px, viewport)

function mouseEvent(dbg, type, p, extra = {}) {
  return chrome.debugger.sendCommand(dbg, "Input.dispatchMouseEvent", {
    type,
    x: p.x,
    y: p.y,
    pointerType: "mouse",
    ...extra,
  });
}

async function mouseClick(dbg, p, button, clickCount) {
  const buttons = BUTTON_MASK[button] || 1;
  for (let i = 1; i <= clickCount; i++) {
    await mouseEvent(dbg, "mousePressed", p, { button, buttons, clickCount: i });
    await mouseEvent(dbg, "mouseReleased", p, { button, buttons: 0, clickCount: i });
  }
}

const cursorShown = (info) => settings.showCursor && info && !info.hidden;

// A slight arc from a to b: cubic Bézier, control points pushed sideways.
function bezierPath(a, b, duration, step) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const bend = Math.min(dist * 0.16, 90) * (dx >= 0 ? -1 : 1);
  const nx = -dy / dist;
  const ny = dx / dist;
  const c1 = { x: a.x + dx * 0.28 + nx * bend, y: a.y + dy * 0.28 + ny * bend };
  const c2 = { x: a.x + dx * 0.74 + nx * bend * 0.6, y: a.y + dy * 0.74 + ny * bend * 0.6 };
  // Sine ease-in-out: gentle start and stop, peak speed only ~1.6x the mean,
  // so consecutive moves stay close together (hover targets are not skipped).
  const ease = (t) => 0.5 - Math.cos(Math.PI * t) / 2;
  const n = Math.max(1, Math.round(duration / step));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = ease(i / n);
    const u = 1 - t;
    pts.push([
      Math.round((u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x) * 10) / 10,
      Math.round((u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y) * 10) / 10,
    ]);
  }
  return pts;
}

const GLIDE_STEP_MS = 16;

// Moves the pointer to `to`: the visible cursor glides there along an arc
// while real mouseMoved events follow the same path (hover states fire);
// resolves when both arrive. Without the cursor: one move, no delay.
async function glideTo(tabId, dbg, to, info) {
  const from = cursorPos.get(tabId) || { x: info.vw / 2, y: Math.max(0, info.vh - 34) };
  cursorPos.set(tabId, { x: to.x, y: to.y });
  if (!cursorShown(info)) {
    await mouseEvent(dbg, "mouseMoved", to, { button: "none", buttons: 0 });
    return;
  }
  if (info.reduced) {
    await pageCallQuiet(tabId, "cursorJump", to.x, to.y);
    await mouseEvent(dbg, "mouseMoved", to, { button: "none", buttons: 0 });
    await sleep(120);
    return;
  }
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const duration = Math.round(Math.min(700, Math.max(250, 220 + dist * 0.45)));
  const pts = bezierPath(from, to, duration, GLIDE_STEP_MS);
  await pageCallQuiet(tabId, "cursorGlide", pts, GLIDE_STEP_MS);
  // One move per frame, paced by the clock and pipelined (not awaited one by
  // one), so the pointer never skips across a thin hover target.
  const start = Date.now();
  const sends = [];
  for (let i = 1; i < pts.length; i++) {
    const wait = start + i * GLIDE_STEP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    sends.push(mouseEvent(dbg, "mouseMoved", { x: pts[i][0], y: pts[i][1] }, { button: "none", buttons: 0 }));
  }
  await Promise.all(sends);
}

// ---------------------------------------------------------------------------
// Real keyboard input
// ---------------------------------------------------------------------------
const isMac = /Mac/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "");

const MODIFIERS = {
  Alt: { bit: 1, code: "AltLeft", vk: 18 },
  Control: { bit: 2, code: "ControlLeft", vk: 17 },
  Meta: { bit: 4, code: "MetaLeft", vk: 91 },
  Shift: { bit: 8, code: "ShiftLeft", vk: 16 },
};
const KEY_ALIASES = {
  ctrl: "Control", control: "Control", cmd: "Meta", command: "Meta", meta: "Meta", win: "Meta", super: "Meta",
  alt: "Alt", option: "Alt", opt: "Alt", shift: "Shift",
  enter: "Enter", return: "Enter", esc: "Escape", escape: "Escape", tab: "Tab", backspace: "Backspace",
  delete: "Delete", del: "Delete", insert: "Insert", space: " ", spacebar: " ",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", plus: "+",
};
const NAMED_KEYS = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  Insert: { code: "Insert", vk: 45 },
  " ": { code: "Space", vk: 32, text: " " },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
};
for (let i = 1; i <= 12; i++) NAMED_KEYS[`F${i}`] = { code: `F${i}`, vk: 111 + i };
const PUNCT_CODES = {
  "-": ["Minus", 189], "=": ["Equal", 187], "[": ["BracketLeft", 219], "]": ["BracketRight", 221],
  "\\": ["Backslash", 220], ";": ["Semicolon", 186], "'": ["Quote", 222], ",": ["Comma", 188],
  ".": ["Period", 190], "/": ["Slash", 191], "`": ["Backquote", 192],
};
// Editing commands Chrome on macOS only runs when asked to (Puppeteer does the same).
const MAC_COMMANDS = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo" };

function keyInfo(name) {
  const k = KEY_ALIASES[name.toLowerCase()] || name;
  if (NAMED_KEYS[k]) return { key: k, ...NAMED_KEYS[k] };
  if ([...k].length !== 1) {
    throw new Error(`Unknown key "${name}". Use a character or one of: ${Object.keys(NAMED_KEYS).map((n) => (n === " " ? "Space" : n)).join(", ")}, with Control/Alt/Shift/Meta+.`);
  }
  if (/^[a-z]$/i.test(k)) return { key: k, code: `Key${k.toUpperCase()}`, vk: k.toUpperCase().charCodeAt(0), text: k };
  if (/^\d$/.test(k)) return { key: k, code: `Digit${k}`, vk: k.charCodeAt(0), text: k };
  const p = PUNCT_CODES[k];
  return { key: k, code: p ? p[0] : "", vk: p ? p[1] : 0, text: k };
}

// "Control+Shift+A" -> { mods: ["Control", "Shift"], key }. "Control++" is plus.
function parseCombo(combo) {
  const raw = String(combo || "");
  if (!raw) throw new Error("key is empty.");
  const parts = raw === "+" ? ["+"] : raw.endsWith("++") ? [...raw.slice(0, -2).split("+"), "+"] : raw.split("+");
  const mods = [];
  for (const part of parts.slice(0, -1)) {
    const m = KEY_ALIASES[part.trim().toLowerCase()] || part.trim();
    if (!MODIFIERS[m]) throw new Error(`Unknown modifier "${part}" in "${combo}". Use Control, Alt, Shift or Meta.`);
    if (!mods.includes(m)) mods.push(m);
  }
  const last = parts[parts.length - 1];
  const lastName = KEY_ALIASES[last.trim().toLowerCase()] || last;
  if (MODIFIERS[lastName]) return { mods, key: null, modKey: lastName };
  return { mods, key: keyInfo(last === " " ? " " : last.trim() || last) };
}

async function pressParsed(dbg, { mods, key, modKey }) {
  let bits = 0;
  const down = [...mods, ...(modKey ? [modKey] : [])];
  for (const m of down) {
    bits |= MODIFIERS[m].bit;
    await chrome.debugger.sendCommand(dbg, "Input.dispatchKeyEvent", {
      type: "rawKeyDown", modifiers: bits, key: m, code: MODIFIERS[m].code, windowsVirtualKeyCode: MODIFIERS[m].vk, location: 1,
    });
  }
  if (key) {
    const chorded = bits & (MODIFIERS.Control.bit | MODIFIERS.Alt.bit | MODIFIERS.Meta.bit);
    let k = key.key;
    let text = key.text;
    if (/^[a-z]$/i.test(k)) {
      k = bits & MODIFIERS.Shift.bit ? k.toUpperCase() : chorded ? k.toLowerCase() : k;
      text = k;
    }
    if (chorded) text = undefined; // Ctrl+A selects, it doesn't type "a"
    const ev = { modifiers: bits, key: k, code: key.code, windowsVirtualKeyCode: key.vk };
    const commands = isMac && bits & MODIFIERS.Meta.bit && MAC_COMMANDS[k.toLowerCase()] ? [MAC_COMMANDS[k.toLowerCase()]] : undefined;
    const downEv = { type: text ? "keyDown" : "rawKeyDown", ...ev };
    if (text) Object.assign(downEv, { text, unmodifiedText: text });
    if (commands) downEv.commands = commands;
    await chrome.debugger.sendCommand(dbg, "Input.dispatchKeyEvent", downEv);
    await chrome.debugger.sendCommand(dbg, "Input.dispatchKeyEvent", { type: "keyUp", ...ev });
  }
  for (const m of down.reverse()) {
    bits &= ~MODIFIERS[m].bit;
    await chrome.debugger.sendCommand(dbg, "Input.dispatchKeyEvent", {
      type: "keyUp", modifiers: bits, key: m, code: MODIFIERS[m].code, windowsVirtualKeyCode: MODIFIERS[m].vk, location: 1,
    });
  }
}

const pressCombo = (dbg, combo) => pressParsed(dbg, parseCombo(combo));

// One printable character as a real key press (keydown/keypress/input/keyup).
async function typeChar(dbg, ch) {
  let info;
  try {
    info = keyInfo(ch);
  } catch {
    info = { key: ch, code: "", vk: 0, text: ch };
  }
  const upper = /^[A-Z]$/.test(ch);
  const ev = { key: ch, code: info.code, windowsVirtualKeyCode: upper ? ch.charCodeAt(0) : info.vk, modifiers: 0 };
  await chrome.debugger.sendCommand(dbg, "Input.dispatchKeyEvent", { type: "keyDown", ...ev, text: ch, unmodifiedText: ch });
  await chrome.debugger.sendCommand(dbg, "Input.dispatchKeyEvent", { type: "keyUp", ...ev });
}

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
