// Detects locally installed MCP clients (opencode, Claude Code, Cursor, Codex
// CLI) and installs/removes a "webmcp" MCP server entry in each one's config
// file. This lets the Chrome extension's popup offer a one-click "install
// into detected clients" action instead of the user hand-editing JSON/TOML.
//
// Design notes:
// - JSON/JSONC configs (opencode, Claude Code, Cursor) are edited with
//   `jsonc-parser`'s `modify`/`applyEdits`, which does a surgical text edit
//   instead of parse+stringify, so existing formatting/comments/other
//   servers are preserved.
// - Codex's config is TOML, so we do a small text-based section
//   replace/insert for `[mcp_servers.webmcp]` instead of pulling in a full
//   TOML parser/serializer (which would reformat the whole file).
// - Every write is preceded by a best-effort `<file>.bak` backup.
// - We point every client at the exact Node binary running this process
//   (`process.execPath`) and an absolute path to `src/index.js`, so the
//   entry works regardless of the launching app's PATH or working
//   directory.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, modify, applyEdits } from "jsonc-parser";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_JS = path.join(SERVER_DIR, "src", "index.js");
const NODE_BIN = process.execPath;
// Kept as "webmcp" after the rename to NeuroSquad Browser MCP (1.4.0): existing
// client configs, `mcp__webmcp__*` tool names and permissions depend on this key.
const ENTRY_NAME = "webmcp";

