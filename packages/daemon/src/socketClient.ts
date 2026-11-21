import net from "node:net";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** MCP client transport over the host's Unix socket. Same newline-delimited
 * JSON-RPC framing as MCP's stdio transport. Used by `sharepane status` and
 * by tests. */
export class SocketClientTransport implements Transport {
  private socket: net.Socket | undefined;
  private readonly readBuffer = new ReadBuffer();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly socketPath: string) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      this.socket = socket;
      socket.once("connect", () => {
        socket.off("error", reject);
        socket.on("error", (err) => this.onerror?.(err));
        resolve();
      });
      socket.once("error", reject);
      socket.on("data", (chunk: Buffer) => {
        this.readBuffer.append(chunk);
        for (;;) {
          let message: JSONRPCMessage | null;
          try {
            message = this.readBuffer.readMessage();
          } catch (err) {
            this.onerror?.(err as Error);
            continue;
          }
          if (!message) break;
          this.onmessage?.(message);
        }
      });
      socket.on("close", () => this.onclose?.());
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve) => {
      if (!this.socket || !this.socket.writable) return resolve();
      this.socket.write(serializeMessage(message), () => resolve());
    });
  }

  async close(): Promise<void> {
    this.socket?.end();
    this.socket = undefined;
  }
}
