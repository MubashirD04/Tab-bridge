// Prototype native-messaging host for Tab Bridge (step 1 of the rebuild).
//
// Firefox launches this process when the extension calls
// browser.runtime.connectNative("tab_bridge_proto"). It speaks Firefox's
// native-messaging framing on stdin/stdout (4-byte little-endian length +
// UTF-8 JSON) and also listens on a Unix socket so a separate process (the
// future MCP stdio server) can reach the extension without ports or tokens.
//
// Every lifecycle event is appended to host.log so we can see exactly when
// Firefox starts and stops the host.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DIR = path.join(os.homedir(), ".tab-bridge");
const SOCKET_PATH = path.join(DIR, "nm-proto.sock");
const LOG_PATH = path.join(DIR, "nm-proto-host.log");
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });

function log(event, extra = {}) {
  fs.appendFileSync(LOG_PATH, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, ...extra }) + "\n");
}

// ---- Firefox side: length-prefixed JSON on stdio ----
function sendToExtension(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

let pending = Buffer.alloc(0);
const waiters = new Map(); // id -> socket client callback
let nextId = 1;

process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const len = pending.readUInt32LE(0);
    if (pending.length < 4 + len) break;
    const msg = JSON.parse(pending.subarray(4, 4 + len).toString("utf8"));
    pending = pending.subarray(4 + len);
    handleExtensionMessage(msg);
  }
});

process.stdin.on("end", () => {
  // Firefox closes stdin when the port disconnects (extension page unloaded,
  // extension disabled, or browser quit). This is the lifecycle signal the
  // prototype is meant to observe.
  log("stdin_closed");
  shutdown(0);
});

function handleExtensionMessage(msg) {
  if (msg.type === "hello") {
    log("extension_hello", { reason: msg.reason });
    return;
  }
  if (msg.type === "heartbeat") return;
  if (msg.type === "response" && waiters.has(msg.id)) {
    waiters.get(msg.id)(msg);
    waiters.delete(msg.id);
  }
}

// ---- MCP side: newline-delimited JSON over a Unix socket ----
// The socket file is created inside a 0700 directory and chmod'ed 0600, so
// only this user can connect: the OS does the authentication a bearer
// token used to do.
try { fs.unlinkSync(SOCKET_PATH); } catch {}
const server = net.createServer((sock) => {
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const req = JSON.parse(line);
      const id = nextId++;
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        waiters.delete(id);
        sock.write(JSON.stringify({ ok: false, error: "extension did not answer in 5s" }) + "\n");
      }, 5000);
      waiters.set(id, (resp) => {
        clearTimeout(timer);
        sock.write(JSON.stringify({ ok: true, hostPid: process.pid, roundTripMs: Date.now() - startedAt, result: resp.result }) + "\n");
      });
      sendToExtension({ type: "request", id, cmd: req.cmd });
    }
  });
  sock.on("error", () => {});
});
server.listen(SOCKET_PATH, () => {
  fs.chmodSync(SOCKET_PATH, 0o600);
  log("host_started", { socket: SOCKET_PATH });
});

function shutdown(code) {
  try { server.close(); } catch {}
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  log("host_exiting", { code });
  process.exit(code);
}
process.on("SIGTERM", () => { log("sigterm"); shutdown(0); });
process.on("SIGINT", () => { log("sigint"); shutdown(0); });