const FORMATTING = { insertSpaces: true, tabSize: 2, eol: "\n" };

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function backup(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.bak`);
  } catch {
    /* best effort */
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function getIn(obj, keys) {
  let cur = obj;
  for (const key of keys) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// JSON / JSONC configs (opencode.json, ~/.claude.json, .cursor/mcp.json)
// ---------------------------------------------------------------------------

function upsertJsoncEntry(filePath, jsonPath, value) {
  const original = readFile(filePath) ?? "{}";
  const edits = modify(original, jsonPath, value, { formattingOptions: FORMATTING });
  const updated = applyEdits(original, edits);
  ensureDir(filePath);
  backup(filePath);
  fs.writeFileSync(filePath, updated, "utf8");
}

function removeJsoncEntry(filePath, jsonPath) {
  const original = readFile(filePath);
  if (original == null) return;
  const edits = modify(original, jsonPath, undefined, { formattingOptions: FORMATTING });
  const updated = applyEdits(original, edits);
  backup(filePath);
  fs.writeFileSync(filePath, updated, "utf8");
}

function jsoncEntryExists(filePath, jsonPath) {
  const original = readFile(filePath);
  if (original == null) return false;
  let parsed;
  try {
    parsed = parse(original) ?? {};
  } catch {
    return false;
  }
  return getIn(parsed, jsonPath) !== undefined;
}

// ---------------------------------------------------------------------------
// TOML config (~/.codex/config.toml) — surgical section replace/insert.
// ---------------------------------------------------------------------------

const TOML_HEADER_RE = new RegExp(`^\\[mcp_servers\\.${ENTRY_NAME}\\]\\s*$`, "m");

function buildCodexBlock() {
  return [
    `[mcp_servers.${ENTRY_NAME}]`,
    `command = ${JSON.stringify(NODE_BIN)}`,
    `args = ${JSON.stringify([INDEX_JS])}`,
    `cwd = ${JSON.stringify(SERVER_DIR)}`,
    `env = {}`,
    "",
  ].join("\n");
}

function findTomlSectionRange(original) {
  const match = TOML_HEADER_RE.exec(original);
  if (!match) return null;
  const startIdx = match.index;
  const afterHeader = original.slice(startIdx + match[0].length);
  const nextSectionMatch = /^\[/m.exec(afterHeader);
  const endIdx = nextSectionMatch
    ? startIdx + match[0].length + nextSectionMatch.index
    : original.length;
  return { startIdx, endIdx };
}

function upsertTomlSection(filePath) {
  ensureDir(filePath);
  const original = readFile(filePath) ?? "";
  const block = buildCodexBlock();
  const range = findTomlSectionRange(original);

  backup(filePath);
  if (!range) {
    const sep = original.length === 0 ? "" : original.endsWith("\n") ? "\n" : "\n\n";
    fs.writeFileSync(filePath, original + sep + block, "utf8");
    return;
  }
  const updated = original.slice(0, range.startIdx) + block + original.slice(range.endIdx);
  fs.writeFileSync(filePath, updated, "utf8");
}

function removeTomlSection(filePath) {
  const original = readFile(filePath);
  if (original == null) return;
  const range = findTomlSectionRange(original);
  if (!range) return;
  const updated = (original.slice(0, range.startIdx) + original.slice(range.endIdx)).replace(
    /\n{3,}/g,
    "\n\n"
  );
  backup(filePath);
  fs.writeFileSync(filePath, updated, "utf8");
}

function tomlSectionExists(filePath) {
  const original = readFile(filePath);
  if (original == null) return false;
  return TOML_HEADER_RE.test(original);
}

// ---------------------------------------------------------------------------
// Client registry
// ---------------------------------------------------------------------------

const home = os.homedir();

const CLIENTS = [
  {
    id: "opencode",
    name: "opencode",
    kind: "json",
    configPath: path.join(home, ".config", "opencode", "opencode.json"),
    jsonPath: ["mcp", ENTRY_NAME],
    detect: () => fs.existsSync(path.join(home, ".config", "opencode")),
    buildEntry: () => ({
      type: "local",
      command: [NODE_BIN, INDEX_JS],
      cwd: SERVER_DIR,
      enabled: true,
    }),
  },
  {
    id: "claude-code",
    name: "Claude Code",
    kind: "json",
    configPath: path.join(home, ".claude.json"),
    // Assumes user-scoped servers live at the top-level `mcpServers` key of
    // ~/.claude.json (as opposed to project-local scope, which nests under
    // `projects.<path>.mcpServers`). Verify with `claude mcp list` after
    // installing.
    jsonPath: ["mcpServers", ENTRY_NAME],
    detect: () => fs.existsSync(path.join(home, ".claude.json")) || fs.existsSync(path.join(home, ".claude")),
    buildEntry: () => ({
      command: NODE_BIN,
      args: [INDEX_JS],
      env: {},
    }),
  },
  {
    id: "cursor",
    name: "Cursor",
    kind: "json",
    configPath: path.join(home, ".cursor", "mcp.json"),
    jsonPath: ["mcpServers", ENTRY_NAME],
    detect: () => fs.existsSync(path.join(home, ".cursor")),
    buildEntry: () => ({
      command: NODE_BIN,
      args: [INDEX_JS],
      env: {},
    }),
  },
  {
    id: "codex",
    name: "Codex CLI",
    kind: "toml",
    configPath: path.join(home, ".codex", "config.toml"),
    detect: () => fs.existsSync(path.join(home, ".codex")),
  },
];

function isInstalled(client) {
  return client.kind === "toml"
    ? tomlSectionExists(client.configPath)
    : jsoncEntryExists(client.configPath, client.jsonPath);
}

export function listClients() {
  return CLIENTS.map((client) => ({
    id: client.id,
    name: client.name,
    configPath: client.configPath,
    detected: client.detect(),
    installed: isInstalled(client),
  }));
}

export function installClient(id) {
  const client = CLIENTS.find((c) => c.id === id);
  if (!client) throw new Error(`Unknown MCP client: ${id}`);

  if (client.kind === "toml") {
    upsertTomlSection(client.configPath);
  } else {
    upsertJsoncEntry(client.configPath, client.jsonPath, client.buildEntry());
  }
  return { id: client.id, name: client.name, configPath: client.configPath };
}

export function uninstallClient(id) {
  const client = CLIENTS.find((c) => c.id === id);
  if (!client) throw new Error(`Unknown MCP client: ${id}`);

  if (client.kind === "toml") {
    removeTomlSection(client.configPath);
  } else {
    removeJsoncEntry(client.configPath, client.jsonPath);
  }
  return { id: client.id, name: client.name, configPath: client.configPath };
}
