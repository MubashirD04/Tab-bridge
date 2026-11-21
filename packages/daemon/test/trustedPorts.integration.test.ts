import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AllowlistStore } from "../src/allowlist.js";
import { ConfigStore, DEFAULT_TRUSTED_PORTS } from "../src/config.js";
import { ExtensionBridge } from "../src/extensionBridge.js";
import { Logger } from "../src/logger.js";
import { TabRegistry } from "../src/tabSessions.js";
import { attachToBridge, type FakeExtension } from "./helpers/fakeExtension.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exercises the options page's "edit trusted ports" flow end to end: a fake
// extension sends set_trusted_ports the same way options.js -> background.js
// does, and we assert both the ack the options page renders from and what
// actually lands on disk.
describe("ExtensionBridge — set_trusted_ports (options-page port editing)", () => {
  let tmpDir: string;
  let configStore: ConfigStore;
  let allowlistStore: AllowlistStore;
  let ext: FakeExtension;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "sharepane-test-"));
    configStore = new ConfigStore(tmpDir);
    allowlistStore = new AllowlistStore(configStore);
    await allowlistStore.load();
    ext = attachToBridge(new ExtensionBridge(allowlistStore, new TabRegistry(), new Logger(tmpDir)));
    await ext.hello("session-A");
  });

  afterEach(async () => {
    ext.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("persists a replaced port list and acks with the sanitized result", async () => {
    const ack = ext.nextMessage();
    ext.send({
        type: "set_trusted_ports",
        ports: [{ port: 3000, label: "Vite", protocol: "http" }],
      });
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
    const ack = ext.nextMessage();
    ext.send({
        type: "set_trusted_ports",
        ports: [
          { port: 3000, label: "Vite", protocol: "http" },
          { port: "not-a-number", label: "bad", protocol: "http" },
          { port: 99999, label: "out-of-range", protocol: "http" },
          { port: 4000, label: "bad-protocol", protocol: "ftp" },
          { port: 5000, protocol: "https" }, // missing label -> falls back to "Port 5000"
        ],
      });
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
    const ack = ext.nextMessage();
    ext.send({ type: "set_trusted_ports", ports: [] });
    const msg = await ack;
    expect(msg).toEqual({ type: "trusted_ports_updated", trustedPorts: [] });
  });

  it("does not touch the list on connect — defaults stay until explicitly edited", async () => {
    await delay(50);
    expect(allowlistStore.getTrustedPorts()).toEqual(DEFAULT_TRUSTED_PORTS);
  });
});
