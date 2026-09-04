#!/usr/bin/env node
import http from "node:http";
import { AllowlistStore } from "./allowlist.js";
import { ConfigStore, writeMcpJson } from "./config.js";
import { Logger } from "./logger.js";
import { createMcpRequestHandler } from "./mcpServer.js";
import { isProcessAlive, readPidFile, removePidFile, writePidFile } from "./pid.js";
import { TabRegistry } from "./tabSessions.js";
import { ExtensionBridge } from "./wsServer.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Writes/refreshes the "tab-bridge" entry in `./.mcp.json` (relative to
 * wherever `tab-bridge start`/`status` was run from — expected to be a
 * Claude Code project root) so Claude Code picks the daemon up without the
 * README's copy-paste step, and reports what happened.
 */
async function reportMcpJson(config: { port: number; token: string; tokenCreatedAt: string; tokenRotatedAt?: string }): Promise<void> {
  const result = await writeMcpJson(process.cwd(), config);
  if (result.changed) {
    console.log(`  Wrote tab-bridge to ${result.path}`);
  }
  if (result.gitignoreUpdated) {
    console.log("  Added .mcp.json to .gitignore (it now holds a bearer token).");
  }
}

async function printStatus(configStore: ConfigStore): Promise<void> {
  const config = await configStore.loadOrCreateDaemonConfig();
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/health`);
    if (res.ok) {
      const body = (await res.json()) as { extensionConnected: boolean };
      console.log(`tab-bridge daemon is running on port ${config.port}.`);
      console.log(
        body.extensionConnected
          ? "The Firefox extension is connected."
          : "The Firefox extension is NOT currently connected."
      );
      console.log(`  Bearer token: ${config.token}`);
      await reportMcpJson(config);
      return;
    }
    console.log(`tab-bridge daemon responded unhealthily on port ${config.port}.`);
  } catch {
    console.log(`tab-bridge daemon is not running (checked http://127.0.0.1:${config.port}).`);
    console.log("Start it with: tab-bridge start");
  }
}

/**
 * Stops a daemon started with `tab-bridge start`, via its PID file — this is
 * what lets a skill spin the daemon up for one task and tear it down
 * afterward, the same shape as a browser-automation skill starting and
 * stopping a headless browser process. Safe to call when nothing is
 * running: reports that plainly rather than erroring.
 */
async function stopDaemon(configStore: ConfigStore): Promise<void> {
  const info = await readPidFile(configStore.configDir);
  if (!info) {
    console.log("tab-bridge daemon is not running (no PID file found).");
    return;
  }
  if (!isProcessAlive(info.pid)) {
    console.log("tab-bridge daemon was not running (stale PID file cleaned up).");
    await removePidFile(configStore.configDir);
    return;
  }

  process.kill(info.pid, "SIGTERM");
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(info.pid)) {
      console.log(`tab-bridge daemon (pid ${info.pid}) stopped.`);
      await removePidFile(configStore.configDir);
      return;
    }
    await delay(100);
  }
  console.log(`tab-bridge daemon (pid ${info.pid}) did not stop within 3s; it may still be shutting down.`);
}

async function startDaemon(configStore: ConfigStore): Promise<void> {
  const existing = await readPidFile(configStore.configDir);
  if (existing && isProcessAlive(existing.pid)) {
    console.log(`tab-bridge daemon is already running (pid ${existing.pid}, port ${existing.port}).`);
    const runningConfig = await configStore.loadOrCreateDaemonConfig();
    console.log(`  Bearer token: ${runningConfig.token}`);
    await reportMcpJson(runningConfig);
    return;
  }

  const config = await configStore.loadOrCreateDaemonConfig();
  const logger = new Logger(configStore.configDir);
  const allowlistStore = new AllowlistStore(configStore);
  await allowlistStore.load();
  const tabRegistry = new TabRegistry();

  // Bound to 127.0.0.1 explicitly, never 0.0.0.0 — see blueprint Section 5,
  // Security: "rules out anything on your LAN reaching it."
  const httpServer = http.createServer();

  const extensionBridge = new ExtensionBridge(
    httpServer,
    "/ext",
    config.token,
    allowlistStore,
    tabRegistry,
    logger
  );
  const mcpHandler = createMcpRequestHandler({ tabRegistry, extensionBridge }, config.token);

  httpServer.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, extensionConnected: extensionBridge.isConnected() }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/mcp") {
      void mcpHandler(req, res);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
  });

  httpServer.listen(config.port, "127.0.0.1", () => {
    console.log(`tab-bridge daemon listening on http://127.0.0.1:${config.port}`);
    console.log(`  MCP endpoint (Claude Code, .mcp.json "type": "http"): http://127.0.0.1:${config.port}/mcp`);
    console.log(`  Extension WebSocket:                                 ws://127.0.0.1:${config.port}/ext`);
    console.log(`  Bearer token:                                        ${config.token}`);
    console.log("  (Use this to pair the extension's options page, and in the Authorization: Bearer header for MCP clients.)");
    void reportMcpJson(config);
  });

  void writePidFile(configStore.configDir, { pid: process.pid, port: config.port, startedAt: new Date().toISOString() });
  void logger.log({ event: "daemon_started", port: config.port, pid: process.pid });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void logger.log({ event: "daemon_stopping", signal });
      void removePidFile(configStore.configDir);
      httpServer.close(() => process.exit(0));
    });
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "start";
  const configStore = new ConfigStore();

  if (command === "status") {
    await printStatus(configStore);
    return;
  }
  if (command === "start") {
    await startDaemon(configStore);
    return;
  }
  if (command === "stop") {
    await stopDaemon(configStore);
    return;
  }

  console.error(`Unknown command: ${command}\nUsage: tab-bridge [start|stop|status]`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
