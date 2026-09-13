import { redactHeaders } from "./redact.js";
import { DEFAULT_RING_BUFFER_OPTIONS, RingBuffer } from "./ringBuffer.js";
import type {
  AllowlistStore,
} from "./allowlist.js";
import type {
  CaptureSettings,
  ConsoleLogEntry,
  NetworkRequestEntry,
  TabSession,
} from "./types.js";

interface TabBuffers {
  console: RingBuffer<ConsoleLogEntry>;
  network: RingBuffer<NetworkRequestEntry>;
}

/** Owns the in-memory `TabSession` map plus each allowed tab's console/network
 * ring buffers. Sessions are rebuilt from scratch on every extension
 * (re)connect — see `resetAll()` — rather than trusted to stay in sync across
 * a WebSocket drop, per the blueprint's "treat the connection as unreliable"
 * state strategy. Buffers can outlive that reset (see `keepBuffers`). */
export class TabRegistry {
  private sessions = new Map<number, TabSession>();
  private buffers = new Map<number, TabBuffers>();
  // Off until the extension says otherwise (in `hello`), matching the
  // extension's own default.
  private capture: CaptureSettings = { consoleLogs: false, networkRequests: false };

  /** Clears every TabSession. With `keepBuffers` (a reconnect from the same
   * browser session, where tab ids are still meaningful), captured logs are
   * kept for tabs the extension re-reports — otherwise every background-page
   * restart in Firefox would silently wipe get_console_logs. Buffers whose
   * tab was never re-reported during the previous connection are dropped
   * here, so a closed tab's buffer lives at most one extra connection. */
  resetAll(options?: { keepBuffers?: boolean }): void {
    if (options?.keepBuffers) {
      for (const tabId of this.buffers.keys()) {
        if (!this.sessions.has(tabId)) this.buffers.delete(tabId);
      }
    } else {
      this.buffers.clear();
    }
    this.sessions.clear();
  }

  getCaptureSettings(): CaptureSettings {
    return { ...this.capture };
  }

  /** Turning a toggle off also discards what was already captured for it —
   * "off" shouldn't keep serving the last five minutes of data. */
  setCaptureSettings(capture: CaptureSettings): void {
    this.capture = { consoleLogs: capture.consoleLogs, networkRequests: capture.networkRequests };
    for (const buf of this.buffers.values()) {
      if (!this.capture.consoleLogs) buf.console.clear();
      if (!this.capture.networkRequests) buf.network.clear();
    }
  }

  /** Re-evaluates a tab against the allow-list and either creates/updates its
   * TabSession, or removes it (and its buffers) if it no longer matches —
   * e.g. the tab navigated away from an allowed origin. */
  applyTabUpdate(
    tabId: number,
    windowId: number,
    url: string,
    title: string,
    allowlistStore: AllowlistStore,
    browserSessionId: string
  ): void {
    const match = allowlistStore.match(url, browserSessionId);
    if (!match) {
      this.remove(tabId);
      return;
    }

    const now = new Date().toISOString();
    const existing = this.sessions.get(tabId);
    this.sessions.set(tabId, {
      tabId,
      windowId,
      url,
      title,
      source: match.source,
      allowlistEntryId: match.allowlistEntryId,
      matchedTrustedPort: match.matchedTrustedPort,
      connectedAt: existing?.connectedAt ?? now,
      lastSeenAt: now,
    });
    if (!this.buffers.has(tabId)) {
      this.buffers.set(tabId, {
        console: new RingBuffer<ConsoleLogEntry>(DEFAULT_RING_BUFFER_OPTIONS),
        network: new RingBuffer<NetworkRequestEntry>(DEFAULT_RING_BUFFER_OPTIONS),
      });
    }
  }

  remove(tabId: number): void {
    this.sessions.delete(tabId);
    this.buffers.delete(tabId);
  }

  get(tabId: number): TabSession | undefined {
    return this.sessions.get(tabId);
  }

  list(): TabSession[] {
    return Array.from(this.sessions.values());
  }

  isAllowed(tabId: number): boolean {
    return this.sessions.has(tabId);
  }

  /** Redaction is applied here, unconditionally, rather than left to the
   * caller — this is the "fixed behavior, no opt-out" guarantee from the
   * blueprint's Security section; there is deliberately no code path that
   * stores a network entry without going through this method. */
  appendNetworkRequest(entry: NetworkRequestEntry): void {
    if (!this.capture.networkRequests) return; // defense in depth — the extension gates this too
    if (!this.isAllowed(entry.tabId)) return; // defense in depth
    const buf = this.buffers.get(entry.tabId);
    if (!buf) return;
    buf.network.push({
      ...entry,
      requestHeaders: redactHeaders(entry.requestHeaders),
      responseHeaders: redactHeaders(entry.responseHeaders),
    });
  }

  appendConsoleLog(entry: ConsoleLogEntry): void {
    if (!this.capture.consoleLogs) return; // defense in depth — the extension gates this too
    if (!this.isAllowed(entry.tabId)) return; // defense in depth
    const buf = this.buffers.get(entry.tabId);
    if (!buf) return;
    buf.console.push(entry);
  }

  getConsoleLogs(
    tabId: number,
    options?: { since?: string; levels?: string[]; limit?: number }
  ): ConsoleLogEntry[] {
    const buf = this.buffers.get(tabId);
    if (!buf) return [];
    const levels = options?.levels?.length ? new Set(options.levels) : undefined;
    return buf.console.list({
      since: options?.since,
      limit: options?.limit,
      filter: levels ? (e) => levels.has(e.level) : undefined,
    });
  }

  getNetworkRequests(
    tabId: number,
    options?: { since?: string; urlFilter?: string; limit?: number }
  ): NetworkRequestEntry[] {
    const buf = this.buffers.get(tabId);
    if (!buf) return [];
    const needle = options?.urlFilter?.toLowerCase();
    return buf.network.list({
      since: options?.since,
      limit: options?.limit,
      filter: needle ? (e) => e.url.toLowerCase().includes(needle) : undefined,
    });
  }
}
