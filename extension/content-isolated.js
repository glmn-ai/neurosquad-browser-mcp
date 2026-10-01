// Runs in the isolated content script world (has access to chrome.runtime).
// Relays console messages captured by content-main.js to the background
// service worker, which forwards them to the MCP server over WebSocket.
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.marker !== "__webmcp_console_v1__") return;

  chrome.runtime.sendMessage({ type: "console-log", level: data.level, text: data.text }).catch(() => {
    /* background may be waking up; drop this message */
  });
});
