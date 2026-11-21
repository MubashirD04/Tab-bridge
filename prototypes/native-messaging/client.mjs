// Stand-in for the future MCP stdio server: connects to the host's Unix
// socket, asks the extension for its tab list, and prints the round trip.
// Usage: node client.mjs [count] [intervalSeconds]
import net from "node:net";
import os from "node:os";
import path from "node:path";

const SOCKET_PATH = path.join(os.homedir(), ".tab-bridge", "nm-proto.sock");
const count = Number(process.argv[2] ?? 1);
const intervalMs = Number(process.argv[3] ?? 0) * 1000;

function ping() {
  return new Promise((resolve) => {
    const sock = net.createConnection(SOCKET_PATH);
    sock.on("error", (err) => resolve({ ok: false, error: err.code }));
    sock.on("connect", () => sock.write(JSON.stringify({ cmd: "list_tabs" }) + "\n"));
    sock.on("data", (d) => {
      resolve(JSON.parse(d.toString("utf8").trim()));
      sock.end();
    });
  });
}

for (let i = 0; i < count; i++) {
  const r = await ping();
  const summary = r.ok
    ? `ok host=${r.hostPid} rtt=${r.roundTripMs}ms tabs=${r.result.tabs.length} bgPage=${r.result.backgroundLoadedAt}`
    : `FAIL ${r.error}`;
  console.log(`${new Date().toISOString()} #${i + 1} ${summary}`);
  if (i < count - 1) await new Promise((res) => setTimeout(res, intervalMs));
}
