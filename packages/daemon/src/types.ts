/**
 * Shared types for the Sharepane daemon.
 *
 * See sharepane-blueprint.md, Section 2 (Data Model & Schema Spec) for the
 * reasoning behind each entity and its retention policy.
 */

/** A manually-granted permission for Claude to read a tab. Session-scoped: valid
 * only for the browser session it was granted in (see `grantedInSession`). */
export interface AllowlistEntry {
  id: string;
  /** e.g. "https://staging.myapp.com" — matched against a tab URL's origin. */
  originPattern: string;
  label: string;
  addedAt: string; // ISO 8601
  /** The extension's browser.storage.session-backed session id at grant time.
   * An entry whose session id doesn't match the extension's *current* session
   * id is treated as expired — this is what "lasts until browser restart"
   * means in practice, since browser.storage.session is cleared by Firefox
   * itself on browser close. */
  grantedInSession: string;
  source: "manual";
}

/** A localhost port treated as pre-approved (e.g. VS Code Live Server). Not
 * session-scoped — persists across restarts until you edit it yourself. */
export interface TrustedDevPort {
  port: number;
  label: string;
  protocol: "http" | "https";
}

export type TabSessionSource = "manual" | "live-server-auto";

/** A currently-open, currently-allowed tab, as the daemon understands it right
 * now. In-memory only — rebuilt from the extension's state each time the
 * host starts rather than persisted, since tabs open and close
 * constantly and a stale copy would just be wrong. */
export interface TabSession {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  source: TabSessionSource;
  allowlistEntryId?: string;
  matchedTrustedPort?: number;
  connectedAt: string;
  lastSeenAt: string;
}

export type ConsoleLevel = "log" | "warn" | "error" | "info" | "debug";

export interface ConsoleLogEntry {
  tabId: number;
  timestamp: string;
  level: ConsoleLevel;
  /** Safely stringified, depth- and size-capped by the content script before
   * it ever leaves the browser. */
  args: string[];
  stackTrace?: string;
  /** Where the entry came from: a console.* call, an uncaught exception, an
   * unhandled promise rejection, or a failed resource load (img/script/css).
   * The last three are always level "error". */
  kind?: "console" | "uncaught" | "unhandledrejection" | "resource";
}

export interface NetworkRequestEntry {
  tabId: number;
  requestId: string;
  timestamp: string;
  method: string;
  url: string;
  type: string; // Firefox's webRequest resource type: "main_frame" | "xmlhttprequest" (XHR and fetch) | "script" | ...
  /** Absent when the request failed before a response (see `error`). */
  statusCode?: number;
  /** Credential header values are already replaced with "[redacted]" by the
   * time this reaches the ring buffer — see redact.ts. This is a fixed,
   * non-configurable default (see blueprint Security). */
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  timingMs?: number;
  /** Firefox's network error string, e.g. "NS_ERROR_CONNECTION_REFUSED" — set
   * for requests that failed (CORS, DNS, refused, blocked) instead of completing. */
  error?: string;
  /** Set on a redirect hop; the follow-up request is its own entry. */
  redirectUrl?: string;
  fromCache?: boolean;
}

/** The extension's opt-in capture toggles (Settings → Capture permissions),
 * mirrored to the daemon so get_console_logs/get_network_requests can say
 * "capture is off" instead of returning an empty list that reads as "no
 * errors / no requests". */
export interface CaptureSettings {
  consoleLogs: boolean;
  networkRequests: boolean;
  /** Firefox only exposes tabs.captureTab once the user grants all-sites
   * access, so screenshots are their own opt-in (Settings → Capture
   * permissions). Mirrors whether that permission is currently granted. */
  screenshots: boolean;
}

// Matches the blueprint's documented error codes (Section 3, API Interface
// Definition) — a request timeout surfaces as CAPTURE_FAILED with a
// distinguishing message rather than inventing a new code. CAPTURE_DISABLED
// was added alongside the opt-in capture permissions.
export type ErrorCode =
  | "TAB_NOT_ALLOWED"
  | "TAB_NOT_FOUND"
  | "EXTENSION_DISCONNECTED"
  | "CAPTURE_FAILED"
  | "CAPTURE_DISABLED"
  | "TAB_REQUIRED";

export class SharepaneError extends Error {
  code: ErrorCode;
  tabId?: number;

  constructor(code: ErrorCode, message: string, tabId?: number) {
    super(message);
    this.name = "SharepaneError";
    this.code = code;
    this.tabId = tabId;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.tabId !== undefined ? { tabId: this.tabId } : {}),
      },
    };
  }
}

// ---- Native-messaging wire protocol (extension <-> host) ----
// Envelope: every message is `{ type: string, ...payload }`, framed as
// described in nativeMessaging.ts. Firefox launches one host process per
// `runtime.connectNative()` port, so there is exactly one connection per
// host and no authentication step: only the extension listed in the host
// manifest's `allowed_extensions` can start it.

