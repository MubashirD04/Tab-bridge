// Starts the MCP server a Claude Code plugin's .mcp.json describes, the way
// Claude Code does, and checks it answers with its tools. `claude plugin
// validate` doesn't catch a server that can't start (a wrong path, say).
//
//   node scripts/check-plugin.mjs plugins/sharepane
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
const root = path.resolve(process.argv[2]);
const spec = JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf-8")).mcpServers;
const [name, server] = Object.entries(spec)[0];
const args = server.args.map((a) => a.replace("${CLAUDE_PLUGIN_ROOT}", root));
const child = spawn(server.command, args, { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const timer = setTimeout(() => { console.log("no reply in 10s"); child.kill(); process.exit(1); }, 10000);
child.stdout.on("data", (d) => {
  buf += d;
  for (const line of buf.split("\n").slice(0, -1)) {
    const msg = JSON.parse(line);
    if (msg.id === 1) {
      console.log(`server "${name}" started: ${msg.result.serverInfo.name} ${msg.result.serverInfo.version}`);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    }
    if (msg.id === 2) {
      console.log("tools:", msg.result.tools.map((t) => t.name).join(", "));
      clearTimeout(timer); child.kill(); process.exit(0);
    }
  }
  buf = buf.slice(buf.lastIndexOf("\n") + 1);
});
child.on("exit", (code) => { console.log(`server exited early (code ${code})`); process.exit(1); });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "plugin-check", version: "1" } } }) + "\n");
