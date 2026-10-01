// Runs in the page's own JS world ("MAIN"). Wraps console methods and global
// error handlers so we can mirror console output back to opencode via
// browser_get_console_logs. Communicates with content-isolated.js (which has
// access to chrome.runtime) through window.postMessage, since MAIN-world
// content scripts cannot call extension APIs directly.
(() => {
  const MARKER = "__webmcp_console_v1__";
  const methods = ["log", "info", "warn", "error", "debug"];

  function stringify(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function send(level, args) {
    try {
      const text = args.map(stringify).join(" ");
      window.postMessage({ marker: MARKER, level, text }, "*");
    } catch {
      /* ignore serialization failures */
    }
  }

  for (const level of methods) {
    const original = typeof console[level] === "function" ? console[level].bind(console) : () => {};
    console[level] = (...args) => {
      original(...args);
      send(level, args);
    };
  }

  window.addEventListener("error", (event) => {
    send("error", [`Uncaught ${event.message} (${event.filename}:${event.lineno}:${event.colno})`]);
  });

  window.addEventListener("unhandledrejection", (event) => {
    send("error", [`Unhandled promise rejection: ${stringify(event.reason)}`]);
  });
})();
