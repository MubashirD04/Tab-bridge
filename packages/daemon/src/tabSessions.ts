import { redactHeaders } from "./redact.js";
import { DEFAULT_RING_BUFFER_OPTIONS, RingBuffer } from "./ringBuffer.js";
import type {
  AllowlistStore,
} from "./allowlist.js";
import type {
  ConsoleLogEntry,
  NetworkRequestEntry,
  TabSession,
} from "./types.js";

interface TabBuffers {
  console: RingBuffer<ConsoleLogEntry>;
  network: RingBuffer<NetworkRequestEntry>;
}

/** Owns the in-memory `TabSession` map plus each allowed tab's console/network
 * ring buffers. Rebuilt from scratch on every extension (re)connect — see
 * `resetAll()` — rather than trusted to stay in sync across a WebSocket drop,
 * per the blueprint's "treat the connection as unreliable" state strategy. */
export class TabRegistry {
  private sessions = new Map<number, TabSession>();
  private buffers = new Map<number, TabBuffers>();

  resetAll(): void {
    this.sessions.clear();
    this.buffers.clear();
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
    const entries = buf.console.list({ since: options?.since, limit: options?.limit });
    if (options?.levels?.length) {
      const allowed = new Set(options.levels);
      return entries.filter((e) => allowed.has(e.level));
    }
    return entries;
  }

  getNetworkRequests(
    tabId: number,
    options?: { since?: string; urlFilter?: string; limit?: number }
  ): NetworkRequestEntry[] {
    const buf = this.buffers.get(tabId);
    if (!buf) return [];
    const entries = buf.network.list({ since: options?.since, limit: options?.limit });
    if (options?.urlFilter) {
      const needle = options.urlFilter.toLowerCase();
      return entries.filter((e) => e.url.toLowerCase().includes(needle));
    }
    return entries;
  }
}
