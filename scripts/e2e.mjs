#!/usr/bin/env node
// Live end-to-end test: the real extension in a real Chrome for Testing,
// driven through the real MCP server over stdio. MANUAL — not part of CI
// (it needs a Chrome window with the unpacked extension and, on the first
// run, downloads React/Draft.js from unpkg for the test page).
//
//   node scripts/e2e.mjs --chrome <path to Chrome for Testing> [--work <dir>] [--shots <dir>] [--keep]
//
// Everything is private to the run: a fresh --user-data-dir, a copy of
// extension/ whose default port is patched to a random free port (so it never
// talks to a webmcp server you already run on 47615), its own server process
// (WEBMCP_PORT, WEBMCP_TOKEN_FILE under --work) and a local HTTP test page.
// --shots saves screencast frames of the agent cursor gliding and clicking.
// Branded Google Chrome ignores --load-extension since 137: use Chrome for
// Testing (npx @puppeteer/browsers install chrome@stable).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverRequire = createRequire(path.join(root, "server", "package.json"));
const { WebSocket } = serverRequire("ws");
const sdk = (p) => import(pathToFileURL(serverRequire.resolve(`@modelcontextprotocol/sdk/${p}`)).href);
const { Client } = await sdk("client/index.js");
const { StdioClientTransport } = await sdk("client/stdio.js");

// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const CHROME = opt("chrome", process.env.CHROME_PATH);
if (!CHROME || !fs.existsSync(CHROME)) {
  console.error("Pass --chrome <path to Chrome for Testing> (or CHROME_PATH).");
  process.exit(2);
}
const WORK = path.resolve(opt("work", path.join(os.tmpdir(), `webmcp-e2e-${process.pid}`)));
const SHOTS = opt("shots") ? path.resolve(opt("shots")) : null;
const KEEP = args.includes("--keep");
const VENDOR = path.join(path.dirname(WORK), "vendor"); // shared download cache
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(VENDOR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[e2e]", ...a);

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

async function waitUntil(fn, { timeout = 15_000, interval = 150, what = "condition" } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${what} (${last?.message ?? JSON.stringify(last)})`);
}

// ---------------------------------------------------------------------------
// Test page
// ---------------------------------------------------------------------------
const VENDOR_FILES = {
  "react.js": "https://unpkg.com/react@18.3.1/umd/react.production.min.js",
  "react-dom.js": "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js",
  "immutable.js": "https://unpkg.com/immutable@3.7.6/dist/immutable.min.js",
  "draft.js": "https://unpkg.com/draft-js@0.11.7/dist/Draft.min.js",
  "draft.css": "https://unpkg.com/draft-js@0.11.7/dist/Draft.css",
};

async function ensureVendor() {
  for (const [name, url] of Object.entries(VENDOR_FILES)) {
    const file = path.join(VENDOR, name);
    if (fs.existsSync(file) && fs.statSync(file).size > 0) continue;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download ${url}: ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
}

// No greens anywhere on the page: the overlay check counts green pixels.
const MAIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>webmcp e2e</title>
<link rel="stylesheet" href="/vendor/draft.css">
<style>
  body { margin: 0; background: #11131f; color: #e6e8f2; font: 15px/1.4 system-ui, sans-serif; }
  .wrap { padding: 24px 40px; }
  button { background: #5b4bd6; color: #fff; border: 0; border-radius: 8px; padding: 10px 18px; font: inherit; cursor: pointer; }
  button:hover { background: #7a6cf0; }
  #hover { margin: 70px 0; height: 46px; background: #23263a; border-radius: 10px; display: flex; align-items: center; padding: 0 16px; color: #9aa0c0; }
  #hover:hover { background: #3b3466; }
  input, [contenteditable], #draft { display: block; width: 420px; margin: 8px 0; padding: 9px 12px; font: inherit;
    color: #e6e8f2; background: #1b1e30; border: 1px solid #3a3f5c; border-radius: 8px; }
  #draft { min-height: 40px; }
  .row { display: flex; gap: 14px; align-items: center; margin: 10px 0; }
  #feed li { padding: 18px; margin: 6px 0; background: #1b1e30; border-radius: 8px; list-style: none; }
  .state { color: #b7a8ff; font-family: monospace; min-height: 1.2em; }
</style></head><body><div class="wrap">
  <h1>Agent test bench</h1>
  <div class="row"><button id="btn">Trusted?</button><button id="spawn">Spawn later</button><button id="snap">Snap target</button>
    <span id="snap-count" class="state">0</span></div>
  <div id="hover">Hover strip: the cursor crosses me on its way down</div>
  <div class="row"><button id="target2">Below the strip</button><button id="far" style="margin-left:520px">Far right</button></div>
  <h2>React form</h2>
  <div id="app"></div>
  <h2>Draft.js</h2>
  <div id="draft-app"></div>
  <h2>Feed</h2>
  <ul id="feed"></ul><div id="sentinel" style="height:1px"></div>
</div>
<script>
  window.__clicks = []; window.__hover = 0; window.__moves = []; window.__events = [];
  document.addEventListener("click", (e) => __clicks.push({ id: e.target.id, isTrusted: e.isTrusted, x: e.clientX, y: e.clientY, button: e.button, detail: e.detail }), true);
  document.addEventListener("dblclick", (e) => __events.push({ type: "dblclick", id: e.target.id, isTrusted: e.isTrusted }), true);
  document.addEventListener("mousemove", (e) => { if (e.isTrusted) __moves.push({ t: performance.now(), x: e.clientX, y: e.clientY }); }, true);
  document.getElementById("hover").addEventListener("mouseover", (e) => { if (e.isTrusted) __hover++; });
  const t2 = document.getElementById("target2");
  t2.addEventListener("mouseenter", (e) => __events.push({ type: "enter", id: "target2", t: performance.now(), isTrusted: e.isTrusted }));
  t2.addEventListener("mousedown", (e) => __events.push({ type: "down", id: "target2", t: performance.now(), isTrusted: e.isTrusted }));
  document.getElementById("spawn").onclick = () => setTimeout(() => {
    const d = document.createElement("div"); d.id = "later"; d.textContent = "Later ready"; d.className = "state";
    document.getElementById("spawn").after(d);
  }, 1200);
  document.getElementById("snap").onclick = () => { const c = document.getElementById("snap-count"); c.textContent = String(+c.textContent + 1); };
  let n = 0;
  const feed = document.getElementById("feed");
  const more = (k) => { for (let i = 0; i < k; i++) { const li = document.createElement("li"); li.textContent = "Item " + (++n); feed.appendChild(li); } };
  more(30);
  new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) more(20); }).observe(document.getElementById("sentinel"));
</script>
<script src="/vendor/react.js"></script><script src="/vendor/react-dom.js"></script>
<script src="/vendor/immutable.js"></script><script src="/vendor/draft.js"></script>
<script>
  const h = React.createElement;
  function App() {
    const [name, setName] = React.useState("");
    const [email, setEmail] = React.useState("");
    const [submitted, setSubmitted] = React.useState("");
    const [note, setNote] = React.useState("");
    return h("div", null,
      h("form", { id: "form", onSubmit: (e) => { e.preventDefault(); setSubmitted(name); } },
        h("label", { htmlFor: "name" }, "Your name"),
        h("input", { id: "name", value: name, placeholder: "Name", onChange: (e) => setName(e.target.value) }),
        h("input", { id: "email", type: "email", "aria-label": "Email", value: email, onChange: (e) => setEmail(e.target.value) }),
        h("button", { id: "submit", type: "submit" }, "Send")),
      h("div", { id: "name-state", className: "state" }, name),
      h("div", { id: "email-state", className: "state" }, email),
      h("div", { id: "submitted", className: "state" }, submitted ? "submitted: " + submitted : ""),
      h("div", { id: "ce", contentEditable: true, suppressContentEditableWarning: true, role: "textbox", "aria-label": "Note",
        onInput: (e) => setNote(e.currentTarget.textContent) }),
      h("div", { id: "ce-state", className: "state" }, note));
  }
  ReactDOM.createRoot(document.getElementById("app")).render(h(App));
  function DraftBox() {
    const [state, setState] = React.useState(() => Draft.EditorState.createEmpty());
    return h("div", null,
      h("div", { id: "draft" }, h(Draft.Editor, { editorState: state, onChange: setState, placeholder: "What's happening?" })),
      h("div", { id: "draft-state", className: "state" }, state.getCurrentContent().getPlainText()));
  }
  if (window.Draft) ReactDOM.render(h(DraftBox), document.getElementById("draft-app"));
</script></body></html>`;

const PAGE2 = `<!doctype html><html><head><meta charset="utf-8"><title>webmcp e2e page 2</title>
<style>body { margin: 0; background: #11131f; color: #fff; font: 15px system-ui; }
#box { margin: 60px; width: 200px; height: 120px; border-radius: 14px; background: linear-gradient(135deg, #5b4bd6, #2f6fe0);
  display: flex; align-items: center; justify-content: center; font-weight: 700; }
button { margin: 0 60px; background: #5b4bd6; color: #fff; border: 0; border-radius: 8px; padding: 10px 18px; }</style></head>
<body><div id="box">BOX</div><button id="p2btn">Page 2 button</button></body></html>`;

function startHttp() {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...extra });
      res.end(body);
    };
    if (url.pathname === "/") return send(200, "text/html; charset=utf-8", MAIN_PAGE);
    if (url.pathname === "/page2") return send(200, "text/html; charset=utf-8", PAGE2);
    if (url.pathname === "/api/data") return send(200, "application/json", JSON.stringify({ ok: true, items: [1, 2, 3] }));
    if (url.pathname === "/api/cors") {
      return send(200, "application/json", JSON.stringify({ cors: true }), { "access-control-allow-origin": "*" });
    }
    if (url.pathname === "/api/echo") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => send(200, "application/json", JSON.stringify({ method: req.method, body, cookie: req.headers.cookie || null })));
      return;
    }
    if (url.pathname.startsWith("/vendor/")) {
      const file = path.join(VENDOR, path.basename(url.pathname));
      if (fs.existsSync(file)) return send(200, file.endsWith(".css") ? "text/css" : "text/javascript", fs.readFileSync(file));
    }
    send(404, "text/plain", "not found");
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}

