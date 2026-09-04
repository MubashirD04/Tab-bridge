import { describe, expect, it, vi } from "vitest";
import { RingBuffer } from "../src/ringBuffer.js";

interface Entry {
  timestamp: string;
  value: number;
}

describe("RingBuffer", () => {
  it("evicts the oldest entries once maxCount is exceeded", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2020, 0, 1, 0, 0, 30));

    const buf = new RingBuffer<Entry>({ maxCount: 3, maxAgeMs: 1_000_000 });
    for (let i = 0; i < 5; i++) {
      buf.push({ timestamp: new Date(2020, 0, 1, 0, 0, i).toISOString(), value: i });
    }
    const values = buf.list().map((e) => e.value);
    expect(values).toEqual([2, 3, 4]);
    expect(buf.size).toBe(3);

    vi.useRealTimers();
  });

  it("evicts entries older than maxAgeMs", () => {
    vi.useFakeTimers();
    const now = new Date("2024-01-01T00:10:00.000Z");
    vi.setSystemTime(now);

    const buf = new RingBuffer<Entry>({ maxCount: 100, maxAgeMs: 5 * 60 * 1000 }); // 5 min
    buf.push({ timestamp: "2024-01-01T00:00:00.000Z", value: 1 }); // 10 min ago -> evicted
    buf.push({ timestamp: "2024-01-01T00:06:00.000Z", value: 2 }); // 4 min ago -> kept
    buf.push({ timestamp: "2024-01-01T00:09:59.000Z", value: 3 }); // ~1s ago -> kept

    const values = buf.list().map((e) => e.value);
    expect(values).toEqual([2, 3]);

    vi.useRealTimers();
  });

  it("filters by `since` and caps by `limit` on read", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2020, 0, 1, 0, 0, 30));

    const buf = new RingBuffer<Entry>({ maxCount: 100, maxAgeMs: 1_000_000 });
    for (let i = 0; i < 10; i++) {
      buf.push({ timestamp: new Date(2020, 0, 1, 0, 0, i).toISOString(), value: i });
    }
    const sinceFiltered = buf.list({ since: new Date(2020, 0, 1, 0, 0, 5).toISOString() });
    expect(sinceFiltered.map((e) => e.value)).toEqual([5, 6, 7, 8, 9]);

    const limited = buf.list({ limit: 2 });
    expect(limited.map((e) => e.value)).toEqual([8, 9]);

    vi.useRealTimers();
  });

  it("clear() empties the buffer", () => {
    const buf = new RingBuffer<Entry>({ maxCount: 10, maxAgeMs: 1_000_000 });
    buf.push({ timestamp: new Date().toISOString(), value: 1 });
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.list()).toEqual([]);
  });
});
