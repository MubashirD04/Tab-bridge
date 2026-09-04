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

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (raw) => resolve(JSON.parse(raw.toString())));
  });
}

const SESSION_ID = "test-browser-session";
const GRANTED_URL = "https://staging.myapp.com/dashboard";
const TAB_ID = 1;

// Covers the fix for a second, related staleness bug uncovered alongside the
// reconnect-grace fix: a manual grant is origin-scoped on the daemon (see
// allowlist.ts), but the extension's local allowedTabIds mirror is wiped on
// every reconnect (fresh script context). Without hello_ack telling it which
// origins are still validly granted, a manually-allowed tab would silently
// stop responding to get_page_content/screenshot_tab after any reconnect
// until the user re-clicked "Allow." See HelloAckMessage.grantedOrigins.
describe("ExtensionBridge — grantedOrigins survives a reconnect", () => {
  let tmpDir: string;
  let httpServer: http.Server;
  let port: number;
  let token: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "tab-bridge-test-"));
    const configStore = new ConfigStore(tmpDir);
    const config = await configStore.loadOrCreateDaemonConfig();
    token = config.token;

    const logger = new Logger(configStore.configDir);
    const allowlistStore = new AllowlistStore(configStore);
    await allowlistStore.load();
    const tabRegistry = new TabRegistry();
    httpServer = http.createServer();
    new ExtensionBridge(httpServer, "/ext", token, allowlistStore, tabRegistry, logger);

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("a fresh connection's hello_ack has no grantedOrigins yet", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    const helloAck = nextMessage(ws);
    ws.send(JSON.stringify({ type: "hello", token, browserSessionId: SESSION_ID }));
    expect((await helloAck).grantedOrigins).toEqual([]);
    ws.close();
  });

  it("a manual grant made on one connection is reported back in hello_ack on the next", async () => {
    const first = new WebSocket(`ws://127.0.0.1:${port}/ext`);
    await new Promise<void>((resolve) => first.once("open", () => resolve()));
    const firstHelloAck = nextMessage(first);
    first.send(JSON.stringify({ type: "hello", token, browserSessionId: SESSION_ID }));
    await firstHelloAck;

    first.send(JSON.stringify({ type: "grant_access", tabId: TAB_ID, url: GRANTED_URL, label: "Staging" }));
    // grant() persists asynchronously — give it a beat before disconnecting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = new WebSocket(`ws://127.0.0.1:${port}/ext`);
    await new Promise<void>((resolve) => second.once("open", () => resolve()));
    const secondHelloAck = nextMessage(second);
    second.send(JSON.stringify({ type: "hello", token, browserSessionId: SESSION_ID }));
    expect((await secondHelloAck).grantedOrigins).toEqual(["https://staging.myapp.com"]);
    second.close();
  });

  it("does not report a grant made in a different browser session", async () => {
    const first = new WebSocket(`ws://127.0.0.1:${port}/ext`);
    await new Promise<void>((resolve) => first.once("open", () => resolve()));
    const firstHelloAck = nextMessage(first);
    first.send(JSON.stringify({ type: "hello", token, browserSessionId: SESSION_ID }));
    await firstHelloAck;
    first.send(JSON.stringify({ type: "grant_access", tabId: TAB_ID, url: GRANTED_URL, label: "Staging" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = new WebSocket(`ws://127.0.0.1:${port}/ext`);
    await new Promise<void>((resolve) => second.once("open", () => resolve()));
    const secondHelloAck = nextMessage(second);
    second.send(JSON.stringify({ type: "hello", token, browserSessionId: "a-different-browser-session" }));
    expect((await secondHelloAck).grantedOrigins).toEqual([]);
    second.close();
  });
});
