import { describe, expect, it } from 'vitest';

import { encodeNativeMessage, NativeMessageDecoder, NativeMessageFramingError } from './framing.js';

describe('native messaging framing', () => {
  it('decodes fragmented and coalesced frames', () => {
    const first = encodeNativeMessage({ one: 1 });
    const second = encodeNativeMessage({ two: 2 });
    const bytes = Buffer.concat([first, second]);
    const decoder = new NativeMessageDecoder();

    expect(decoder.push(bytes.subarray(0, 2))).toEqual([]);
    expect(decoder.push(bytes.subarray(2, first.length + 3))).toEqual([{ one: 1 }]);
    expect(decoder.push(bytes.subarray(first.length + 3))).toEqual([{ two: 2 }]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it('rejects oversized frames before allocating their bodies', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(1025, 0);
    const decoder = new NativeMessageDecoder(1024);
    expect(() => decoder.push(header)).toThrowError(
      expect.objectContaining<Partial<NativeMessageFramingError>>({ code: 'FRAME_TOO_LARGE' }),
    );
  });

  it('reports graceful EOF only at a frame boundary', () => {
    const frame = encodeNativeMessage({ ok: true });
    const decoder = new NativeMessageDecoder();
    decoder.push(frame.subarray(0, 6));
    expect(() => decoder.finish()).toThrowError(
      expect.objectContaining<Partial<NativeMessageFramingError>>({ code: 'TRUNCATED_FRAME' }),
    );
  });

  it('rejects malformed JSON', () => {
    const body = Buffer.from('{nope', 'utf8');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(body.length, 0);
    const decoder = new NativeMessageDecoder();
    expect(() => decoder.push(Buffer.concat([prefix, body]))).toThrowError(
      expect.objectContaining<Partial<NativeMessageFramingError>>({ code: 'MALFORMED_JSON' }),
    );
  });
});
