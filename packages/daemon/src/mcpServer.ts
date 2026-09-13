import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ExtensionBridge } from "./wsServer.js";
import type { TabRegistry } from "./tabSessions.js";
import { TabBridgeError } from "./types.js";

export interface McpDeps {
  tabRegistry: TabRegistry;
  extensionBridge: ExtensionBridge;
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function errResult(err: unknown): CallToolResult {
  if (err instanceof TabBridgeError) {
    return { content: [{ type: "text", text: JSON.stringify(err.toJSON()) }], isError: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: JSON.stringify({ error: { code: "CAPTURE_FAILED", message } }) }],
    isError: true,
  };
}

/**
 * Builds the MCP server exposing Tab Bridge's five tools. All read-only, by
 * design (blueprint Section 3): there is deliberately no tool that lets a
 * client grant itself access to a new tab — only a click in the extension's
 * popup does that.
 */
export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "tab-bridge", version: "0.1.0" });
  const { tabRegistry, extensionBridge } = deps;

  server.registerTool(
    "list_allowed_tabs",
    {
      title: "List allowed tabs",
      description:
        "Lists the browser tabs currently allowed for viewing — either manually allowed via the extension popup, or auto-approved because they're on a trusted local dev-server port (e.g. VS Code Live Server).",
    },
    async () => {
      const tabs = tabRegistry.list().map((t) => ({
        tabId: t.tabId,
        title: t.title,
        url: t.url,
        origin: new URL(t.url).origin,
        source: t.source,
        connectedAt: t.connectedAt,
      }));
      return ok({ tabs });
    }
  );

  server.registerTool(
    "get_page_content",
    {
      title: "Get page content",
      description: "Reads the live HTML or visible text of an allowed tab.",
      inputSchema: {
        tabId: z.number().describe("The tab ID, from list_allowed_tabs."),
        mode: z.enum(["html", "text"]).describe("\"html\" for the full DOM, \"text\" for visible text only."),
      },
    },
    async ({ tabId, mode }) => {
      try {
        const result = await extensionBridge.requestContent(tabId, mode);
        return ok({
          tabId,
          url: tabRegistry.get(tabId)?.url,
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
      description: "Captures a rendered screenshot of an allowed tab, even if it's not the active tab.",
      inputSchema: {
        tabId: z.number().describe("The tab ID, from list_allowed_tabs."),
        format: z.enum(["png", "jpeg"]).optional().describe("Defaults to png."),
      },
    },
    async ({ tabId, format }) => {
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
                tabId,
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
        tabId: z.number(),
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
    async ({ tabId, since, levels, limit }) => {
      if (!tabRegistry.isAllowed(tabId)) {
        return errResult(new TabBridgeError("TAB_NOT_ALLOWED", `Tab ${tabId} is not on the allow-list.`, tabId));
      }
      if (!tabRegistry.getCaptureSettings().consoleLogs) {
        return errResult(
          new TabBridgeError(
            "CAPTURE_DISABLED",
            "Console log capture is turned off in the Tab Bridge extension (Settings → Capture permissions), so nothing has been recorded. This does not mean the page has no console output.",
            tabId
          )
        );
      }
      const entries = tabRegistry.getConsoleLogs(tabId, { since, levels, limit });
      return ok({ tabId, entries });
    }
  );

  server.registerTool(
    "get_network_requests",
    {
      title: "Get network requests",
      description:
        "Returns recently observed network requests for an allowed tab, including failed requests (`error` set, no `statusCode`) and redirect hops (`redirectUrl` set). Credential header values (Authorization, Cookie, Set-Cookie, API-key/token/CSRF headers) are always redacted.",
      inputSchema: {
        tabId: z.number(),
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
    async ({ tabId, since, urlFilter, limit }) => {
      if (!tabRegistry.isAllowed(tabId)) {
        return errResult(new TabBridgeError("TAB_NOT_ALLOWED", `Tab ${tabId} is not on the allow-list.`, tabId));
      }
      if (!tabRegistry.getCaptureSettings().networkRequests) {
        return errResult(
          new TabBridgeError(
            "CAPTURE_DISABLED",
            "Network request capture is turned off in the Tab Bridge extension (Settings → Capture permissions), so nothing has been recorded. This does not mean the page made no requests.",
            tabId
          )
        );
      }
      const entries = tabRegistry.getNetworkRequests(tabId, { since, urlFilter, limit });
      return ok({ tabId, entries });
    }
  );

  return server;
}

/**
 * Node HTTP handler for POST /mcp, in stateless mode (a fresh McpServer +
 * transport per request — this tool surface has no need for a persistent
 * streaming session). Bearer-token auth is checked before the request ever
 * reaches the transport.
 */
export function createMcpRequestHandler(deps: McpDeps, expectedToken: string) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const authHeader = req.headers["authorization"];
    const expected = `Bearer ${expectedToken}`;
    if (authHeader !== expected) {
      res.writeHead(401, { "content-type": "application/json" }).end(
        JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Missing or invalid bearer token." } })
      );
      return;
    }

    const server = buildMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };
}
