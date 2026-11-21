import { describe, expect, it } from "vitest";
import {
  encodeNativeMessage,
  MAX_HOST_TO_BROWSER_BYTES,
  NativeMessageDecoder,
  NativeMessageTooLargeError,
} from "../src/nativeMessaging.js";

describe("native-messaging framing", () => {
  it("round-trips a message with a little-endian length prefix", () => {
    const frame = encodeNativeMessage({ type: "hello", n: 1 });
    expect(frame.readUInt32LE(0)).toBe(frame.length - 4);
    expect(new NativeMessageDecoder().push(frame)).toEqual([{ type: "hello", n: 1 }]);
  });

  it("reassembles messages split across chunks, and several in one chunk", () => {
    const a = encodeNativeMessage({ a: "é".repeat(10) }); // multi-byte UTF-8
    const b = encodeNativeMessage({ b: 2 });
    const all = Buffer.concat([a, b]);
    const decoder = new NativeMessageDecoder();
    const out: unknown[] = [];
    for (let i = 0; i < all.length; i += 3) out.push(...decoder.push(all.subarray(i, i + 3)));
    expect(out).toEqual([{ a: "é".repeat(10) }, { b: 2 }]);
  });

  it("refuses to send a message over Firefox's 1 MB host-to-browser limit", () => {
    expect(() => encodeNativeMessage({ x: "a".repeat(MAX_HOST_TO_BROWSER_BYTES) })).toThrow(
      NativeMessageTooLargeError
    );
  });

  it("rejects an oversized incoming length prefix instead of buffering it", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(100, 0);
    expect(() => new NativeMessageDecoder(10).push(header)).toThrow(NativeMessageTooLargeError);
  });
});
