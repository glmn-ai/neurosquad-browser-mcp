#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ExtensionBridge } from "./wsBridge.js";
import { registerTools } from "./tools.js";
import { listClients, installClient, uninstallClient } from "./clients.js";

// IMPORTANT: stdout is reserved for the MCP JSON-RPC protocol (StdioServerTransport).
// All diagnostics must go to stderr.
const log = (...args) => console.error("[webmcp-server]", ...args);

const PORT = Number(process.env.WEBMCP_PORT || 8765);

const bridge = new ExtensionBridge({
  port: PORT,
  clientHandlers: {
    listClients: async () => listClients(),
    installClient: async ({ id }) => installClient(id),
    uninstallClient: async ({ id }) => uninstallClient(id),
  },
});
log(`Waiting for the WebMCP Chrome extension to connect on ws://localhost:${PORT}`);

const server = new McpServer({ name: "webmcp", version: "1.0.0" });
registerTools(server, bridge);

const transport = new StdioServerTransport();
await server.connect(transport);
log("MCP server connected over stdio.");

function shutdown() {
  log("Shutting down.");
  bridge.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
