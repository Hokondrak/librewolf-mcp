import type { Writable } from 'node:stream';

const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export class NativeMessageFramingError extends Error {
  constructor(
    readonly code:
      | 'FRAME_TOO_LARGE'
      | 'INVALID_FRAME_LENGTH'
      | 'MALFORMED_JSON'
      | 'TRUNCATED_FRAME'
      | 'OUTPUT_CLOSED',
    message: string,
  ) {
    super(message);
    this.name = 'NativeMessageFramingError';
  }
}

export class NativeMessageDecoder {
  #buffer = Buffer.alloc(0);
  #expectedLength: number | undefined;

  constructor(private readonly maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES) {}

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength === 0) return [];
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const messages: unknown[] = [];

    while (true) {
      if (this.#expectedLength === undefined) {
        if (this.#buffer.length < 4) break;
        const length = this.#buffer.readUInt32LE(0);
        this.#buffer = this.#buffer.subarray(4);
        if (length === 0) {
          throw new NativeMessageFramingError(
            'INVALID_FRAME_LENGTH',
            'Native messaging frames cannot be empty.',
          );
        }
        if (length > this.maxMessageBytes) {
          throw new NativeMessageFramingError(
            'FRAME_TOO_LARGE',
            `Native messaging frame exceeds ${this.maxMessageBytes} bytes.`,
          );
        }
        this.#expectedLength = length;
      }

      if (this.#buffer.length < this.#expectedLength) break;
      const body = this.#buffer.subarray(0, this.#expectedLength);
      this.#buffer = this.#buffer.subarray(this.#expectedLength);
      this.#expectedLength = undefined;
      try {
        messages.push(JSON.parse(body.toString('utf8')) as unknown);
      } catch {
        throw new NativeMessageFramingError(
          'MALFORMED_JSON',
          'Native messaging frame contains malformed JSON.',
        );
      }
    }
    return messages;
  }

  finish(): void {
    if (this.#expectedLength !== undefined || this.#buffer.length > 0) {
      throw new NativeMessageFramingError(
        'TRUNCATED_FRAME',
        'Native messaging input ended inside a frame.',
      );
    }
  }
}

export function encodeNativeMessage(
  message: unknown,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length === 0) {
    throw new NativeMessageFramingError(
      'INVALID_FRAME_LENGTH',
      'Message encoded to an empty body.',
    );
  }
  if (body.length > maxMessageBytes) {
    throw new NativeMessageFramingError(
      'FRAME_TOO_LARGE',
      `Native messaging frame exceeds ${maxMessageBytes} bytes.`,
    );
  }
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32LE(body.length, 0);
  return Buffer.concat([prefix, body]);
}

export class NativeMessageWriter {
  #closed = false;

  constructor(
    private readonly output: Writable,
    private readonly maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  ) {}

  async write(message: unknown): Promise<void> {
    if (this.#closed || this.output.destroyed) {
      throw new NativeMessageFramingError('OUTPUT_CLOSED', 'Native messaging stdout is closed.');
    }
    const frame = encodeNativeMessage(message, this.maxMessageBytes);
    await new Promise<void>((resolve, reject) => {
      this.output.write(frame, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  close(): void {
    this.#closed = true;
  }
}

export async function* decodeNativeMessages(
  input: AsyncIterable<Uint8Array | string>,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
): AsyncGenerator<unknown> {
  const decoder = new NativeMessageDecoder(maxMessageBytes);
  for await (const chunk of input) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    for (const message of decoder.push(bytes)) yield message;
  }
  decoder.finish();
}
