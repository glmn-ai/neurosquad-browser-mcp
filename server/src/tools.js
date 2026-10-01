import { z } from "zod";

const text = (value) => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

const errorText = (err) => ({
  content: [{ type: "text", text: `Error: ${err.message || String(err)}` }],
  isError: true,
});

async function resolveTabId(bridge, tabId) {
  if (typeof tabId === "number") return tabId;
  const active = await bridge.request("getActiveTab");
  if (!active || typeof active.id !== "number") {
    throw new Error("Could not determine the active browser tab. Pass an explicit tabId.");
  }
  return active.id;
}

const tabIdParam = z
  .number()
  .int()
  .optional()
  .describe("Target tab id. Defaults to the active tab in the last focused Chrome window.");

/**
 * Registers every WebMCP tool onto the given McpServer instance. Each tool
 * ultimately talks to the Chrome extension through `bridge.request(...)`.
 */
export function registerTools(server, bridge) {
  server.registerTool(
    "browser_list_tabs",
    {
      title: "List browser tabs",
      description:
        "List all open tabs across Chrome windows, including their id, title, url and whether they are active.",
      inputSchema: {},
    },
    async () => {
      try {
        const tabs = await bridge.request("listTabs");
        return text(tabs);
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    "browser_get_page_info",
    {
      title: "Get page info",
      description: "Get the URL, title and tab id of a page (defaults to the active tab).",
      inputSchema: { tabId: tabIdParam },
    },
    async ({ tabId }) => {
      try {
        const id = await resolveTabId(bridge, tabId);
        const info = await bridge.request("getPageInfo", { tabId: id });
        return text(info);
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    "browser_get_page_content",
    {
      title: "Get page content",
      description:
        "Read the rendered content of a page: title, url, visible text (innerText) and, optionally, the full HTML. Use this to see what the user currently sees in their browser.",
      inputSchema: {
        tabId: tabIdParam,
        format: z
          .enum(["text", "html"])
          .default("text")
          .describe("'text' returns visible text only, 'html' returns the full outerHTML of <html>."),
        maxLength: z
          .number()
          .int()
          .positive()
          .max(500_000)
          .default(20_000)
          .describe("Truncate the returned content to this many characters."),
      },
    },
    async ({ tabId, format, maxLength }) => {
      try {
        const id = await resolveTabId(bridge, tabId);
        const result = await bridge.request("getPageContent", { tabId: id, format });
        let content = result.content ?? "";
        let truncated = false;
        if (content.length > maxLength) {
          content = content.slice(0, maxLength);
          truncated = true;
        }
        return text({ url: result.url, title: result.title, truncated, content });
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    "browser_query_selector",
    {
      title: "Query DOM elements",
      description:
        "Run document.querySelectorAll(selector) on a page and return matches (tag, text, key attributes, and a stable index you can use with browser_click/browser_fill).",
      inputSchema: {
        tabId: tabIdParam,
        selector: z.string().describe("A CSS selector, e.g. 'button.submit' or '#id'."),
        limit: z.number().int().positive().max(200).default(50).describe("Max number of matches to return."),
      },
    },
    async ({ tabId, selector, limit }) => {
      try {
        const id = await resolveTabId(bridge, tabId);
        const matches = await bridge.request("querySelector", { tabId: id, selector, limit });
        return text(matches);
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    "browser_click",
    {
      title: "Click an element",
      description: "Click the first element matching a CSS selector on the page.",
      inputSchema: {
        tabId: tabIdParam,
        selector: z.string().describe("A CSS selector identifying the element to click."),
      },
    },
    async ({ tabId, selector }) => {
      try {
        const id = await resolveTabId(bridge, tabId);
        const result = await bridge.request("click", { tabId: id, selector });
        return text(result);
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    "browser_fill",
    {
      title: "Fill a form field",
      description:
        "Set the value of an <input>, <textarea> or contenteditable element matching a CSS selector, dispatching input/change events so frameworks like React notice the change.",
      inputSchema: {
        tabId: tabIdParam,
        selector: z.string().describe("A CSS selector identifying the field to fill."),
        value: z.string().describe("The text value to set."),
      },
    },
    async ({ tabId, selector, value }) => {
      try {
        const id = await resolveTabId(bridge, tabId);
        const result = await bridge.request("fill", { tabId: id, selector, value });
        return text(result);
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    "browser_navigate",
    {
      title: "Navigate a tab",
      description: "Navigate a browser tab to a given URL (defaults to the active tab).",
      inputSchema: {
        tabId: tabIdParam,
        url: z.string().url().describe("The URL to navigate to."),
      },
    },
    async ({ tabId, url }) => {
      try {
        const id = await resolveTabId(bridge, tabId);
        const result = await bridge.request("navigate", { tabId: id, url });
        return text(result);
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    "browser_execute_script",
    {
      title: "Execute JavaScript on the page",
      description:
        "Execute arbitrary JavaScript in the context of the page (same world as the page's own scripts) and return the JSON-serializable result. The code runs as the body of an async function, so you can use `return` and top-level `await`.",
      inputSchema: {
        tabId: tabIdParam,
        code: z.string().describe("JavaScript source. Executed as `async () => { <code> }`."),
      },
    },
    async ({ tabId, code }) => {
      try {
        const id = await resolveTabId(bridge, tabId);
        const result = await bridge.request("executeScript", { tabId: id, code });
        return text(result);
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    "browser_screenshot",
    {
      title: "Screenshot a tab",
      description: "Capture a screenshot (PNG) of the currently visible area of a tab.",
      inputSchema: { tabId: tabIdParam },
    },
    async ({ tabId }) => {
      try {
        const id = await resolveTabId(bridge, tabId);
        const { dataUrl } = await bridge.request("screenshot", { tabId: id });
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
        return {
          content: [{ type: "image", data: base64, mimeType: "image/png" }],
        };
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    "browser_get_console_logs",
    {
      title: "Get console logs",
      description:
        "Retrieve console messages (log/warn/error/info) captured from a page since it loaded, or since they were last cleared.",
      inputSchema: {
        tabId: tabIdParam,
        clear: z.boolean().default(false).describe("Clear the buffered logs for this tab after reading them."),
        limit: z.number().int().positive().max(500).optional().describe("Only return the most recent N entries."),
      },
    },
    async ({ tabId, clear, limit }) => {
      try {
        const id = await resolveTabId(bridge, tabId);
        const logs = bridge.getConsoleLogs(id, { clear, limit });
        return text(logs);
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    "browser_connection_status",
    {
      title: "Check extension connection",
      description: "Check whether the WebMCP Chrome extension is currently connected to this MCP server.",
      inputSchema: {},
    },
    async () => text({ connected: bridge.isConnected() })
  );
}
