// End-to-end tests for the hub + peers bridge. Spawns real webmcp server
// processes (on a private test port, with a private token file) and a fake
// Chrome extension WebSocket client. Run with `npm test`.
//
// Env:
//   WEBMCP_TEST_PORT    port to use (default: random in 18700-18999)
//   WEBMCP_TEST_TMPDIR  where to put the temporary token file (default: os.tmpdir())
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "..", "src", "index.js");
const PORT = Number(process.env.WEBMCP_TEST_PORT || 18700 + Math.floor(Math.random() * 300));
const TMP = fs.mkdtempSync(path.join(process.env.WEBMCP_TEST_TMPDIR || os.tmpdir(), "webmcp-test-"));
const TOKEN_FILE = path.join(TMP, "peer-token");
const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 15_000, interval = 100, what = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${what}; last: ${last?.message ?? JSON.stringify(last)}`);
}

// ---------------------------------------------------------------------------
// Fake Chrome extension: connects like background.js, answers requests,
// reconnects quickly when the hub goes away.
// ---------------------------------------------------------------------------
class FakeExtension {
  constructor() {
    this.ws = null;
    this.stopped = false;
    this.connects = 0;
    this.handled = 0;
    this.clientResponses = new Map();
  }
  start() {
    this.stopped = false;
    this._connect();
  }
  _connect() {
    if (this.stopped) return;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, { origin: EXT_ORIGIN });
    this.ws = ws;
    ws.on("open", () => {
      this.connects++;
      ws.send(JSON.stringify({ type: "hello", role: "extension", version: "test" }));
    });
    ws.on("message", async (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "client-response") {
        this.clientResponses.set(msg.id, msg);
        return;
      }
      if (msg.type !== "request") return;
      await sleep(Math.random() * 40); // out-of-order responses exercise multiplexing
      let result;
      let ok = true;
      let error;
      switch (msg.method) {
        case "getActiveTab":
          result = { id: 7, title: "Active", url: "https://example.test/" };
          break;
        case "getPageInfo":
          result = { id: msg.params.tabId, title: `Tab ${msg.params.tabId}`, url: `https://t/${msg.params.tabId}` };
          break;
        case "listTabs":
          result = [{ id: 7, title: "Active", url: "https://example.test/", active: true }];
          break;
        default:
          ok = false;
          error = `Unknown method: ${msg.method}`;
      }
      this.handled++;
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "response", id: msg.id, ok, result, error }));
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      if (this.ws === ws) this.ws = null;
      if (!this.stopped) setTimeout(() => this._connect(), 100);
    });
  }
  get open() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }
  console(tabId, text) {
    this.ws.send(JSON.stringify({ type: "event", name: "console", data: { tabId, level: "log", text, timestamp: Date.now() } }));
  }
  clientRequest(method, params = {}) {
    const id = `cr-${Math.random()}`;
    this.ws.send(JSON.stringify({ type: "client-request", id, method, params }));
    return waitFor(() => this.clientResponses.get(id), { what: `client-response ${method}` });
  }
  stop() {
    this.stopped = true;
    this.ws?.close();
  }
}

// ---------------------------------------------------------------------------
// MCP server instances
// ---------------------------------------------------------------------------
const instances = [];

async function spawnInstance(name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, WEBMCP_PORT: String(PORT), WEBMCP_TOKEN_FILE: TOKEN_FILE },
    stderr: "pipe",
  });
  const stderr = [];
  transport.stderr?.on("data", (d) => stderr.push(d.toString()));
  const client = new Client({ name: `test-${name}`, version: "0.0.0" });
  await client.connect(transport);
  const inst = { name, client, transport, pid: transport.pid, stderr, dead: false };
  instances.push(inst);
  return inst;
}

async function call(inst, name, args = {}) {
  const res = await inst.client.callTool({ name, arguments: args });
  const textOut = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(textOut);
  try {
    return JSON.parse(textOut);
  } catch {
    return textOut;
  }
}

const status = (inst) => call(inst, "browser_connection_status");
const alive = () => instances.filter((i) => !i.dead);

