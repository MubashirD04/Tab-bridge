import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AllowlistEntry, TrustedDevPort } from "./types.js";

export interface AllowlistFile {
  entries: AllowlistEntry[];
  trustedPorts: TrustedDevPort[];
}

/** Seeded on first run — VS Code Live Server's default ports. User-editable
 * from here on via the extension's options page (which calls back into the
 * host; see extensionBridge.ts). */
export const DEFAULT_TRUSTED_PORTS: TrustedDevPort[] = [
  { port: 5500, label: "VS Code Live Server", protocol: "http" },
  { port: 5501, label: "VS Code Live Server (HTTPS)", protocol: "https" },
];

export function defaultConfigDir(): string {
  return path.join(os.homedir(), ".sharepane");
}

export class ConfigStore {
  readonly configDir: string;
  private readonly allowlistPath: string;

  constructor(configDir: string = defaultConfigDir()) {
    this.configDir = configDir;
    this.allowlistPath = path.join(configDir, "allowlist.json");
  }

  /** 0700: the directory holds the MCP socket, so its permissions are what
   * keep other local users away from it. */
  private async ensureDir(): Promise<void> {
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
  }

  get socketPath(): string {
    return path.join(this.configDir, "sharepane.sock");
  }

  async loadAllowlistFile(): Promise<AllowlistFile> {
    await this.ensureDir();
    if (existsSync(this.allowlistPath)) {
      const raw = await readFile(this.allowlistPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<AllowlistFile>;
      return {
        entries: parsed.entries ?? [],
        trustedPorts: parsed.trustedPorts ?? DEFAULT_TRUSTED_PORTS,
      };
    }
    const initial: AllowlistFile = { entries: [], trustedPorts: DEFAULT_TRUSTED_PORTS };
    await writeFile(this.allowlistPath, JSON.stringify(initial, null, 2), "utf-8");
    return initial;
  }

  async saveAllowlistFile(data: AllowlistFile): Promise<void> {
    await this.ensureDir();
    await writeFile(this.allowlistPath, JSON.stringify(data, null, 2), "utf-8");
  }
}
