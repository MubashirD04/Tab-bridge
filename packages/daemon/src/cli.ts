import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigStore } from "./config.js";
import { HostAlreadyRunningError, runHost } from "./host.js";
import { buildMcpProxy } from "./mcpProxy.js";
import {
  defaultSetupEnv,
  formatChecks,
  planSetup,
  planUninstall,
  runDoctor,
  SkipError,
  type SetupAction,
} from "./setup.js";

const USAGE = `Usage: sharepane <command>

  setup [--dry-run]       Connect Firefox and Claude (run once; again to update)
  doctor                  Check every piece and say how to fix what's broken
  uninstall [--dry-run]   Undo setup (your allow-list is kept)

Started for you, not by hand:
  mcp                     The MCP server Claude launches
  host                    The native host Firefox launches`;

/** Started by Firefox. stdout belongs to native messaging, so nothing on
 * this path may print to it. */
async function host(): Promise<void> {
  let running;
  try {
    running = await runHost({ input: process.stdin, output: process.stdout });
  } catch (err) {
    if (err instanceof HostAlreadyRunningError) {
      // Give the host_error message a moment to flush before exiting.
      process.stdout.end(() => process.exit(0));
      return;
    }
    throw err;
  }
  const shutdown = () => void running.close().then(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await running.ended;
  shutdown();
}

/** Started by Claude (or any MCP client) over stdio. Like `host`, stdout is
 * protocol-only. */
async function mcp(configStore: ConfigStore): Promise<void> {
  const server = buildMcpProxy(configStore.socketPath);
  await server.connect(new StdioServerTransport());
}

async function runActions(actions: SetupAction[], dryRun: boolean): Promise<boolean> {
  let ok = true;
  for (const action of actions) {
    if (dryRun) {
      console.log(`• ${action.description}`);
      continue;
    }
    try {
      await action.run();
      console.log(`✓ ${action.description}`);
    } catch (err) {
      if (err instanceof SkipError) {
        console.log(`– ${action.description}\n    ${err.message}`);
      } else {
        ok = false;
        console.log(`✗ ${action.description}\n    ${(err as Error).message}`);
      }
    }
  }
  return ok;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const dryRun = rest.includes("--dry-run");
  const configStore = new ConfigStore();
  const env = () => defaultSetupEnv(fileURLToPath(import.meta.url), configStore.configDir);

  switch (command) {
    case "host":
      return host();
    case "mcp":
      return mcp(configStore);
    case "setup": {
      if (dryRun) console.log("sharepane setup would:\n");
      // --plugin: the Claude Code plugin runs this, and provides the MCP
      // server itself.
      const ok = await runActions(planSetup(env(), { claudeCode: rest.includes("--plugin") ? "plugin" : "register" }), dryRun);
      if (dryRun) return;
      console.log(
        ok
          ? "\nDone. Next: load the extension in Firefox (or reload it if it's already loaded),\n" +
              "then restart Claude Code / Claude Desktop. `sharepane doctor` checks everything."
          : "\nSome steps failed; see above. `sharepane doctor` shows what's still missing."
      );
      process.exitCode = ok ? 0 : 1;
      return;
    }
    case "uninstall": {
      if (dryRun) console.log("sharepane uninstall would:\n");
      const ok = await runActions(planUninstall(env()), dryRun);
      process.exitCode = ok ? 0 : 1;
      return;
    }
    case "doctor": {
      const checks = await runDoctor(env());
      console.log(formatChecks(checks));
      process.exitCode = checks.some((c) => c.status === "fail") ? 1 : 0;
      return;
    }
    default:
      console.error(command ? `Unknown command: ${command}\n\n${USAGE}` : USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
