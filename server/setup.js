#!/usr/bin/env node
// One-shot setup: writes the "webmcp" MCP server entry directly into every
// locally detected MCP client's config file (opencode, Claude Code, Cursor,
// Codex CLI) — the same logic the extension's popup "Install into MCP
// clients" button uses, but run straight from Node with direct filesystem
// access instead of over the WebSocket bridge.
//
// Why this exists: the popup's installer can only run *through* an already
// -connected extension <-> server WebSocket, but that server is normally
// spawned by an MCP client reading the very config entry this script writes.
// Running this once (via `npm install` -> postinstall, or `npm run setup`)
// breaks that chicken-and-egg loop so a freshly cloned repo works without
// hand-editing any client config file.
//
// Safe to run multiple times: entries that already exist are left alone.
// This script never starts a server process itself — clients keep spawning
// their own instance of src/index.js on demand, so there's no risk of two
// processes fighting over the WebSocket port.

import { listClients, installClient } from "./src/clients.js";

function log(...args) {
  console.log("[webmcp-setup]", ...args);
}

const clients = listClients();
const detected = clients.filter((c) => c.detected);

if (detected.length === 0) {
  log(
    "No local MCP clients (opencode, Claude Code, Cursor, Codex CLI) were detected on this machine."
  );
  log("See README.md 'Configure opencode' for how to add the server entry by hand.");
  process.exit(0);
}

let changed = false;
for (const client of detected) {
  if (client.installed) {
    log(`${client.name}: already configured (${client.configPath}).`);
    continue;
  }
  try {
    installClient(client.id);
    changed = true;
    log(`${client.name}: added a "webmcp" MCP server entry to ${client.configPath}.`);
  } catch (err) {
    log(`${client.name}: failed to update ${client.configPath} -- ${err.message}`);
  }
}

if (changed) {
  log("Restart the client(s) above (or start a new session) so they pick up the new server.");
}
log(
  "Next: load the extension/ folder as an unpacked Chrome extension, then open its popup " +
    "-- the dot should turn green once a configured client starts the server."
);
