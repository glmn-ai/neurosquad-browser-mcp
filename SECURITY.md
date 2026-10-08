# Security Policy

This extension can read and act on every page in your browser, so we take reports seriously.

## Supported versions

Security fixes go into the latest release and `main` only.

## Reporting a vulnerability

**Please do not report security vulnerabilities in public issues, discussions or pull requests.**

Report privately through either channel:

1. **GitHub Security Advisories** (preferred) —
   [report a vulnerability](https://github.com/glmn-ai/neurosquad-browser-mcp/security/advisories/new).
2. **Email** — [i@neurosquad.ai](mailto:i@neurosquad.ai).

Please include the affected version or commit, your OS and browser, steps to reproduce, and the
impact you see. We will acknowledge your report within 3 business days, keep you updated, and
credit you in the advisory unless you prefer to stay anonymous.

## Scope

Of particular interest:

- A **web page** reaching the local hub (`127.0.0.1:47615`) or driving the browser through it —
  e.g. bypassing the `Origin` check on the extension endpoint or the token on the peer endpoint.
- A web page reading data from other tabs, or abusing the content scripts / `postMessage` relay
  beyond injecting fake console lines into its own tab.
- The hub binding anything other than loopback, or the peer token file being readable by other
  users.
- `server/setup.js` / the popup installer writing anything other than the documented `webmcp`
  entry into MCP client configs.
- Any request from the extension or the server to a remote host.

Out of scope: the documented capabilities themselves. A **local** program running as your user can
start its own MCP server (or read the peer token) and drive the browser through the extension —
that is how MCP clients use it. Only install the extension on machines and accounts you trust, and
only connect agents you trust.
