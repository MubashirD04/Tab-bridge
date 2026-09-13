/**
 * A bounded, per-tab, in-memory buffer. Stands in for a database
 * index/retention policy (see blueprint Section 2, "Access-pattern notes"):
 * without a cap, a chatty tab (constant console.log spam, a polling XHR)
 * would grow unbounded for as long as the daemon runs.
 *
 * Evicts by count and by age, whichever limit is hit first. In-memory only,
 * by design — see the blueprint's "Log persistence" decision. Nothing here
 * is ever written to disk unless the (separate, opt-in, not-yet-built)
 * recording feature is active for a tab.
 */
export interface TimestampedEntry {
  timestamp: string; // ISO 8601
}

export interface RingBufferOptions {
  maxCount: number;
  maxAgeMs: number;
}

export class RingBuffer<T extends TimestampedEntry> {
  private entries: T[] = [];
  private readonly maxCount: number;
  private readonly maxAgeMs: number;

  constructor(options: RingBufferOptions) {
    this.maxCount = options.maxCount;
    this.maxAgeMs = options.maxAgeMs;
  }

  push(entry: T): void {
    this.entries.push(entry);
    this.evict();
  }

  /** Returns entries, newest last, optionally filtered to those at or after
   * `since` and matching `filter`, then capped to the most recent `limit`.
   * Filtering happens before the cap, so `limit: 10` with a filter means "the
   * last 10 matching entries", not "whichever of the last 10 entries match". */
  list(options?: { since?: string; limit?: number; filter?: (entry: T) => boolean }): T[] {
    this.evict();
    let result = this.entries;
    if (options?.since) {
      const sinceTime = Date.parse(options.since);
      if (!Number.isNaN(sinceTime)) {
        result = result.filter((e) => Date.parse(e.timestamp) >= sinceTime);
      }
    }
    if (options?.filter) {
      result = result.filter(options.filter);
    }
    if (options?.limit !== undefined && result.length > options.limit) {
      result = result.slice(result.length - options.limit);
    }
    return result;
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }

  private evict(): void {
    if (this.entries.length > this.maxCount) {
      this.entries.splice(0, this.entries.length - this.maxCount);
    }
    const cutoff = Date.now() - this.maxAgeMs;
    let firstKeepIndex = 0;
    while (
      firstKeepIndex < this.entries.length &&
      Date.parse(this.entries[firstKeepIndex].timestamp) < cutoff
    ) {
      firstKeepIndex++;
    }
    if (firstKeepIndex > 0) {
      this.entries.splice(0, firstKeepIndex);
    }
  }
}

/** Defaults from the blueprint: "last 500 entries or 5 minutes, whichever is
 * smaller." */
export const DEFAULT_RING_BUFFER_OPTIONS: RingBufferOptions = {
  maxCount: 500,
  maxAgeMs: 5 * 60 * 1000,
};
