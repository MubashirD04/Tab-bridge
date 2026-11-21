import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHost } from "../src/host.js";
import {
  _internal,
  installedCliPath,
  PLUGIN_SERVER_NAME,
  planSetup,
  planUninstall,
  runDoctor,
  SkipError,
  stableNodePath,
  type ClaudeCliResult,
  type SetupEnv,
} from "../src/setup.js";
import { attachToHostStreams } from "./helpers/fakeExtension.js";

type Entry = { scope: string; spec: { type: string; command?: string; args?: string[]; url?: string } };

/** A stand-in for the `claude` CLI with its own registry, printing `mcp get`
 * in the same shape the real CLI does. */
function fakeClaude() {
  const servers = new Map<string, Entry>();
  const calls: string[][] = [];
  const run = (args: string[]): ClaudeCliResult => {
    calls.push(args);
    const [, sub, name] = args;
    if (sub === "add-json") {
      if (servers.has(name!)) return { status: 1, stdout: "", stderr: `MCP server ${name} already exists` };
      servers.set(name!, { scope: "user", spec: JSON.parse(args[3]!) });
      return { status: 0, stdout: "Added", stderr: "" };
    }
    if (sub === "remove") {
      return servers.delete(name!)
        ? { status: 0, stdout: "Removed", stderr: "" }
        : { status: 1, stdout: "", stderr: `No MCP server found with name: ${name}` };
    }
    if (sub === "get") {
      const entry = servers.get(name!);
      if (!entry) return { status: 1, stdout: "", stderr: `No MCP server found with name: ${name}` };
      const body =
        entry.spec.type === "stdio"
          ? `  Type: stdio\n  Command: ${entry.spec.command}\n  Args: ${entry.spec.args?.join(" ")}\n`
          : `  Type: http\n  URL: ${entry.spec.url}\n`;
      return { status: 0, stdout: `${name}:\n  Scope: ${entry.scope}\n  Status: ✓ Connected\n${body}`, stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unknown" };
  };
  return { servers, calls, run };
}

describe("sharepane setup / doctor / uninstall", () => {
  let tmp: string;
  let env: SetupEnv;
  let claude: ReturnType<typeof fakeClaude>;
  let realNode: string;

  async function applySetup(e: SetupEnv = env) {
    for (const action of planSetup(e)) await action.run();
  }

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "tb-"));
    // A Homebrew-like layout: a versioned binary plus a stable alias on PATH.
    realNode = path.join(tmp, "Cellar/node/26.8.1/bin/node");
    await mkdir(path.dirname(realNode), { recursive: true });
    await writeFile(realNode, "#!/bin/sh\n");
    await chmod(realNode, 0o755);
    await mkdir(path.join(tmp, "bin"));
    await symlink(realNode, path.join(tmp, "bin/node"));
    const cliPath = path.join(tmp, "dist/cli.js");
    await mkdir(path.dirname(cliPath), { recursive: true });
    await writeFile(cliPath, "");
    await mkdir(path.join(tmp, "project"));

    claude = fakeClaude();
    env = {
      home: path.join(tmp, "home"),
      platform: "darwin",
      cwd: path.join(tmp, "project"),
      configDir: path.join(tmp, "c"),
      execPath: realNode,
      pathEnv: [path.join(tmp, "empty"), path.join(tmp, "bin")].join(path.delimiter),
      cliPath,
      runClaude: claude.run,
      manifestDir: path.join(tmp, "NativeMessagingHosts"),
      desktopConfigPath: path.join(tmp, "Claude/claude_desktop_config.json"),
    };
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("prefers a PATH alias that survives `brew upgrade node` over the versioned Cellar path", () => {
    expect(stableNodePath(realNode, env.pathEnv)).toBe(path.join(tmp, "bin/node"));
    expect(stableNodePath(realNode, path.join(tmp, "empty"))).toBe(realNode);
  });

  it("planning has no side effects (what --dry-run prints)", () => {
    const actions = planSetup(env);
    expect(actions.map((a) => a.description).join("\n")).toMatch(/native host[\s\S]*Claude Code/);
    expect(existsSync(env.manifestDir!)).toBe(false);
    expect(claude.calls).toEqual([]);
  });

  it("registers the native host and Claude Code at user scope, with the stable node path", async () => {
    await applySetup();
    const launcher = await readFile(path.join(env.configDir, "native-host.sh"), "utf-8");
    expect(launcher).toContain(`'${path.join(tmp, "bin/node")}'`);
    expect(claude.servers.get("sharepane")).toEqual({
      scope: "user",
      spec: { type: "stdio", command: path.join(tmp, "bin/node"), args: [installedCliPath(env.configDir), "mcp"] },
    });
    expect(launcher).toContain(`'${installedCliPath(env.configDir)}' host`);
  });

  it("installs a copy of itself where npm can't clean it up, and points everything at the copy", async () => {
    await writeFile(env.cliPath, "// bundle v1\n");
    await applySetup();
    const copy = installedCliPath(env.configDir);
    expect(await readFile(copy, "utf-8")).toBe("// bundle v1\n");
    expect((await stat(copy)).mode & 0o111).not.toBe(0);

    // Re-running from a newer npx download updates the copy.
    await writeFile(env.cliPath, "// bundle v2\n");
    await applySetup();
    expect(await readFile(copy, "utf-8")).toBe("// bundle v2\n");
  });

  it("doesn't try to copy itself onto itself when run from the installed copy", async () => {
    const actions = planSetup({ ...env, cliPath: installedCliPath(env.configDir) });
    expect(actions.some((a) => a.description.startsWith("Install sharepane"))).toBe(false);
  });

  it("in plugin mode, leaves Claude Code to the plugin and removes a user-wide duplicate", async () => {
    await applySetup(); // an earlier npx setup registered it user-wide
    expect(claude.servers.has("sharepane")).toBe(true);
    const addsBefore = claude.calls.filter((c) => c[1] === "add-json").length;
    for (const action of planSetup(env, { claudeCode: "plugin" })) await action.run();
    expect(claude.servers.has("sharepane")).toBe(false);
    expect(claude.calls.filter((c) => c[1] === "add-json").length).toBe(addsBefore); // registered nothing new
    expect(existsSync(path.join(env.manifestDir!, "sharepane.json"))).toBe(true); // Firefox side still set up
  });

  it("is safe to run twice (replaces its own Claude Code entry)", async () => {
    await applySetup();
    await applySetup();
    expect(claude.servers.size).toBe(1);
  });

  it("reports a missing Claude Code CLI as skipped, not failed", async () => {
    const action = planSetup({ ...env, runClaude: () => null }).find((a) => a.description.includes("Claude Code"))!;
    await expect(action.run()).rejects.toBeInstanceOf(SkipError);
  });

  it("removes the old token entry from the project's .mcp.json but keeps other servers", async () => {
    const mcpJson = path.join(env.cwd, ".mcp.json");
    const legacy = { type: "http", url: "http://127.0.0.1:8765/mcp", headers: { Authorization: "Bearer x" } };
    await writeFile(mcpJson, JSON.stringify({ mcpServers: { "tab-bridge": legacy, other: { command: "x" } } }));
    await applySetup();
    expect(JSON.parse(await readFile(mcpJson, "utf-8"))).toEqual({ mcpServers: { other: { command: "x" } } });
  });

  it("deletes .mcp.json entirely when the old entry was all it held", async () => {
    const mcpJson = path.join(env.cwd, ".mcp.json");
    await writeFile(mcpJson, JSON.stringify({ mcpServers: { "tab-bridge": { type: "http", url: "http://127.0.0.1:8765/mcp" } } }));
    await applySetup();
    expect(existsSync(mcpJson)).toBe(false);
  });

  it("also finds the old entry in a parent folder's .mcp.json (Claude Code reads those too)", async () => {
    const parentMcpJson = path.join(path.dirname(env.cwd), ".mcp.json");
    await writeFile(parentMcpJson, JSON.stringify({ mcpServers: { "tab-bridge": { type: "http", url: "http://127.0.0.1:8765/mcp" } } }));
    await applySetup();
    expect(existsSync(parentMcpJson)).toBe(false);
  });

  it("leaves a .mcp.json tab-bridge entry alone if it isn't the old token one", async () => {
    const mcpJson = path.join(env.cwd, ".mcp.json");
    const custom = JSON.stringify({ mcpServers: { "tab-bridge": { command: "my-fork", args: ["mcp"] } } });
    await writeFile(mcpJson, custom);
    await applySetup();
    expect(await readFile(mcpJson, "utf-8")).toBe(custom);
    expect(_internal.isLegacyEntry({ type: "http", url: "https://example.com/mcp" })).toBe(false);
  });

  describe("moving an install from the old Tab Bridge name", () => {
    const oldDir = () => path.join(env.home, ".tab-bridge");
    const oldManifest = () => path.join(env.manifestDir!, "tab_bridge.json");

    beforeEach(async () => {
      await mkdir(oldDir(), { recursive: true });
      await writeFile(path.join(oldDir(), "allowlist.json"), '{"entries":[{"origin":"http://localhost"}]}');
      await writeFile(path.join(oldDir(), "config.json"), '{"token":"x"}');
      await writeFile(path.join(oldDir(), "native-host.sh"), "#!/bin/sh\nexec old\n");
      await mkdir(env.manifestDir!, { recursive: true });
      await writeFile(oldManifest(), "{}");
      claude.servers.set("tab-bridge", { scope: "user", spec: { type: "stdio", command: "node", args: ["old.js", "mcp"] } });
      await mkdir(path.dirname(env.desktopConfigPath!), { recursive: true });
      await writeFile(env.desktopConfigPath!, JSON.stringify({ mcpServers: { "tab-bridge": { command: "node" }, other: { command: "x" } } }));
    });

    it("moves the settings folder, keeping the allow-list and dropping the old token", async () => {
      await applySetup();
      expect(existsSync(oldDir())).toBe(false);
      expect(await readFile(path.join(env.configDir, "allowlist.json"), "utf-8")).toContain("localhost");
      expect(existsSync(path.join(env.configDir, "config.json"))).toBe(false);
      expect(await readFile(path.join(env.configDir, "native-host.sh"), "utf-8")).toContain(" host");
    });

    it("unregisters the old native host and the old Claude entries", async () => {
      await applySetup();
      expect(existsSync(oldManifest())).toBe(false);
      expect(existsSync(path.join(env.manifestDir!, "sharepane.json"))).toBe(true);
      expect([...claude.servers.keys()]).toEqual(["sharepane"]);
      expect(Object.keys(JSON.parse(await readFile(env.desktopConfigPath!, "utf-8")).mcpServers).sort()).toEqual([
        "other",
        "sharepane",
      ]);
    });

    it("leaves the old folder alone if the new one already exists", async () => {
      await mkdir(env.configDir, { recursive: true });
      await applySetup();
      expect(existsSync(path.join(oldDir(), "allowlist.json"))).toBe(true);
    });

    it("doctor points at setup until it's done", async () => {
      const before = await runDoctor(env);
      expect(before.find((c) => c.name === "Old Tab Bridge install")?.status).toBe("warn");
      await applySetup();
      const after = await runDoctor(env);
      expect(after.some((c) => c.name === "Old Tab Bridge install")).toBe(false);
    });
  });

  it("registers with Claude Desktop only if it's installed, keeping its other settings", async () => {
    expect(planSetup(env).some((a) => a.description.includes("Claude Desktop"))).toBe(false);

    await mkdir(path.dirname(env.desktopConfigPath!), { recursive: true });
    await writeFile(env.desktopConfigPath!, JSON.stringify({ preferences: { a: 1 } }));
    await applySetup();
    expect(JSON.parse(await readFile(env.desktopConfigPath!, "utf-8"))).toEqual({
      preferences: { a: 1 },
      mcpServers: { "sharepane": { command: path.join(tmp, "bin/node"), args: [installedCliPath(env.configDir), "mcp"] } },
    });
  });

  it("uninstall removes what setup added and keeps the allow-list", async () => {
    await mkdir(path.dirname(env.desktopConfigPath!), { recursive: true });
    await applySetup();
    await writeFile(path.join(env.configDir, "allowlist.json"), "{}");
    for (const action of planUninstall(env)) await action.run();
    expect(existsSync(path.join(env.manifestDir!, "sharepane.json"))).toBe(false);
    expect(claude.servers.size).toBe(0);
    expect(JSON.parse(await readFile(env.desktopConfigPath!, "utf-8")).mcpServers).toEqual({});
    expect(existsSync(path.join(env.configDir, "allowlist.json"))).toBe(true);
  });

  describe("doctor", () => {
    const byName = async (e: SetupEnv) => Object.fromEntries((await runDoctor(e)).map((c) => [c.name, c]));

    it("before setup: says to run setup, and that Firefox isn't connected", async () => {
      const checks = await byName(env);
      expect(checks["Firefox native host"]).toMatchObject({ status: "fail", fix: expect.stringMatching(/npx sharepane setup/) });
      expect(checks["Claude Code"]).toMatchObject({ status: "fail" });
      expect(checks["Firefox connection"]).toMatchObject({ status: "fail" });
    });

    it("after setup, with Firefox connected: everything passes", async () => {
      await applySetup();
      const { input, output, fake } = attachToHostStreams();
      const host = await runHost({ input, output, configDir: env.configDir });
      await fake.hello("s");
      try {
        const checks = await runDoctor(env);
        expect(checks.filter((c) => c.status !== "ok" && c.status !== "skip")).toEqual([]);
        expect(checks.find((c) => c.name === "Firefox connection")?.detail).toBe("Connected, 0 allowed tabs.");
      } finally {
        await host.close();
      }
    });

    it("catches a launcher whose node binary was removed by an upgrade", async () => {
      await applySetup({ ...env, pathEnv: "" }); // pins the versioned path
      await rm(realNode);
      expect((await byName(env))["Host launcher"]).toMatchObject({ status: "fail", detail: expect.stringMatching(/no longer exists/) });
    });

    it("warns when the launcher is pinned to a versioned node path that has a stable alias", async () => {
      await applySetup({ ...env, pathEnv: "" }); // pins the versioned path
      expect((await byName(env))["Host launcher"]).toMatchObject({ status: "warn", detail: expect.stringMatching(/next time Node is upgraded/) });
    });

    it("catches the old HTTP entry shadowing the new one", async () => {
      claude.servers.set("sharepane", { scope: "Project config (shared via .mcp.json)", spec: { type: "http", url: "http://127.0.0.1:8765/mcp" } });
      expect((await byName(env))["Claude Code"]).toMatchObject({
        status: "fail",
        detail: expect.stringMatching(/old token-based HTTP entry \(Project config/),
      });
    });

    it("accepts the plugin's server, and warns when setup registered a second copy", async () => {
      claude.servers.set(PLUGIN_SERVER_NAME, { scope: "plugin", spec: { type: "stdio", command: "node", args: ["x/sharepane.mjs", "mcp"] } });
      expect((await byName(env))["Claude Code"]).toMatchObject({ status: "ok", detail: "Provided by the Sharepane plugin." });

      await applySetup();
      expect((await byName(env))["Claude Code"]).toMatchObject({ status: "warn", detail: expect.stringMatching(/twice/) });
    });

    it("skips Claude Code checks when its CLI isn't installed", async () => {
      expect((await byName({ ...env, runClaude: () => null }))["Claude Code"]).toMatchObject({ status: "skip" });
    });
  });

  it("parses the launcher it writes, including quoted paths", () => {
    expect(_internal.parseLauncher("#!/bin/sh\nexec '/a b/node' '/it'\\''s/cli.js' host\n")).toEqual({
      nodePath: "/a b/node",
      cliPath: "/it's/cli.js",
    });
  });
});
