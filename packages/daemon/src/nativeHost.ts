import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Must match `runtime.connectNative(...)` in extension/background.js. */
export const NATIVE_HOST_NAME = "sharepane";
/** Must match `browser_specific_settings.gecko.id` in extension/manifest.json. */
export const EXTENSION_ID = "sharepane@sharepane.dev";

/** Where Firefox looks for per-user native-messaging host manifests. */
export function firefoxManifestDir(platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  if (platform === "darwin") return path.join(home, "Library/Application Support/Mozilla/NativeMessagingHosts");
  if (platform === "linux") return path.join(home, ".mozilla/native-messaging-hosts");
  // Windows registers the manifest path in the registry instead; that lands
  // with `sharepane setup` (rebuild step 4).
  throw new Error(`Installing the native host isn't supported on ${platform} yet.`);
}

export interface NativeHostInstallOptions {
  /** Absolute path to the node binary. Defaults to the one running now. */
  nodePath?: string;
  /** Absolute path to the built cli.js. */
  cliPath: string;
  configDir: string;
  manifestDir?: string;
}

export interface NativeHostPaths {
  manifestPath: string;
  launcherPath: string;
}

export function nativeHostPaths(configDir: string, manifestDir = firefoxManifestDir()): NativeHostPaths {
  return {
    manifestPath: path.join(manifestDir, `${NATIVE_HOST_NAME}.json`),
    launcherPath: path.join(configDir, "native-host.sh"),
  };
}

/**
 * Registers the host with Firefox. Writes:
 *  1. A launcher script that runs `cli.js host` with an ABSOLUTE node path.
 *     Firefox started from the Dock only gets the minimal GUI PATH
 *     (/usr/bin:/bin:/usr/sbin:/sbin), so `#!/usr/bin/env node` fails for
 *     Homebrew and nvm installs. Found in the step-1 prototype.
 *  2. The host manifest, which lets only the Sharepane extension start it.
 */
export async function installNativeHost(options: NativeHostInstallOptions): Promise<NativeHostPaths> {
  const nodePath = options.nodePath ?? process.execPath;
  const paths = nativeHostPaths(options.configDir, options.manifestDir);

  await mkdir(options.configDir, { recursive: true, mode: 0o700 });
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  // Firefox passes the manifest path and extension id as arguments; the
  // host doesn't need them, so they're dropped rather than forwarded.
  await writeFile(paths.launcherPath, `#!/bin/sh\nexec ${quote(nodePath)} ${quote(options.cliPath)} host\n`, "utf-8");
  await chmod(paths.launcherPath, 0o755);

  await mkdir(path.dirname(paths.manifestPath), { recursive: true });
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: "Sharepane: lets Claude read Firefox tabs you allow",
    path: paths.launcherPath,
    type: "stdio",
    allowed_extensions: [EXTENSION_ID],
  };
  await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  return paths;
}

export async function uninstallNativeHost(configDir: string, manifestDir?: string): Promise<NativeHostPaths> {
  const paths = nativeHostPaths(configDir, manifestDir);
  await rm(paths.manifestPath, { force: true });
  await rm(paths.launcherPath, { force: true });
  return paths;
}
