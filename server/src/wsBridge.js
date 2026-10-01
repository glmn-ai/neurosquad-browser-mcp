import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_LOG_LINES_PER_TAB = 500;

/**
 * ExtensionBridge hosts a local WebSocket server that the WebMCP Chrome
 * extension connects to. It exposes a simple request/response RPC on top of
 * the socket so MCP tool handlers can ask the extension to do things in the
 * browser (read the DOM, click, navigate, screenshot, ...) and await a
 * result.
 */
export class ExtensionBridge {
  constructor({ port, clientHandlers = {} }) {
    this.port = port;
    this.socket = null;
    this.pending = new Map();
    this.consoleLogs = new Map(); // tabId -> [{level, args, timestamp}]
    // Handlers for requests initiated BY the extension (e.g. the popup asking
    // to install/uninstall an MCP client config), as opposed to `pending`
    // above, which tracks requests this server sent TO the extension.
    this.clientHandlers = clientHandlers;
    this.wss = new WebSocketServer({ port });

    this.wss.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `[webmcp-server] Port ${port} is already in use (likely another webmcp server ` +
            `instance still running). Browser tools will fail until that process exits or ` +
            `WEBMCP_PORT is changed. This MCP server will keep running for other tools, but ` +
            `the extension cannot connect on this port right now.`
        );
        return;
      }
      console.error("[webmcp-server] WebSocket server error:", err.message || err);
    });

    this.wss.on("connection", (ws) => {
      // Only one browser extension is expected to talk to this server. If a
      // new connection shows up (e.g. the extension reloaded), replace the
      // old one.
      if (this.socket && this.socket.readyState === this.socket.OPEN) {
        try {
          this.socket.close();
        } catch {
          /* ignore */
        }
      }
      this.socket = ws;

      ws.on("message", (raw) => this._handleMessage(raw));
      ws.on("close", () => {
        if (this.socket === ws) this.socket = null;
      });
      ws.on("error", () => {
        if (this.socket === ws) this.socket = null;
      });
    });
  }

  isConnected() {
    return !!this.socket && this.socket.readyState === this.socket.OPEN;
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "response") {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.ok) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(msg.error || "Unknown extension error"));
      }
      return;
    }

    if (msg.type === "event" && msg.name === "console") {
      const { tabId, level, text, timestamp } = msg.data || {};
      if (typeof tabId !== "number") return;
      const list = this.consoleLogs.get(tabId) || [];
      list.push({ level, text, timestamp });
      while (list.length > MAX_LOG_LINES_PER_TAB) list.shift();
      this.consoleLogs.set(tabId, list);
      return;
    }

    if (msg.type === "client-request") {
      this._handleClientRequest(msg);
    }
  }

  /**
   * Handle a request initiated by the extension itself (popup UI), as
   * opposed to a response to a request this server sent. Used for local
   * management actions like listing/installing MCP clients.
   */
  async _handleClientRequest(msg) {
    const { id, method, params } = msg;
    const handler = this.clientHandlers[method];
    const ws = this.socket;
    if (!ws) return;

    const respond = (ok, result, error) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ type: "client-response", id, ok, result, error }));
    };

    if (!handler) {
      respond(false, undefined, `Unknown client method: ${method}`);
      return;
    }

    try {
      const result = await handler(params || {});
      respond(true, result);
    } catch (err) {
      respond(false, undefined, err?.message || String(err));
    }
  }

  getConsoleLogs(tabId, { clear = false, limit } = {}) {
    const list = this.consoleLogs.get(tabId) || [];
    const result = typeof limit === "number" ? list.slice(-limit) : list.slice();
    if (clear) this.consoleLogs.set(tabId, []);
    return result;
  }

  /**
   * Send a request to the extension and wait for its response.
   */
  request(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.isConnected()) {
      return Promise.reject(
        new Error(
          "WebMCP Chrome extension is not connected. Make sure Chrome is running with the extension installed and enabled."
        )
      );
    }

    const id = randomUUID();
    const payload = JSON.stringify({ type: "request", id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for extension response to "${method}"`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      this.socket.send(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  close() {
    for (const { timer, reject } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("Bridge is shutting down"));
    }
    this.pending.clear();
    this.wss.close();
  }
}
