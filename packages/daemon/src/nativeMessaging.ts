/**
 * Firefox native-messaging framing: every message is a 4-byte length (in
 * native byte order — little-endian on every platform Firefox ships on)
 * followed by that many bytes of UTF-8 JSON.
 *
 * Limits (from MDN's native-messaging docs):
 *   - host -> browser: 1 MB per message. Only small requests go this way.
 *   - browser -> host: 4 GB per message. Screenshots and page HTML go this
 *     way. We cap it far lower so a bad length prefix can't make us buffer
 *     gigabytes.
 */

export const MAX_HOST_TO_BROWSER_BYTES = 1024 * 1024;
export const MAX_BROWSER_TO_HOST_BYTES = 64 * 1024 * 1024;

export class NativeMessageTooLargeError extends Error {
  constructor(direction: "outgoing" | "incoming", size: number, limit: number) {
    super(`Native message too large (${direction}): ${size} bytes, limit ${limit}.`);
    this.name = "NativeMessageTooLargeError";
  }
}

export function encodeNativeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_HOST_TO_BROWSER_BYTES) {
    throw new NativeMessageTooLargeError("outgoing", body.length, MAX_HOST_TO_BROWSER_BYTES);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Turns an arbitrary chunked byte stream back into whole messages. */
export class NativeMessageDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxMessageBytes: number = MAX_BROWSER_TO_HOST_BYTES) {}

  /** Returns every message completed by this chunk (possibly none). Throws on
   * an oversized length prefix or malformed JSON; the stream can't be
   * resynchronised after either, so the caller should treat that as fatal. */
  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > this.maxMessageBytes) {
        throw new NativeMessageTooLargeError("incoming", length, this.maxMessageBytes);
      }
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(4 + length);
      messages.push(JSON.parse(body));
    }
    return messages;
  }
}
