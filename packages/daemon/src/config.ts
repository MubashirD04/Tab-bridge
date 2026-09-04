import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AllowlistEntry, TrustedDevPort } from "./types.js";

export interface DaemonConfig {
  token: string;
  port: number;
  tokenCreatedAt: string;
  tokenRotatedAt?: string;
}

export interface AllowlistFile {
  entries: AllowlistEntry[];
  trustedPorts: TrustedDevPort[];
}

export const DEFAULT_PORT = 8765;

/** Seeded on first run — VS Code Live Server's default ports. User-editable
 * from here on via the extension's options page (which calls back into the
 * daemon; see wsServer.ts). */
export const DEFAULT_TRUSTED_PORTS: TrustedDevPort[] = [
  { port: 5500, label: "VS Code Live Server", protocol: "http" },
  { port: 5501, label: "VS Code Live Server (HTTPS)", protocol: "https" },
];

export function defaultConfigDir(): string {
  return path.join(os.homedir(), ".tab-bridge");
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export class ConfigStore {
  readonly configDir: string;
  private readonly configPath: string;
  private readonly allowlistPath: string;

  constructor(configDir: string = defaultConfigDir()) {
    this.configDir = configDir;
    this.configPath = path.join(configDir, "config.json");
    this.allowlistPath = path.join(configDir, "allowlist.json");
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.configDir, { recursive: true });
  }

  async loadOrCreateDaemonConfig(): Promise<DaemonConfig> {
    await this.ensureDir();
    if (existsSync(this.configPath)) {
      const raw = await readFile(this.configPath, "utf-8");
      return JSON.parse(raw) as DaemonConfig;
    }
    const config: DaemonConfig = {
      token: generateToken(),
      port: DEFAULT_PORT,
      tokenCreatedAt: new Date().toISOString(),
    };
    await writeFile(this.configPath, JSON.stringify(config, null, 2), "utf-8");
    return config;
  }

  async rotateToken(): Promise<DaemonConfig> {
    const existing = await this.loadOrCreateDaemonConfig();
    const config: DaemonConfig = {
      ...existing,
      token: generateToken(),
      tokenRotatedAt: new Date().toISOString(),
    };
    await this.ensureDir();
    await writeFile(this.configPath, JSON.stringify(config, null, 2), "utf-8");
    return config;
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

export interface McpJsonResult {
  path: string;
  changed: boolean;
  gitignoreUpdated: boolean;
}

/**
 * Writes (or updates in place) the "tab-bridge" entry of `.mcp.json` in
 * `cwd` — the file Claude Code reads to discover MCP servers for a project —
 * so `tab-bridge start` alone is enough to wire the daemon up, instead of
 * requiring a hand copy-paste of port/token from the README. Any other
 * entries already in the file (other MCP servers) are left untouched.
 *
 * Returns `changed: false` if the file already has this exact entry, so
 * callers can skip printing a "wrote .mcp.json" line on every start.
 */
export async function writeMcpJson(cwd: string, config: DaemonConfig): Promise<McpJsonResult> {
  const mcpJsonPath = path.join(cwd, ".mcp.json");
  let doc: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(mcpJsonPath)) {
    const raw = await readFile(mcpJsonPath, "utf-8");
    try {
      doc = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    } catch {
      // Corrupt/hand-edited-into-invalid-JSON .mcp.json: don't clobber it,
      // just leave it for the user to fix.
      return { path: mcpJsonPath, changed: false, gitignoreUpdated: false };
    }
  }

  const entry = {
    type: "http",
    url: `http://127.0.0.1:${config.port}/mcp`,
    headers: { Authorization: `Bearer ${config.token}` },
  };

  const existingEntry = doc.mcpServers?.["tab-bridge"];
  const changed = JSON.stringify(existingEntry) !== JSON.stringify(entry);

  doc.mcpServers = { ...doc.mcpServers, "tab-bridge": entry };
  await writeFile(mcpJsonPath, `${JSON.stringify(doc, null, 2)}\n`, "utf-8");

  const gitignoreUpdated = await ensureGitignored(cwd, ".mcp.json");
  return { path: mcpJsonPath, changed, gitignoreUpdated };
}

/**
 * `.mcp.json` carries a bearer token once tab-bridge writes it, so if this
 * directory has a `.gitignore` already (i.e. it looks like a git project)
 * and it doesn't yet exclude `.mcp.json`, append that line. Never creates a
 * `.gitignore` that doesn't already exist — that's not tab-bridge's call to
 * make for an arbitrary project.
 */
async function ensureGitignored(cwd: string, entry: string): Promise<boolean> {
  const gitignorePath = path.join(cwd, ".gitignore");
  if (!existsSync(gitignorePath)) {
    return false;
  }
  const raw = await readFile(gitignorePath, "utf-8");
  const alreadyIgnored = raw.split("\n").some((line) => line.trim() === entry);
  if (alreadyIgnored) {
    return false;
  }
  const needsLeadingNewline = raw.length > 0 && !raw.endsWith("\n");
  await appendFile(gitignorePath, `${needsLeadingNewline ? "\n" : ""}${entry}\n`, "utf-8");
  return true;
}
