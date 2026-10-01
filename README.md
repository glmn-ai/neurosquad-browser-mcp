# WebMCP

A bridge that lets **opencode** read and interact with whatever page is open
in your Chrome browser, using the Model Context Protocol (MCP).

```
opencode  <-- stdio -->  MCP server (server/)  <-- WebSocket -->  Chrome extension (extension/)  <--->  page
```

- **`server/`** — a local Node.js MCP server. opencode spawns it over stdio
  (standard MCP transport) and it exposes browser tools (`browser_*`). It
  also runs a small WebSocket server (default port `8765`) that the Chrome
  extension connects to.
- **`extension/`** — an unpacked Manifest V3 Chrome extension. Its background
  service worker keeps a WebSocket connection to the MCP server and executes
  the requested actions (read DOM, click, fill, screenshot, run JS, ...)
  using `chrome.tabs` / `chrome.scripting`.

## Setup

### 1. Install server dependencies

```sh
cd server
npm install
```

This also runs `setup.js` automatically (via `postinstall`), which writes a
`webmcp` MCP server entry into every locally detected MCP client's config
(opencode, Claude Code, Cursor, Codex CLI) — see
[One-click MCP client install](#one-click-mcp-client-install). It's safe to
re-run any time with `npm run setup`, and it never overwrites an entry that's
already there. **Restart the client(s) it touched** (or start a new session)
so they pick up the new server — until then, nothing will be listening on
the WebSocket port and the extension popup will show a red dot with no
client list, since listing clients itself depends on a running server. If no
clients were detected, or you'd rather do it by hand, see step 3 below.

### 2. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin the "WebMCP Bridge" extension so you can see its status popup. The
   dot is red until the MCP server is running and the extension connects to
   it.

### 3. Configure opencode (manual, if step 1's automatic setup didn't cover it)

If `~/.config/opencode/` didn't exist yet when you ran `npm install` (or you
want a per-project config instead of the global one), add a local MCP server
entry to your opencode config (`opencode.json` / `opencode.jsonc`, global at
`~/.config/opencode/` or per-project) by hand:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "webmcp": {
      "type": "local",
      "command": ["node", "src/index.js"],
      "cwd": "E:\\Github\\vibe\\webmcp\\server",
      "enabled": true
    }
  }
}
```

Adjust `cwd` to wherever you cloned this repo. Restart opencode (or start a
new session) so it picks up the new MCP server.

If port `8765` is already in use, set `WEBMCP_PORT` in `environment` for the
server entry above, and update the port in the extension popup to match.

Alternatively, once the server is running (see step 1) and the extension is
connected, open the extension popup (it also opens automatically as a tab on
first install) and use **Install into MCP clients** to have the server write
this config for you automatically — see [One-click MCP client install](#one-click-mcp-client-install) below.

### 4. Try it

With the extension connected (green dot in the popup) and a page open in
Chrome, ask opencode things like:

```
use webmcp to tell me what's on the current page
use webmcp to click the "Submit" button
use webmcp to fill the search box with "hello" and show me console errors
```

## Tools

| Tool | Description |
| --- | --- |
| `browser_list_tabs` | List all open tabs (id, title, url, active). |
| `browser_get_page_info` | Get id/title/url of a tab (defaults to active tab). |
| `browser_get_page_content` | Get visible text or full HTML of a page. |
| `browser_query_selector` | Run `querySelectorAll` and return matched elements' tag/text/attributes. |
| `browser_click` | Click the first element matching a CSS selector. |
| `browser_fill` | Set the value of an input/textarea/contenteditable and fire input/change events. |
| `browser_navigate` | Navigate a tab to a URL. |
| `browser_execute_script` | Run arbitrary JS in the page's own JS context and return the result. |
| `browser_screenshot` | Capture a PNG screenshot of the visible area of a tab. |
| `browser_get_console_logs` | Read buffered `console.log/warn/error` output and uncaught errors for a tab. |
| `browser_connection_status` | Check whether the Chrome extension is connected. |

All tools take an optional `tabId`; if omitted, they target the active tab
of the last focused Chrome window.

## One-click MCP client install

A Chrome extension can't write to arbitrary files on disk (Claude Desktop's
config, `~/.cursor/mcp.json`, etc.) — that's outside the extension sandbox.
The one thing it *can* reach is the already-running local `server/` process
over the same WebSocket used for browser tools, and that process has full
filesystem access. So the popup's **Install into MCP clients** section asks
the server to detect and edit each client's config for you:

| Client | Config file | Format |
| --- | --- | --- |
| opencode | `~/.config/opencode/opencode.json` | JSONC, `mcp.webmcp` |
| Claude Code | `~/.claude.json` | JSON, `mcpServers.webmcp` (user scope) |
| Cursor | `~/.cursor/mcp.json` | JSON, `mcpServers.webmcp` |
| Codex CLI | `~/.codex/config.toml` | TOML, `[mcp_servers.webmcp]` |

Detection just checks whether the client's config directory exists on disk;
"Install" merges in a `webmcp` entry pointing at this repo's `server/src/index.js`,
run with the exact Node binary (`process.execPath`) the server itself is
running under (so it works even if a GUI app's `PATH` doesn't include Node).
JSON/JSONC files are edited with a surgical text edit (via `jsonc-parser`)
that preserves existing comments and other configured servers; a `<file>.bak`
backup is written before every change. Restart the target client after
installing so it picks up the new server.

Implementation: `server/src/clients.js` (detect/install/uninstall logic),
exposed to the extension over a small `client-request` / `client-response`
message pair added to the existing WebSocket protocol (see
`server/src/wsBridge.js` and `extension/background.js`).

## Notes & limitations

- Only one Chrome extension instance is expected to connect at a time; if a
  new connection appears (e.g. extension reload), it replaces the old one.
- `browser_execute_script` and `browser_query_selector` inject code into the
  page's main JS world (`chrome.scripting.executeScript` with
  `world: "MAIN"`). Pages with a strict Content-Security-Policy that
  disallows `unsafe-eval` may block dynamically constructed scripts.
- `browser_screenshot` briefly focuses the target tab if it isn't already
  active, since Chrome can only capture the visible tab of a window.
- Console log capture works by wrapping `console.*` in a `MAIN`-world
  content script injected at `document_start`. It won't see logs emitted
  before the content script attaches to a frame that existed prior to
  install/reload (reload the page after installing the extension).
- If opencode isn't running (no MCP server process), the extension will
  just keep retrying the WebSocket connection in the background; no action
  is needed once opencode starts again.
