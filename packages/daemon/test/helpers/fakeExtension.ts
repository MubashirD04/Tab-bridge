import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ExtensionBridge, ExtensionConnection } from "../../src/extensionBridge.js";
import { encodeNativeMessage, NativeMessageDecoder } from "../../src/nativeMessaging.js";

type Message = Record<string, unknown>;

/** Stands in for the Firefox background script in tests. `send` is what the
 * extension posts to the host; "message" events are what the host posts back. */
export class FakeExtension extends EventEmitter {
  constructor(
    private readonly deliver: (message: Message) => void,
    private readonly onClose: () => void
  ) {
    super();
  }

  send(message: Message): void {
    this.deliver(message);
  }

  nextMessage(): Promise<Message> {
    return new Promise((resolve) => this.once("message", resolve));
  }

  async hello(browserSessionId: string, capture?: { consoleLogs: boolean; networkRequests: boolean; screenshots?: boolean }): Promise<Message> {
    const ack = this.nextMessage();
    this.send({ type: "hello", browserSessionId, capture });
    return ack;
  }

  close(): void {
    this.onClose();
  }
}

/** Connected straight to an ExtensionBridge, no framing involved. */
export function attachToBridge(bridge: ExtensionBridge): FakeExtension {
  let connection: ExtensionConnection;
  const fake: FakeExtension = new FakeExtension(
    (message) => connection.receive(message),
    () => connection.close()
  );
  connection = bridge.connect({ send: (message) => fake.emit("message", message) });
  return fake;
}

/** Connected to a real host through native-messaging-framed streams, the
 * same bytes Firefox would exchange with it. */
export function attachToHostStreams(): { input: PassThrough; output: PassThrough; fake: FakeExtension } {
  const input = new PassThrough(); // extension -> host (host's stdin)
  const output = new PassThrough(); // host -> extension (host's stdout)
  const fake = new FakeExtension(
    (message) => input.write(encodeNativeMessage(message)),
    () => input.end()
  );
  const decoder = new NativeMessageDecoder();
  output.on("data", (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) fake.emit("message", message);
  });
  return { input, output, fake };
}
