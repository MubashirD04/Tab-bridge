import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.js";
import { runHost, type RunningHost } from "../src/host.js";
import { buildMcpProxy, NOT_CONNECTED_MESSAGE } from "../src/mcpProxy.js";
import { SocketClientTransport } from "../src/socketClient.js";
import { attachToHostStreams, type FakeExtension } from "./helpers/fakeExtension.js";

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const parse = (r: unknown) => {
  const result = r as ToolResult;
  return { isError: result.isError === true, data: JSON.parse(result.content[0]?.text ?? "{}") };
};

// What Claude sees across a session in which Firefox isn't open at first,
// then opens, quits, and opens again — all without restarting the MCP server.
describe("sharepane mcp — stdio proxy in front of the host socket", () => {
  let tmpDir: string;
  let socketPath: string;
  let client: Client;
  const hosts: RunningHost[] = [];

  let lastFake: FakeExtension;
  async function openFirefox(): Promise<RunningHost> {
    const { input, output, fake } = attachToHostStreams();
    lastFake = fake;
    const host = await runHost({ input, output, configDir: tmpDir });
    hosts.push(host);
    await fake.hello("session");
    fake.send({ type: "tab_updated", tabId: 7, windowId: 1, url: "http://127.0.0.1:5500/", title: "Dev" });
    return host;
  }

  async function listTabs() {
    return parse(await client.callTool({ name: "list_allowed_tabs", arguments: {} }));
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "tb-"));
    socketPath = new ConfigStore(tmpDir).socketPath;
    const proxy = buildMcpProxy(socketPath);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await proxy.connect(serverSide);
    client = new Client({ name: "claude-stand-in", version: "0" });
    await client.connect(clientSide);
  });

  afterEach(async () => {
    await client.close();
    for (const host of hosts.splice(0)) await host.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("lists all five tools even while Firefox is closed", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_console_logs",
      "get_network_requests",
      "get_page_content",
      "list_allowed_tabs",
      "screenshot_tab",
    ]);
    const pageContent = tools.find((t) => t.name === "get_page_content")!;
    expect(pageContent.inputSchema.required).toEqual(["mode"]); // tabId defaults to the active shared tab
    expect(pageContent.inputSchema.properties).toHaveProperty("tabId");
  });

  it("answers a tool call with a clear 'open Firefox' error instead of hanging", async () => {
    const result = await listTabs();
    expect(result.isError).toBe(true);
    expect(result.data.error).toEqual({ code: "EXTENSION_DISCONNECTED", message: NOT_CONNECTED_MESSAGE });
  });

  it("picks up Firefox opening, quitting and reopening mid-session", async () => {
    expect((await listTabs()).isError).toBe(true);

    const first = await openFirefox();
    await expect.poll(async () => (await listTabs()).data.tabs?.length).toBe(1);

    await first.close(); // Firefox quits
    await expect.poll(async () => (await listTabs()).isError).toBe(true);

    await openFirefox();
    await expect.poll(async () => (await listTabs()).data.tabs?.[0]?.tabId).toBe(7);
  });

  it("tells the extension which app is connected through the proxy, ignoring doctor/status", async () => {
    await openFirefox();
    const seen: string[][] = [];
    lastFake.on("message", (m: Record<string, unknown>) => {
      if (m.type === "mcp_clients") seen.push(m.clients as string[]);
    });

    // A direct socket client, as `sharepane doctor` makes, isn't Claude.
    const doctor = new Client({ name: "sharepane-doctor", version: "0" });
    await doctor.connect(new SocketClientTransport(socketPath));
    await doctor.listTools();

    await listTabs(); // the proxy connects upstream on first use
    await expect.poll(() => seen.at(-1)).toEqual(["claude-stand-in"]);
    expect(seen.flat()).not.toContain("sharepane-doctor");

    await doctor.close();
  });
});
