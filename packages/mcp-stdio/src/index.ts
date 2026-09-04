#!/usr/bin/env node
/**
 * Thin stdio -> http transport adapter for the Tab Bridge daemon.
 *
 * This exists purely because some MCP clients — Claude Desktop, notably —
 * only support launching a local stdio subprocess, not connecting to a
 * standing HTTP server (Claude Code supports http directly and doesn't need
 * this at all). It forwards `tools/list` and `tools/call` to the daemon's
 * MCP endpoint unchanged; it does not re-implement or re-validate the tools
 * themselves. The daemon remains the single source of truth for the
 * allow-list and every tool's behavior — see the blueprint's Section 1
 * component table.
 *
 * Configuration is via environment variables, set in claude_desktop_config.json:
 *   TAB_BRIDGE_TOKEN — required, the pairing token from ~/.tab-bridge/config.json
 *   TAB_BRIDGE_URL   — optional, defaults to http://127.0.0.1:8765/mcp
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_DAEMON_URL = "http://127.0.0.1:8765/mcp";

export interface ShimOptions {
  daemonUrl?: string;
  token: string;
}

/** Builds the forwarding server and its upstream client, but does not connect
 * either transport — split out from `main()` so tests can wire in in-memory
 * transports instead of real stdio/network ones. */
export function buildShim(options: ShimOptions): { server: Server; daemonClient: Client } {
  const daemonUrl = options.daemonUrl ?? DEFAULT_DAEMON_URL;

  const daemonClient = new Client({ name: "tab-bridge-mcp-stdio", version: "0.1.0" });

  const server = new Server(
    { name: "tab-bridge", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => daemonClient.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    daemonClient.callTool(request.params)
  );

  return { server, daemonClient };
}

export async function connectShim(options: ShimOptions): Promise<{ server: Server; daemonClient: Client }> {
  const { server, daemonClient } = buildShim(options);
  const daemonUrl = options.daemonUrl ?? DEFAULT_DAEMON_URL;

  const daemonTransport = new StreamableHTTPClientTransport(new URL(daemonUrl), {
    requestInit: { headers: { Authorization: `Bearer ${options.token}` } },
  });
  await daemonClient.connect(daemonTransport);

  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);

  return { server, daemonClient };
}

async function main(): Promise<void> {
  const token = process.env.TAB_BRIDGE_TOKEN;
  if (!token) {
    // Must go to stderr, never stdout — stdout is reserved for MCP JSON-RPC
    // traffic once the stdio transport is connected.
    console.error(
      "tab-bridge-mcp-stdio: TAB_BRIDGE_TOKEN is not set. Copy it from ~/.tab-bridge/config.json " +
        "and set it in your MCP client's config (e.g. claude_desktop_config.json)."
    );
    process.exit(1);
  }

  try {
    await connectShim({ token, daemonUrl: process.env.TAB_BRIDGE_URL });
  } catch (err) {
    console.error(
      "tab-bridge-mcp-stdio: could not reach the tab-bridge daemon. Is it running? (`tab-bridge start`)"
    );
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Only run main() when executed directly (as a subprocess), not when
// imported by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