// ---------------------------------------------------------------------------
// Minimal CDP client for the harness (zoom, storage, frames): never used by
// the code under test, which goes through the MCP server only.
// ---------------------------------------------------------------------------
class Cdp {
  static async connect(url) {
    const c = new Cdp();
    c.ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    c.seq = 0;
    c.pending = new Map();
    c.listeners = [];
    c.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && c.pending.has(msg.id)) {
        const p = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method) for (const l of c.listeners) l(msg);
    });
    await new Promise((resolve, reject) => {
      c.ws.once("open", resolve);
      c.ws.once("error", reject);
    });
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) {
    this.listeners.push(fn);
  }
  close() {
    this.ws.close();
  }
}

// ---------------------------------------------------------------------------
// PNG helpers: size and a count of greenish pixels (the overlay's palette).
// ---------------------------------------------------------------------------
function decodePng(buf) {
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const depth = buf[24];
  const ctype = buf[25];
  const idat = [];
  for (let off = 8; off < buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  if (depth !== 8 || (ctype !== 6 && ctype !== 2)) return { width, height, pixels: null };
  const bpp = ctype === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, bpp, pixels: out };
}

function greenPixels(png) {
  const { pixels, bpp } = decodePng(png);
  if (!pixels) return -1;
  let n = 0;
  for (let i = 0; i < pixels.length; i += bpp) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    if (g - r > 40 && g >= b + 8) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail, ms: Date.now() - t0 });
    log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message, ms: Date.now() - t0 });
    log(`FAIL ${name} — ${err.message}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

let chrome;
let transport;
let httpSrv;
let cdp;
const cleanup = async () => {
  try {
    cdp?.close();
  } catch {}
  await transport?.close().catch(() => {});
  if (chrome?.pid && chrome.exitCode === null) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
    else chrome.kill("SIGKILL");
  }
  httpSrv?.close();
  await sleep(800);
  if (!KEEP) fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
};

try {
  await ensureVendor().catch((err) => log(`vendor download failed (${err.message}); React/Draft checks will fail`));
  httpSrv = await startHttp();
  const HP = httpSrv.address().port;
  const MAIN = `http://127.0.0.1:${HP}/`;
  const PAGE2_URL = `http://localhost:${HP}/page2`;
  const WS_PORT = await freePort();

  // Extension copy, default port patched to ours.
  const extDir = path.join(WORK, "extension");
  fs.cpSync(path.join(root, "extension"), extDir, { recursive: true });
  const bgFile = path.join(extDir, "background.js");
  const bg = fs.readFileSync(bgFile, "utf8");
  const patched = bg.replace(/const DEFAULT_PORT = \d+;/, `const DEFAULT_PORT = ${WS_PORT};`);
  if (patched === bg) throw new Error("could not patch DEFAULT_PORT in the extension copy");
  fs.writeFileSync(bgFile, patched);

  // Server first, so the extension finds it at once.
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "server", "src", "index.js")],
    env: { ...process.env, WEBMCP_PORT: String(WS_PORT), WEBMCP_TOKEN_FILE: path.join(WORK, "peer-token") },
    stderr: "pipe",
  });
  const client = new Client({ name: "webmcp-e2e", version: "0.0.0" });
  await client.connect(transport);

  const profile = path.join(WORK, "profile");
  chrome = spawn(
    CHROME,
    [
      `--user-data-dir=${profile}`,
      `--load-extension=${extDir}`,
      `--disable-extensions-except=${extDir}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-search-engine-choice-screen",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-features=CalculateNativeWinOcclusion",
      "--window-size=1280,900",
      `--window-position=${opt("window-position", "40,40")}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  log(`chrome pid ${chrome.pid}, server port ${WS_PORT}, http ${HP}`);

  const devtoolsFile = path.join(profile, "DevToolsActivePort");
  const [rdpPort, rdpPath] = (await waitUntil(() => fs.existsSync(devtoolsFile) && fs.readFileSync(devtoolsFile, "utf8").trim(), { what: "DevToolsActivePort" })).split(/\r?\n/);
  cdp = await Cdp.connect(`ws://127.0.0.1:${rdpPort}${rdpPath}`);

  // ---- MCP helpers ----
  const call = async (name, a = {}) => {
    const res = await client.callTool({ name, arguments: a });
    const textPart = res.content?.find((c) => c.type === "text")?.text ?? "";
    if (res.isError) throw new Error(textPart);
    const image = res.content?.find((c) => c.type === "image");
    if (image) return { image: Buffer.from(image.data, "base64"), text: textPart };
    try {
      return JSON.parse(textPart);
    } catch {
      return textPart;
    }
  };
  const js = (tabId, code) => call("browser_execute_script", { tabId, code });

  await waitUntil(async () => (await call("browser_connection_status")).connected, { timeout: 20_000, what: "extension connected" });
  log("extension connected");

  // Harness access to the extension's service worker (zoom, storage, groups).
  // Our service worker: the one whose manifest is ours (component extensions have workers too).
  const swSession = await waitUntil(async () => {
    const { targetInfos } = await cdp.send("Target.getTargets");
    for (const t of targetInfos.filter((x) => x.type === "service_worker" && x.url.startsWith("chrome-extension://"))) {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      const r = await cdp.send("Runtime.evaluate", { expression: "chrome.runtime.getManifest().name", returnByValue: true }, sessionId);
      if (r.result?.value === "NeuroSquad Browser MCP") return sessionId;
      await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
    return null;
  }, { what: "extension service worker" });
  const sw = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, swSession);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const tabs = await call("browser_list_tabs");
  const mainTab = tabs.find((t) => t.active)?.id ?? tabs[0].id;
  await call("browser_navigate", { tabId: mainTab, url: MAIN });

  await check("wait_for loadState load after navigate", async () => {
    const r = await call("browser_wait_for", { tabId: mainTab, loadState: "load", timeout: 15_000 });
    assert(r.matched, "not matched");
    await call("browser_wait_for", { tabId: mainTab, selector: "#name", timeout: 10_000 });
    return `${r.waitedMs} ms`;
  });

  const pageTarget = async (urlPrefix) => {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const t = targetInfos.find((x) => x.type === "page" && x.url.startsWith(urlPrefix));
    if (!t) throw new Error(`no page target for ${urlPrefix}`);
    return (await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId;
  };
  const mainSession = await pageTarget(MAIN);
  const harnessShot = async () => Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" }, mainSession)).data, "base64");

  await check("trusted click: isTrusted === true", async () => {
    const r = await call("browser_click", { tabId: mainTab, selector: "#btn" });
    assert(r.clicked && r.trusted, `bad result ${JSON.stringify(r)}`);
    const clicks = await js(mainTab, "return __clicks.filter(c => c.id === 'btn')");
    assert(clicks.length === 1 && clicks[0].isTrusted === true, `clicks ${JSON.stringify(clicks)}`);
    return `at ${r.x},${r.y}`;
  });

  await check("hover fires during the cursor glide; press after arrival", async () => {
    await js(mainTab, "__hover = 0; __moves.length = 0; __events.length = 0; return true");
    const t0 = Date.now();
    await call("browser_click", { tabId: mainTab, selector: "#target2" });
    const took = Date.now() - t0;
    const s = await js(mainTab, "return { hover: __hover, moves: __moves.length, events: __events }");
    assert(s.hover > 0, `hover strip got no trusted mouseover (${JSON.stringify(s)})`);
    assert(s.moves >= 5, `only ${s.moves} trusted mousemoves`);
    const enter = s.events.find((e) => e.type === "enter");
    const down = s.events.find((e) => e.type === "down");
    assert(enter && down && enter.t <= down.t && down.isTrusted, `events ${JSON.stringify(s.events)}`);
    return `${s.moves} moves, ${s.hover} hover hits, click took ${took} ms`;
  });

  await check("double click (clickCount 2) and x/y click", async () => {
    await js(mainTab, "__events.length = 0; return true");
    await call("browser_click", { tabId: mainTab, selector: "#snap", clickCount: 2 });
    const ev = await js(mainTab, "return __events.filter(e => e.type === 'dblclick')");
    assert(ev.length === 1 && ev[0].isTrusted, `dblclick ${JSON.stringify(ev)}`);
    const rect = await js(mainTab, "const r = document.getElementById('btn').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }");
    await js(mainTab, "__clicks.length = 0; return true");
    await call("browser_click", { tabId: mainTab, x: Math.round(rect.x), y: Math.round(rect.y) });
    const c = await js(mainTab, "return __clicks");
    assert(c.length === 1 && c[0].id === "btn" && c[0].isTrusted, `xy click ${JSON.stringify(c)}`);
    return "ok";
  });

  await check("type into a React input updates state", async () => {
    const r = await call("browser_type", { tabId: mainTab, selector: "#name", text: "Hello NeuroSquad" });
    const state = await js(mainTab, "return document.getElementById('name-state').textContent");
    assert(state === "Hello NeuroSquad", `state ${JSON.stringify(state)} (tool value ${JSON.stringify(r.value)})`);
    return `value=${r.value}`;
  });

  await check("type with clear + per-key delay", async () => {
    await call("browser_type", { tabId: mainTab, selector: "#name", text: "Ada", clear: true, delay: 25 });
    const state = await js(mainTab, "return document.getElementById('name-state').textContent");
    assert(state === "Ada", `state ${JSON.stringify(state)}`);
    return "ok";
  });

  await check("press_key Enter submits the form", async () => {
    await call("browser_press_key", { tabId: mainTab, selector: "#name", key: "Enter" });
    const s = await waitUntil(() => js(mainTab, "return document.getElementById('submitted').textContent"), { timeout: 3000, what: "submit" });
    assert(s === "submitted: Ada", `submitted ${JSON.stringify(s)}`);
    return s;
  });

  await check("press_key Control+A then Backspace clears", async () => {
    await call("browser_press_key", { tabId: mainTab, selector: "#name", key: process.platform === "darwin" ? "Meta+A" : "Control+A" });
    await call("browser_press_key", { tabId: mainTab, key: "Backspace" });
    const s = await js(mainTab, "return document.getElementById('name-state').textContent");
    assert(s === "", `still ${JSON.stringify(s)}`);
    return "ok";
  });

  await check("type into a React contenteditable updates state", async () => {
    await call("browser_type", { tabId: mainTab, selector: "#ce", text: "Typed in CE" });
    const s = await js(mainTab, "return document.getElementById('ce-state').textContent");
    assert(s === "Typed in CE", `state ${JSON.stringify(s)}`);
    return "ok";
  });

  await check("type into Draft.js (x.com's editor) updates EditorState", async () => {
    const has = await js(mainTab, "return !!document.querySelector('#draft .public-DraftEditor-content')");
    assert(has, "Draft.js did not load");
    await call("browser_type", { tabId: mainTab, selector: "#draft .public-DraftEditor-content", text: "Draft hello" });
    let s = await waitUntil(() => js(mainTab, "return document.getElementById('draft-state').textContent"), { timeout: 3000, what: "draft state" });
    assert(s === "Draft hello", `state ${JSON.stringify(s)}`);
    await call("browser_type", { tabId: mainTab, selector: "#draft .public-DraftEditor-content", text: "Replaced", clear: true });
    s = await js(mainTab, "return document.getElementById('draft-state').textContent");
    assert(s === "Replaced", `after clear ${JSON.stringify(s)}`);
    return "type + clear ok";
  });

  let snapText = "";
  await check("snapshot refs work for click and type", async () => {
    snapText = await call("browser_snapshot", { tabId: mainTab });
    const ref = (re) => (snapText.match(re) || [])[1];
    const snapRef = ref(/\[(e\d+)\] button "Snap target"/);
    const emailRef = ref(/\[(e\d+)\] textbox "Email"/);
    assert(snapRef && emailRef, `refs not found in:\n${snapText.slice(0, 1200)}`);
    const before = Number(await js(mainTab, "return document.getElementById('snap-count').textContent"));
    await call("browser_click", { tabId: mainTab, ref: snapRef });
    const after = Number(await js(mainTab, "return document.getElementById('snap-count').textContent"));
    assert(after === before + 1, `count ${before} -> ${after}`);
    await call("browser_type", { tabId: mainTab, ref: emailRef, text: "a@b.co" });
    const email = await js(mainTab, "return document.getElementById('email-state').textContent");
    assert(email === "a@b.co", `email ${JSON.stringify(email)}`);
    const scoped = await call("browser_snapshot", { tabId: mainTab, selector: "#form" });
    assert(/textbox "Your name"/.test(scoped) && !/Snap target/.test(scoped), `scoped snapshot: ${scoped}`);
    return `${snapText.split("\n")[1]}; refs ${snapRef}, ${emailRef}`;
  });

  await check("wait_for: delayed element, text, timeout error", async () => {
    await call("browser_click", { tabId: mainTab, selector: "#spawn" });
    const r = await call("browser_wait_for", { tabId: mainTab, selector: "#later", timeout: 5000 });
    assert(r.matched && r.waitedMs >= 500, `waited ${r.waitedMs}`);
    await call("browser_wait_for", { tabId: mainTab, text: "Later ready", timeout: 2000 });
    let err = "";
    try {
      await call("browser_wait_for", { tabId: mainTab, selector: "#never", timeout: 400 });
    } catch (e) {
      err = e.message;
    }
    assert(/Timed out after 400 ms/.test(err), `no timeout error: ${err}`);
    await call("browser_wait_for", { tabId: mainTab, url: "/127\\.0\\.0\\.1:\\d+\\/$/", loadState: "networkidle", timeout: 5000 });
    return `appeared after ${r.waitedMs} ms`;
  });

  await check("scroll reports new content", async () => {
    const r = await call("browser_scroll", { tabId: mainTab, to: "bottom", waitMs: 1500 });
    assert(r.newContent === true && r.scrollHeightAfter > r.scrollHeightBefore, JSON.stringify(r));
    const r2 = await call("browser_scroll", { tabId: mainTab, y: -300 });
    assert(r2.scrolledBy.y === -300, JSON.stringify(r2));
    const r3 = await call("browser_scroll", { tabId: mainTab, selector: "#btn" });
    assert(r3.element && r3.element.startsWith("button"), JSON.stringify(r3));
    return `${r.scrollHeightBefore} -> ${r.scrollHeightAfter}`;
  });

  await check("overlay absent from screenshots (present on the page)", async () => {
    await call("browser_scroll", { tabId: mainTab, to: "top" });
    await call("browser_click", { tabId: mainTab, selector: "#far" });
    const withOverlay = greenPixels(await harnessShot());
    const shot = await call("browser_screenshot", { tabId: mainTab });
    const inShot = greenPixels(shot.image);
    const el = await call("browser_screenshot", { tabId: mainTab, selector: "#far" });
    const inEl = greenPixels(el.image);
    const full = await call("browser_screenshot", { tabId: mainTab, fullPage: true });
    const inFull = greenPixels(full.image);
    assert(withOverlay > 500, `overlay not visible on the page? ${withOverlay} green px`);
    assert(inShot < 30 && inEl < 30 && inFull < 30, `overlay in screenshots: visible ${inShot}, element ${inEl}, full ${inFull}`);
    const { height } = decodePng(full.image);
    return `page ${withOverlay} green px; shots ${inShot}/${inEl}/${inFull}; full page ${height}px tall`;
  });

  let tab2;
  let groupId;
  await check("open_tab lands in the NeuroSquad group", async () => {
    const r = await call("browser_open_tab", { url: PAGE2_URL });
    tab2 = r.id;
    groupId = r.groupId;
    assert(Number.isInteger(groupId), `no groupId ${JSON.stringify(r)}`);
    const g = await sw(`chrome.tabGroups.get(${groupId})`);
    assert(g.title === "NeuroSquad" && g.collapsed === false, JSON.stringify(g));
    const r2 = await call("browser_open_tab", { url: PAGE2_URL + "?2" });
    assert(r2.groupId === groupId, `second tab in group ${r2.groupId}`);
    const mainGroup = (await sw(`chrome.tabs.get(${mainTab})`)).groupId;
    assert(mainGroup === -1, "the user's tab was regrouped");
    await call("browser_close_tab", { tabId: r2.id });
    return `group ${groupId} "${g.title}" (${g.color})`;
  });

  await check("element screenshot of a background tab doesn't activate it", async () => {
    await call("browser_wait_for", { tabId: tab2, selector: "#box", timeout: 10_000 });
    const shot = await call("browser_screenshot", { tabId: tab2, selector: "#box" });
    const list = await call("browser_list_tabs");
    const t2 = list.find((t) => t.id === tab2);
    const t1 = list.find((t) => t.id === mainTab);
    assert(!t2.active && t1.active, `activation changed: main ${t1.active}, tab2 ${t2.active}`);
    const { width, height } = decodePng(shot.image);
    const dpr = await js(tab2, "return devicePixelRatio");
    assert(Math.abs(width - 200 * dpr) <= 2 && Math.abs(height - 120 * dpr) <= 2, `size ${width}x${height} at dpr ${dpr}`);
    assert(greenPixels(shot.image) < 10, "overlay in the element shot");
    return `${width}x${height} (dpr ${dpr}), tab stayed in background`;
  });

  await check("site policy: read-only blocks a click, blocked refuses reads", async () => {
    await sw(`chrome.storage.local.set({ sitePolicy: [{ pattern: "localhost", mode: "read-only" }] })`);
    await sleep(150);
    let err = "";
    try {
      await call("browser_click", { tabId: tab2, selector: "#p2btn" });
    } catch (e) {
      err = e.message;
    }
    assert(/Site policy: localhost is read-only/.test(err), `click not refused: ${err}`);
    const snap = await call("browser_snapshot", { tabId: tab2 });
    assert(/Page 2 button/.test(snap), "read-only should still allow snapshot");
    let ferr = "";
    try {
      await call("browser_fetch", { tabId: tab2, url: "/api/echo", method: "POST", body: "x" });
    } catch (e) {
      ferr = e.message;
    }
    assert(/read-only/.test(ferr), `POST fetch not refused: ${ferr}`);
    await sw(`chrome.storage.local.set({ sitePolicy: [{ pattern: "localhost", mode: "blocked" }] })`);
    await sleep(150);
    let berr = "";
    try {
      await call("browser_get_page_content", { tabId: tab2 });
    } catch (e) {
      berr = e.message;
    }
    assert(/is blocked/.test(berr), `read not refused: ${berr}`);
    await call("browser_list_tabs");
    await sw(`chrome.storage.local.set({ sitePolicy: [] })`);
    await sleep(150);
    await call("browser_click", { tabId: tab2, selector: "#p2btn" });
    return err.slice(0, 90) + "…";
  });

  await check("fetch returns JSON (same origin), POST, CORS rules", async () => {
    const r = await call("browser_fetch", { tabId: mainTab, url: "/api/data" });
    assert(r.status === 200 && r.bodyType === "json" && r.body.ok === true, JSON.stringify(r));
    const p = await call("browser_fetch", { tabId: mainTab, url: "/api/echo", method: "POST", body: "hi", headers: { "content-type": "text/plain" } });
    assert(p.body.method === "POST" && p.body.body === "hi", JSON.stringify(p));
    const cors = await call("browser_fetch", { tabId: mainTab, url: `http://localhost:${HP}/api/cors` });
    assert(cors.body.cors === true && cors.crossOrigin, JSON.stringify(cors));
    let err = "";
    try {
      await call("browser_fetch", { tabId: mainTab, url: `http://localhost:${HP}/api/data` });
    } catch (e) {
      err = e.message;
    }
    assert(/cross-origin/.test(err), `cross-origin without CORS not refused: ${err}`);
    return "json + POST + CORS ok";
  });

  await check("trusted click at 125% browser zoom", async () => {
    await sw(`chrome.tabs.setZoom(${mainTab}, 1.25)`);
    await sleep(400);
    await js(mainTab, "__clicks.length = 0; return true");
    const r = await call("browser_click", { tabId: mainTab, selector: "#snap" });
    const c = await js(mainTab, "return __clicks");
    const rect = await js(mainTab, "const r = document.getElementById('snap').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }");
    const shot = await call("browser_screenshot", { tabId: mainTab, selector: "#snap" });
    const size = await js(mainTab, "const r = document.getElementById('snap').getBoundingClientRect(); return { w: r.width * devicePixelRatio, h: r.height * devicePixelRatio, dpr: devicePixelRatio }");
    await sw(`chrome.tabs.setZoom(${mainTab}, 1)`);
    await sleep(300);
    assert(c.length === 1 && c[0].id === "snap" && c[0].isTrusted, `clicks ${JSON.stringify(c)}`);
    if (KEEP) fs.writeFileSync(path.join(WORK, "zoom-element.png"), shot.image);
    const png = decodePng(shot.image);
    let purple = 0;
    for (let i = 0; i < png.pixels.length; i += png.bpp) if (png.pixels[i + 2] > 180 && png.pixels[i] < 140 && png.pixels[i + 1] < 130) purple++;
    assert(purple / (png.width * png.height) > 0.5, `zoomed element shot is not the button (${purple} of ${png.width * png.height} px are its colour)`);
    assert(Math.abs(png.width - size.w) <= 3 && Math.abs(png.height - size.h) <= 3, `zoomed element shot ${png.width}x${png.height}, expected ${size.w}x${size.h}`);
    assert(Math.abs(c[0].x - rect.x) <= 2 && Math.abs(c[0].y - rect.y) <= 2, `event at ${c[0].x},${c[0].y}, centre ${rect.x},${rect.y}`);
    return `event at ${c[0].x},${c[0].y} = centre (tool said ${r.x},${r.y})`;
  });

  await check("latency: cursor on vs off", async () => {
    const time = async (sel) => {
      const t0 = Date.now();
      await call("browser_click", { tabId: mainTab, selector: sel });
      return Date.now() - t0;
    };
    await time("#btn");
    const on = await time("#far");
    await sw(`chrome.storage.local.set({ showCursor: false })`);
    await sleep(150);
    await time("#btn");
    const off = await time("#far");
    await sw(`chrome.storage.local.set({ showCursor: true })`);
    assert(on - off < 800, `cursor adds ${on - off} ms`);
    return `long glide click ${on} ms with cursor, ${off} ms without (+${on - off} ms)`;
  });

  if (SHOTS) {
    await check("record cursor frames", async () => {
      fs.mkdirSync(SHOTS, { recursive: true });
      const frames = [];
      const onFrame = (msg) => {
        if (msg.method !== "Page.screencastFrame" || msg.sessionId !== mainSession) return;
        frames.push({ t: Date.now(), data: msg.params.data });
        cdp.send("Page.screencastFrameAck", { sessionId: msg.params.sessionId }, mainSession).catch(() => {});
      };
      cdp.on(onFrame);
      await call("browser_scroll", { tabId: mainTab, to: "top" });
      await call("browser_click", { tabId: mainTab, selector: "#btn" });
      await sleep(400);
      await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 }, mainSession);
      await sleep(200);
      await call("browser_click", { tabId: mainTab, selector: "#target2" });
      await call("browser_type", { tabId: mainTab, selector: "#name", text: "Cursor demo", clear: true, delay: 45 });
      await call("browser_click", { tabId: mainTab, selector: "#submit" });
      await sleep(900);
      await cdp.send("Page.stopScreencast", {}, mainSession);
      let i = 0;
      for (const f of frames) fs.writeFileSync(path.join(SHOTS, `frame-${String(++i).padStart(3, "0")}.png`), Buffer.from(f.data, "base64"));
      // A still mid-typing with the highlight and caret: via the harness, so the overlay shows.
      assert(frames.length >= 10, `only ${frames.length} frames`);
      return `${frames.length} frames in ${SHOTS}`;
    });
  }
} catch (err) {
  results.push({ name: "harness", ok: false, detail: err.stack || err.message });
  log(`HARNESS ERROR ${err.stack || err.message}`);
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log("\n" + results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${String(r.detail).split("\n")[0]})` : ""}`).join("\n"));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
