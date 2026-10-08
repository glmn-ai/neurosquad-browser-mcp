// Smoke test: one server process on a free port. It must bind 127.0.0.1, answer the hub
// info endpoint, accept the WebSocket handshake from a chrome-extension:// origin and
// refuse one from a web page. Never touches ~/.webmcp (private token file).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "webmcp-smoke-"));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function handshake(port, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { origin });
    ws.once("open", () => {
      ws.close();
      resolve({ ok: true });
    });
    ws.once("unexpected-response", (_req, res) => resolve({ ok: false, status: res.statusCode }));
    ws.once("error", (err) => resolve({ ok: false, error: err.message }));
  });
}

const port = await freePort();
const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, WEBMCP_PORT: String(port), WEBMCP_TOKEN_FILE: path.join(TMP, "peer-token") },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdout.resume();
child.stderr.resume();

after(async () => {
  child.stdin.end();
  if (child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const timer = setTimeout(() => child.kill(), 3000);
    await exited;
    clearTimeout(timer);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("server starts as hub on a free port and answers the info endpoint", async () => {
  const deadline = Date.now() + 15_000;
  let info;
  while (!info && Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/webmcp`);
      if (res.ok) info = await res.json();
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(info, "hub info endpoint did not answer");
  assert.equal(info.pid, child.pid);
});

test("WebSocket handshake: extension origin accepted, web page origin rejected", async () => {
  const ext = await handshake(port, "chrome-extension://abcdefghijklmnopabcdefghijklmnop");
  assert.deepEqual(ext, { ok: true });
  const page = await handshake(port, "https://example.com");
  assert.equal(page.ok, false);
  assert.equal(page.status, 403);
});
