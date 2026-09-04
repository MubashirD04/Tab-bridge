import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AllowlistStore } from "../src/allowlist.js";
import { ConfigStore, DEFAULT_TRUSTED_PORTS } from "../src/config.js";

let tmpDir: string;
let configStore: ConfigStore;
let store: AllowlistStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "tab-bridge-test-"));
  configStore = new ConfigStore(tmpDir);
  store = new AllowlistStore(configStore);
  await store.load();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("AllowlistStore — manual grants", () => {
  it("matches a granted origin in the same browser session", async () => {
    await store.grant("https://staging.myapp.com/dashboard", "session-A");
    const result = store.match("https://staging.myapp.com/other-page", "session-A");
    expect(result?.source).toBe("manual");
  });

  it("does NOT match a granted origin from a different (i.e. expired) session", async () => {
    await store.grant("https://staging.myapp.com/dashboard", "session-A");
    const result = store.match("https://staging.myapp.com/dashboard", "session-B");
    expect(result).toBeUndefined();
  });

  it("does not match an origin that was never granted", async () => {
    await store.grant("https://staging.myapp.com", "session-A");
    const result = store.match("https://not-allowed.example.com", "session-A");
    expect(result).toBeUndefined();
  });

  it("pruneExpired drops grants from stale sessions and persists the drop", async () => {
    await store.grant("https://a.example.com", "session-A");
    await store.grant("https://b.example.com", "session-B");

    await store.pruneExpired("session-B");
    expect(store.match("https://a.example.com", "session-B")).toBeUndefined();
    expect(store.match("https://b.example.com", "session-B")?.source).toBe("manual");

    // Reload from disk to confirm the prune was actually persisted, not just in-memory.
    const reloaded = new AllowlistStore(configStore);
    await reloaded.load();
    expect(reloaded.match("https://a.example.com", "session-B")).toBeUndefined();
    expect(reloaded.match("https://b.example.com", "session-B")?.source).toBe("manual");
  });

  it("revokeByOrigin removes the grant regardless of session", async () => {
    await store.grant("https://a.example.com", "session-A");
    await store.revokeByOrigin("https://a.example.com/some/path");
    expect(store.match("https://a.example.com", "session-A")).toBeUndefined();
  });

  it("re-granting the same origin in the same session does not create duplicates", async () => {
    const first = await store.grant("https://a.example.com", "session-A");
    const second = await store.grant("https://a.example.com/different/path", "session-A");
    expect(second?.id).toBe(first?.id);
  });

  it("getGrantedOrigins returns only origins granted in the given session", async () => {
    await store.grant("https://a.example.com", "session-A");
    await store.grant("https://b.example.com", "session-B");
    expect(store.getGrantedOrigins("session-A")).toEqual(["https://a.example.com"]);
    expect(store.getGrantedOrigins("session-B")).toEqual(["https://b.example.com"]);
    expect(store.getGrantedOrigins("session-C")).toEqual([]);
  });
});

describe("AllowlistStore — Live-Server auto-approval", () => {
  it("auto-approves a tab on a default trusted port (5500)", () => {
    const result = store.match("http://127.0.0.1:5500/index.html", "session-A");
    expect(result).toEqual({ source: "live-server-auto", matchedTrustedPort: 5500 });
  });

  it("auto-approves localhost as well as 127.0.0.1", () => {
    const result = store.match("http://localhost:5500/index.html", "session-A");
    expect(result?.source).toBe("live-server-auto");
  });

  it("does NOT auto-approve a non-localhost origin, even if it claims the same port", () => {
    const result = store.match("http://example.com:5500/index.html", "session-A");
    expect(result).toBeUndefined();
  });

  it("does NOT auto-approve a localhost port that isn't in the trusted list", () => {
    const result = store.match("http://127.0.0.1:9999/index.html", "session-A");
    expect(result).toBeUndefined();
  });

  it("respects a custom trusted-port list set via setTrustedPorts", async () => {
    await store.setTrustedPorts([{ port: 3000, label: "Vite", protocol: "http" }]);
    expect(store.match("http://127.0.0.1:3000/", "session-A")?.source).toBe("live-server-auto");
    // The old default (5500) should no longer match since it's not in the new list.
    expect(store.match("http://127.0.0.1:5500/", "session-A")).toBeUndefined();
  });

  it("seeds the default trusted ports on first load", () => {
    expect(store.getTrustedPorts()).toEqual(DEFAULT_TRUSTED_PORTS);
  });
});

describe("AllowlistStore — precedence", () => {
  it("a manual grant takes precedence over Live-Server auto-approval for the same origin", async () => {
    await store.grant("http://127.0.0.1:5500", "session-A", "explicitly allowed");
    const result = store.match("http://127.0.0.1:5500/page.html", "session-A");
    expect(result?.source).toBe("manual");
  });
});