export interface HelloMessage {
  type: "hello";
  browserSessionId: string;
  /** Missing is treated as both toggles off. */
  capture?: CaptureSettings;
}

/** Sent whenever the user flips a capture toggle while connected; a later
 * reconnect carries the current values in `hello` instead. */
export interface CaptureSettingsUpdatedMessage {
  type: "capture_settings_updated";
  capture: CaptureSettings;
}

export interface HelloAckMessage {
  type: "hello_ack";
  trustedPorts: TrustedDevPort[];
  /** Origins with a still-valid manual grant in the extension's *current*
   * browser session (already pruned against it — see AllowlistStore.
   * pruneExpired). A manual grant is origin-scoped, not tab-scoped (see
   * AllowlistEntry.originPattern), so the extension uses this the same way
   * it uses trustedPorts: to re-derive which of its currently-open tabs are
   * locally allowed after a reconnect, when its own allowedTabIds mirror
   * came back empty. */
  grantedOrigins: string[];
  /** See McpClientsMessage. */
  mcpClients: string[];
}

/** Which MCP clients (by the name they gave, e.g. "claude-code") are
 * connected through `sharepane mcp` right now. Sent whenever it changes,
 * so the onboarding page can tick "Claude connected" by itself. */
export interface McpClientsMessage {
  type: "mcp_clients";
  clients: string[];
}

export interface TabUpdatedMessage {
  type: "tab_updated";
  tabId: number;
  windowId: number;
  url: string;
  title: string;
}

export interface TabRemovedMessage {
  type: "tab_removed";
  tabId: number;
}

export interface GrantAccessMessage {
  type: "grant_access";
  tabId: number;
  url: string;
  label?: string;
}

export interface RevokeAccessMessage {
  type: "revoke_access";
  tabId: number;
}

/** The tab the user is looking at: the active tab of the last-focused
 * Firefox window (kept while Firefox is in the background, e.g. while the
 * user types to Claude in a terminal). null for private windows and when
 * there's no such tab. Lets tools default to it when no tabId is given. */
export interface ActiveTabMessage {
  type: "active_tab";
  tabId: number | null;
}

/** The user removed the extension's permission for an origin outside the
 * popup (about:addons → Permissions), so its grant must go too. Unlike
 * revoke_access this needs no open tab at that origin. */
export interface RevokeOriginMessage {
  type: "revoke_origin";
  origin: string;
}

export interface ConsoleLogMessage {
  type: "console_log";
  entry: ConsoleLogEntry;
}

export interface NetworkRequestMessage {
  type: "network_request";
  entry: NetworkRequestEntry;
}

export interface GetContentRequestMessage {
  type: "get_content_request";
  requestId: string;
  tabId: number;
  mode: "html" | "text";
}

export interface GetContentResponseMessage {
  type: "get_content_response";
  requestId: string;
  tabId: number;
  content?: string;
  truncated?: boolean;
  error?: string;
}

export interface ScreenshotRequestMessage {
  type: "screenshot_request";
  requestId: string;
  tabId: number;
  format: "png" | "jpeg";
}

export interface ScreenshotResponseMessage {
  type: "screenshot_response";
  requestId: string;
  tabId: number;
  imageBase64?: string;
  width?: number;
  height?: number;
  error?: string;
}

/** Sent from the extension's options page (via the background script) to
 * add/remove/edit trusted dev ports without hand-editing allowlist.json —
 * see config.ts's DEFAULT_TRUSTED_PORTS comment. Replaces the whole list
 * rather than patching one entry, matching how the options page edits it
 * (a rendered table, saved as a whole). */
export interface SetTrustedPortsMessage {
  type: "set_trusted_ports";
  ports: TrustedDevPort[];
}

/** The daemon's reply to `set_trusted_ports` (and, for symmetry, could be
 * sent any time the list changes) carrying the persisted, sanitized list
 * back — the options page renders this rather than trusting its own
 * optimistic copy of what it sent. */
export interface TrustedPortsUpdatedMessage {
  type: "trusted_ports_updated";
  trustedPorts: TrustedDevPort[];
}

export type ExtensionToDaemonMessage =
  | HelloMessage
  | TabUpdatedMessage
  | TabRemovedMessage
  | GrantAccessMessage
  | RevokeAccessMessage
  | RevokeOriginMessage
  | ActiveTabMessage
  | ConsoleLogMessage
  | NetworkRequestMessage
  | GetContentResponseMessage
  | ScreenshotResponseMessage
  | SetTrustedPortsMessage
  | CaptureSettingsUpdatedMessage;

/** Sent just before the host exits on startup failure, so the popup can
 * explain why instead of showing a generic "disconnected". */
export interface HostErrorMessage {
  type: "host_error";
  code: "ANOTHER_INSTANCE" | "STARTUP_FAILED";
  message: string;
}

export type DaemonToExtensionMessage =
  | HostErrorMessage
  | McpClientsMessage
  | HelloAckMessage
  | GetContentRequestMessage
  | ScreenshotRequestMessage
  | TrustedPortsUpdatedMessage;
