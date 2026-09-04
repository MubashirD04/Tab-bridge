import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { AllowlistStore } from "../src/allowlist.js";
import { ConfigStore, DEFAULT_TRUSTED_PORTS } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { TabRegistry } from "../src/tabSessions.js";
import { ExtensionBridge } from "../src/wsServer.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (raw) => resolve(JSON.parse(raw.toString())));
  });
}

// Exercises the options page's "edit trusted ports" flow end to end: a fake
// extension WebSocket client sends set_trusted_ports the same way
// options.js -> background.js does, and we assert both the ack the options
// page renders from and what actually lands on disk.
describe("ExtensionBridge — set_trusted_ports (options-page port editing)", () => {
  let tmpDir: string;
  let configStore: ConfigStore;
  let allowlistStore: AllowlistStore;
  let httpServer: http.Server;
  let port: number;
  let token: string;
  let ws: WebSocket;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "tab-bridge-test-"));
    configStore = new ConfigStore(tmpDir);
    const config = await configStore.loadOrCreateDaemonConfig();
    token = config.token;

    allowlistStore = new AllowlistStore(configStore);
    await allowlistStore.load();

    const logger = new Logger(configStore.configDir);
    const tabRegistry = new TabRegistry();
    httpServer = http.createServer();
    new ExtensionBridge(httpServer, "/ext", token, allowlistStore, tabRegistry, logger);

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    port = (httpServer.address() as { port: number }).port;

    ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    const helloAck = nextMessage(ws);
    ws.send(JSON.stringify({ type: "hello", token, browserSessionId: "session-A" }));
    await helloAck;
  });

  afterEach(async () => {
    ws.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("persists a replaced port list and acks with the sanitized result", async () => {
    const ack = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: "set_trusted_ports",
        ports: [{ port: 3000, label: "Vite", protocol: "http" }],
      })
    );
    const msg = await ack;
    expect(msg).toEqual({
      type: "trusted_ports_updated",
      trustedPorts: [{ port: 3000, label: "Vite", protocol: "http" }],
    });

    // Reload from disk to confirm it was actually persisted, not just echoed.
    const reloaded = new AllowlistStore(configStore);
    await reloaded.load();
    expect(reloaded.getTrustedPorts()).toEqual([{ port: 3000, label: "Vite", protocol: "http" }]);
  });

  it("drops invalid entries instead of corrupting the whole list", async () => {
    const ack = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: "set_trusted_ports",
        ports: [
          { port: 3000, label: "Vite", protocol: "http" },
          { port: "not-a-number", label: "bad", protocol: "http" },
          { port: 99999, label: "out-of-range", protocol: "http" },
          { port: 4000, label: "bad-protocol", protocol: "ftp" },
          { port: 5000, protocol: "https" }, // missing label -> falls back to "Port 5000"
        ],
      })
    );
    const msg = await ack;
    expect(msg).toEqual({
      type: "trusted_ports_updated",
      trustedPorts: [
        { port: 3000, label: "Vite", protocol: "http" },
        { port: 5000, label: "Port 5000", protocol: "https" },
      ],
    });
  });

  it("an empty list is valid (removing all trusted ports)", async () => {
    const ack = nextMessage(ws);
    ws.send(JSON.stringify({ type: "set_trusted_ports", ports: [] }));
    const msg = await ack;
    expect(msg).toEqual({ type: "trusted_ports_updated", trustedPorts: [] });
  });

  it("does not touch the list on connect — defaults stay until explicitly edited", async () => {
    await delay(50);
    expect(allowlistStore.getTrustedPorts()).toEqual(DEFAULT_TRUSTED_PORTS);
  });
});
