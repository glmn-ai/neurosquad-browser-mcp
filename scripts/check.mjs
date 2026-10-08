#!/usr/bin/env node
// Repository checks that need no dependencies:
//   1. `node --check` on every JavaScript file (syntax errors fail fast, on every OS);
//   2. extension/manifest.json is valid JSON with the Manifest V3 fields Chrome requires,
//      and every file it references exists.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(c|m)?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

// 1. Syntax.
const files = walk(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) errors.push(`syntax: ${path.relative(root, file)}\n${result.stderr.trim()}`);
}
console.log(`node --check: ${files.length} files`);

// 2. Manifest.
const extDir = path.join(root, "extension");
let manifest;
try {
  manifest = JSON.parse(readFileSync(path.join(extDir, "manifest.json"), "utf8"));
} catch (err) {
  errors.push(`manifest.json is not valid JSON: ${err.message}`);
}

if (manifest) {
  const need = (cond, message) => {
    if (!cond) errors.push(`manifest.json: ${message}`);
  };
  const fileExists = (rel, what) => need(typeof rel === "string" && existsSync(path.join(extDir, rel)), `${what} "${rel}" does not exist`);

  need(manifest.manifest_version === 3, "manifest_version must be 3");
  need(typeof manifest.name === "string" && manifest.name.length > 0 && manifest.name.length <= 75, "name is required (max 75 chars)");
  if (manifest.short_name && manifest.short_name.length > 12) {
    console.warn(`warning: short_name "${manifest.short_name}" is longer than the recommended 12 chars`);
  }
  need(typeof manifest.version === "string" && /^\d+(\.\d+){0,3}$/.test(manifest.version), "version must be 1-4 dot-separated integers");
  need(typeof manifest.description === "string" && manifest.description.length <= 132, "description is required (max 132 chars, Chrome Web Store)");
  need(!("browser_action" in manifest) && !("page_action" in manifest), "MV3 uses `action`, not browser_action/page_action");
  need(!manifest.background || (manifest.background.service_worker && !manifest.background.scripts && !manifest.background.persistent),
    "MV3 background must be a service_worker");
  need(Array.isArray(manifest.permissions), "permissions must be an array");
  need(!(manifest.permissions || []).some((p) => /^(https?|\*|<all_urls>)/.test(p)), "host patterns belong in host_permissions in MV3");

  for (const [size, icon] of Object.entries(manifest.icons || {})) fileExists(icon, `icon ${size}`);
  need(manifest.icons && manifest.icons["128"], "a 128px icon is required by the Chrome Web Store");
  if (manifest.background?.service_worker) fileExists(manifest.background.service_worker, "service worker");
  for (const cs of manifest.content_scripts || []) {
    for (const js of cs.js || []) fileExists(js, "content script");
    for (const css of cs.css || []) fileExists(css, "content stylesheet");
  }
  if (manifest.action?.default_popup) fileExists(manifest.action.default_popup, "popup");
  for (const icon of Object.values(manifest.action?.default_icon || {})) fileExists(icon, "action icon");

  const serverVersion = JSON.parse(readFileSync(path.join(root, "server", "package.json"), "utf8")).version;
  console.log(`manifest.json: ${manifest.name} ${manifest.version} (server ${serverVersion})`);
}

if (errors.length) {
  for (const e of errors) console.error(`ERROR ${e}`);
  process.exit(1);
}
console.log("all checks passed");
