import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AllowlistStore } from "../src/allowlist.js";
import { ConfigStore } from "../src/config.js";
import { ExtensionBridge } from "../src/extensionBridge.js";
import { Logger } from "../src/logger.js";
import { TabRegistry } from "../src/tabSessions.js";
import { attachToBridge } from "./helpers/fakeExtension.js";

const SESSION_ID = "test-browser-session";
const GRANTED_URL = "https://staging.myapp.com/dashboard";
const TAB_ID = 1;

// A manual grant is origin-scoped and persisted (allowlist.json), and lasts
// for the browser session it was made in. With native messaging each host
// process is one connection, so "the next connection" here means the next
// host process, e.g. after the extension is reloaded or updated mid-session.
describe("ExtensionBridge — grantedOrigins in hello_ack", () => {
  let tmpDir: string;

  /** A fresh bridge reading the same allowlist.json, like a new host process. */
  async function connectedHost() {
    const allowlistStore = new AllowlistStore(new ConfigStore(tmpDir));
    await allowlistStore.load();
    return attachToBridge(new ExtensionBridge(allowlistStore, new TabRegistry(), new Logger(tmpDir)));
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "sharepane-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("a fresh host's hello_ack has no grantedOrigins yet", async () => {
    const ext = await connectedHost();
    expect((await ext.hello(SESSION_ID)).grantedOrigins).toEqual([]);
  });

  it("a grant made under one host is reported to the next host in the same browser session", async () => {
    const first = await connectedHost();
    await first.hello(SESSION_ID);
    first.send({ type: "grant_access", tabId: TAB_ID, url: GRANTED_URL, label: "Staging" });
    await new Promise((resolve) => setTimeout(resolve, 50)); // grant() persists asynchronously
    first.close();

    const second = await connectedHost();
    expect((await second.hello(SESSION_ID)).grantedOrigins).toEqual(["https://staging.myapp.com"]);
  });

  it("does not report a grant made in a different browser session", async () => {
    const first = await connectedHost();
    await first.hello(SESSION_ID);
    first.send({ type: "grant_access", tabId: TAB_ID, url: GRANTED_URL, label: "Staging" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    first.close();

    const second = await connectedHost();
    expect((await second.hello("a-different-browser-session")).grantedOrigins).toEqual([]);
  });
});
