import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AllowlistStore } from "../src/allowlist.js";
import { ConfigStore } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { createMcpRequestHandler } from "../src/mcpServer.js";
import { TabRegistry } from "../src/tabSessions.js";
import { ExtensionBridge } from "../src/wsServer.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(fn: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const value = await fn();
    if (predicate(value)) return value;
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await delay(25);
  }
}

function parseToolJson(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }) {
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  return { data: JSON.parse(text), isError: result.isError === true };
}

const SESSION_ID = "test-browser-session";
const ALLOWED_URL = "http://127.0.0.1:5500/index.html";
const TAB_ID = 1;

describe("Tab Bridge — MCP tool server, end to end", () => {
  let tmpDir: string;
  let httpServer: http.Server;
  let port: number;
  let token: string;
  let fakeExtension: WebSocket;
  let client: Client;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "tab-bridge-test-"));
    const configStore = new ConfigStore(tmpDir);
    const config = await configStore.loadOrCreateDaemonConfig();
    token = config.token;

    const logger = new Logger(configStore.configDir);
    const allowlistStore = new AllowlistStore(configStore);
    await allowlistStore.load();
    // No manual grant here on purpose: ALLOWED_URL is on port 5500, one of
    // the default trusted dev ports, so it's allowed via Live-Server
    // auto-approval — exercising that path end-to-end rather than the
    // manual-grant path, which allowlist.test.ts already covers directly.

    const tabRegistry = new TabRegistry();
    httpServer = http.createServer();
    const extensionBridge = new ExtensionBridge(httpServer, "/ext", token, allowlistStore, tabRegistry, logger);
    const mcpHandler = createMcpRequestHandler({ tabRegistry, extensionBridge }, token);

    httpServer.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/mcp") {
        void mcpHandler(req, res);
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    port = (httpServer.address() as AddressInfo).port;

    // --- Fake extension: a real WebSocket client standing in for the
    // Firefox background script (blueprint Section 9: "integration tests
    // against the http endpoint using a mock WebSocket client standing in
    // for the extension"). ---
    fakeExtension = new WebSocket(`ws://127.0.0.1:${port}/ext`);
    await new Promise<void>((resolve) => fakeExtension.once("open", () => resolve()));

    const helloAck = new Promise<void>((resolve) => {
      fakeExtension.once("message", () => resolve()); // hello_ack
    });
    fakeExtension.send(JSON.stringify({ type: "hello", token, browserSessionId: SESSION_ID }));
    await helloAck;

    fakeExtension.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "get_content_request") {
        fakeExtension.send(
          JSON.stringify({
            type: "get_content_response",
            requestId: msg.requestId,
            tabId: msg.tabId,
            content: "<html><body><button class=\"misaligned\">Submit</button></body></html>",
            truncated: false,
          })
        );
      } else if (msg.type === "screenshot_request") {
        fakeExtension.send(
          JSON.stringify({
            type: "screenshot_response",
            requestId: msg.requestId,
            tabId: msg.tabId,
            imageBase64: "ZmFrZS1wbmctYnl0ZXM=",
            width: 1280,
            height: 720,
          })
        );
      }
    });

    fakeExtension.send(
      JSON.stringify({ type: "tab_updated", tabId: TAB_ID, windowId: 1, url: ALLOWED_URL, title: "Test Page" })
    );

    client = new Client({ name: "test-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);

    // Make sure the tab_updated message above has actually been processed
    // before any test body runs, rather than relying on timing.
    await waitFor(
      async () => parseToolJson(await client.callTool({ name: "list_allowed_tabs", arguments: {} }) as never).data,
      (data) => data.tabs?.length === 1
    );
  });

  afterEach(async () => {
    await client.close();
    fakeExtension.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("the primary journey: list -> get_page_content -> screenshot_tab against a real allowed tab", async () => {
    const list = parseToolJson(await client.callTool({ name: "list_allowed_tabs", arguments: {} }) as never);
    expect(list.data.tabs).toEqual([
      expect.objectContaining({ tabId: TAB_ID, source: "live-server-auto", url: ALLOWED_URL }),
    ]);

    const content = parseToolJson(
      (await client.callTool({
        name: "get_page_content",
        arguments: { tabId: TAB_ID, mode: "html" },
      })) as never
    );
    expect(content.isError).toBe(false);
    expect(content.data.content).toContain("misaligned");

    const screenshotResult = (await client.callTool({
      name: "screenshot_tab",
      arguments: { tabId: TAB_ID },
    })) as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };
    expect(screenshotResult.isError).toBeFalsy();

    // The critical assertion: the image must arrive as its own `type: "image"`
    // content block, not buried as base64 text inside a JSON blob — that's
    // the difference between Claude actually seeing the screenshot and
    // Claude receiving an opaque wall of text (see mcpServer.ts's comment on
    // this exact point, added after this was initially built wrong).
    const imageBlock = screenshotResult.content.find((c) => c.type === "image");
    expect(imageBlock).toBeDefined();
    expect(imageBlock?.data).toBe("ZmFrZS1wbmctYnl0ZXM=");
    expect(imageBlock?.mimeType).toBe("image/png");

    const metadata = parseToolJson(screenshotResult as never);
    expect(metadata.data.width).toBe(1280);
    expect(metadata.data.height).toBe(720);
  });

  it("returns TAB_NOT_ALLOWED for a tab that was never granted, without ever asking the extension", async () => {
    const result = parseToolJson(
      (await client.callTool({
        name: "get_page_content",
        arguments: { tabId: 999, mode: "html" },
      })) as never
    );
    expect(result.isError).toBe(true);
    expect(result.data.error.code).toBe("TAB_NOT_ALLOWED");
  });

  it("redacts Authorization/Cookie headers in captured network requests before they're ever readable via MCP", async () => {
    fakeExtension.send(
      JSON.stringify({
        type: "network_request",
        entry: {
          tabId: TAB_ID,
          requestId: "req-1",
          timestamp: new Date().toISOString(),
          method: "GET",
          url: "http://127.0.0.1:5500/api/data",
          type: "fetch",
          statusCode: 200,
          requestHeaders: { Authorization: "Bearer super-secret", "X-Custom": "keep-me" },
          responseHeaders: { "Set-Cookie": "session=abc123" },
        },
      })
    );

    const result = await waitFor(
      async () =>
        parseToolJson(
          (await client.callTool({ name: "get_network_requests", arguments: { tabId: TAB_ID } })) as never
        ),
      (r) => r.data.entries?.length === 1
    );

    const entry = result.data.entries[0];
    expect(entry.requestHeaders.Authorization).toBe("[redacted]");
    expect(entry.requestHeaders["X-Custom"]).toBe("keep-me");
    expect(entry.responseHeaders["Set-Cookie"]).toBe("[redacted]");
  });

  it("get_console_logs returns captured entries for an allowed tab", async () => {
    fakeExtension.send(
      JSON.stringify({
        type: "console_log",
        entry: {
          tabId: TAB_ID,
          timestamp: new Date().toISOString(),
          level: "error",
          args: ["TypeError: cannot read property 'foo' of undefined"],
        },
      })
    );

    const result = await waitFor(
      async () =>
        parseToolJson((await client.callTool({ name: "get_console_logs", arguments: { tabId: TAB_ID } })) as never),
      (r) => r.data.entries?.length === 1
    );

    expect(result.data.entries[0].level).toBe("error");
    expect(result.data.entries[0].args[0]).toContain("TypeError");
  });
});
