import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { AllowlistStore } from "./allowlist.js";
import type { Logger } from "./logger.js";
import type { TabRegistry } from "./tabSessions.js";
import { TabBridgeError } from "./types.js";
import type {
  CaptureSettings,
  DaemonToExtensionMessage,
  ExtensionToDaemonMessage,
  GetContentResponseMessage,
  HelloMessage,
  ScreenshotResponseMessage,
  TrustedDevPort,
} from "./types.js";

const MAX_TRUSTED_PORTS = 50;

/** Never trust the wire message as-is before writing it to allowlist.json —
 * a malformed port/protocol here would otherwise corrupt the file or break
 * Live-Server matching for every tab. Silently drops invalid entries rather
 * than rejecting the whole batch, since this is edited from a form one field
 * at a time, not hand-authored JSON. */
function sanitizeTrustedPorts(raw: unknown): TrustedDevPort[] {
  if (!Array.isArray(raw)) return [];
  const out: TrustedDevPort[] = [];
  for (const entry of raw.slice(0, MAX_TRUSTED_PORTS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { port, label, protocol } = entry as Record<string, unknown>;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (protocol !== "http" && protocol !== "https") continue;
    out.push({ port, protocol, label: typeof label === "string" && label.trim() ? label.trim() : `Port ${port}` });
  }
  return out;
}

function sanitizeCaptureSettings(raw: unknown): CaptureSettings {
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return { consoleLogs: obj.consoleLogs === true, networkRequests: obj.networkRequests === true };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface LastKnownTab {
  windowId: number;
  url: string;
  title: string;
}

const CONTENT_TIMEOUT_MS = 5_000;
const SCREENSHOT_TIMEOUT_MS = 8_000;
// The Firefox extension's fast reconnect path (a setTimeout in its close
// handler, see background.js) typically lands within ~3s of a dropped
// WebSocket, well before its much slower alarm-based backstop (which
// Firefox clamps to a 60s-minimum period) ever needs to fire. Without this
// grace window, a get_page_content/screenshot_tab call made in that ~3s gap
// fails immediately with EXTENSION_DISCONNECTED even though the extension
// was already on its way back — which then races against whatever's
// driving the tool call (e.g. the tab-bridge skill) re-prompting and
// hitting the same brief gap again. Waiting here absorbs that flap
// transparently instead of surfacing it as a hard error.
const RECONNECT_GRACE_MS = 5_000;

/** The extension-facing half of the daemon: a single-connection WebSocket
 * server at `/ext`, token-authed via the first message rather than at the
 * HTTP-upgrade layer. See wire protocol in types.ts and blueprint Section 1
 * (Components) / Section 5 (Security — "pairing token on both channels"). */
export class ExtensionBridge {
  private socket: WebSocket | undefined;
  private browserSessionId: string | undefined;
  private readonly lastKnownTabs = new Map<number, LastKnownTab>();
  private readonly pending = new Map<string, PendingRequest>();
  private connectWaiters: Array<() => void> = [];

  constructor(
    httpServer: HttpServer,
    private readonly wsPath: string,
    private readonly expectedToken: string,
    private readonly allowlistStore: AllowlistStore,
    private readonly tabRegistry: TabRegistry,
    private readonly logger: Logger,
    private readonly reconnectGraceMs: number = RECONNECT_GRACE_MS
  ) {
    const wss = new WebSocketServer({ noServer: true });

    httpServer.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== this.wsPath) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });

    wss.on("connection", (ws: WebSocket) => this.handleConnection(ws));
  }

  isConnected(): boolean {
    return this.socket !== undefined && this.socket.readyState === WebSocket.OPEN;
  }

  private handleConnection(ws: WebSocket): void {
    let authed = false;

    const authTimeout = setTimeout(() => {
      if (!authed) {
        ws.close(4001, "auth timeout");
      }
    }, 5_000);

    ws.once("message", (raw) => {
      let msg: HelloMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.close(4000, "malformed hello");
        return;
      }
      if (msg.type !== "hello" || msg.token !== this.expectedToken) {
        void this.logger.log({ event: "ws_auth_rejected" });
        ws.close(4001, "unauthorized");
        return;
      }

      authed = true;
      clearTimeout(authTimeout);

      // A new authenticated connection replaces whatever was there before —
      // only one extension connection is treated as authoritative at a time.
      if (this.socket && this.socket !== ws) {
        this.socket.close(4002, "replaced by a new connection");
      }
      this.socket = ws;
      // Same browser session → tab ids still refer to the same tabs, so
      // captured logs can survive the reconnect (Firefox restarts the
      // extension's background page often). A new session means a browser
      // restart, where tab ids get reused for unrelated tabs.
      const sameBrowserSession = this.browserSessionId === msg.browserSessionId;
      this.browserSessionId = msg.browserSessionId;
      this.tabRegistry.resetAll({ keepBuffers: sameBrowserSession });
      this.tabRegistry.setCaptureSettings(sanitizeCaptureSettings(msg.capture));
      this.lastKnownTabs.clear();

      void this.allowlistStore.pruneExpired(msg.browserSessionId).then(() => {
        void this.logger.log({ event: "extension_connected", browserSessionId: msg.browserSessionId });
        this.send({
          type: "hello_ack",
          trustedPorts: this.allowlistStore.getTrustedPorts(),
          grantedOrigins: this.allowlistStore.getGrantedOrigins(msg.browserSessionId),
        });
        // Only release requests that were waiting out a reconnect (see
        // waitForConnection) once hello_ack is actually on the wire — a
        // WebSocket preserves per-connection message order, so this
        // guarantees the extension sees hello_ack (and starts its own tab
        // resync, which repopulates its local allow-list mirror) before any
        // queued get_content_request/screenshot_request reaches it. Notifying
        // any earlier risks the request arriving first and being bounced as
        // "tab_closed" simply because the extension hadn't resynced yet.
        const waiters = this.connectWaiters;
        this.connectWaiters = [];
        for (const notify of waiters) notify();
      });

      ws.on("message", (raw2) => this.handleMessage(raw2.toString()));
      ws.on("close", () => {
        if (this.socket === ws) {
          this.socket = undefined;
          // Any in-flight content/screenshot request was sent down this
          // socket and will never be answered — fail it now rather than
          // making the tool call sit out its full timeout.
          for (const [requestId, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(
              new TabBridgeError("EXTENSION_DISCONNECTED", "The extension disconnected before responding.")
            );
            this.pending.delete(requestId);
          }
        }
        void this.logger.log({ event: "extension_disconnected" });
      });
      ws.on("error", (err) => {
        void this.logger.log({ event: "extension_ws_error", message: (err as Error).message });
      });
    });
  }

  private send(message: DaemonToExtensionMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  private handleMessage(raw: string): void {
    let msg: ExtensionToDaemonMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!this.browserSessionId) return;

    switch (msg.type) {
      case "tab_updated": {
        this.lastKnownTabs.set(msg.tabId, { windowId: msg.windowId, url: msg.url, title: msg.title });
        this.tabRegistry.applyTabUpdate(
          msg.tabId,
          msg.windowId,
          msg.url,
          msg.title,
          this.allowlistStore,
          this.browserSessionId
        );
        break;
      }
      case "tab_removed": {
        this.lastKnownTabs.delete(msg.tabId);
        this.tabRegistry.remove(msg.tabId);
        break;
      }
      case "grant_access": {
        void this.allowlistStore.grant(msg.url, this.browserSessionId, msg.label).then(() => {
          const known = this.lastKnownTabs.get(msg.tabId);
          this.tabRegistry.applyTabUpdate(
            msg.tabId,
            known?.windowId ?? 0,
            msg.url,
            known?.title ?? msg.url,
            this.allowlistStore,
            this.browserSessionId!
          );
          void this.logger.log({ event: "tab_allowed", tabId: msg.tabId });
        });
        break;
      }
      case "revoke_access": {
        const known = this.lastKnownTabs.get(msg.tabId);
        this.tabRegistry.remove(msg.tabId);
        if (known) {
          // A grant is origin-scoped, so revoking it has to drop every other
          // open tab at that origin too — not just the one clicked. Tabs that
          // still match some other way (a trusted port) are kept.
          void this.allowlistStore.revokeByOrigin(known.url).then(() => {
            this.reevaluateTabs((tabId) => tabId !== msg.tabId && this.tabRegistry.isAllowed(tabId));
          });
        }
        void this.logger.log({ event: "tab_revoked", tabId: msg.tabId });
        break;
      }
      case "console_log": {
        this.tabRegistry.appendConsoleLog(msg.entry);
        break;
      }
      case "network_request": {
        this.tabRegistry.appendNetworkRequest(msg.entry);
        break;
      }
      case "get_content_response":
      case "screenshot_response": {
        this.resolvePending(msg);
        break;
      }
      case "set_trusted_ports": {
        const sanitized = sanitizeTrustedPorts(msg.ports);
        void this.allowlistStore.setTrustedPorts(sanitized).then(() => {
          // Apply the new list to already-open tabs: a removed port stops
          // being readable now, an added one starts without a reload.
          this.reevaluateTabs(() => true);
          void this.logger.log({ event: "trusted_ports_updated", count: sanitized.length });
          this.send({ type: "trusted_ports_updated", trustedPorts: this.allowlistStore.getTrustedPorts() });
        });
        break;
      }
      case "capture_settings_updated": {
        this.tabRegistry.setCaptureSettings(sanitizeCaptureSettings(msg.capture));
        void this.logger.log({ event: "capture_settings_updated", ...this.tabRegistry.getCaptureSettings() });
        break;
      }
    }
  }

  /** Re-runs allow-list matching for last-known tabs selected by `which`. */
  private reevaluateTabs(which: (tabId: number) => boolean): void {
    if (!this.browserSessionId) return;
    for (const [tabId, tab] of this.lastKnownTabs) {
      if (!which(tabId)) continue;
      this.tabRegistry.applyTabUpdate(
        tabId,
        tab.windowId,
        tab.url,
        tab.title,
        this.allowlistStore,
        this.browserSessionId
      );
    }
  }

  private resolvePending(msg: GetContentResponseMessage | ScreenshotResponseMessage): void {
    const pending = this.pending.get(msg.requestId);
    if (!pending) return;
    this.pending.delete(msg.requestId);
    clearTimeout(pending.timer);
    if (msg.error) {
      const code = msg.error === "tab_closed" ? "TAB_NOT_FOUND" : "CAPTURE_FAILED";
      pending.reject(new TabBridgeError(code, msg.error));
    } else {
      pending.resolve(msg);
    }
  }

  /** Resolves once connected, or after graceMs elapses — whichever comes
   * first. Doesn't reject on timeout; the caller decides what a still-not-
   * connected result means. */
  private waitForConnection(graceMs: number): Promise<void> {
    if (this.isConnected() || graceMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.connectWaiters = this.connectWaiters.filter((w) => w !== notify);
        resolve();
      }, graceMs);
      const notify = () => {
        clearTimeout(timer);
        resolve();
      };
      this.connectWaiters.push(notify);
    });
  }

  private async requireAllowed(tabId: number): Promise<void> {
    if (!this.tabRegistry.isAllowed(tabId)) {
      throw new TabBridgeError("TAB_NOT_ALLOWED", `Tab ${tabId} is not on the allow-list.`, tabId);
    }
    if (!this.isConnected()) {
      await this.waitForConnection(this.reconnectGraceMs);
    }
    if (!this.isConnected()) {
      throw new TabBridgeError(
        "EXTENSION_DISCONNECTED",
        "The Tab Bridge extension is not currently connected to the daemon.",
        tabId
      );
    }
  }

  private awaitResponse<T>(requestId: string, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new TabBridgeError("CAPTURE_FAILED", "Timed out waiting for the extension to respond."));
      }, timeoutMs);
      this.pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
  }

  async requestContent(
    tabId: number,
    mode: "html" | "text"
  ): Promise<{ content: string; truncated: boolean }> {
    await this.requireAllowed(tabId);
    const requestId = randomUUID();
    this.send({ type: "get_content_request", requestId, tabId, mode });
    const result = await this.awaitResponse<{ content: string; truncated: boolean }>(
      requestId,
      CONTENT_TIMEOUT_MS
    );
    return result;
  }

  async requestScreenshot(
    tabId: number,
    format: "png" | "jpeg"
  ): Promise<{ imageBase64: string; width: number; height: number }> {
    await this.requireAllowed(tabId);
    const requestId = randomUUID();
    this.send({ type: "screenshot_request", requestId, tabId, format });
    const result = await this.awaitResponse<{
      imageBase64: string;
      width: number;
      height: number;
    }>(requestId, SCREENSHOT_TIMEOUT_MS);
    return result;
  }
}
