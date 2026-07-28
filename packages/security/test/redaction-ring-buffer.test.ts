import { describe, expect, it } from 'vitest';

import {
  REDACTED,
  RingBuffer,
  redactBody,
  redactFormValues,
  redactHeaders,
  redactSecrets,
  redactUrl,
} from '../src/index.js';

describe('secret redaction', () => {
  it('redacts sensitive headers case-insensitively and embedded bearer values', () => {
    expect(
      redactHeaders({
        Authorization: 'Bearer very-secret-token',
        Cookie: 'session=abc',
        'X-Api-Key': 'key',
        Accept: 'application/json',
        'X-Debug': 'Bearer hidden',
      }),
    ).toEqual({
      Authorization: REDACTED,
      Cookie: REDACTED,
      'X-Api-Key': REDACTED,
      Accept: 'application/json',
      'X-Debug': `Bearer ${REDACTED}`,
    });
    expect(redactHeaders([['authorization', 'secret']])).toEqual({
      authorization: REDACTED,
    });
  });

  it('redacts URL credentials and repeated secret query parameters', () => {
    const redacted = new URL(
      redactUrl('https://alice:password@example.com/path?token=one&safe=yes&token=two#visible'),
    );
    expect(decodeURIComponent(redacted.username)).toBe(REDACTED);
    expect(decodeURIComponent(redacted.password)).toBe(REDACTED);
    expect(redacted.searchParams.getAll('token')).toEqual([REDACTED, REDACTED]);
    expect(redacted.searchParams.get('safe')).toBe('yes');
  });

  it('redacts JSON, form-encoded, and plain-text bodies', () => {
    expect(JSON.parse(redactBody('{"username":"max","password":"secret"}') as string)).toEqual({
      username: 'max',
      password: REDACTED,
    });
    const form = new URLSearchParams(
      redactBody('email=max%40example.com&access_token=secret') as string,
    );
    expect(form.get('email')).toBe('max@example.com');
    expect(form.get('access_token')).toBe(REDACTED);
    expect(redactBody('Authorization: Bearer abc.def.ghi')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  it('redacts nested bodies, form values, binaries, and cycles', () => {
    const nested = {
      profile: { name: 'Max', clientSecret: 'hidden' },
      data: new Uint8Array([1, 2, 3]),
    };
    expect(redactSecrets(nested)).toEqual({
      profile: { name: 'Max', clientSecret: REDACTED },
      data: '[REDACTED: 3 binary bytes]',
    });
    expect(
      redactFormValues({ email: 'max@example.com', password: 'hidden', pin: '1234' }, ['pin']),
    ).toEqual({
      email: 'max@example.com',
      password: REDACTED,
      pin: REDACTED,
    });

    const cyclic: Record<string, unknown> = { safe: true };
    cyclic['self'] = cyclic;
    expect(redactSecrets(cyclic)).toEqual({
      safe: true,
      self: '[REDACTED: circular reference]',
    });
  });
});

describe('RingBuffer', () => {
  it('retains only the newest bounded entries in insertion order', () => {
    const buffer = new RingBuffer<number>(3);
    expect(buffer.push(1)).toBeUndefined();
    buffer.push(2);
    buffer.push(3);
    expect(buffer.push(4)).toBe(1);
    expect(buffer.toArray()).toEqual([2, 3, 4]);
    expect([...buffer]).toEqual([2, 3, 4]);
    expect(buffer.size).toBe(3);
    expect(buffer.droppedCount).toBe(1);
  });

  it('supports limited reads, drains, and clear without unbounding counters', () => {
    const buffer = new RingBuffer<string>(2);
    buffer.push('a');
    buffer.push('b');
    expect(buffer.read({ limit: 1 })).toEqual(['b']);
    expect(buffer.read({ clear: true })).toEqual(['a', 'b']);
    expect(buffer.size).toBe(0);
    buffer.push('c');
    expect(buffer.drain()).toEqual(['c']);
    expect(buffer.size).toBe(0);
  });

  it('validates bounds', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
    expect(() => new RingBuffer(1_000_001)).toThrow(RangeError);
    const buffer = new RingBuffer(1);
    expect(() => buffer.read({ limit: -1 })).toThrow(RangeError);
  });

  it('retains undefined when it is a valid entry type', () => {
    const buffer = new RingBuffer<number | undefined>(2);
    buffer.push(undefined);
    buffer.push(1);
    expect(buffer.toArray()).toEqual([undefined, 1]);
  });
});
