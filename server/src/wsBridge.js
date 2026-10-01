import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { readOrCreateToken, tokenFilePath, tokensEqual } from "./token.js";

/**
 * Hub + peers bridge between any number of webmcp MCP server processes and
 * the single WebMCP Chrome extension.
 *
 * Every MCP client session (Claude Code, opencode, ...) spawns its own
 * webmcp process. Only one of them can own the WebSocket port; that one is
 * the HUB:
 *   - the Chrome extension connects to it on ws://127.0.0.1:<port>/
 *   - every other instance connects to it as a PEER on /peer (authenticated
 *     with a shared token file) and sends its browser requests through it.
 * The hub forwards peer requests to the extension (request ids are UUIDs, so
 * they multiplex on the one extension socket) and routes each response back
 * to the peer that asked. Console logs captured by the extension are kept on
 * the hub; peers read them with a hub call.
 *
 * Failover: when the hub process exits, its sockets close; peers race to bind
 * the port (with jitter), the winner becomes the new hub, the rest reconnect
 * to it as peers, and the extension's reconnect loop finds the new hub.
 *
 * Wire protocol (JSON text frames):
 *   hub <-> extension (unchanged from v1, so old extension builds still work)
 *     hub -> ext   {type:"request", id, method, params}
 *     ext -> hub   {type:"response", id, ok, result, error}
 *     ext -> hub   {type:"event", name:"console", data}
 *     ext -> hub   {type:"client-request", id, method, params}   (popup actions)
 *     hub -> ext   {type:"client-response", id, ok, result, error}
 *     v2 additions: ext -> hub {type:"hello", role:"extension", version}
 *                   ext -> hub {type:"ping"}  hub -> ext {type:"pong"}
 *                   hub -> ext {type:"hub-status", ...}
 *   peer <-> hub
 *     peer -> hub  {type:"hello", role:"peer", pid, version}
 *     peer -> hub  {type:"peer-request", id, method, params, timeoutMs}
 *     peer -> hub  {type:"hub-call", id, method, params}   (consoleLogs, status)
 *     hub -> peer  {type:"peer-response", id, ok, result, error}
 *     hub -> peer  {type:"hub-status", extensionConnected, peers, hubPid, version}
 */

export const PROTOCOL_VERSION = 2;
const HUB_INFO_PATH = "/webmcp";
const PEER_PATH = "/peer";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_LOG_LINES_PER_TAB = 500;
const HEARTBEAT_MS = 15_000;
const EXTENSION_ID_RE = /^chrome-extension:\/\/([a-p]{32})$/;

const log = (...args) => console.error("[webmcp-server]", ...args);
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min));

export function extensionNotConnectedError(port) {
  return new Error(
    `Browser extension not connected — is Chrome open with WebMCP enabled? ` +
      `(the extension should connect to ws://127.0.0.1:${port}; check the popup's port and status dot)`
  );
}

export class ExtensionBridge {
  /**
   * @param {object} opts
   * @param {number} opts.port
   * @param {string} [opts.host] interface to bind; always loopback by default
   * @param {object} [opts.clientHandlers] handlers for extension-initiated requests (popup)
   * @param {string} [opts.version] server version, reported in status
   * @param {string[]} [opts.allowedExtensionIds] if set, only these extension ids may connect
   * @param {string} [opts.tokenFile]
   * @param {number} [opts.roleWaitMs] how long a request waits for hub election to settle
   * @param {number} [opts.extensionGraceMs] how long the hub waits for the extension to (re)connect
   */
  constructor({
    port,
    host = "127.0.0.1",
    clientHandlers = {},
    version = "0.0.0",
    allowedExtensionIds = [],
    tokenFile = tokenFilePath(),
    roleWaitMs = 10_000,
    extensionGraceMs = 6_000,
    autoStart = true,
  }) {
    this.port = port;
    this.host = host;
    this.clientHandlers = clientHandlers;
    this.version = version;
    this.allowedExtensionIds = new Set(allowedExtensionIds.filter(Boolean));
    this.tokenFile = tokenFile;
    this.roleWaitMs = roleWaitMs;
    this.extensionGraceMs = extensionGraceMs;

    this.role = "electing"; // "electing" | "hub" | "peer"
    this.closed = false;
    this.roleWaiters = new Set();
    this.electTimer = null;
    this.foreignWarned = false;

    // hub state
    this.httpServer = null;
    this.wss = null;
    this.ext = null; // extension socket
    this.extInfo = null;
    this.extWaiters = new Set();
    this.peers = new Set();
    this.pending = new Map(); // id -> {resolve, reject, timer, method}
    this.consoleLogs = new Map(); // tabId -> [{level, text, timestamp}]
    this.hubSince = 0;
    this.extLastSeen = 0;
    this.heartbeat = null;

    // peer state
    this.hubSocket = null;
    this.hubStatus = null;
    this.peerPending = new Map();

    if (autoStart) this.start();
  }

