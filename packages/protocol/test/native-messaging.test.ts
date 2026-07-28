import { describe, expect, it } from 'vitest';

import {
  NativeMessageError,
  NativeMessageParser,
  decodeNativeMessage,
  encodeNativeMessage,
} from '../src/index.js';

describe('native messaging framing', () => {
  it('uses a four-byte little-endian length header', () => {
    const frame = encodeNativeMessage({ x: 1 });
    expect([...frame.subarray(0, 4)]).toEqual([7, 0, 0, 0]);
    expect(new TextDecoder().decode(frame.subarray(4))).toBe('{"x":1}');
    expect(decodeNativeMessage(frame)).toEqual({ x: 1 });
  });

  it('parses fragmented and coalesced messages incrementally', () => {
    const first = encodeNativeMessage({ first: true });
    const second = encodeNativeMessage(['second']);
    const parser = new NativeMessageParser();

    expect(parser.push(first.subarray(0, 2))).toEqual([]);
    expect(parser.bufferedBytes).toBe(2);
    const combined = new Uint8Array(first.byteLength - 2 + second.byteLength);
    combined.set(first.subarray(2));
    combined.set(second, first.byteLength - 2);
    expect(parser.push(combined)).toEqual([{ first: true }, ['second']]);
    expect(parser.bufferedBytes).toBe(0);
    expect(() => parser.finish()).not.toThrow();
  });

  it('enforces the configured byte cap for encoding and parsing', () => {
    expect(() => encodeNativeMessage('12345', 4)).toThrowError(
      expect.objectContaining({ code: 'FRAME_TOO_LARGE' }),
    );
    const oversizedHeader = new Uint8Array([5, 0, 0, 0]);
    const parser = new NativeMessageParser(4);
    expect(() => parser.push(oversizedHeader)).toThrowError(
      expect.objectContaining({ code: 'FRAME_TOO_LARGE' }),
    );
    expect(parser.bufferedBytes).toBe(0);
  });

  it.each([
    [new Uint8Array([0, 0, 0, 0]), 'INVALID_LENGTH'],
    [new Uint8Array([1, 0, 0, 0, 0xff]), 'INVALID_UTF8'],
    [new Uint8Array([1, 0, 0, 0, 0x7b]), 'INVALID_JSON'],
  ])('rejects malformed frame %#', (frame, code) => {
    expect(() => decodeNativeMessage(frame)).toThrowError(expect.objectContaining({ code }));
  });

  it('resets parser state after malformed payloads', () => {
    const parser = new NativeMessageParser();
    expect(() => parser.push(new Uint8Array([1, 0, 0, 0, 0x7b]))).toThrowError(
      expect.objectContaining({ code: 'INVALID_JSON' }),
    );
    expect(parser.bufferedBytes).toBe(0);
    expect(parser.push(encodeNativeMessage({ recovered: true }))).toEqual([{ recovered: true }]);
  });

  it('rejects incomplete frames and trailing bytes', () => {
    const complete = encodeNativeMessage({ ok: true });
    expect(() => decodeNativeMessage(complete.subarray(0, -1))).toThrowError(
      expect.objectContaining({ code: 'INCOMPLETE_FRAME' }),
    );
    const trailing = new Uint8Array(complete.byteLength + 1);
    trailing.set(complete);
    expect(() => decodeNativeMessage(trailing)).toThrowError(
      expect.objectContaining({ code: 'TRAILING_BYTES' }),
    );

    const parser = new NativeMessageParser();
    parser.push(complete.subarray(0, -1));
    expect(() => parser.finish()).toThrowError(
      expect.objectContaining({ code: 'INCOMPLETE_FRAME' }),
    );
    expect(parser.bufferedBytes).toBe(0);
  });

  it('rejects non-JSON-serializable top-level values', () => {
    expect(() => encodeNativeMessage(undefined)).toThrow(NativeMessageError);
    expect(() => encodeNativeMessage(1n)).toThrow(NativeMessageError);
  });
});
