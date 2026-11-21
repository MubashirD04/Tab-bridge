import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer } from "./mcpServer.js";
import { SocketClientTransport } from "./socketClient.js";
import { SharepaneError } from "./types.js";
import { VERSION } from "./version.js";


export const NOT_CONNECTED_MESSAGE =
  "Sharepane isn't connected to Firefox. Open Firefox with the Sharepane extension installed " +
  "(if it's open, click the Sharepane toolbar icon to see what's wrong), then try again.";

/** The tool list straight from the host's own definitions, so it can be
 * served while Firefox is closed without a second copy to keep in sync. */
async function offlineToolList(): Promise<ListToolsResult> {
  // listTools never touches the deps; they're only used inside tool handlers.
  const server = buildMcpServer({ tabRegistry: undefined as never, extensionBridge: undefined as never });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "sharepane-offline", version: VERSION });
  await server.connect(serverSide);
  await client.connect(clientSide);
  const result = await client.listTools();
  await client.close();
  await server.close();
  return result;
}

function notConnectedResult(): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(new SharepaneError("EXTENSION_DISCONNECTED", NOT_CONNECTED_MESSAGE).toJSON()) }],
    isError: true,
  };
}

/** Upstream client names starting with this are Claude (or another MCP app)
 * via the proxy; the rest of the name is the app's own client name. Anything
 * else on the socket (doctor, status) isn't counted as "Claude connected". */
export const PROXY_CLIENT_PREFIX = "sharepane-proxy:";

/**
 * The MCP server Claude launches (`sharepane mcp`, over stdio).
 *
 * The host only exists while Firefox is open, but Claude starts its MCP
 * servers once per session and doesn't reliably reconnect one that failed.
 * So this proxy always starts, always lists the tools, and connects to the
 * host's socket lazily, on each request, until it gets through. Firefox can
 * be opened, closed or restarted mid-session and the next tool call simply
 * works (or says plainly that Firefox isn't connected).
 */
export function buildMcpProxy(socketPath: string): Server {
  let upstream: Promise<Client> | undefined;
  let offlineTools: Promise<ListToolsResult> | undefined;

  const getUpstream = (): Promise<Client> => {
    upstream ??= (async () => {
      const transport = new SocketClientTransport(socketPath);
      const downstream = server.getClientVersion()?.name ?? "unknown";
      const client = new Client({ name: `${PROXY_CLIENT_PREFIX}${downstream}`, version: VERSION });
      transport.onclose = () => {
        upstream = undefined; // Firefox closed: reconnect on the next request
      };
      await client.connect(transport);
      return client;
    })().catch((err) => {
      upstream = undefined;
      throw err;
    });
    return upstream;
  };

  const server = new Server({ name: "sharepane", version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      return await (await getUpstream()).listTools();
    } catch {
      offlineTools ??= offlineToolList();
      return offlineTools;
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    let client: Client;
    try {
      client = await getUpstream();
    } catch {
      return notConnectedResult();
    }
    try {
      return (await client.callTool(request.params)) as CallToolResult;
    } catch (err) {
      // The socket dropped mid-call (Firefox quit). Anything else is a real
      // protocol error and should surface as one.
      if (!upstream) return notConnectedResult();
      throw err;
    }
  });

  return server;
}
