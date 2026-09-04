import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Structured local logging (blueprint Section 10, Observability & Monitoring).
 *
 * Deliberately logs connection/auth/tool-call *events*, never captured page
 * content (HTML, screenshots, console/network entries) — otherwise the log
 * file would quietly become its own sensitive-data sink, undercutting the
 * whole "logs stay in memory only by default" decision.
 */
export interface LogEvent {
  event: string;
  [key: string]: unknown;
}

export class Logger {
  private readonly logPath: string;
  private ready: Promise<void>;

  constructor(configDir: string) {
    this.logPath = path.join(configDir, "daemon.log");
    this.ready = mkdir(configDir, { recursive: true }).then(() => undefined);
  }

  async log(evt: LogEvent): Promise<void> {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...evt });
    // eslint-disable-next-line no-console
    console.error(`[tab-bridge] ${line}`);
    await this.ready;
    try {
      await appendFile(this.logPath, line + "\n", "utf-8");
    } catch {
      // Logging must never crash the daemon; a failed write is dropped.
    }
  }
}
