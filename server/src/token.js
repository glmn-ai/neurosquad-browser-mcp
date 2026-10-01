import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Shared secret that lets local webmcp server instances (peers) talk to the
 * instance that owns the WebSocket port (the hub). A web page can't read
 * this file, and browsers can't set custom headers on a WebSocket handshake,
 * so a random site cannot impersonate a peer and drive the browser through
 * localhost.
 *
 * Default location: ~/.webmcp/peer-token (override with WEBMCP_TOKEN_FILE).
 */
export function tokenFilePath() {
  return process.env.WEBMCP_TOKEN_FILE || path.join(os.homedir(), ".webmcp", "peer-token");
}

function readToken(file) {
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    return value.length >= 32 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Returns the shared token, creating the file if it doesn't exist yet. Safe
 * against several instances starting at the same moment: the file is
 * published with an atomic hard link (fails with EEXIST if someone else won),
 * and every caller ends up reading the same winning file.
 */
export function readOrCreateToken(file = tokenFilePath()) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const existing = readToken(file);
    if (existing) return existing;

    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tmp, randomBytes(32).toString("hex"), { mode: 0o600 });
      try {
        fs.linkSync(tmp, file);
      } catch (err) {
        if (err.code === "EEXIST") {
          // Another instance published first; if the existing file is
          // empty/garbage (e.g. truncated by hand), replace it.
          if (!readToken(file)) {
            try {
              fs.renameSync(tmp, file);
            } catch {
              /* lost a race again; loop re-reads */
            }
          }
        } else if (err.code === "EPERM" || err.code === "ENOTSUP" || err.code === "EXDEV") {
          // Filesystem without hard links: fall back to exclusive create.
          try {
            fs.writeFileSync(file, fs.readFileSync(tmp), { flag: "wx", mode: 0o600 });
          } catch {
            /* someone else created it */
          }
        } else {
          throw err;
        }
      }
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* already moved or never created */
      }
    }
  }
  const final = readToken(file);
  if (!final) throw new Error(`Could not create or read the webmcp peer token at ${file}`);
  return final;
}

export function tokensEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
