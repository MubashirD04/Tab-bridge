import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AllowlistStore } from "../src/allowlist.js";
import { ConfigStore } from "../src/config.js";
import { ExtensionBridge } from "../src/extensionBridge.js";
import { Logger } from "../src/logger.js";
import { TabRegistry } from "../src/tabSessions.js";
import { attachToBridge, type FakeExtension } from "./helpers/fakeExtension.js";

const SESSION_ID = "test-browser-session";
const CAPTURE_ON = { consoleLogs: true, networkRequests: true, screenshots: true };

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

describe("ExtensionBridge — tab state, revokes and trusted-port edits", () => {
  let tmpDir: string;
  let tabRegistry: TabRegistry;
  let bridge: ExtensionBridge;
  let ext: FakeExtension;

  function reportTab(tabId: number, url: string): void {
    ext.send({ type: "tab_updated", tabId, windowId: 1, url, title: url });
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "sharepane-test-"));
    const configStore = new ConfigStore(tmpDir);
    const allowlistStore = new AllowlistStore(configStore);
    await allowlistStore.load();
    tabRegistry = new TabRegistry();
    bridge = new ExtensionBridge(allowlistStore, tabRegistry, new Logger(tmpDir));
    ext = attachToBridge(bridge);
    await ext.hello(SESSION_ID, CAPTURE_ON);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("ignores everything sent before hello", async () => {
    const other = new ExtensionBridge(
      new AllowlistStore(new ConfigStore(tmpDir)),
      new TabRegistry(),
      new Logger(tmpDir)
    );
    const fake = attachToBridge(other);
    fake.send({ type: "tab_updated", tabId: 1, windowId: 1, url: "http://127.0.0.1:5500/", title: "x" });
    await delay(20);
    expect(other.isConnected()).toBe(false);
  });

  it("revoking a manual grant from one tab removes every tab at that origin", async () => {
    reportTab(1, "https://staging.myapp.com/a");
    reportTab(2, "https://staging.myapp.com/b");
    reportTab(3, "http://127.0.0.1:5500/");
    ext.send({ type: "grant_access", tabId: 1, url: "https://staging.myapp.com/a" });
    await until(() => tabRegistry.isAllowed(1));
    // Tab 2 becomes allowed on its next report now that the origin is granted.
    reportTab(2, "https://staging.myapp.com/b");
    await until(() => tabRegistry.isAllowed(2));

    ext.send({ type: "revoke_access", tabId: 1 });
    await until(() => !tabRegistry.isAllowed(1) && !tabRegistry.isAllowed(2));
    expect(tabRegistry.isAllowed(3)).toBe(true);
  });

  it("revoke_origin drops the grant even with no tab open at that origin, and keeps trusted-port tabs", async () => {
    reportTab(1, "https://staging.myapp.com/a");
    reportTab(2, "http://127.0.0.1:5500/");
    ext.send({ type: "grant_access", tabId: 1, url: "https://staging.myapp.com/a" });
    await until(() => tabRegistry.isAllowed(1));

    ext.send({ type: "tab_removed", tabId: 1 });
    ext.send({ type: "revoke_origin", origin: "https://staging.myapp.com" });
    await delay(50);
    // A tab opened at that origin afterwards is no longer allowed.
    reportTab(3, "https://staging.myapp.com/b");
    await delay(20);
    expect(tabRegistry.isAllowed(3)).toBe(false);
    expect(tabRegistry.isAllowed(2)).toBe(true);
  });

  it("applies trusted-port edits to tabs that are already open", async () => {
    reportTab(1, "http://127.0.0.1:5500/");
    reportTab(2, "http://127.0.0.1:4321/");
    await until(() => tabRegistry.isAllowed(1));
    expect(tabRegistry.isAllowed(2)).toBe(false);

    ext.send({ type: "set_trusted_ports", ports: [{ port: 4321, protocol: "http", label: "Astro" }] });
    await until(() => tabRegistry.isAllowed(2) && !tabRegistry.isAllowed(1));
  });

  it("fails an in-flight content request as soon as the extension disconnects", async () => {
    reportTab(1, "http://127.0.0.1:5500/");
    await until(() => tabRegistry.isAllowed(1));

    const request = bridge.requestContent(1, "html");
    await delay(20);
    ext.close();
    await expect(request).rejects.toMatchObject({ code: "EXTENSION_DISCONNECTED" });
  });

  it("refuses requests once disconnected instead of waiting", async () => {
    reportTab(1, "http://127.0.0.1:5500/");
    await until(() => tabRegistry.isAllowed(1));
    ext.close();
    await expect(bridge.requestContent(1, "html")).rejects.toMatchObject({ code: "EXTENSION_DISCONNECTED" });
  });
});
