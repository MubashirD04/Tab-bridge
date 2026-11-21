import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostStartupError, runHost, type RunningHost } from "../src/host.js";
import { SocketClientTransport } from "../src/socketClient.js";
import { attachToHostStreams, type FakeExtension } from "./helpers/fakeExtension.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(fn: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const value = await fn();
    if (predicate(value)) return value;
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await delay(25);
  }
}

function parseToolJson(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }) {
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  return { data: JSON.parse(text), isError: result.isError === true };
}

const SESSION_ID = "test-browser-session";
const ALLOWED_URL = "http://127.0.0.1:5500/index.html";
const TAB_ID = 1;

// The whole production path minus Firefox itself: a fake extension speaking
// native-messaging framing on the host's stdin/stdout, and a real MCP client
// on the host's Unix socket.
describe("Sharepane — native host + MCP over Unix socket, end to end", () => {
  let tmpDir: string;
  let host: RunningHost;
  let fakeExtension: FakeExtension;
  let client: Client;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "tb-"));
    // No manual grant here on purpose: ALLOWED_URL is on port 5500, one of
    // the default trusted dev ports, so it's allowed via Live-Server
    // auto-approval — exercising that path end-to-end rather than the
    // manual-grant path, which allowlist.test.ts already covers directly.
    const streams = attachToHostStreams();
    fakeExtension = streams.fake;
    host = await runHost({ input: streams.input, output: streams.output, configDir: tmpDir });

    await fakeExtension.hello(SESSION_ID, { consoleLogs: true, networkRequests: true, screenshots: true });

    fakeExtension.on("message", (msg: Record<string, unknown>) => {
      if (msg.type === "get_content_request") {
        fakeExtension.send({
          type: "get_content_response",
          requestId: msg.requestId,
          tabId: msg.tabId,
          content: "<html><body><button class=\"misaligned\">Submit</button></body></html>",
          truncated: false,
        });
      } else if (msg.type === "screenshot_request") {
        fakeExtension.send({
          type: "screenshot_response",
          requestId: msg.requestId,
          tabId: msg.tabId,
          imageBase64: "ZmFrZS1wbmctYnl0ZXM=",
          width: 1280,
          height: 720,
        });
      }
    });

    fakeExtension.send({ type: "tab_updated", tabId: TAB_ID, windowId: 1, url: ALLOWED_URL, title: "Test Page" });

    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(new SocketClientTransport(host.socketPath));

    // Make sure the tab_updated message above has actually been processed
    // before any test body runs, rather than relying on timing.
    await waitFor(
      async () => parseToolJson(await client.callTool({ name: "list_allowed_tabs", arguments: {} }) as never).data,
      (data) => data.tabs?.length === 1
    );
  });

  afterEach(async () => {
    await client.close();
    await host.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates the socket so only this user can reach it", async () => {
    expect((await stat(host.socketPath)).mode & 0o777).toBe(0o600);
    expect((await stat(tmpDir)).mode & 0o777).toBe(0o700);
  });

  it("refuses to start a second host on the same socket, and tells its extension why", async () => {
    const second = attachToHostStreams();
    const told = second.fake.nextMessage();
    await expect(runHost({ input: second.input, output: second.output, configDir: tmpDir })).rejects.toThrow(
      /already serving/
    );
    expect(await told).toMatchObject({ type: "host_error", code: "ANOTHER_INSTANCE" });
  });

  it("tells its extension why, instead of crashing, when the socket path is too long", async () => {
    // macOS allows 103 bytes in a socket path; a deep home folder can exceed it.
    const deepDir = path.join(tmpDir, "x".repeat(120));
    const other = attachToHostStreams();
    const told = other.fake.nextMessage();
    await expect(runHost({ input: other.input, output: other.output, configDir: deepDir })).rejects.toThrow(
      HostStartupError
    );
    expect(await told).toMatchObject({ type: "host_error", code: "STARTUP_FAILED", message: expect.stringMatching(/too long/) });
  });

  it("reports when Firefox closes the connection", async () => {
    fakeExtension.close();
    await host.ended;
  });

  it("the primary journey: list -> get_page_content -> screenshot_tab against a real allowed tab", async () => {
    const list = parseToolJson(await client.callTool({ name: "list_allowed_tabs", arguments: {} }) as never);
    expect(list.data.tabs).toEqual([
      expect.objectContaining({ tabId: TAB_ID, source: "live-server-auto", url: ALLOWED_URL }),
    ]);

    const content = parseToolJson(
      (await client.callTool({
        name: "get_page_content",
        arguments: { tabId: TAB_ID, mode: "html" },
      })) as never
    );
    expect(content.isError).toBe(false);
    expect(content.data.content).toContain("misaligned");

    const screenshotResult = (await client.callTool({
      name: "screenshot_tab",
      arguments: { tabId: TAB_ID },
    })) as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };
    expect(screenshotResult.isError).toBeFalsy();

    // The critical assertion: the image must arrive as its own `type: "image"`
    // content block, not buried as base64 text inside a JSON blob — that's
    // the difference between Claude actually seeing the screenshot and
    // Claude receiving an opaque wall of text (see mcpServer.ts's comment on
    // this exact point, added after this was initially built wrong).
    const imageBlock = screenshotResult.content.find((c) => c.type === "image");
    expect(imageBlock).toBeDefined();
    expect(imageBlock?.data).toBe("ZmFrZS1wbmctYnl0ZXM=");
    expect(imageBlock?.mimeType).toBe("image/png");

    const metadata = parseToolJson(screenshotResult as never);
    expect(metadata.data.width).toBe(1280);
    expect(metadata.data.height).toBe(720);
  });

  it("screenshot_tab returns CAPTURE_DISABLED, without asking the extension, while screenshots are off", async () => {
    fakeExtension.send({ type: "capture_settings_updated", capture: { consoleLogs: true, networkRequests: true, screenshots: false } });
    const result = await waitFor(
      async () => parseToolJson((await client.callTool({ name: "screenshot_tab", arguments: { tabId: TAB_ID } })) as never),
      (r) => r.isError
    );
    expect(result.data.error.code).toBe("CAPTURE_DISABLED");
    expect(result.data.error.message).toMatch(/Allow screenshots/);
  });

  describe("tabId defaults", () => {
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      parseToolJson((await client.callTool({ name, arguments: args })) as never);
    const SECOND_URL = "http://127.0.0.1:5500/other.html";

    it("uses the only shared tab when no tabId is given, and says which tab it used", async () => {
      const result = await call("get_page_content", { mode: "html" });
      expect(result.isError).toBe(false);
      expect(result.data).toMatchObject({ tabId: TAB_ID, title: "Test Page", url: ALLOWED_URL });
    });

    it("prefers the shared tab the user is looking at, and marks it in list_allowed_tabs", async () => {
      fakeExtension.send({ type: "tab_updated", tabId: 2, windowId: 1, url: SECOND_URL, title: "Other" });
      fakeExtension.send({ type: "active_tab", tabId: 2 });
      const used = await waitFor(() => call("get_console_logs"), (r) => r.data.tabId === 2);
      expect(used.data.url).toBe(SECOND_URL);

      const list = await call("list_allowed_tabs");
      expect(list.data.tabs.map((t: { tabId: number; active: boolean }) => [t.tabId, t.active])).toEqual([
        [TAB_ID, false],
        [2, true],
      ]);
    });

    it("asks for a tabId, listing the choices, when several are shared and the active one isn't", async () => {
      fakeExtension.send({ type: "tab_updated", tabId: 2, windowId: 1, url: SECOND_URL, title: "Other" });
      fakeExtension.send({ type: "active_tab", tabId: 99 }); // e.g. an unshared docs page
      const result = await waitFor(() => call("get_network_requests"), (r) => r.isError);
      expect(result.data.error.code).toBe("TAB_REQUIRED");
      expect(result.data.error.message).toContain(`${TAB_ID}: Test Page (${ALLOWED_URL})`);
      expect(result.data.error.message).toContain(`2: Other (${SECOND_URL})`);

      // An explicit tabId still works as before.
      expect((await call("get_network_requests", { tabId: 2 })).data.tabId).toBe(2);
    });

    it("says nothing is shared yet, rather than guessing, when no tab is shared", async () => {
      fakeExtension.send({ type: "tab_removed", tabId: TAB_ID });
      const result = await waitFor(() => call("screenshot_tab"), (r) => r.isError && r.data.error.code === "TAB_NOT_ALLOWED");
      expect(result.data.error.message).toMatch(/No tabs are shared yet/);
    });
  });

  it("returns TAB_NOT_ALLOWED for a tab that was never granted, without ever asking the extension", async () => {
    const result = parseToolJson(
      (await client.callTool({
        name: "get_page_content",
        arguments: { tabId: 999, mode: "html" },
      })) as never
    );
    expect(result.isError).toBe(true);
    expect(result.data.error.code).toBe("TAB_NOT_ALLOWED");
  });

  it("redacts Authorization/Cookie headers in captured network requests before they're ever readable via MCP", async () => {
    fakeExtension.send({
        type: "network_request",
        entry: {
          tabId: TAB_ID,
          requestId: "req-1",
          timestamp: new Date().toISOString(),
          method: "GET",
          url: "http://127.0.0.1:5500/api/data",
          type: "fetch",
          statusCode: 200,
          requestHeaders: { Authorization: "Bearer super-secret", "X-Custom": "keep-me" },
          responseHeaders: { "Set-Cookie": "session=abc123" },
        },
      });

    const result = await waitFor(
      async () =>
        parseToolJson(
          (await client.callTool({ name: "get_network_requests", arguments: { tabId: TAB_ID } })) as never
        ),
      (r) => r.data.entries?.length === 1
    );

    const entry = result.data.entries[0];
    expect(entry.requestHeaders.Authorization).toBe("[redacted]");
    expect(entry.requestHeaders["X-Custom"]).toBe("keep-me");
    expect(entry.responseHeaders["Set-Cookie"]).toBe("[redacted]");
  });

  it("get_console_logs returns captured entries for an allowed tab", async () => {
    fakeExtension.send({
        type: "console_log",
        entry: {
          tabId: TAB_ID,
          timestamp: new Date().toISOString(),
          level: "error",
          args: ["TypeError: cannot read property 'foo' of undefined"],
        },
      });

    const result = await waitFor(
      async () =>
        parseToolJson((await client.callTool({ name: "get_console_logs", arguments: { tabId: TAB_ID } })) as never),
      (r) => r.data.entries?.length === 1
    );

    expect(result.data.entries[0].level).toBe("error");
    expect(result.data.entries[0].args[0]).toContain("TypeError");
  });

  it("returns CAPTURE_DISABLED (not an empty list) once capture is turned off, and drops what was captured", async () => {
    fakeExtension.send({
        type: "console_log",
        entry: { tabId: TAB_ID, timestamp: new Date().toISOString(), level: "log", args: ["before"] },
      });
    await waitFor(
      async () =>
        parseToolJson((await client.callTool({ name: "get_console_logs", arguments: { tabId: TAB_ID } })) as never),
      (r) => r.data.entries?.length === 1
    );

    fakeExtension.send({ type: "capture_settings_updated", capture: { consoleLogs: false, networkRequests: true, screenshots: true } });
    const disabled = await waitFor(
      async () =>
        parseToolJson((await client.callTool({ name: "get_console_logs", arguments: { tabId: TAB_ID } })) as never),
      (r) => r.isError
    );
    expect(disabled.data.error.code).toBe("CAPTURE_DISABLED");

    // Network capture is still on and unaffected.
    const network = parseToolJson(
      (await client.callTool({ name: "get_network_requests", arguments: { tabId: TAB_ID } })) as never
    );
    expect(network.isError).toBe(false);

    fakeExtension.send({ type: "capture_settings_updated", capture: { consoleLogs: true, networkRequests: true, screenshots: true } });
    const reenabled = await waitFor(
      async () =>
        parseToolJson((await client.callTool({ name: "get_console_logs", arguments: { tabId: TAB_ID } })) as never),
      (r) => !r.isError
    );
    expect(reenabled.data.entries).toEqual([]);
  });

  it("applies level filters before limit", async () => {
    const now = Date.now();
    const send = (i: number, level: string) =>
      fakeExtension.send({
          type: "console_log",
          entry: { tabId: TAB_ID, timestamp: new Date(now + i).toISOString(), level, args: [`${level}-${i}`] },
        });
    send(0, "error");
    for (let i = 1; i <= 5; i++) send(i, "log");
    await waitFor(
      async () =>
        parseToolJson((await client.callTool({ name: "get_console_logs", arguments: { tabId: TAB_ID } })) as never),
      (r) => r.data.entries?.length === 6
    );

    const result = parseToolJson(
      (await client.callTool({
        name: "get_console_logs",
        arguments: { tabId: TAB_ID, levels: ["error"], limit: 2 },
      })) as never
    );
    expect(result.data.entries.map((e: { args: string[] }) => e.args[0])).toEqual(["error-0"]);
  });
});