  start() {
    this._elect();
  }

  // -------------------------------------------------------------------------
  // Election
  // -------------------------------------------------------------------------

  _scheduleElect(delayMs) {
    if (this.closed || this.electTimer) return;
    this.electTimer = setTimeout(() => {
      this.electTimer = null;
      this._elect();
    }, delayMs);
  }

  async _elect() {
    if (this.closed || this.role !== "electing") return;
    try {
      await this._listen();
      this._becomeHub();
      return;
    } catch (err) {
      if (this.closed) return;
      if (err.code !== "EADDRINUSE" && err.code !== "EACCES") {
        log(`Could not listen on ${this.host}:${this.port}: ${err.message}. Retrying.`);
        this._scheduleElect(jitter(1000, 3000));
        return;
      }
    }

    // Port is taken: is it a webmcp hub we can join?
    const info = await this._probeHub();
    if (this.closed) return;
    if (info === "refused") {
      // Hub just went away between our bind attempt and the probe: race again.
      this._scheduleElect(jitter(30, 300));
      return;
    }
    if (info && info.name === "webmcp-hub") {
      this.foreignWarned = false;
      try {
        await this._connectAsPeer();
        return;
      } catch (err) {
        if (this.closed) return;
        log(`Could not join hub on port ${this.port} as a peer: ${err.message}. Retrying.`);
        this._scheduleElect(jitter(200, 1000));
        return;
      }
    }
    if (!this.foreignWarned) {
      this.foreignWarned = true;
      log(
        `Port ${this.port} on ${this.host} is held by something that is not a webmcp hub ` +
          `(probably an older webmcp server version). Browser tools will fail until it exits; ` +
          `retrying every few seconds.`
      );
    }
    this._scheduleElect(jitter(2000, 5000));
  }

