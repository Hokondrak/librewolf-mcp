export const MAX_NATIVE_MESSAGE_BYTES = 8 * 1024 * 1024;
export const NATIVE_MESSAGE_HEADER_BYTES = 4;

export type NativeMessageErrorCode =
  | 'INVALID_LENGTH'
  | 'FRAME_TOO_LARGE'
  | 'INCOMPLETE_FRAME'
  | 'INVALID_UTF8'
  | 'INVALID_JSON'
  | 'TRAILING_BYTES';

export class NativeMessageError extends Error {
  public readonly code: NativeMessageErrorCode;

  public constructor(code: NativeMessageErrorCode, message: string) {
    super(message);
    this.name = 'NativeMessageError';
    this.code = code;
  }
}

const validateMaxBytes = (maxBytes: number): void => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 0xffff_ffff) {
    throw new RangeError('maxBytes must be a positive unsigned 32-bit integer.');
  }
};

const readLength = (frame: Uint8Array): number => {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return view.getUint32(0, true);
};

const parsePayload = (payload: Uint8Array): unknown => {
  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    throw new NativeMessageError('INVALID_UTF8', 'Native message payload is not valid UTF-8.');
  }
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new NativeMessageError('INVALID_JSON', 'Native message payload is not valid JSON.');
  }
};

export const encodeNativeMessage = (
  message: unknown,
  maxBytes = MAX_NATIVE_MESSAGE_BYTES,
): Uint8Array => {
  validateMaxBytes(maxBytes);
  let serialized: string;
  try {
    serialized = JSON.stringify(message);
  } catch (error) {
    throw new NativeMessageError(
      'INVALID_JSON',
      `Native message is not JSON serializable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (serialized === undefined) {
    throw new NativeMessageError('INVALID_JSON', 'Native message must be a JSON value.');
  }
  const payload = new TextEncoder().encode(serialized);
  if (payload.byteLength === 0) {
    throw new NativeMessageError('INVALID_LENGTH', 'Native message payload cannot be empty.');
  }
  if (payload.byteLength > maxBytes) {
    throw new NativeMessageError(
      'FRAME_TOO_LARGE',
      `Native message payload is ${payload.byteLength} bytes; maximum is ${maxBytes}.`,
    );
  }

  const framed = new Uint8Array(NATIVE_MESSAGE_HEADER_BYTES + payload.byteLength);
  new DataView(framed.buffer).setUint32(0, payload.byteLength, true);
  framed.set(payload, NATIVE_MESSAGE_HEADER_BYTES);
  return framed;
};

export const decodeNativeMessage = (
  frame: Uint8Array,
  maxBytes = MAX_NATIVE_MESSAGE_BYTES,
): unknown => {
  validateMaxBytes(maxBytes);
  if (frame.byteLength < NATIVE_MESSAGE_HEADER_BYTES) {
    throw new NativeMessageError('INCOMPLETE_FRAME', 'Native message header is incomplete.');
  }
  const length = readLength(frame);
  if (length === 0) {
    throw new NativeMessageError('INVALID_LENGTH', 'Native message payload cannot be empty.');
  }
  if (length > maxBytes) {
    throw new NativeMessageError(
      'FRAME_TOO_LARGE',
      `Native message declares ${length} bytes; maximum is ${maxBytes}.`,
    );
  }
  const expectedLength = NATIVE_MESSAGE_HEADER_BYTES + length;
  if (frame.byteLength < expectedLength) {
    throw new NativeMessageError('INCOMPLETE_FRAME', 'Native message payload is incomplete.');
  }
  if (frame.byteLength > expectedLength) {
    throw new NativeMessageError(
      'TRAILING_BYTES',
      'Native message contains bytes after its declared payload.',
    );
  }
  return parsePayload(frame.subarray(NATIVE_MESSAGE_HEADER_BYTES));
};

const concatenate = (first: Uint8Array, second: Uint8Array): Uint8Array => {
  if (first.byteLength === 0) {
    return second.slice();
  }
  const combined = new Uint8Array(first.byteLength + second.byteLength);
  combined.set(first);
  combined.set(second, first.byteLength);
  return combined;
};

export class NativeMessageParser {
  readonly #maxBytes: number;
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();

  public constructor(maxBytes = MAX_NATIVE_MESSAGE_BYTES) {
    validateMaxBytes(maxBytes);
    this.#maxBytes = maxBytes;
  }

  public get bufferedBytes(): number {
    return this.#buffer.byteLength;
  }

  public push(chunk: Uint8Array): unknown[] {
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError('Native message parser expects a Uint8Array.');
    }
    this.#buffer = concatenate(this.#buffer, chunk);
    const messages: unknown[] = [];

    while (this.#buffer.byteLength >= NATIVE_MESSAGE_HEADER_BYTES) {
      const length = readLength(this.#buffer);
      if (length === 0) {
        this.reset();
        throw new NativeMessageError('INVALID_LENGTH', 'Native message payload cannot be empty.');
      }
      if (length > this.#maxBytes) {
        this.reset();
        throw new NativeMessageError(
          'FRAME_TOO_LARGE',
          `Native message declares ${length} bytes; maximum is ${this.#maxBytes}.`,
        );
      }
      const frameLength = NATIVE_MESSAGE_HEADER_BYTES + length;
      if (this.#buffer.byteLength < frameLength) {
        break;
      }
      try {
        messages.push(
          parsePayload(this.#buffer.subarray(NATIVE_MESSAGE_HEADER_BYTES, frameLength)),
        );
      } catch (error) {
        this.reset();
        throw error;
      }
      this.#buffer = this.#buffer.slice(frameLength);
    }

    return messages;
  }

  public finish(): void {
    if (this.#buffer.byteLength !== 0) {
      const bufferedBytes = this.#buffer.byteLength;
      this.reset();
      throw new NativeMessageError(
        'INCOMPLETE_FRAME',
        `Native messaging stream ended with ${bufferedBytes} incomplete bytes.`,
      );
    }
  }

  public reset(): void {
    this.#buffer = new Uint8Array();
  }
}
