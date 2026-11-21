import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXTENSION_ID, firefoxManifestDir, installNativeHost, NATIVE_HOST_NAME, uninstallNativeHost } from "../src/nativeHost.js";

describe("native host registration", () => {
  let tmpDir: string;
  let configDir: string;
  let manifestDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "sharepane-test-"));
    configDir = path.join(tmpDir, "config");
    manifestDir = path.join(tmpDir, "NativeMessagingHosts");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes a manifest that only the Sharepane extension may launch", async () => {
    const paths = await installNativeHost({ cliPath: "/opt/tb/cli.js", configDir, manifestDir });
    const manifest = JSON.parse(await readFile(paths.manifestPath, "utf-8"));
    expect(manifest).toEqual({
      name: NATIVE_HOST_NAME,
      description: expect.any(String),
      path: paths.launcherPath,
      type: "stdio",
      allowed_extensions: [EXTENSION_ID],
    });
  });

  it("launches with an absolute node path, since Firefox from the Dock has no Homebrew PATH", async () => {
    const paths = await installNativeHost({
      nodePath: "/opt/homebrew/bin/node",
      cliPath: "/path with spaces/it's/cli.js",
      configDir,
      manifestDir,
    });
    const launcher = await readFile(paths.launcherPath, "utf-8");
    expect(launcher).toBe(`#!/bin/sh\nexec '/opt/homebrew/bin/node' '/path with spaces/it'\\''s/cli.js' host\n`);
    expect((await stat(paths.launcherPath)).mode & 0o111).not.toBe(0);
  });

  it("uninstall removes both files", async () => {
    const paths = await installNativeHost({ cliPath: "/opt/tb/cli.js", configDir, manifestDir });
    await uninstallNativeHost(configDir, manifestDir);
    expect(existsSync(paths.manifestPath)).toBe(false);
    expect(existsSync(paths.launcherPath)).toBe(false);
  });

  it("knows Firefox's per-user manifest location on macOS and Linux", () => {
    expect(firefoxManifestDir("darwin", "/Users/a")).toBe("/Users/a/Library/Application Support/Mozilla/NativeMessagingHosts");
    expect(firefoxManifestDir("linux", "/home/a")).toBe("/home/a/.mozilla/native-messaging-hosts");
    expect(() => firefoxManifestDir("win32", "C:\\")).toThrow(/isn't supported/);
  });
});
