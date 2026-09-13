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
import { ExtensionBridge } from "../src/wsServer.js";

const SESSION_ID = "test-browser-session";
const CAPTURE_ON = { consoleLogs: true, networkRequests: true };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("until timed out");
    await delay(10);
  }
}

describe("ExtensionBridge — tab state across reconnects, revokes and trusted-port edits", () => {
  let tmpDir: string;
  let httpServer: http.Server;
  let port: number;
  let token: string;
  let tabRegistry: TabRegistry;
  let bridge: ExtensionBridge;
  const sockets: WebSocket[] = [];

  async function connect(browserSessionId = SESSION_ID): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
    sockets.push(ws);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    const helloAck = new Promise<void>((resolve) => ws.once("message", () => resolve()));
    ws.send(JSON.stringify({ type: "hello", token, browserSessionId, capture: CAPTURE_ON }));
    await helloAck;
    return ws;
  }

  function reportTab(ws: WebSocket, tabId: number, url: string): void {
    ws.send(JSON.stringify({ type: "tab_updated", tabId, windowId: 1, url, title: url }));
  }

  function log(ws: WebSocket, tabId: number, text: string): void {
    ws.send(
      JSON.stringify({
        type: "console_log",
        entry: { tabId, timestamp: new Date().toISOString(), level: "log", args: [text] },
      })
    );
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "tab-bridge-test-"));
    const configStore = new ConfigStore(tmpDir);
    const config = await configStore.loadOrCreateDaemonConfig();
    token = config.token;
    const logger = new Logger(configStore.configDir);
    const allowlistStore = new AllowlistStore(configStore);
    await allowlistStore.load();
    tabRegistry = new TabRegistry();
    httpServer = http.createServer();
    bridge = new ExtensionBridge(httpServer, "/ext", token, allowlistStore, tabRegistry, logger, 0);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("keeps captured console logs across a reconnect from the same browser session", async () => {
    const first = await connect();
    reportTab(first, 1, "http://127.0.0.1:5500/");
    log(first, 1, "survives");
    await until(() => tabRegistry.getConsoleLogs(1).length === 1);
    first.close();
    await delay(50);

    const second = await connect();
    reportTab(second, 1, "http://127.0.0.1:5500/");
    await until(() => tabRegistry.isAllowed(1));
    expect(tabRegistry.getConsoleLogs(1).map((e) => e.args[0])).toEqual(["survives"]);
  });

  it("discards captured logs when the browser session changes", async () => {
    const first = await connect();
    reportTab(first, 1, "http://127.0.0.1:5500/");
    log(first, 1, "old session");
    await until(() => tabRegistry.getConsoleLogs(1).length === 1);
    first.close();
    await delay(50);

    const second = await connect("a-new-browser-session");
    reportTab(second, 1, "http://127.0.0.1:5500/");
    await until(() => tabRegistry.isAllowed(1));
    expect(tabRegistry.getConsoleLogs(1)).toEqual([]);
  });

  it("revoking a manual grant from one tab removes every tab at that origin", async () => {
    const ws = await connect();
    reportTab(ws, 1, "https://staging.myapp.com/a");
    reportTab(ws, 2, "https://staging.myapp.com/b");
    reportTab(ws, 3, "http://127.0.0.1:5500/");
    ws.send(JSON.stringify({ type: "grant_access", tabId: 1, url: "https://staging.myapp.com/a" }));
    await until(() => tabRegistry.isAllowed(1));
    // Tab 2 becomes allowed on its next report now that the origin is granted.
    reportTab(ws, 2, "https://staging.myapp.com/b");
    await until(() => tabRegistry.isAllowed(2));

    ws.send(JSON.stringify({ type: "revoke_access", tabId: 1 }));
    await until(() => !tabRegistry.isAllowed(1) && !tabRegistry.isAllowed(2));
    expect(tabRegistry.isAllowed(3)).toBe(true);
  });

  it("applies trusted-port edits to tabs that are already open", async () => {
    const ws = await connect();
    reportTab(ws, 1, "http://127.0.0.1:5500/");
    reportTab(ws, 2, "http://127.0.0.1:4321/");
    await until(() => tabRegistry.isAllowed(1));
    expect(tabRegistry.isAllowed(2)).toBe(false);

    ws.send(JSON.stringify({ type: "set_trusted_ports", ports: [{ port: 4321, protocol: "http", label: "Astro" }] }));
    await until(() => tabRegistry.isAllowed(2) && !tabRegistry.isAllowed(1));
  });

  it("fails an in-flight content request as soon as the extension disconnects", async () => {
    const ws = await connect();
    reportTab(ws, 1, "http://127.0.0.1:5500/");
    await until(() => tabRegistry.isAllowed(1));

    const request = bridge.requestContent(1, "html");
    await delay(20);
    ws.close();
    await expect(request).rejects.toMatchObject({ code: "EXTENSION_DISCONNECTED" });
  });
});
