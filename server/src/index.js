#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ExtensionBridge } from "./wsBridge.js";
import { registerTools } from "./tools.js";
import { listClients, installClient, uninstallClient } from "./clients.js";

// IMPORTANT: stdout is reserved for the MCP JSON-RPC protocol (StdioServerTransport).
// All diagnostics must go to stderr.
const log = (...args) => console.error("[webmcp-server]", ...args);

const PORT = Number(process.env.WEBMCP_PORT || 47615);
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// Every MCP client session spawns its own copy of this server. They share
// the one Chrome extension through a hub + peers scheme (see wsBridge.js):
// whichever instance owns the port is the hub, the rest join it as peers,
// and a peer takes over if the hub exits.
const bridge = new ExtensionBridge({
  port: PORT,
  version: VERSION,
  allowedExtensionIds: (process.env.WEBMCP_EXTENSION_IDS || "").split(",").map((s) => s.trim()),
  clientHandlers: {
    listClients: async () => listClients(),
    installClient: async ({ id }) => installClient(id),
    uninstallClient: async ({ id }) => uninstallClient(id),
  },
});

// Shown to MCP clients as serverInfo. The client-side config key stays "webmcp"
// (see clients.js ENTRY_NAME) so existing installs and tool names keep working.
const server = new McpServer({ name: "neurosquad-browser-mcp", title: "NeuroSquad Browser MCP", version: VERSION });
registerTools(server, bridge);

let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down (${reason}).`);
  bridge.close();
  // Give the hub a moment to send close frames so peers fail over at once.
  setTimeout(() => process.exit(0), 150).unref();
}

const transport = new StdioServerTransport();
transport.onclose = () => shutdown("stdio transport closed");
await server.connect(transport);
log(`MCP server ${VERSION} connected over stdio (pid ${process.pid}).`);

// When the MCP client goes away, stdin ends. Without this the WebSocket
// server would keep the process (and the port) alive as an orphan.
process.stdin.on("end", () => shutdown("stdin closed"));
process.stdin.on("close", () => shutdown("stdin closed"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
