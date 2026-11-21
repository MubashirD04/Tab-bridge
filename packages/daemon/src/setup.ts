import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { EXTENSION_ID, firefoxManifestDir, installNativeHost, nativeHostPaths } from "./nativeHost.js";
import { SocketClientTransport } from "./socketClient.js";
import { PACKAGE_NAME, VERSION } from "./version.js";

export const MCP_SERVER_NAME = "sharepane";
/** How the Claude Code plugin's server shows up in `claude mcp` (plugin
 * "sharepane", server "sharepane"). */
export const PLUGIN_SERVER_NAME = "plugin:sharepane:sharepane";

/** Names from before the project was renamed from Tab Bridge to Sharepane.
 * Setup finds an install that used them and moves it over. */
export const LEGACY = {
  serverName: "tab-bridge",
  nativeHostName: "tab_bridge",
  dirName: ".tab-bridge",
} as const;

function legacyPaths(env: SetupEnv, manifestDir: string) {
  return {
    dir: path.join(env.home, LEGACY.dirName),
    manifest: path.join(manifestDir, `${LEGACY.nativeHostName}.json`),
  };
}

/** Where setup installs the CLI. Firefox's launcher and the Claude configs
 * point here, not at wherever setup was run from: an `npx` run lives in a
 * cache npm may clear at any time. */
export function installedCliPath(configDir: string): string {
  return path.join(configDir, "bin", "sharepane.mjs");
}

export interface SetupOptions {
  /** "plugin": the Claude Code plugin provides the MCP server, so don't
   * register one with Claude Code (and remove a user-wide one, which would
   * load the same tools twice). */
  claudeCode?: "register" | "plugin";
}

export interface ClaudeCliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Everything setup/doctor read from or write to, so tests can point it all
 * at a temp directory and a fake `claude` CLI. */
export interface SetupEnv {
  home: string;
  platform: NodeJS.Platform;
  cwd: string;
  configDir: string;
  /** The node binary running now, and the PATH to look for a stabler alias of it on. */
  execPath: string;
  pathEnv: string;
  /** Absolute path to the built cli.js. */
  cliPath: string;
  /** Runs the `claude` CLI; returns null if it isn't installed. */
  runClaude: (args: string[]) => ClaudeCliResult | null;
  manifestDir?: string;
  desktopConfigPath?: string;
}

export function defaultSetupEnv(cliPath: string, configDir: string): SetupEnv {
  return {
    home: os.homedir(),
    platform: process.platform,
    cwd: process.cwd(),
    configDir,
    execPath: process.execPath,
    pathEnv: process.env.PATH ?? "",
    cliPath,
    runClaude: (args) => {
      const result = spawnSync("claude", args, { encoding: "utf-8", timeout: 20_000 });
      if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
  };
}

function manifestDirFor(env: SetupEnv): string {
  return env.manifestDir ?? firefoxManifestDir(env.platform, env.home);
}

function desktopConfigPathFor(env: SetupEnv): string {
  if (env.desktopConfigPath) return env.desktopConfigPath;
  return env.platform === "darwin"
    ? path.join(env.home, "Library/Application Support/Claude/claude_desktop_config.json")
    : path.join(env.home, ".config/Claude/claude_desktop_config.json");
}

/**
 * `process.execPath` is fully resolved, so on Homebrew it's a versioned
 * Cellar path (…/Cellar/node/26.8.1/bin/node) that disappears on the next
 * `brew upgrade node`. If a `node` on PATH resolves to the same binary
 * (/opt/homebrew/bin/node does), use that alias instead: it survives
 * upgrades. Otherwise (nvm, a one-off install) keep execPath.
 */
export function stableNodePath(execPath: string, pathEnv: string): string {
  let target: string;
  try {
    target = realpathSync(execPath);
  } catch {
    return execPath;
  }
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "node");
    try {
      if (realpathSync(candidate) === target) return candidate;
    } catch {
      // not there
    }
  }
  return execPath;
}

export function mcpServerSpec(nodePath: string, cliPath: string) {
  return { type: "stdio" as const, command: nodePath, args: [cliPath, "mcp"] };
}

/** The entry the old `tab-bridge start` wrote into a project's .mcp.json:
 * HTTP to 127.0.0.1 with a bearer token. Project scope overrides user scope
 * in Claude Code, so a leftover one silently shadows the new registration. */
function isLegacyEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as { type?: unknown; url?: unknown };
  return e.type === "http" && typeof e.url === "string" && e.url.startsWith("http://127.0.0.1:");
}

function selfAndParents(dir: string): string[] {
  const dirs: string[] = [];
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    dirs.push(d);
    if (path.dirname(d) === d) return dirs;
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- setup

export interface SetupAction {
  description: string;
  run: () => Promise<void>;
}

/** The ordered list of changes `sharepane setup` would make. Building the
 * list has no side effects, which is what `--dry-run` prints. */
export function planSetup(env: SetupEnv, options: SetupOptions = {}): SetupAction[] {
  const actions: SetupAction[] = [];
  const nodePath = stableNodePath(env.execPath, env.pathEnv);
  const cliPath = installedCliPath(env.configDir);
  const spec = mcpServerSpec(nodePath, cliPath);
  const manifestDir = manifestDirFor(env);
  const legacy = legacyPaths(env, manifestDir);
  const legacyInstall = existsSync(legacy.dir) || existsSync(legacy.manifest);

  // Moving off Tab Bridge, the old name. The folder moves first: it holds
  // the allow-list, and everything after this writes into the new one.
  if (existsSync(legacy.dir) && !existsSync(env.configDir) && path.resolve(legacy.dir) !== path.resolve(env.configDir)) {
    actions.push({
      description: `Move your settings from ${legacy.dir} to ${env.configDir} (Tab Bridge is now Sharepane)`,
      run: async () => {
        await rename(legacy.dir, env.configDir);
        await chmod(env.configDir, 0o700);
        // Old files the new install replaces or no longer uses: the pairing
        // token, the daemon PID file, the old launcher, socket and CLI copy.
        for (const file of ["config.json", "daemon.pid", "native-host.sh", "tab-bridge.sock"]) {
          await rm(path.join(env.configDir, file), { force: true });
        }
        await rm(path.join(env.configDir, "bin"), { recursive: true, force: true });
      },
    });
  }

  if (path.resolve(env.cliPath) !== path.resolve(cliPath)) {
    actions.push({
      description: `Install sharepane ${VERSION} to ${cliPath}`,
      run: async () => {
        await mkdir(path.dirname(cliPath), { recursive: true, mode: 0o700 });
        await copyFile(env.cliPath, cliPath);
        await chmod(cliPath, 0o755);
      },
    });
  }

  actions.push({
    description: `Register the native host with Firefox (${path.join(manifestDir, "sharepane.json")}), using ${nodePath}`,
    run: async () => {
      await installNativeHost({ nodePath, cliPath, configDir: env.configDir, manifestDir });
    },
  });

  if (existsSync(legacy.manifest)) {
    actions.push({
      description: `Unregister the old Tab Bridge native host (${legacy.manifest})`,
      run: () => rm(legacy.manifest, { force: true }),
    });
  }

  // Legacy cleanup first, so nothing shadows the new registration. Claude
  // Code reads .mcp.json from the current folder and every parent, so the
  // old `tab-bridge start` entry may sit in any of them (often ~/.mcp.json).
  for (const dir of selfAndParents(env.cwd)) {
    const projectMcpJson = path.join(dir, ".mcp.json");
    const project = readJson(projectMcpJson);
    const projectServers = (project?.mcpServers ?? {}) as Record<string, unknown>;
    if (!isLegacyEntry(projectServers[LEGACY.serverName])) continue;
    actions.push({
      description: `Remove the old token-based "${LEGACY.serverName}" entry from ${projectMcpJson}`,
      run: async () => {
        const { [LEGACY.serverName]: _removed, ...rest } = projectServers;
        const next = { ...project, mcpServers: rest };
        const nothingLeft = Object.keys(rest).length === 0 && Object.keys(next).length === 1;
        if (nothingLeft) await rm(projectMcpJson, { force: true });
        else await writeFile(projectMcpJson, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
      },
    });
  }
  if (legacyInstall) {
    actions.push({
      description: `Remove the old "${LEGACY.serverName}" entry from Claude Code, if there is one`,
      run: async () => {
        // Fails harmlessly when there's no such entry.
        if (env.runClaude(["mcp", "remove", LEGACY.serverName, "-s", "user"]) === null) {
          throw new SkipError("Claude Code isn't installed; skipped.");
        }
      },
    });
  }

  if (options.claudeCode === "plugin") {
    actions.push({
      description: `Remove any user-wide "${MCP_SERVER_NAME}" entry from Claude Code (the plugin provides the tools)`,
      run: async () => {
        if (env.runClaude(["mcp", "remove", MCP_SERVER_NAME, "-s", "user"]) === null) {
          throw new SkipError("Claude Code isn't installed; skipped.");
        }
      },
    });
  } else {
    // Claude Code: user scope, so it works in every project.
    actions.push({
      description: `Register "${MCP_SERVER_NAME}" with Claude Code for all projects (claude mcp add-json -s user)`,
      run: async () => {
        // Replacing an existing user-scope entry: add-json refuses duplicates.
        env.runClaude(["mcp", "remove", MCP_SERVER_NAME, "-s", "user"]);
        const result = env.runClaude(["mcp", "add-json", MCP_SERVER_NAME, JSON.stringify(spec), "-s", "user"]);
        if (result === null) throw new SkipError("Claude Code isn't installed; skipped.");
        if (result.status !== 0) throw new Error(`claude mcp add-json failed: ${result.stderr.trim() || result.stdout.trim()}`);
      },
    });
  }

  // Claude Desktop: only if it's installed (its config directory exists).
  const desktopConfig = desktopConfigPathFor(env);
  if (existsSync(path.dirname(desktopConfig))) {
    actions.push({
      description: `Register "${MCP_SERVER_NAME}" with Claude Desktop (${desktopConfig})`,
      run: async () => {
        const doc = readJson(desktopConfig) ?? {};
        const servers = (doc.mcpServers ?? {}) as Record<string, unknown>;
        const { type: _type, ...desktopSpec } = spec; // Desktop's format has no "type"
        const { [LEGACY.serverName]: _old, ...rest } = servers;
        doc.mcpServers = { ...rest, [MCP_SERVER_NAME]: desktopSpec };
        await mkdir(path.dirname(desktopConfig), { recursive: true });
        await writeFile(desktopConfig, `${JSON.stringify(doc, null, 2)}\n`, "utf-8");
      },
    });
  }

  return actions;
}

/** What `sharepane uninstall` removes: everything setup registered. The
 * allow-list (your trusted ports and grants) is left in place. */
export function planUninstall(env: SetupEnv): SetupAction[] {
  const actions: SetupAction[] = [];
  let manifestDir: string | undefined;
  try {
    manifestDir = manifestDirFor(env);
  } catch {
    // unsupported platform: nothing was installed there
  }
  if (manifestDir) {
    const paths = nativeHostPaths(env.configDir, manifestDir);
    actions.push({
      description: `Unregister the Firefox native host and remove ${installedCliPath(env.configDir)}`,
      run: async () => {
        await rm(paths.manifestPath, { force: true });
        await rm(paths.launcherPath, { force: true });
        await rm(path.dirname(installedCliPath(env.configDir)), { recursive: true, force: true });
      },
    });
  }
  actions.push({
    description: `Remove "${MCP_SERVER_NAME}" from Claude Code (user scope)`,
    run: async () => {
      if (env.runClaude(["mcp", "remove", MCP_SERVER_NAME, "-s", "user"]) === null) {
        throw new SkipError("Claude Code isn't installed; skipped.");
      }
    },
  });
  const desktopConfig = desktopConfigPathFor(env);
  const doc = readJson(desktopConfig);
  const servers = (doc?.mcpServers ?? {}) as Record<string, unknown>;
  if (doc && MCP_SERVER_NAME in servers) {
    actions.push({
      description: `Remove "${MCP_SERVER_NAME}" from Claude Desktop (${desktopConfig})`,
      run: async () => {
        const { [MCP_SERVER_NAME]: _removed, ...rest } = servers;
        await writeFile(desktopConfig, `${JSON.stringify({ ...doc, mcpServers: rest }, null, 2)}\n`, "utf-8");
      },
    });
  }
  return actions;
}

/** An action that couldn't apply here but isn't a failure (e.g. no Claude Code). */
export class SkipError extends Error {}

// ---------------------------------------------------------------- doctor

export type CheckStatus = "ok" | "fail" | "warn" | "skip";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

const RUN_SETUP = `Run \`npx ${PACKAGE_NAME} setup\` (or /sharepane:setup with the Claude Code plugin).`;

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Pulls the node and cli.js paths out of the launcher install wrote. */
function parseLauncher(text: string): { nodePath: string; cliPath: string } | undefined {
  const match = /^exec '((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)' host$/m.exec(text);
  if (!match) return undefined;
  const unquote = (s: string) => s.replace(/'\\''/g, "'");
  return { nodePath: unquote(match[1]!), cliPath: unquote(match[2]!) };
}

function checkNativeHost(env: SetupEnv): Check[] {
  let manifestDir: string;
  try {
    manifestDir = manifestDirFor(env);
  } catch (err) {
    return [{ name: "Platform", status: "fail", detail: (err as Error).message }];
  }
  const paths = nativeHostPaths(env.configDir, manifestDir);
  const manifest = readJson(paths.manifestPath);
  if (!manifest) {
    return [{ name: "Firefox native host", status: "fail", detail: `Not registered (${paths.manifestPath} missing).`, fix: RUN_SETUP }];
  }
  const allowed = Array.isArray(manifest.allowed_extensions) && manifest.allowed_extensions.includes(EXTENSION_ID);
  if (manifest.path !== paths.launcherPath || !allowed) {
    return [{ name: "Firefox native host", status: "fail", detail: "Registered, but the manifest doesn't match this install.", fix: RUN_SETUP }];
  }
  const checks: Check[] = [{ name: "Firefox native host", status: "ok", detail: paths.manifestPath }];

  const launcher = existsSync(paths.launcherPath) ? readFileSync(paths.launcherPath, "utf-8") : undefined;
  const parsed = launcher ? parseLauncher(launcher) : undefined;
  if (!launcher || !parsed || !isExecutable(paths.launcherPath)) {
    checks.push({ name: "Host launcher", status: "fail", detail: `${paths.launcherPath} is missing or not runnable.`, fix: RUN_SETUP });
  } else if (!isExecutable(parsed.nodePath)) {
    checks.push({
      name: "Host launcher",
      status: "fail",
      detail: `Points at ${parsed.nodePath}, which no longer exists (Node upgraded or moved?).`,
      fix: RUN_SETUP,
    });
  } else if (!existsSync(parsed.cliPath)) {
    checks.push({ name: "Host launcher", status: "fail", detail: `Points at ${parsed.cliPath}, which no longer exists.`, fix: RUN_SETUP });
  } else if (stableNodePath(parsed.nodePath, env.pathEnv) !== parsed.nodePath) {
    checks.push({
      name: "Host launcher",
      status: "warn",
      detail: `Pinned to ${parsed.nodePath}, which will break the next time Node is upgraded.`,
      fix: RUN_SETUP,
    });
  } else {
    checks.push({ name: "Host launcher", status: "ok", detail: `${parsed.nodePath} ${parsed.cliPath}` });
  }
  return checks;
}

function isRegistered(result: ClaudeCliResult): boolean {
  return result.status === 0 && !/not found/i.test(`${result.stdout}\n${result.stderr}`);
}

function checkClaudeCode(env: SetupEnv): Check {
  const name = "Claude Code";
  // Run from the cwd, so a project-scope entry that shadows the user one shows up.
  const result = env.runClaude(["mcp", "get", MCP_SERVER_NAME]);
  if (result === null) return { name, status: "skip", detail: "Claude Code CLI not found." };
  const plugin = env.runClaude(["mcp", "get", PLUGIN_SERVER_NAME]);
  const viaPlugin = plugin !== null && isRegistered(plugin);
  const out = `${result.stdout}\n${result.stderr}`;
  if (!isRegistered(result)) {
    if (viaPlugin) return { name, status: "ok", detail: "Provided by the Sharepane plugin." };
    return { name, status: "fail", detail: `"${MCP_SERVER_NAME}" isn't registered.`, fix: RUN_SETUP };
  }
  if (viaPlugin) {
    return {
      name,
      status: "warn",
      detail: "Registered twice: by the Sharepane plugin and by setup, so Claude sees every tool twice.",
      fix: "Run /sharepane:setup, which removes the extra registration.",
    };
  }
  if (/Type:\s*http/i.test(out)) {
    const scope = /Scope:\s*(.+)/.exec(out)?.[1]?.trim() ?? "unknown scope";
    return {
      name,
      status: "fail",
      detail: `Using the old token-based HTTP entry (${scope}), which can't connect any more.`,
      fix: `${RUN_SETUP} (from this directory, so it can remove the old entry)`,
    };
  }
  if (!/Type:\s*stdio/i.test(out) || !/\bmcp\b/.test(out.split(/Args:/i)[1] ?? "")) {
    return { name, status: "warn", detail: `"${MCP_SERVER_NAME}" is registered, but not as \`sharepane mcp\`.`, fix: RUN_SETUP };
  }
  return { name, status: "ok", detail: "Registered as `sharepane mcp`." };
}

function checkClaudeDesktop(env: SetupEnv): Check {
  const name = "Claude Desktop";
  const file = desktopConfigPathFor(env);
  if (!existsSync(path.dirname(file))) return { name, status: "skip", detail: "Not installed." };
  const servers = (readJson(file)?.mcpServers ?? {}) as Record<string, { args?: unknown }>;
  const entry = servers[MCP_SERVER_NAME];
  if (!entry) return { name, status: "warn", detail: "Installed, but Sharepane isn't registered with it.", fix: RUN_SETUP };
  if (!Array.isArray(entry.args) || entry.args.at(-1) !== "mcp") {
    return { name, status: "fail", detail: "Registered with an old configuration.", fix: RUN_SETUP };
  }
  return { name, status: "ok", detail: "Registered. Restart Claude Desktop if you just ran setup." };
}

async function checkFirefox(env: SetupEnv): Promise<Check> {
  const name = "Firefox connection";
  const client = new Client({ name: "sharepane-doctor", version: VERSION });
  try {
    await client.connect(new SocketClientTransport(path.join(env.configDir, "sharepane.sock")));
  } catch {
    return {
      name,
      status: "fail",
      detail: "Firefox isn't connected.",
      fix: "Open Firefox with the Sharepane extension. If it's open, click the toolbar icon to see what's wrong.",
    };
  }
  try {
    const result = (await client.callTool({ name: "list_allowed_tabs", arguments: {} })) as {
      content: Array<{ text?: string }>;
    };
    const tabs = (JSON.parse(result.content[0]?.text ?? "{}").tabs ?? []) as unknown[];
    return {
      name,
      status: "ok",
      detail: `Connected, ${tabs.length} allowed tab${tabs.length === 1 ? "" : "s"}.`,
      ...(tabs.length === 0 ? { fix: "Click the toolbar icon on a tab and turn on Share with Claude." } : {}),
    };
  } finally {
    await client.close();
  }
}

export async function runDoctor(env: SetupEnv): Promise<Check[]> {
  const checks = checkNativeHost(env);
  checks.push(checkClaudeCode(env), checkClaudeDesktop(env));
  let manifestDir: string | undefined;
  try {
    manifestDir = manifestDirFor(env);
  } catch {
    // unsupported platform; checkNativeHost already said so
  }
  if (manifestDir) {
    const legacy = legacyPaths(env, manifestDir);
    // The old folder only matters while it hasn't been moved; if both exist,
    // setup leaves the old one alone rather than delete anything.
    const found = [existsSync(env.configDir) ? undefined : legacy.dir, legacy.manifest].filter(
      (p): p is string => p !== undefined && existsSync(p)
    );
    if (found.length > 0) {
      checks.push({
        name: "Old Tab Bridge install",
        status: "warn",
        detail: `Left over from before the rename to Sharepane: ${found.join(", ")}.`,
        fix: RUN_SETUP,
      });
    }
  }
  checks.push(await checkFirefox(env));
  return checks;
}

export function formatChecks(checks: Check[]): string {
  const icon: Record<CheckStatus, string> = { ok: "✓", fail: "✗", warn: "!", skip: "–" };
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${icon[c.status]} ${c.name}: ${c.detail}`);
    if (c.fix && c.status !== "skip") lines.push(`    → ${c.fix}`);
  }
  return lines.join("\n");
}

// Exported for tests.
export const _internal = { parseLauncher, isLegacyEntry };