async function killInstance(inst) {
  inst.dead = true;
  process.kill(inst.pid); // hard kill (TerminateProcess on Windows): no graceful close frames
  await inst.transport.close().catch(() => {});
}

const ext = new FakeExtension();

before(async () => {
  // Start the three instances at once so they really race for the port.
  await Promise.all([spawnInstance("a"), spawnInstance("b"), spawnInstance("c")]);
  ext.start();
});

after(async () => {
  ext.stop();
  for (const inst of instances) {
    await inst.transport.close().catch(() => {});
    try {
      process.kill(inst.pid);
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("exactly one hub, the others are peers, all see the extension", async () => {
  const statuses = await waitFor(
    async () => {
      const s = await Promise.all(alive().map(status));
      return s.every((x) => x.connected && x.peers === 2) ? s : null;
    },
    { what: "all instances connected" }
  );
  const roles = statuses.map((s) => s.role).sort();
  assert.deepEqual(roles, ["hub", "peer", "peer"]);
  const hubPids = new Set(statuses.map((s) => s.hubPid));
  assert.equal(hubPids.size, 1);
  assert.equal(fs.readFileSync(TOKEN_FILE, "utf8").trim().length, 64);
});

test("concurrent requests from all instances are routed back correctly", async () => {
  const jobs = [];
  for (const inst of alive()) {
    for (let i = 0; i < 25; i++) {
      const tabId = 1000 * (instances.indexOf(inst) + 1) + i;
      jobs.push(
        call(inst, "browser_get_page_info", { tabId }).then((info) => {
          assert.equal(info.id, tabId, `${inst.name} got a response meant for someone else`);
        })
      );
    }
    jobs.push(call(inst, "browser_get_page_info").then((info) => assert.equal(info.id, 7)));
  }
  await Promise.all(jobs);
});

test("console logs captured on the hub are readable from every instance", async () => {
  ext.console(42, "hello from tab 42");
  for (const inst of alive()) {
    const logs = await waitFor(async () => {
      const l = await call(inst, "browser_get_console_logs", { tabId: 42 });
      return l.length ? l : null;
    }, { what: "console logs" });
    assert.equal(logs[0].text, "hello from tab 42");
  }
});

test("extension-initiated (popup) requests are answered by the hub", async () => {
  const res = await ext.clientRequest("noSuchMethod");
  assert.equal(res.ok, false);
  assert.match(res.error, /Unknown client method/);
});

test("failover: killing the hub elects a new one and requests keep working", async () => {
  for (let round = 0; round < 2; round++) {
    const statuses = await Promise.all(alive().map(async (i) => ({ i, s: await status(i) })));
    const hub = statuses.find((x) => x.s.role === "hub").i;
    const before = ext.connects;
    await killInstance(hub);

    const survivors = alive();
    // Calls issued right after the kill must succeed (they wait for re-election).
    const immediate = await Promise.all(survivors.map((i) => call(i, "browser_get_page_info", { tabId: 5 })));
    for (const info of immediate) assert.equal(info.id, 5);

    const after = await waitFor(
      async () => {
        const s = await Promise.all(survivors.map(status));
        return s.every((x) => x.connected && x.peers === survivors.length - 1) ? s : null;
      },
      { what: `re-election round ${round}` }
    );
    assert.equal(after.filter((s) => s.role === "hub").length, 1);
    assert.ok(!after.some((s) => s.hubPid === hub.pid), "dead hub still reported");
    assert.ok(ext.connects > before, "extension did not reconnect to the new hub");
  }
  // One instance left: it's the hub and still works.
  const [last] = alive();
  assert.equal((await status(last)).role, "hub");
  const tabs = await call(last, "browser_list_tabs");
  assert.equal(tabs[0].id, 7);
});

test("a new instance joins the current hub as a peer", async () => {
  const d = await spawnInstance("d");
  const s = await waitFor(async () => {
    const x = await status(d);
    return x.connected ? x : null;
  }, { what: "late joiner connected" });
  assert.equal(s.role, "peer");
  assert.equal((await call(d, "browser_get_page_info", { tabId: 9 })).id, 9);
});

test("security: browser origins and unauthenticated peers are rejected", async () => {
  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  const attempt = (pathName, opts) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}${pathName}`, opts);
      ws.on("open", () => {
        ws.close();
        resolve("open");
      });
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode);
        ws.terminate();
      });
      ws.on("error", () => resolve("error"));
    });

  assert.equal(await attempt("/", { origin: "https://evil.example" }), 403, "web page origin as extension");
  assert.equal(await attempt("/", {}), 403, "no origin as extension");
  assert.equal(await attempt("/", { origin: "moz-extension://abc" }), 403);
  assert.equal(await attempt("/peer", {}), 401, "peer without token");
  assert.equal(await attempt("/peer", { headers: { "x-webmcp-token": "x".repeat(64) } }), 401, "peer with wrong token");
  assert.equal(
    await attempt("/peer", { origin: "https://evil.example", headers: { "x-webmcp-token": token } }),
    403,
    "peer from a browser origin"
  );
  assert.equal(await attempt("/other", { origin: EXT_ORIGIN }), 404);
  assert.equal(await attempt("/peer", { headers: { "x-webmcp-token": token } }), "open", "legit peer");
});

test("extension gone: requests fail fast with a clear error, no hang", async () => {
  ext.stop();
  const [inst] = alive();
  await waitFor(async () => !(await status(inst)).connected, { what: "disconnect noticed" });
  const started = Date.now();
  await assert.rejects(call(inst, "browser_list_tabs"), /Browser extension not connected/);
  // Within the reconnect grace window (6 s) plus slack, never the 15 s request timeout.
  assert.ok(Date.now() - started < 9_000, `took ${Date.now() - started} ms`);
});

test("graceful: when the MCP client closes stdin, the hub process exits and a peer takes over", async () => {
  ext.start();
  await spawnInstance("e");
  const statuses = await waitFor(
    async () => {
      const s = await Promise.all(alive().map(async (i) => ({ i, s: await status(i) })));
      return s.length >= 2 && s.every((x) => x.s.connected) ? s : null;
    },
    { what: "two connected instances" }
  );
  const hub = statuses.find((x) => x.s.role === "hub").i;
  hub.dead = true;
  // Close only our end of stdio (like Claude Code exiting) without killing it.
  hub.transport._process?.stdin?.end();
  await waitFor(() => {
    try {
      process.kill(hub.pid, 0);
      return false;
    } catch {
      return true; // process is gone: no orphan holding the port
    }
  }, { what: "hub process exit after stdin close" });
  const survivors = alive();
  const s = await waitFor(async () => {
    const x = await Promise.all(survivors.map(status));
    return x.every((y) => y.connected && y.hubPid !== hub.pid && y.peers === survivors.length - 1) ? x : null;
  }, { what: "a survivor became hub" });
  assert.equal(s.filter((x) => x.role === "hub").length, 1);
});

test("a port held by a non-webmcp server (e.g. an old version) is reported, then taken over", async () => {
  const { WebSocketServer } = await import("ws");
  const otherPort = PORT + 1000;
  const old = new WebSocketServer({ port: otherPort, host: "127.0.0.1" });
  await new Promise((r) => old.once("listening", r));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, WEBMCP_PORT: String(otherPort), WEBMCP_TOKEN_FILE: TOKEN_FILE },
    stderr: "pipe",
  });
  const client = new Client({ name: "test-legacy", version: "0.0.0" });
  await client.connect(transport);
  const inst = { name: "legacy", client, transport, pid: transport.pid, stderr: [], dead: false };
  instances.push(inst);
  try {
    const s1 = await status(inst);
    assert.equal(s1.connected, false);
    assert.match(s1.error, /Could not reach the WebMCP hub/);
    await new Promise((r) => old.close(r));
    const s2 = await waitFor(async () => {
      const x = await status(inst);
      return x.role === "hub" ? x : null;
    }, { what: "takeover after old server exit" });
    assert.equal(s2.role, "hub");
  } finally {
    inst.dead = true;
    await transport.close().catch(() => {});
  }
});
