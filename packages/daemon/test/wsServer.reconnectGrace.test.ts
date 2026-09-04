import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { AllowlistStore } from "../src/allowlist.js";
import { ConfigStore } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { TabRegistry } from "../src/tabSessions.js";
import { TabBridgeError } from "../src/types.js";
import { ExtensionBridge } from "../src/wsServer.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SESSION_ID = "test-browser-session";
const ALLOWED_URL = "http://127.0.0.1:5500/index.html"; // matches a default trusted dev port
const TAB_ID = 1;

// Covers the fix for the "extension flaps, tool call fails instantly, and by
// the time the extension reconnects the caller has already given up and
// tried again" race — see the RECONNECT_GRACE_MS comment in wsServer.ts.
describe("ExtensionBridge — reconnect grace window", () => {
  let tmpDir: string;
  let allowlistStore: AllowlistStore;
  let tabRegistry: TabRegistry;
  let logger: Logger;
  let httpServer: http.Server;
  let port: number;
  let token: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "tab-bridge-test-"));
    const configStore = new ConfigStore(tmpDir);
    const config = await configStore.loadOrCreateDaemonConfig();
    token = config.token;

    logger = new Logger(configStore.configDir);
    allowlistStore = new AllowlistStore(configStore);
    await allowlistStore.load();

    tabRegistry = new TabRegistry();
    httpServer = http.createServer();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function connectFakeExtension(respond = true): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));

    // Dispatch by message type rather than by arrival order: the daemon can
    // fire a queued get_content_request the instant it sees `this.socket`
    // set (see the connectWaiters notify in wsServer.ts), which races ahead
    // of hello_ack's own async chain — so "the first message is hello_ack"
    // isn't a safe assumption here the way it is in the happy-path tests.
    const helloAck = new Promise<void>((resolve) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "hello_ack") {
          resolve();
        } else if (respond && msg.type === "get_content_request") {
          ws.send(
            JSON.stringify({
              type: "get_content_response",
              requestId: msg.requestId,
              tabId: msg.tabId,
              content: "<html>reconnected</html>",
              truncated: false,
            })
          );
        }
      });
    });
    ws.send(JSON.stringify({ type: "hello", token, browserSessionId: SESSION_ID }));
    await helloAck;
    ws.send(JSON.stringify({ type: "tab_updated", tabId: TAB_ID, windowId: 1, url: ALLOWED_URL, title: "Test Page" }));
    return ws;
  }

  it("absorbs a brief drop: a request made mid-flap succeeds once the extension reconnects within the grace window", async () => {
    const extensionBridge = new ExtensionBridge(
      httpServer,
      "/ext",
      token,
      allowlistStore,
      tabRegistry,
      logger,
      2_000 // generous grace — the assertion is "waits and succeeds," not exact timing
    );
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    port = (httpServer.address() as AddressInfo).port;

    const first = await connectFakeExtension(false);
    // Let the tab registration land before we pull the rug.
    await delay(50);
    first.close();
    // Give the daemon a beat to actually process the close (this.socket
    // becomes undefined) before the request fires, so it genuinely hits the
    // "not connected, wait" branch rather than racing the close itself.
    await delay(50);

    expect(extensionBridge.isConnected()).toBe(false);
    const contentPromise = extensionBridge.requestContent(TAB_ID, "html");

    // Reconnect while the request is still pending — this is the "extension
    // is on its way back" case the grace window exists for.
    await delay(100);
    const second = await connectFakeExtension(true);

    const result = await contentPromise;
    expect(result.content).toBe("<html>reconnected</html>");

    second.close();
  });

  it("still fails with EXTENSION_DISCONNECTED if nothing reconnects within the grace window", async () => {
    const extensionBridge = new ExtensionBridge(
      httpServer,
      "/ext",
      token,
      allowlistStore,
      tabRegistry,
      logger,
      75 // short grace so the test doesn't hang
    );
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    port = (httpServer.address() as AddressInfo).port;

    const first = await connectFakeExtension(false);
    await delay(50);
    first.close();
    await delay(50);

    await expect(extensionBridge.requestContent(TAB_ID, "html")).rejects.toMatchObject({
      code: "EXTENSION_DISCONNECTED",
    } satisfies Partial<TabBridgeError>);
  });
});
