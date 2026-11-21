import type { Duplex } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ExtensionBridge } from "./extensionBridge.js";
import type { TabRegistry } from "./tabSessions.js";
import { SharepaneError } from "./types.js";
import { VERSION } from "./version.js";

export interface McpDeps {
  tabRegistry: TabRegistry;
  extensionBridge: ExtensionBridge;
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function errResult(err: unknown): CallToolResult {
  if (err instanceof SharepaneError) {
    return { content: [{ type: "text", text: JSON.stringify(err.toJSON()) }], isError: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: JSON.stringify({ error: { code: "CAPTURE_FAILED", message } }) }],
    isError: true,
  };
}

/**
 * Builds the MCP server exposing Sharepane's five tools. All read-only, by
 * design (blueprint Section 3): there is deliberately no tool that lets a
 * client grant itself access to a new tab — only a click in the extension's
 * popup does that.
 */
const TAB_ID_ARG = z
  .number()
  .optional()
  .describe(
    "Optional. Defaults to the shared tab the user is looking at (or the only shared tab). IDs come from list_allowed_tabs."
  );

export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "sharepane", version: VERSION });
  const { tabRegistry, extensionBridge } = deps;

  /** Which tab a call acted on, echoed in every result so a defaulted
   * tabId is never ambiguous. */
  const tabInfo = (tabId: number) => {
    const tab = tabRegistry.get(tabId);
    return { tabId, title: tab?.title, url: tab?.url };
  };

  server.registerTool(
    "list_allowed_tabs",
    {
      title: "List allowed tabs",
      description:
        "Lists the browser tabs the user has shared — either via the extension's Share with Claude switch, or automatically because they're on a trusted local dev-server port (e.g. VS Code Live Server). `active: true` marks the one the user is looking at; the other tools default to it.",
    },
    async () => {
      const activeTabId = tabRegistry.getActiveTabId();
      const tabs = tabRegistry.list().map((t) => ({
        tabId: t.tabId,
        title: t.title,
        url: t.url,
        origin: new URL(t.url).origin,
        source: t.source,
        active: t.tabId === activeTabId,
        connectedAt: t.connectedAt,
      }));
      return ok({ tabs });
    }
  );

  server.registerTool(
    "get_page_content",
    {
      title: "Get page content",
      description: "Reads the live HTML or visible text of a shared tab.",
      inputSchema: {
        tabId: TAB_ID_ARG,
        mode: z.enum(["html", "text"]).describe("\"html\" for the full DOM, \"text\" for visible text only."),
      },
    },
    async ({ tabId: requestedTabId, mode }) => {
      let tabId: number;
      try {
        tabId = tabRegistry.resolveTab(requestedTabId);
      } catch (err) {
        return errResult(err);
      }
      try {
        const result = await extensionBridge.requestContent(tabId, mode);
        return ok({
          ...tabInfo(tabId),
          capturedAt: new Date().toISOString(),
          content: result.content,
          truncated: result.truncated,
        });
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    "screenshot_tab",
    {
      title: "Screenshot tab",
      description: "Captures a rendered screenshot of a shared tab, even if it's not the active tab.",
      inputSchema: {
        tabId: TAB_ID_ARG,
        format: z.enum(["png", "jpeg"]).optional().describe("Defaults to png."),
      },
    },
    async ({ tabId: requestedTabId, format }) => {
      let tabId: number;
      try {
        tabId = tabRegistry.resolveTab(requestedTabId);
      } catch (err) {
        return errResult(err);
      }
      if (tabRegistry.isAllowed(tabId) && !tabRegistry.getCaptureSettings().screenshots) {
        return errResult(
          new SharepaneError(
            "CAPTURE_DISABLED",
            "Screenshots are turned off in the Sharepane extension (Settings → Capture permissions → Allow screenshots). Firefox requires all-sites access for screenshots, so they're a separate opt-in. get_page_content still works.",
            tabId
          )
        );
      }
      try {
        const result = await extensionBridge.requestScreenshot(tabId, format ?? "png");
        // The image has to be its own `type: "image"` content block — an
        // MCP client only renders base64 bytes as an actual viewable image
        // when they arrive this way. Burying them inside a JSON text blob
        // (as an earlier version of this tool did) transmits the same
        // bytes but the model never actually sees a picture, just a wall of
        // text — silently defeating the whole point of the tool.
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ...tabInfo(tabId),
                capturedAt: new Date().toISOString(),
                width: result.width,
                height: result.height,
              }),
            },
            {
              type: "image",
              data: result.imageBase64,
              mimeType: (format ?? "png") === "jpeg" ? "image/jpeg" : "image/png",
            },
          ],
        };
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.registerTool(
    "get_console_logs",
    {
      title: "Get console logs",
      description:
        "Returns recently captured console output (log/warn/error/info/debug) for an allowed tab, including uncaught exceptions, unhandled promise rejections and failed resource loads (level \"error\", with `kind` saying which).",
      inputSchema: {
        tabId: TAB_ID_ARG,
        since: z.string().optional().describe("ISO 8601 timestamp; only entries at or after this time."),
        levels: z.array(z.string()).optional().describe("Filter to these console levels only."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Return only the most recent N matching entries. Entries are always ordered oldest first."),
      },
    },
    async ({ tabId: requestedTabId, since, levels, limit }) => {
      let tabId: number;
      try {
        tabId = tabRegistry.resolveTab(requestedTabId);
      } catch (err) {
        return errResult(err);
      }
      if (!tabRegistry.isAllowed(tabId)) {
        return errResult(new SharepaneError("TAB_NOT_ALLOWED", `Tab ${tabId} is not on the allow-list.`, tabId));
      }
      if (!tabRegistry.getCaptureSettings().consoleLogs) {
        return errResult(
          new SharepaneError(
            "CAPTURE_DISABLED",
            "Console log capture is turned off in the Sharepane extension (Settings → Capture permissions), so nothing has been recorded. This does not mean the page has no console output.",
            tabId
          )
        );
      }
      const entries = tabRegistry.getConsoleLogs(tabId, { since, levels, limit });
      return ok({ ...tabInfo(tabId), entries });
    }
  );

  server.registerTool(
    "get_network_requests",
    {
      title: "Get network requests",
      description:
        "Returns recently observed network requests for an allowed tab, including failed requests (`error` set, no `statusCode`) and redirect hops (`redirectUrl` set). Credential header values (Authorization, Cookie, Set-Cookie, API-key/token/CSRF headers) are always redacted.",
      inputSchema: {
        tabId: TAB_ID_ARG,
        since: z.string().optional().describe("ISO 8601 timestamp; only entries at or after this time."),
        urlFilter: z.string().optional().describe("Case-insensitive substring match against the request URL."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Return only the most recent N matching entries. Entries are always ordered oldest first."),
      },
    },
    async ({ tabId: requestedTabId, since, urlFilter, limit }) => {
      let tabId: number;
      try {
        tabId = tabRegistry.resolveTab(requestedTabId);
      } catch (err) {
        return errResult(err);
      }
      if (!tabRegistry.isAllowed(tabId)) {
        return errResult(new SharepaneError("TAB_NOT_ALLOWED", `Tab ${tabId} is not on the allow-list.`, tabId));
      }
      if (!tabRegistry.getCaptureSettings().networkRequests) {
        return errResult(
          new SharepaneError(
            "CAPTURE_DISABLED",
            "Network request capture is turned off in the Sharepane extension (Settings → Capture permissions), so nothing has been recorded. This does not mean the page made no requests.",
            tabId
          )
        );
      }
      const entries = tabRegistry.getNetworkRequests(tabId, { since, urlFilter, limit });
      return ok({ ...tabInfo(tabId), entries });
    }
  );

  return server;
}

/**
 * Serves one MCP session over a duplex stream (a Unix-socket connection, in
 * the host). Newline-delimited JSON-RPC, exactly as MCP's stdio transport
 * frames it, so a client process can simply pipe its own stdin/stdout to the
 * socket. There is no auth check here: the socket file is only reachable by
 * the user who owns it (see host.ts).
 */
export async function serveMcpOnStream(
  deps: McpDeps,
  stream: Duplex,
  onClientName?: (name: string | undefined) => void
): Promise<void> {
  const server = buildMcpServer(deps);
  if (onClientName) {
    server.server.oninitialized = () => onClientName(server.server.getClientVersion()?.name);
  }
  const transport = new StdioServerTransport(stream, stream);
  stream.on("close", () => {
    void server.close();
  });
  stream.on("error", () => {
    // A client vanishing mid-write is normal; "close" follows and cleans up.
  });
  await server.connect(transport);
}
