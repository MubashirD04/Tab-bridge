import { randomUUID } from "node:crypto";
import type { ConfigStore } from "./config.js";
import type { AllowlistEntry, TrustedDevPort } from "./types.js";

export interface MatchResult {
  source: "manual" | "live-server-auto";
  allowlistEntryId?: string;
  matchedTrustedPort?: number;
}

function originOf(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return undefined;
  }
}

/** Owns the allow-list and trusted-port list, and the matching logic that
 * decides whether a tab URL is currently allowed. This is the single most
 * safety-critical module in the daemon (blueprint Section 9, Testing
 * Strategy): a bug here means either "Claude can't see a tab it should"
 * (annoying) or "Claude can see a tab it shouldn't" (the actual risk). */
export class AllowlistStore {
  private entries: AllowlistEntry[] = [];
  private trustedPorts: TrustedDevPort[] = [];
  private loaded = false;

  constructor(private readonly configStore: ConfigStore) {}

  async load(): Promise<void> {
    const file = await this.configStore.loadAllowlistFile();
    this.entries = file.entries;
    this.trustedPorts = file.trustedPorts;
    this.loaded = true;
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error("AllowlistStore.load() must be called before use");
    }
  }

  private async persist(): Promise<void> {
    await this.configStore.saveAllowlistFile({
      entries: this.entries,
      trustedPorts: this.trustedPorts,
    });
  }

  getTrustedPorts(): TrustedDevPort[] {
    this.assertLoaded();
    return [...this.trustedPorts];
  }

  /** Origins with a currently-valid manual grant in this browser session —
   * call after pruneExpired() so an entry from a previous session is never
   * included. Used to hand hello_ack a list the extension can use to
   * re-derive its local allowedTabIds mirror after a reconnect (see
   * HelloAckMessage.grantedOrigins). */
  getGrantedOrigins(currentBrowserSessionId: string): string[] {
    this.assertLoaded();
    return this.entries.filter((e) => e.grantedInSession === currentBrowserSessionId).map((e) => e.originPattern);
  }

  async setTrustedPorts(ports: TrustedDevPort[]): Promise<void> {
    this.assertLoaded();
    this.trustedPorts = ports;
    await this.persist();
  }

  /** Drops any manual grant that wasn't granted in the extension's current
   * browser session — this *is* "a grant lasts until browser restart" in
   * practice, since the extension's browserSessionId itself comes from
   * browser.storage.session, which Firefox clears on browser close. Called
   * whenever the extension (re)connects and reports its current session id. */
  async pruneExpired(currentBrowserSessionId: string): Promise<void> {
    this.assertLoaded();
    const before = this.entries.length;
    this.entries = this.entries.filter(
      (e) => e.grantedInSession === currentBrowserSessionId
    );
    if (this.entries.length !== before) {
      await this.persist();
    }
  }

  async grant(
    url: string,
    browserSessionId: string,
    label?: string
  ): Promise<AllowlistEntry | undefined> {
    this.assertLoaded();
    const origin = originOf(url);
    if (!origin) return undefined;

    // Re-granting the same origin in the same session just refreshes it,
    // rather than accumulating duplicate entries.
    const existing = this.entries.find(
      (e) => e.originPattern === origin && e.grantedInSession === browserSessionId
    );
    if (existing) return existing;

    const entry: AllowlistEntry = {
      id: randomUUID(),
      originPattern: origin,
      label: label ?? origin,
      addedAt: new Date().toISOString(),
      grantedInSession: browserSessionId,
      source: "manual",
    };
    this.entries.push(entry);
    await this.persist();
    return entry;
  }

  async revokeByOrigin(url: string): Promise<void> {
    this.assertLoaded();
    const origin = originOf(url);
    if (!origin) return;
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.originPattern !== origin);
    if (this.entries.length !== before) {
      await this.persist();
    }
  }

  /** Manual grants take precedence over Live-Server auto-approval when a URL
   * happens to match both (blueprint Section 2: "auto-approval and manual
   * grant are mutually exclusive per session, manual takes precedence"). */
  match(url: string, currentBrowserSessionId: string): MatchResult | undefined {
    this.assertLoaded();
    const origin = originOf(url);
    if (!origin) return undefined;

    const manual = this.entries.find(
      (e) => e.originPattern === origin && e.grantedInSession === currentBrowserSessionId
    );
    if (manual) {
      return { source: "manual", allowlistEntryId: manual.id };
    }

    const trustedPort = this.matchTrustedPort(url);
    if (trustedPort) {
      return { source: "live-server-auto", matchedTrustedPort: trustedPort.port };
    }

    return undefined;
  }

  /** Host-scoped on purpose: only ever matches an actual 127.0.0.1/localhost
   * origin, never anything a remote page could claim (blueprint Security:
   * "the match is on the actual origin the browser resolved, not on
   * anything the page can control"). */
  private matchTrustedPort(url: string): TrustedDevPort | undefined {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    const isLocalHost = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    if (!isLocalHost) return undefined;

    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    const protocol = parsed.protocol === "https:" ? "https" : "http";
    return this.trustedPorts.find((p) => p.port === port && p.protocol === protocol);
  }
}
