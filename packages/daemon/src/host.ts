import { chmod, mkdir, unlink } from "node:fs/promises";
import net from "node:net";
import type { Readable, Writable } from "node:stream";
import { AllowlistStore } from "./allowlist.js";
import { ConfigStore } from "./config.js";
import { ExtensionBridge } from "./extensionBridge.js";
import { Logger } from "./logger.js";
import { PROXY_CLIENT_PREFIX } from "./mcpProxy.js";
import { serveMcpOnStream } from "./mcpServer.js";
import { encodeNativeMessage, NativeMessageDecoder } from "./nativeMessaging.js";
import { TabRegistry } from "./tabSessions.js";
import type { DaemonToExtensionMessage } from "./types.js";

export interface HostOptions {
  /** Native-messaging stdin from Firefox. */
  input: Readable;
  /** Native-messaging stdout to Firefox. Nothing else may ever write to it. */
  output: Writable;
  configDir?: string;
}

export interface RunningHost {
  socketPath: string;
  /** Resolves when Firefox closes the connection (stdin ends). */
  ended: Promise<void>;
  close(): Promise<void>;
}

export class HostAlreadyRunningError extends Error {
  constructor(socketPath: string) {
    super(`Another Sharepane host is already serving ${socketPath}.`);
    this.name = "HostAlreadyRunningError";
  }
}

/** The host couldn't open its socket. It has already told the extension
 * why (a host_error message); the caller should just exit. */
export class HostStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostStartupError";
  }
}

/** Unix socket paths are limited by sockaddr_un.sun_path: 104 bytes on
 * macOS and the BSDs, 108 on Linux, including the terminating NUL. */
export const MAX_SOCKET_PATH_BYTES = process.platform === "linux" ? 107 : 103;

/** True if something is accepting connections on the socket right now. */
function socketIsLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

/**
 * The process Firefox launches for `runtime.connectNative("sharepane")`.
 *
 * - Talks to the extension over stdio with native-messaging framing.
 * - Serves MCP on a Unix socket in the config directory. The directory is
 *   0700 and the socket 0600, so only this user can connect: the OS does
 *   the job the old bearer token did.
 * - Lives exactly as long as the extension's port. Firefox closes stdin when
 *   the port goes away (and sends SIGTERM on quit), and the host exits.
 */
export async function runHost(options: HostOptions): Promise<RunningHost> {
  const configStore = new ConfigStore(options.configDir);
  const socketPath = configStore.socketPath;
  const logger = new Logger(configStore.configDir);

  const sendToExtension = (message: DaemonToExtensionMessage): void => {
    try {
      options.output.write(encodeNativeMessage(message));
    } catch (err) {
      void logger.log({ event: "native_send_failed", message: (err as Error).message });
    }
  };

  await mkdir(configStore.configDir, { recursive: true, mode: 0o700 });
  await chmod(configStore.configDir, 0o700);

  // A second Firefox profile with the extension installed would start a
  // second host. Only one can own the socket; the other tells its extension
  // why and steps aside instead of stealing it.
  if (await socketIsLive(socketPath)) {
    sendToExtension({
      type: "host_error",
      code: "ANOTHER_INSTANCE",
      message: "Another Firefox profile is already connected to Sharepane.",
    });
    void logger.log({ event: "host_refused_another_instance" });
    throw new HostAlreadyRunningError(socketPath);
  }
  await unlink(socketPath).catch(() => undefined); // stale file from a crash

  const allowlistStore = new AllowlistStore(configStore);
  await allowlistStore.load();
  const tabRegistry = new TabRegistry();
  const extensionBridge = new ExtensionBridge(allowlistStore, tabRegistry, logger);
  const connection = extensionBridge.connect({ send: sendToExtension });

  const clients = new Set<net.Socket>();
  const clientNames = new Map<net.Socket, string>();
  const reportMcpClients = () => {
    const names = [...clientNames.values()]
      .filter((n) => n.startsWith(PROXY_CLIENT_PREFIX))
      .map((n) => n.slice(PROXY_CLIENT_PREFIX.length));
    extensionBridge.setMcpClients([...new Set(names)].sort());
  };
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => {
      clients.delete(socket);
      if (clientNames.delete(socket)) reportMcpClients();
    });
    const onClientName = (name: string | undefined) => {
      if (!name) return;
      clientNames.set(socket, name);
      reportMcpClients();
    };
    void serveMcpOnStream({ tabRegistry, extensionBridge }, socket, onClientName).catch((err) => {
      void logger.log({ event: "mcp_session_failed", message: (err as Error).message });
      socket.destroy();
    });
  });
  // Without this, a failure here crashes the host and the extension can only
  // say "the helper stopped unexpectedly", over and over.
  const failStartup = (reason: string): never => {
    const message = `Sharepane's helper couldn't start: ${reason}`;
    sendToExtension({ type: "host_error", code: "STARTUP_FAILED", message });
    void logger.log({ event: "host_startup_failed", message });
    throw new HostStartupError(message);
  };
  const pathBytes = Buffer.byteLength(socketPath);
  if (pathBytes > MAX_SOCKET_PATH_BYTES) {
    failStartup(
      `the path to its socket is too long (${pathBytes} bytes; this system allows ${MAX_SOCKET_PATH_BYTES}): ${socketPath}`
    );
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  }).catch((err: Error) => failStartup(`couldn't open ${socketPath} (${err.message}).`));
  await chmod(socketPath, 0o600);
  void logger.log({ event: "host_started", pid: process.pid, socketPath });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      connection.close();
      for (const socket of clients) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => undefined);
      // Awaited: the CLI calls process.exit() right after close() resolves.
      await logger.log({ event: "host_stopped", pid: process.pid });
    })();
    return closing;
  };

  const decoder = new NativeMessageDecoder();
  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => (resolveEnded = resolve));

  options.input.on("data", (chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch (err) {
      // The framing can't be resynchronised after a bad length or body.
      void logger.log({ event: "native_decode_failed", message: (err as Error).message });
      options.input.destroy();
      return;
    }
    for (const message of messages) connection.receive(message);
  });
  options.input.on("close", () => resolveEnded());
  options.input.on("end", () => resolveEnded());

  return { socketPath, ended, close };
}
