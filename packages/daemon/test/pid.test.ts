import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProcessAlive, readPidFile, removePidFile, writePidFile } from "../src/pid.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "tab-bridge-pid-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("pid file lifecycle", () => {
  it("returns undefined when no pid file exists", async () => {
    expect(await readPidFile(tmpDir)).toBeUndefined();
  });

  it("round-trips a written pid file", async () => {
    await writePidFile(tmpDir, { pid: 12345, port: 8765, startedAt: "2026-01-01T00:00:00.000Z" });
    const info = await readPidFile(tmpDir);
    expect(info).toEqual({ pid: 12345, port: 8765, startedAt: "2026-01-01T00:00:00.000Z" });
  });

  it("removePidFile deletes it and is safe to call when nothing exists", async () => {
    await writePidFile(tmpDir, { pid: 1, port: 1, startedAt: "x" });
    await removePidFile(tmpDir);
    expect(await readPidFile(tmpDir)).toBeUndefined();
    await expect(removePidFile(tmpDir)).resolves.toBeUndefined(); // idempotent
  });

  it("returns undefined for a corrupt pid file rather than throwing", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(tmpDir, "daemon.pid"), "{not json", "utf-8");
    expect(await readPidFile(tmpDir)).toBeUndefined();
  });
});

describe("isProcessAlive", () => {
  it("is true for this test process's own pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("is false for a pid that almost certainly doesn't exist", () => {
    // A very high PID that's extremely unlikely to be in use.
    expect(isProcessAlive(999_999)).toBe(false);
  });
});
