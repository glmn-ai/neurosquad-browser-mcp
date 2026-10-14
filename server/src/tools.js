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

const selectorParam = (what) => z.string().optional().describe(`CSS selector of ${what}. Pass this or ref.`);
const refParam = z
  .string()
  .regex(/^e\d+$/, "a ref looks like e12")
  .optional()
  .describe("Element ref from browser_snapshot (e.g. 'e12'), instead of selector. Refs expire when the page navigates.");

// Extra time the bridge waits on top of what a tool itself may take.
const SLACK_MS = 15_000;

function needTarget({ selector, ref }) {
  if (!selector && !ref) throw new Error("Pass a selector or a ref (from browser_snapshot).");
  if (selector && ref) throw new Error("Pass either selector or ref, not both.");
}

/** Runs a tool body, turning thrown errors into MCP error results. */
const run = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    return errorText(err);
  }
};

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
      description:
        "Click an element (by CSS selector or snapshot ref) or a point (x/y). By default this is a real click through the DevTools protocol: the element is scrolled into view, the pointer moves to its centre (hover fires) and presses there, so the page sees isTrusted mouse events. This works on React apps and on sites that ignore synthetic clicks. trusted: false uses the old element.click() instead. A visible agent cursor glides to the target unless the user turned it off.",
      inputSchema: {
        tabId: tabIdParam,
        selector: selectorParam("the element to click"),
        ref: refParam,
        x: z.number().min(0).optional().describe("Viewport x in CSS pixels, instead of an element (with y)."),
        y: z.number().min(0).optional().describe("Viewport y in CSS pixels, instead of an element (with x)."),
        trusted: z
          .boolean()
          .default(true)
          .describe("Real mouse input (default). false: dispatch element.click() from the page instead."),
        button: z.enum(["left", "right", "middle"]).default("left").describe("Mouse button."),
        clickCount: z.number().int().min(1).max(3).default(1).describe("2 for a double click, 3 for a triple click."),
      },
    },
    run(async ({ tabId, selector, ref, x, y, trusted, button, clickCount }) => {
      const point = x !== undefined || y !== undefined;
      if (point && (x === undefined || y === undefined)) throw new Error("Pass both x and y.");
      if (!point) needTarget({ selector, ref });
      else if (selector || ref) throw new Error("Pass either an element (selector/ref) or x/y, not both.");
      const id = await resolveTabId(bridge, tabId);
      return text(await bridge.request("click", { tabId: id, selector, ref, x, y, trusted, button, clickCount }));
    })
  );

  server.registerTool(
    "browser_type",
    {
      title: "Type text",
      description:
        "Type text with real keyboard input (DevTools protocol), as a user would: focuses the element (selector or ref) first, or types into whatever is focused. Works with React-controlled inputs and contenteditable editors (Draft.js on x.com, ProseMirror, Lexical). Without delay the text is inserted in one go; with delay, each character is a separate key press and newlines become Enter. Returns the field's value afterwards. To set a value without key events use browser_fill.",
      inputSchema: {
        tabId: tabIdParam,
        selector: selectorParam("the field to type into"),
        ref: refParam,
        text: z.string().max(100_000).describe("Text to type."),
        clear: z.boolean().default(false).describe("Delete the field's current content first."),
        delay: z
          .number()
          .int()
          .min(0)
          .max(1000)
          .default(0)
          .describe("Milliseconds between key presses. 0 = insert the text at once."),
      },
    },
    run(async ({ tabId, selector, ref, text: value, clear, delay }) => {
      if (selector && ref) throw new Error("Pass either selector or ref, not both.");
      const id = await resolveTabId(bridge, tabId);
      const timeout = SLACK_MS + (delay ? [...value].length * (delay + 15) : 0);
      return text(await bridge.request("type", { tabId: id, selector, ref, text: value, clear, delay }, timeout));
    })
  );

  server.registerTool(
    "browser_press_key",
    {
      title: "Press a key",
      description:
        "Press a key or a key combination with real keyboard events: Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, F1-F12, Space or any single character, with modifiers joined by '+': 'Control+A', 'Shift+Tab', 'Meta+Enter', 'Control+Shift+K'. Optionally focuses an element (selector or ref) first.",
      inputSchema: {
        tabId: tabIdParam,
        key: z.string().min(1).max(64).describe("Key or combo, e.g. 'Enter', 'Escape', 'Control+A', 'Shift+ArrowDown'."),
        selector: selectorParam("an element to focus first"),
        ref: refParam,
        repeat: z.number().int().min(1).max(100).default(1).describe("Press it this many times."),
      },
    },
    run(async ({ tabId, key, selector, ref, repeat }) => {
      if (selector && ref) throw new Error("Pass either selector or ref, not both.");
      const id = await resolveTabId(bridge, tabId);
      return text(await bridge.request("pressKey", { tabId: id, key, selector, ref, repeat }));
    })
  );

  server.registerTool(
    "browser_fill",
    {
      title: "Fill a form field",
      description:
        "Set the value of an <input>, <textarea> or contenteditable element (CSS selector or snapshot ref) directly, dispatching synthetic input/change events. Fast, but some rich editors ignore it; browser_type types with real key events instead.",
      inputSchema: {
        tabId: tabIdParam,
        selector: selectorParam("the field to fill"),
        ref: refParam,
        value: z.string().describe("The text value to set."),
      },
    },
    async ({ tabId, selector, ref, value }) => {
      try {
        needTarget({ selector, ref });
        const id = await resolveTabId(bridge, tabId);
        const result = await bridge.request("fill", { tabId: id, selector, ref, value });
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
    "browser_open_tab",
    {
      title: "Open a new tab",
      description:
        "Open a URL in a new browser tab and return its id. The tab opens in the background unless active is true, so the user's current tab keeps focus. Agent tabs are collected in a \"NeuroSquad\" tab group in their window.",
      inputSchema: {
        url: z.string().url().describe("The URL to open."),
        active: z.boolean().optional().describe("Switch to the new tab (default false)."),
      },
    },
    async ({ url, active }) => {
      try {
        const result = await bridge.request("openTab", { url, active: active === true });
        return text(result);
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    "browser_close_tab",
    {
      title: "Close a tab",
      description:
        "Close a tab that was opened with browser_open_tab. Tabs the user opened can't be closed.",
      inputSchema: {
        tabId: z.number().int().describe("Id returned by browser_open_tab."),
      },
    },
    async ({ tabId }) => {
      try {
        const result = await bridge.request("closeTab", { tabId });
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
        "Execute arbitrary JavaScript in the context of the page (same world as the page's own scripts) and return the JSON-serializable result. On pages whose CSP forbids eval (x.com, github.com) it runs through the DevTools protocol instead. The code runs as the body of an async function, so you can use `return` and top-level `await`.",
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
    "browser_upload_files",
    {
      title: "Attach local files to a file input",
      description:
        "Set local files (absolute paths on this machine) on an <input type=file> (CSS selector or snapshot ref), as if the user picked them (Chrome DevTools Protocol). Use it for uploads/attachments.",
      inputSchema: {
        tabId: tabIdParam,
        selector: selectorParam("the <input type=file>"),
        ref: refParam,
        paths: z.array(z.string()).min(1).describe("Absolute file paths to attach."),
      },
    },
    async ({ tabId, selector, ref, paths }) => {
      try {
        needTarget({ selector, ref });
        const id = await resolveTabId(bridge, tabId);
        const result = await bridge.request("uploadFiles", { tabId: id, selector, ref, paths });
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
      description:
        "Capture a PNG of a tab: the visible area (default), one element (selector or ref), or the full scrollable page. Background tabs are captured without switching to them. The NeuroSquad overlay (glow, cursor, highlight) is never in the image.",
      inputSchema: {
        tabId: tabIdParam,
        selector: selectorParam("an element to capture alone"),
        ref: refParam,
        fullPage: z.boolean().default(false).describe("Capture the whole scrollable page (up to 16384 px tall)."),
      },
    },
    run(async ({ tabId, selector, ref, fullPage }) => {
      if (selector && ref) throw new Error("Pass either selector or ref, not both.");
      const id = await resolveTabId(bridge, tabId);
      const result = await bridge.request("screenshot", { tabId: id, selector, ref, fullPage }, 30_000);
      const base64 = result.dataUrl.replace(/^data:image\/png;base64,/, "");
      const content = [{ type: "image", data: base64, mimeType: "image/png" }];
      if (result.note) content.push({ type: "text", text: result.note });
      return { content };
    })
  );

  server.registerTool(
    "browser_snapshot",
    {
      title: "Snapshot the page structure",
      description:
        "A compact outline of what you can act on: interactive elements (buttons, links, fields, checkboxes, tabs, menu items...) and headings in page order, each with role, accessible name, value, state (disabled, checked, expanded, focused, offscreen) and a ref like 'e12'. Pass a ref instead of a selector to browser_click, browser_type, browser_press_key, browser_fill, browser_scroll, browser_wait_for, browser_screenshot and browser_upload_files. Refs stay valid until the page navigates. Cheaper and more reliable than reading the HTML.",
      inputSchema: {
        tabId: tabIdParam,
        selector: z.string().optional().describe("Only outline this part of the page (CSS selector), e.g. 'main' or '[role=dialog]'."),
        maxNodes: z.number().int().positive().max(3000).default(400).describe("Stop after this many elements."),
        maxLength: z.number().int().positive().max(200_000).default(20_000).describe("Stop after this many characters."),
      },
    },
    run(async ({ tabId, selector, maxNodes, maxLength }) => {
      const id = await resolveTabId(bridge, tabId);
      const r = await bridge.request("snapshot", { tabId: id, selector, maxNodes, maxLength });
      const head = [
        `Page: ${r.title || "(untitled)"} - ${r.url}`,
        `${r.count} elements${r.truncated ? " (truncated: raise maxNodes/maxLength or pass a selector)" : ""}${r.offscreen ? `, ${r.offscreen} offscreen` : ""}`,
        "",
      ].join("\n");
      return text(head + (r.text || "(no interactive elements found)"));
    })
  );

  server.registerTool(
    "browser_scroll",
    {
      title: "Scroll the page",
      description:
        "Scroll the page (or a scrollable element) by pixels, to the top/bottom, or until an element (selector or ref) is in view. Waits briefly for lazy content and reports the scroll position and whether new content appeared (scrollHeight grew), so you can page through infinite feeds.",
      inputSchema: {
        tabId: tabIdParam,
        y: z.number().optional().describe("Pixels to scroll down (negative: up)."),
        x: z.number().optional().describe("Pixels to scroll right (negative: left)."),
        to: z.enum(["top", "bottom"]).optional().describe("Jump to the top or bottom."),
        selector: selectorParam("an element to scroll into view"),
        ref: refParam,
        within: z.string().optional().describe("CSS selector of a scrollable container to scroll instead of the page."),
        waitMs: z.number().int().min(0).max(5000).default(600).describe("How long to wait for new content after scrolling."),
      },
    },
    run(async ({ tabId, x, y, to, selector, ref, within, waitMs }) => {
      if (selector && ref) throw new Error("Pass either selector or ref, not both.");
      if (!selector && !ref && !to && !x && !y) throw new Error("Pass x/y pixels, to: 'top'/'bottom', or an element (selector/ref).");
      const id = await resolveTabId(bridge, tabId);
      return text(await bridge.request("scroll", { tabId: id, x, y, to, selector, ref, within, waitMs }));
    })
  );

  server.registerTool(
    "browser_wait_for",
    {
      title: "Wait for a condition",
      description:
        "Wait until a condition holds: an element (selector or ref) is visible / attached / hidden / detached, some text appears on the page, the URL matches (substring, glob with *, or /regex/), or the page reaches 'load' or 'networkidle' (no new requests for 500 ms). With several conditions, all must hold. Fails with an error after the timeout.",
      inputSchema: {
        tabId: tabIdParam,
        selector: z.string().optional().describe("CSS selector to wait for."),
        ref: refParam,
        state: z
          .enum(["visible", "attached", "hidden", "detached"])
          .default("visible")
          .describe("Element state to wait for."),
        text: z.string().min(1).optional().describe("Text that must appear in the page's visible text."),
        url: z.string().min(1).optional().describe("URL condition: substring, glob ('*/status/*') or /regex/flags."),
        loadState: z.enum(["load", "networkidle"]).optional().describe("Wait for the page to finish loading."),
        timeout: z.number().int().min(100).max(60_000).default(10_000).describe("Milliseconds (max 60000)."),
      },
    },
    run(async ({ tabId, selector, ref, state, text: needle, url, loadState, timeout }) => {
      if (selector && ref) throw new Error("Pass either selector or ref, not both.");
      if (!selector && !ref && !needle && !url && !loadState) {
        throw new Error("Pass at least one of selector, ref, text, url, loadState.");
      }
      const id = await resolveTabId(bridge, tabId);
      const params = { tabId: id, selector, ref, state, text: needle, url, loadState, timeout };
      return text(await bridge.request("waitFor", params, timeout + SLACK_MS));
    })
  );

  server.registerTool(
    "browser_fetch",
    {
      title: "HTTP request from the page",
      description:
        "Run fetch() from inside the page: same origin and cookies as the page, so it can call the site's own API as the signed-in user. Cross-origin requests work only where the other server's CORS allows the page's origin. Returns status, headers and the body (parsed JSON when the response is JSON), truncated to maxLength characters.",
      inputSchema: {
        tabId: tabIdParam,
        url: z.string().min(1).describe("Absolute URL, or a path relative to the page (e.g. '/api/me')."),
        method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).default("GET").describe("HTTP method."),
        headers: z.record(z.string(), z.string()).optional().describe("Request headers."),
        body: z.string().optional().describe("Request body (e.g. a JSON string; set content-type in headers)."),
        responseType: z
          .enum(["auto", "json", "text"])
          .default("auto")
          .describe("'auto' parses JSON when the response says it is JSON."),
        maxLength: z.number().int().positive().max(1_000_000).default(20_000).describe("Truncate the body to this many characters."),
      },
    },
    run(async ({ tabId, url, method, headers, body, responseType, maxLength }) => {
      if (body !== undefined && (method === "GET" || method === "HEAD")) throw new Error(`A ${method} request can't have a body.`);
      const id = await resolveTabId(bridge, tabId);
      const params = { tabId: id, url, method, headers, body, responseType, maxLength };
      return text(await bridge.request("fetch", params, 60_000));
    })
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
        const logs = await bridge.getConsoleLogs(id, { clear, limit });
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
      description:
        "Check whether the WebMCP Chrome extension is connected. All webmcp server instances share one extension through a hub; reports this instance's role (hub/peer), the hub pid and how many peer instances are attached.",
      inputSchema: {},
    },
    async () => text(await bridge.status())
  );
}
