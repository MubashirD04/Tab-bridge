import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeMcpJson, type DaemonConfig } from "../src/config.js";

let tmpDir: string;
const config: DaemonConfig = { token: "abc123", port: 8765, tokenCreatedAt: "2026-01-01T00:00:00.000Z" };

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "tab-bridge-mcpjson-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("writeMcpJson", () => {
  it("creates .mcp.json from scratch with the tab-bridge entry", async () => {
    const result = await writeMcpJson(tmpDir, config);
    expect(result.changed).toBe(true);

    const doc = JSON.parse(await readFile(result.path, "utf-8"));
    expect(doc.mcpServers["tab-bridge"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:8765/mcp",
      headers: { Authorization: "Bearer abc123" },
    });
  });

  it("preserves other mcpServers entries already in the file", async () => {
    await writeFile(
      path.join(tmpDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { type: "stdio", command: "foo" } } }),
      "utf-8"
    );

    const result = await writeMcpJson(tmpDir, config);
    expect(result.changed).toBe(true);

    const doc = JSON.parse(await readFile(result.path, "utf-8"));
    expect(doc.mcpServers.other).toEqual({ type: "stdio", command: "foo" });
    expect(doc.mcpServers["tab-bridge"].url).toBe("http://127.0.0.1:8765/mcp");
  });

  it("reports changed: false when the entry is already up to date", async () => {
    await writeMcpJson(tmpDir, config);
    const second = await writeMcpJson(tmpDir, config);
    expect(second.changed).toBe(false);
  });

  it("reports changed: true when the token has rotated", async () => {
    await writeMcpJson(tmpDir, config);
    const rotated = { ...config, token: "different-token" };
    const second = await writeMcpJson(tmpDir, rotated);
    expect(second.changed).toBe(true);

    const doc = JSON.parse(await readFile(path.join(tmpDir, ".mcp.json"), "utf-8"));
    expect(doc.mcpServers["tab-bridge"].headers.Authorization).toBe("Bearer different-token");
  });

  it("does not clobber a .mcp.json that isn't valid JSON", async () => {
    await writeFile(path.join(tmpDir, ".mcp.json"), "{not json", "utf-8");
    const result = await writeMcpJson(tmpDir, config);
    expect(result.changed).toBe(false);
    expect(await readFile(path.join(tmpDir, ".mcp.json"), "utf-8")).toBe("{not json");
  });

  it("appends .mcp.json to an existing .gitignore that doesn't have it", async () => {
    await writeFile(path.join(tmpDir, ".gitignore"), "node_modules/\n", "utf-8");
    const result = await writeMcpJson(tmpDir, config);
    expect(result.gitignoreUpdated).toBe(true);

    const gitignore = await readFile(path.join(tmpDir, ".gitignore"), "utf-8");
    expect(gitignore).toBe("node_modules/\n.mcp.json\n");
  });

  it("does not touch .gitignore if .mcp.json is already listed", async () => {
    await writeFile(path.join(tmpDir, ".gitignore"), "node_modules/\n.mcp.json\n", "utf-8");
    const result = await writeMcpJson(tmpDir, config);
    expect(result.gitignoreUpdated).toBe(false);
  });

  it("does not create a .gitignore that doesn't already exist", async () => {
    const result = await writeMcpJson(tmpDir, config);
    expect(result.gitignoreUpdated).toBe(false);
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(tmpDir, ".gitignore"))).toBe(false);
  });
});