  _listen() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._handleHttp(req, res));
      const onError = (err) => {
        server.removeListener("listening", onListening);
        server.close();
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        this.httpServer = server;
        server.on("error", (err) => log("HTTP server error:", err.message || err));
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ port: this.port, host: this.host, exclusive: true });
    });
  }

  _probeHub() {
    return new Promise((resolve) => {
      const req = http.get(
        { host: this.host, port: this.port, path: HUB_INFO_PATH, timeout: 2000 },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => {
            if (body.length < 4096) body += c;
          });
          res.on("end", () => {
            try {
              const parsed = JSON.parse(body);
              resolve(parsed && typeof parsed === "object" ? parsed : "foreign");
            } catch {
              resolve("foreign");
            }
          });
        }
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (err) => resolve(err.code === "ECONNREFUSED" ? "refused" : "foreign"));
    });
  }

  _setRole(role) {
    this.role = role;
    if (role === "hub" || role === "peer") {
      for (const w of this.roleWaiters) w.resolve();
      this.roleWaiters.clear();
    }
  }

  _waitForRole() {
    if (this.role === "hub" || this.role === "peer") return Promise.resolve();
    if (this.closed) return Promise.reject(new Error("WebMCP bridge is shutting down"));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        this.roleWaiters.delete(waiter);
        reject(
          new Error(
            `Could not reach the WebMCP hub on 127.0.0.1:${this.port} within ${this.roleWaitMs} ms ` +
              `(port held by another program or an old webmcp version?).`
          )
        );
      }, this.roleWaitMs);
      this.roleWaiters.add(waiter);
    });
  }

  // -------------------------------------------------------------------------
  // Hub
  // -------------------------------------------------------------------------

  _handleHttp(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === HUB_INFO_PATH) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ name: "webmcp-hub", protocol: PROTOCOL_VERSION, version: this.version, pid: process.pid })
      );
      return;
    }
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("Upgrade Required");
  }

  _verifyClient(info) {
    const { req } = info;
    const pathname = new URL(req.url, "http://localhost").pathname;
    const origin = req.headers.origin;
    if (pathname === PEER_PATH) {
      // Peers are local Node processes: no browser Origin, and they must
      // present the shared token (browsers can't set custom WS headers).
      if (origin) return { ok: false, code: 403, reason: "peer connections must not carry an Origin" };
      let expected;
      try {
        expected = readOrCreateToken(this.tokenFile);
      } catch (err) {
        return { ok: false, code: 500, reason: err.message };
      }
      if (!tokensEqual(req.headers["x-webmcp-token"], expected)) {
        return { ok: false, code: 401, reason: "bad peer token" };
      }
      return { ok: true };
    }
    if (pathname === "/" || pathname === "/extension") {
      const m = typeof origin === "string" ? EXTENSION_ID_RE.exec(origin) : null;
      if (!m) return { ok: false, code: 403, reason: `origin not allowed: ${origin ?? "(none)"}` };
      if (this.allowedExtensionIds.size && !this.allowedExtensionIds.has(m[1])) {
        return { ok: false, code: 403, reason: `extension id not allowed: ${m[1]}` };
      }
      return { ok: true };
    }
    return { ok: false, code: 404, reason: "unknown path" };
  }

  _becomeHub() {
    this.wss = new WebSocketServer({
      server: this.httpServer,
      maxPayload: 64 * 1024 * 1024,
      verifyClient: (info, cb) => {
        const v = this._verifyClient(info);
        if (!v.ok) log(`Rejected WebSocket connection: ${v.reason}`);
        cb(v.ok, v.code, v.reason);
      },
    });
    this.wss.on("error", (err) => log("WebSocket server error:", err.message || err));
    this.wss.on("connection", (ws, req) => {
      const pathname = new URL(req.url, "http://localhost").pathname;
      ws.isAlive = true;
      ws.on("pong", () => (ws.isAlive = true));
      if (pathname === PEER_PATH) this._onPeer(ws);
      else this._onExtension(ws);
    });
    this.heartbeat = setInterval(() => this._heartbeatTick(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
    this.hubSince = Date.now();
    this._setRole("hub");
    log(`Hub: listening on ws://${this.host}:${this.port} (pid ${process.pid}); waiting for the Chrome extension.`);
  }

  _heartbeatTick() {
    for (const ws of this.wss?.clients ?? []) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* closing */
      }
    }
  }

  _hubStatus() {
    return {
      type: "hub-status",
      extensionConnected: this._extOpen(),
      extensionVersion: this.extInfo?.version,
      peers: this.peers.size,
      hubPid: process.pid,
      version: this.version,
      protocol: PROTOCOL_VERSION,
    };
  }

  _broadcastStatus() {
    const msg = JSON.stringify(this._hubStatus());
    for (const peer of this.peers) safeSend(peer, msg);
    if (this._extOpen()) safeSend(this.ext, msg);
  }

  _extOpen() {
    return !!this.ext && this.ext.readyState === WebSocket.OPEN;
  }

  _onExtension(ws) {
    // Only one browser extension talks to the hub. A new connection (e.g. the
    // extension reloaded, or reconnected after hub failover) replaces the old.
    if (this.ext && this.ext !== ws) {
      try {
        this.ext.close(4000, "replaced by a newer extension connection");
      } catch {
        /* ignore */
      }
    }
    this.ext = ws;
    this.extInfo = null;
    this.extLastSeen = Date.now();
    log("Chrome extension connected.");

    ws.on("message", (raw) => this._handleExtensionMessage(ws, raw));
    const onGone = () => {
      if (this.ext !== ws) return;
      this.ext = null;
      this.extLastSeen = Date.now();
      log("Chrome extension disconnected.");
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error(`Browser extension disconnected while handling "${p.method}". Try again.`));
      }
      this._broadcastStatus();
    };
    ws.on("close", onGone);
    ws.on("error", onGone);

    for (const w of this.extWaiters) w();
    this.extWaiters.clear();
    this._broadcastStatus();
  }

  _handleExtensionMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (ws === this.ext) this.extLastSeen = Date.now();

    switch (msg.type) {
      case "response": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || "Unknown extension error"));
        return;
      }
      case "event":
        if (msg.name === "console") this._recordConsole(msg.data);
        return;
      case "client-request":
        this._handleClientRequest(ws, msg);
        return;
      case "hello":
        this.extInfo = { version: msg.version };
        safeSend(ws, JSON.stringify(this._hubStatus()));
        return;
      case "ping":
        safeSend(ws, JSON.stringify({ type: "pong" }));
        return;
      default:
        return;
    }
  }

  _recordConsole(data) {
    const { tabId, level, text, timestamp } = data || {};
    if (typeof tabId !== "number") return;
    const list = this.consoleLogs.get(tabId) || [];
    list.push({ level, text, timestamp });
    while (list.length > MAX_LOG_LINES_PER_TAB) list.shift();
    this.consoleLogs.set(tabId, list);
  }

  /** Requests initiated by the extension (popup install/uninstall): the hub handles them. */
  async _handleClientRequest(ws, msg) {
    const { id, method, params } = msg;
    const respond = (ok, result, error) =>
      safeSend(ws, JSON.stringify({ type: "client-response", id, ok, result, error }));
    const handler = Object.prototype.hasOwnProperty.call(this.clientHandlers, method)
      ? this.clientHandlers[method]
      : null;
    if (!handler) return respond(false, undefined, `Unknown client method: ${method}`);
    try {
      respond(true, await handler(params || {}));
    } catch (err) {
      respond(false, undefined, err?.message || String(err));
    }
  }

  _onPeer(ws) {
    this.peers.add(ws);
    ws.on("message", (raw) => this._handlePeerMessage(ws, raw));
    const onGone = () => {
      if (this.peers.delete(ws)) this._broadcastStatus();
    };
    ws.on("close", onGone);
    ws.on("error", onGone);
    this._broadcastStatus();
  }

  async _handlePeerMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const reply = (ok, result, error) =>
      safeSend(ws, JSON.stringify({ type: "peer-response", id: msg.id, ok, result, error }));

    if (msg.type === "hello") {
      safeSend(ws, JSON.stringify(this._hubStatus()));
      return;
    }
    if (msg.type === "peer-request") {
      try {
        const timeoutMs = clampTimeout(msg.timeoutMs);
        reply(true, await this._extRequest(msg.method, msg.params || {}, timeoutMs));
      } catch (err) {
        reply(false, undefined, err?.message || String(err));
      }
      return;
    }
    if (msg.type === "hub-call") {
      try {
        if (msg.method === "consoleLogs") {
          const { tabId, clear, limit } = msg.params || {};
          reply(true, this._readConsole(tabId, { clear, limit }));
        } else if (msg.method === "status") {
          reply(true, this._hubStatus());
        } else {
          reply(false, undefined, `Unknown hub method: ${msg.method}`);
        }
      } catch (err) {
        reply(false, undefined, err?.message || String(err));
      }
    }
  }

  _readConsole(tabId, { clear = false, limit } = {}) {
    const list = this.consoleLogs.get(tabId) || [];
    const result = typeof limit === "number" ? list.slice(-limit) : list.slice();
    if (clear) this.consoleLogs.set(tabId, []);
    return result;
  }

  /**
   * Wait briefly for the extension if it is probably about to (re)connect:
   * right after this process became hub (failover), or right after the
   * extension dropped. Otherwise fail fast so tools don't hang when Chrome
   * simply isn't running.
   */
  _waitForExtension() {
    if (this._extOpen()) return Promise.resolve();
    const now = Date.now();
    const recent = now - this.hubSince < 15_000 || (this.extLastSeen && now - this.extLastSeen < 15_000);
    if (!recent) return Promise.reject(extensionNotConnectedError(this.port));
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.extWaiters.delete(done);
        reject(extensionNotConnectedError(this.port));
      }, this.extensionGraceMs);
      this.extWaiters.add(done);
    });
  }

  async _extRequest(method, params, timeoutMs) {
    await this._waitForExtension();
    const ws = this.ext;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${timeoutMs} ms waiting for the browser extension to answer "${method}".`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      ws.send(JSON.stringify({ type: "request", id, method, params }), (err) => {
        if (err && this.pending.delete(id)) {
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  _teardownHub() {
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error("WebMCP bridge is shutting down"));
    }
    for (const ws of this.wss?.clients ?? []) {
      try {
        ws.close(1012, "webmcp hub shutting down");
      } catch {
        /* ignore */
      }
    }
    this.wss?.close();
    this.httpServer?.close();
    // Don't wait for lingering sockets; peers will see the close and re-elect.
    setTimeout(() => {
      for (const ws of this.wss?.clients ?? []) ws.terminate();
      this.httpServer?.closeAllConnections?.();
    }, 200).unref?.();
  }

  // -------------------------------------------------------------------------
  // Peer
  // -------------------------------------------------------------------------

  _connectAsPeer() {
    return new Promise((resolve, reject) => {
      let token;
      try {
        token = readOrCreateToken(this.tokenFile);
      } catch (err) {
        reject(err);
        return;
      }
      const ws = new WebSocket(`ws://${this.host}:${this.port}${PEER_PATH}`, {
        headers: { "x-webmcp-token": token },
        handshakeTimeout: 3000,
        maxPayload: 64 * 1024 * 1024,
      });
      let opened = false;
      ws.on("unexpected-response", (_req, res) => {
        ws.terminate?.();
        reject(new Error(`hub refused the peer connection (HTTP ${res.statusCode})`));
      });
      ws.on("open", () => {
        opened = true;
        this.hubSocket = ws;
        this.hubStatus = null;
        this._setRole("peer");
        ws.send(JSON.stringify({ type: "hello", role: "peer", pid: process.pid, version: this.version }));
        log(`Peer: joined the webmcp hub on ws://${this.host}:${this.port}.`);
        resolve();
      });
      ws.on("message", (raw) => this._handleHubMessage(raw));
      ws.on("error", (err) => {
        if (!opened) reject(err);
      });
      ws.on("close", () => {
        if (!opened) {
          reject(new Error("connection closed during handshake"));
          return;
        }
        this._onHubLost(ws);
      });
    });
  }

  _handleHubMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "hub-status") {
      this.hubStatus = msg;
      return;
    }
    if (msg.type === "peer-response") {
      const p = this.peerPending.get(msg.id);
      if (!p) return;
      this.peerPending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || "Unknown hub error"));
    }
  }

  _onHubLost(ws) {
    if (this.hubSocket !== ws) return;
    this.hubSocket = null;
    this.hubStatus = null;
    for (const [id, p] of this.peerPending) {
      clearTimeout(p.timer);
      this.peerPending.delete(id);
      // Not retried automatically: the extension may already have executed
      // it (clicks, navigation are not idempotent).
      p.reject(new Error(`The webmcp hub went away while handling "${p.method}"; a new hub is being elected. Try again.`));
    }
    if (this.closed) return;
    log("Peer: hub connection lost; re-electing.");
    this._setRole("electing");
    this._scheduleElect(jitter(20, 400));
  }

  _peerSend(frame, method, timeoutMs) {
    const ws = this.hubSocket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Not connected to the webmcp hub; try again in a moment."));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.peerPending.delete(id);
        reject(new Error(`Timed out after ${timeoutMs} ms waiting for the webmcp hub to answer "${method}".`));
      }, timeoutMs);
      this.peerPending.set(id, { resolve, reject, timer, method });
      ws.send(JSON.stringify({ ...frame, id }), (err) => {
        if (err && this.peerPending.delete(id)) {
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // Public API (used by tools.js)
  // -------------------------------------------------------------------------

  /** Synchronous best-effort: does the hub currently have the extension? */
  isConnected() {
    if (this.role === "hub") return this._extOpen();
    if (this.role === "peer") return !!this.hubStatus?.extensionConnected;
    return false;
  }

  /** Send a request to the extension (directly, or via the hub) and await the result. */
  async request(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await this._waitForRole();
    if (this.role === "hub") return this._extRequest(method, params, timeoutMs);
    // Hub may itself wait up to extensionGraceMs for the extension, then up to timeoutMs.
    return this._peerSend(
      { type: "peer-request", method, params, timeoutMs },
      method,
      timeoutMs + this.extensionGraceMs + 2_000
    );
  }

  async getConsoleLogs(tabId, { clear = false, limit } = {}) {
    await this._waitForRole();
    if (this.role === "hub") return this._readConsole(tabId, { clear, limit });
    return this._peerSend({ type: "hub-call", method: "consoleLogs", params: { tabId, clear, limit } }, "consoleLogs", 5_000);
  }

  async status() {
    const base = { role: this.role, port: this.port, pid: process.pid, version: this.version };
    try {
      await this._waitForRole();
    } catch (err) {
      return { ...base, connected: false, error: err.message };
    }
    let hub;
    if (this.role === "hub") hub = this._hubStatus();
    else {
      try {
        hub = await this._peerSend({ type: "hub-call", method: "status" }, "status", 3_000);
      } catch (err) {
        return { ...base, role: this.role, connected: false, error: err.message };
      }
    }
    return {
      ...base,
      role: this.role,
      connected: !!hub.extensionConnected,
      extensionVersion: hub.extensionVersion,
      hubPid: hub.hubPid,
      hubVersion: hub.version,
      peers: hub.peers,
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.electTimer);
    for (const w of this.roleWaiters) w.resolve();
    this.roleWaiters.clear();
    if (this.role === "hub") this._teardownHub();
    if (this.hubSocket) {
      try {
        this.hubSocket.close(1000, "peer shutting down");
      } catch {
        /* ignore */
      }
    }
    for (const [id, p] of this.peerPending) {
      clearTimeout(p.timer);
      this.peerPending.delete(id);
      p.reject(new Error("WebMCP bridge is shutting down"));
    }
    this.role = "closed";
  }
}

function safeSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(data);
    } catch {
      /* socket closing */
    }
  }
}

function clampTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(n, 5 * 60_000);
}

