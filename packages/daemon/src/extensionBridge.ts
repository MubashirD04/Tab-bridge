import { randomUUID } from "node:crypto";
import type { AllowlistStore } from "./allowlist.js";
import type { Logger } from "./logger.js";
import type { TabRegistry } from "./tabSessions.js";
import { SharepaneError } from "./types.js";
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
  return {
    consoleLogs: obj.consoleLogs === true,
    networkRequests: obj.networkRequests === true,
    screenshots: obj.screenshots === true,
  };
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

/** How the bridge sends to the extension. In production this is the native-
 * messaging stdout of the host process (see host.ts); tests pass an
 * in-memory stand-in. */
export interface ExtensionChannel {
  send(message: DaemonToExtensionMessage): void;
}

/** Returned by ExtensionBridge.connect(): the caller feeds it every message
 * read from the extension, and calls close() when the channel ends. */
export interface ExtensionConnection {
  receive(message: unknown): void;
  close(): void;
}

/** The extension-facing half of the host: tracks the extension's tabs and
 * answers its grant/revoke/settings messages, and forwards MCP tool calls
 * that need the live page (content, screenshots) to it.
 *
 * Transport-agnostic on purpose. With native messaging, Firefox launches one
 * host process per extension connection and closes it when the connection
 * ends, so there is no reconnect, no pairing token and no "replaced by a new
 * connection" case to handle any more: the OS process boundary does all of
 * that. The first message on a channel must be `hello`. */
export class ExtensionBridge {
  private channel: ExtensionChannel | undefined;
  private ready = false;
  private browserSessionId: string | undefined;
  private readonly lastKnownTabs = new Map<number, LastKnownTab>();
  private readonly pending = new Map<string, PendingRequest>();
  private mcpClients: string[] = [];

  constructor(
    private readonly allowlistStore: AllowlistStore,
    private readonly tabRegistry: TabRegistry,
    private readonly logger: Logger
  ) {}

  /** Called by the host as MCP clients connect and disconnect. */
  setMcpClients(clients: string[]): void {
    if (JSON.stringify(clients) === JSON.stringify(this.mcpClients)) return;
    this.mcpClients = [...clients];
    if (this.ready) this.send({ type: "mcp_clients", clients: this.mcpClients });
  }

  /** True once the extension's hello has been acknowledged. */
  isConnected(): boolean {
    return this.channel !== undefined && this.ready;
  }

  connect(channel: ExtensionChannel): ExtensionConnection {
    if (this.channel) {
      // One host process serves exactly one extension connection.
      throw new Error("ExtensionBridge already has a connection.");
    }
    this.channel = channel;
    let closed = false;

    return {
      receive: (message: unknown) => {
        if (closed || typeof message !== "object" || message === null) return;
        const msg = message as ExtensionToDaemonMessage;
        if (!this.browserSessionId) {
          if (msg.type === "hello") this.handleHello(msg);
          return; // everything before hello is ignored
        }
        this.handleMessage(msg);
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.channel = undefined;
        this.ready = false;
        // Any in-flight content/screenshot request went down this channel
        // and will never be answered — fail it now rather than making the
        // tool call sit out its full timeout.
        for (const [requestId, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(
            new SharepaneError("EXTENSION_DISCONNECTED", "The extension disconnected before responding.")
          );
          this.pending.delete(requestId);
        }
        void this.logger.log({ event: "extension_disconnected" });
      },
    };
  }

  private handleHello(msg: HelloMessage): void {
    if (typeof msg.browserSessionId !== "string" || !msg.browserSessionId) return;
    this.browserSessionId = msg.browserSessionId;
    this.tabRegistry.resetAll({ keepBuffers: false });
    this.tabRegistry.setCaptureSettings(sanitizeCaptureSettings(msg.capture));
    this.lastKnownTabs.clear();

    void this.allowlistStore.pruneExpired(msg.browserSessionId).then(() => {
      void this.logger.log({ event: "extension_connected", browserSessionId: msg.browserSessionId });
      this.send({
        type: "hello_ack",
        trustedPorts: this.allowlistStore.getTrustedPorts(),
        grantedOrigins: this.allowlistStore.getGrantedOrigins(msg.browserSessionId),
        mcpClients: this.mcpClients,
      });
      this.ready = true;
    });
  }

  private send(message: DaemonToExtensionMessage): void {
    this.channel?.send(message);
  }

  private handleMessage(msg: ExtensionToDaemonMessage): void {
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
      case "active_tab": {
        this.tabRegistry.setActiveTab(typeof msg.tabId === "number" ? msg.tabId : null);
        break;
      }
      case "revoke_origin": {
        if (typeof msg.origin !== "string") break;
        void this.allowlistStore.revokeByOrigin(msg.origin).then(() => {
          // Drops every tab at that origin unless a trusted port still covers it.
          this.reevaluateTabs(() => true);
          void this.logger.log({ event: "origin_revoked" });
        });
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
      pending.reject(new SharepaneError(code, msg.error));
    } else {
      pending.resolve(msg);
    }
  }

  private requireAllowed(tabId: number): void {
    if (!this.tabRegistry.isAllowed(tabId)) {
      throw new SharepaneError("TAB_NOT_ALLOWED", `Tab ${tabId} is not on the allow-list.`, tabId);
    }
    if (!this.isConnected()) {
      throw new SharepaneError(
        "EXTENSION_DISCONNECTED",
        "The Sharepane extension is not connected.",
        tabId
      );
    }
  }

  private awaitResponse<T>(requestId: string, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new SharepaneError("CAPTURE_FAILED", "Timed out waiting for the extension to respond."));
      }, timeoutMs);
      this.pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
  }

  async requestContent(
    tabId: number,
    mode: "html" | "text"
  ): Promise<{ content: string; truncated: boolean }> {
    this.requireAllowed(tabId);
    const requestId = randomUUID();
    // Register before sending: the reply can arrive synchronously.
    const response = this.awaitResponse<{ content: string; truncated: boolean }>(requestId, CONTENT_TIMEOUT_MS);
    this.send({ type: "get_content_request", requestId, tabId, mode });
    return response;
  }

  async requestScreenshot(
    tabId: number,
    format: "png" | "jpeg"
  ): Promise<{ imageBase64: string; width: number; height: number }> {
    this.requireAllowed(tabId);
    const requestId = randomUUID();
    const response = this.awaitResponse<{ imageBase64: string; width: number; height: number }>(
      requestId,
      SCREENSHOT_TIMEOUT_MS
    );
    this.send({ type: "screenshot_request", requestId, tabId, format });
    return response;
  }
}
