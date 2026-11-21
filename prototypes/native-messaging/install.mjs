// Registers the prototype native-messaging host with Firefox (macOS/Linux).
//
// Writes two files:
//   1. A tiny shell wrapper that runs host.mjs with an ABSOLUTE node path.
//      Firefox started from the Dock gets the minimal GUI PATH
//      (/usr/bin:/bin:/usr/sbin:/sbin), so `#!/usr/bin/env node` would fail
//      for Homebrew / nvm installs.
//   2. The host manifest Firefox looks up by name.
// Run with --uninstall to remove both.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST_NAME = "tab_bridge_proto";
const EXTENSION_ID = "tab-bridge-proto@tab-bridge.dev";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestDir =
  process.platform === "darwin"
    ? path.join(os.homedir(), "Library/Application Support/Mozilla/NativeMessagingHosts")
    : path.join(os.homedir(), ".mozilla/native-messaging-hosts");
const manifestPath = path.join(manifestDir, `${HOST_NAME}.json`);
const wrapperPath = path.join(os.homedir(), ".tab-bridge", "nm-proto-host.sh");

if (process.argv.includes("--uninstall")) {
  for (const p of [manifestPath, wrapperPath]) {
    try { fs.unlinkSync(p); console.log(`removed ${p}`); } catch {}
  }
  process.exit(0);
}

fs.mkdirSync(path.dirname(wrapperPath), { recursive: true, mode: 0o700 });
fs.writeFileSync(
  wrapperPath,
  `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, "host.mjs")}" "$@"\n`,
  { mode: 0o755 }
);

fs.mkdirSync(manifestDir, { recursive: true });
fs.writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      name: HOST_NAME,
      description: "Tab Bridge native-messaging prototype",
      path: wrapperPath,
      type: "stdio",
      allowed_extensions: [EXTENSION_ID],
    },
    null,
    2
  ) + "\n"
);

console.log(`wrote ${wrapperPath}`);
console.log(`wrote ${manifestPath}`);
