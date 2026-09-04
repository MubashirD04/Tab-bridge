import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Reused directly from the daemon package's source (monorepo-internal, not a
// published dependency of the shim) so this test can spin up a real daemon
// without requiring a build step first.
import { AllowlistStore } from "../../daemon/src/allowlist.js";
import { ConfigStore } from "../../daemon/src/config.js";
import { Logger } from "../../daemon/src/logger.js";
import { createMcpRequestHandler } from "../../daemon/src/mcpServer.js";
import { TabRegistry } from "../../daemon/src/tabSessions.js";
import { ExtensionBridge } from "../../daemon/src/wsServer.js";
import { buildShim } from "../src/index.js";

describe("tab-bridge-mcp-stdio — forwards to a real daemon", () => {
  let tmpDir: string;
  let daemonHttpServer: http.Server;
  let daemonUrl: string;
  let token: string;
  let shimClient: Client; // stands in for Claude Desktop, talking to the shim over stdio-equivalent in-memory transport

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "tab-bridge-shim-test-"));
    const configStore = new ConfigStore(tmpDir);
    const config = await configStore.loadOrCreateDaemonConfig();
    token = config.token;

    const logger = new Logger(configStore.configDir);
    const allowlistStore = new AllowlistStore(configStore);
    await allowlistStore.load();
    const tabRegistry = new TabRegistry();

    daemonHttpServer = http.createServer();
    const extensionBridge = new ExtensionBridge(daemonHttpServer, "/ext", token, allowlistStore, tabRegistry, logger);
    const mcpHandler = createMcpRequestHandler({ tabRegistry, extensionBridge }, token);
    daemonHttpServer.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/mcp") {
        void mcpHandler(req, res);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => daemonHttpServer.listen(0, "127.0.0.1", resolve));
    const port = (daemonHttpServer.address() as AddressInfo).port;
    daemonUrl = `http://127.0.0.1:${port}/mcp`;

    // Build the shim, but connect it over an in-memory transport pair instead
    // of real stdio — this is the direct equivalent of Claude Desktop's end
    // of the stdio connection, without needing a real subprocess in a test.
    const { server, daemonClient } = buildShim({ token, daemonUrl });
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    await daemonClient.connect(
      new StreamableHTTPClientTransport(new URL(daemonUrl), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      })
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    shimClient = new Client({ name: "test-desktop-client", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), shimClient.connect(clientTransport)]);
  });

  afterEach(async () => {
    await shimClient.close();
    await new Promise<void>((resolve) => daemonHttpServer.close(() => resolve()));
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("forwards tools/list from the daemon unchanged", async () => {
    const { tools } = await shimClient.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ["get_console_logs", "get_network_requests", "get_page_content", "list_allowed_tabs", "screenshot_tab"].sort()
    );
  });

  it("forwards a successful tools/call through to the daemon", async () => {
    const result = (await shimClient.callTool({ name: "list_allowed_tabs", arguments: {} })) as {
      content: Array<{ type: string; text?: string }>;
    };
    const data = JSON.parse(result.content[0].text ?? "{}");
    expect(data).toEqual({ tabs: [] }); // no extension connected, no tabs granted — genuinely empty
  });

  it("forwards the daemon's error path (e.g. TAB_NOT_ALLOWED) through unchanged", async () => {
    const result = (await shimClient.callTool({
      name: "get_page_content",
      arguments: { tabId: 42, mode: "html" },
    })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text ?? "{}");
    expect(data.error.code).toBe("TAB_NOT_ALLOWED");
  });
});
