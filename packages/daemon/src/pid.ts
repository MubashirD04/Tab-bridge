import { readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * PID-file lifecycle, so the daemon can be started/stopped on demand — e.g.
 * by a skill that spins it up for one task and tears it down afterward,
 * mirroring how a browser-automation skill starts and stops a headless
 * browser process. Not required for the "leave it running" workflow; only
 * `stop` and `start`'s idempotency check rely on this.
 */
export interface PidInfo {
  pid: number;
  port: number;
  startedAt: string;
}

export function pidFilePath(configDir: string): string {
  return path.join(configDir, "daemon.pid");
}

export async function writePidFile(configDir: string, info: PidInfo): Promise<void> {
  await writeFile(pidFilePath(configDir), JSON.stringify(info, null, 2), "utf-8");
}

export async function readPidFile(configDir: string): Promise<PidInfo | undefined> {
  const filePath = pidFilePath(configDir);
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as PidInfo;
  } catch {
    return undefined;
  }
}

export async function removePidFile(configDir: string): Promise<void> {
  const filePath = pidFilePath(configDir);
  if (existsSync(filePath)) {
    await unlink(filePath).catch(() => undefined);
  }
}

/** `process.kill(pid, 0)` sends no signal — it just checks whether the
 * process exists and is reachable, throwing ESRCH if not. Standard
 * cross-platform-enough liveness check for a same-user local process. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
