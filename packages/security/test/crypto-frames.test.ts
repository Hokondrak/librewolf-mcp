import { describe, expect, it } from 'vitest';

import type { AuthenticatedFrameBody } from '@librewolf-agent-bridge/protocol';

import {
  FrameVerificationError,
  FrameVerifier,
  constantTimeEqual,
  deriveSessionKey,
  generateNonce,
  generateSessionToken,
  hkdfSha256,
  hmacSha256,
  signAuthenticatedFrame,
} from '../src/index.js';

const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');

describe('cryptographic primitives', () => {
  it('matches RFC 4231 HMAC-SHA-256 test case 1', () => {
    const key = Buffer.alloc(20, 0x0b);
    expect(hex(hmacSha256(key, 'Hi There'))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });

  it('matches RFC 5869 HKDF-SHA-256 test case 1', () => {
    const ikm = Buffer.alloc(22, 0x0b);
    const salt = Buffer.from('000102030405060708090a0b0c', 'hex');
    const info = Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex');
    expect(hex(hkdfSha256(ikm, salt, info, 42))).toBe(
      '3cb25f25faacd57a90434f64d0362f2a' +
        '2d2d0a90cf1a5a4c5db02d56ecc4c5bf' +
        '34007208d5b887185865',
    );
  });

  it('generates high-entropy URL-safe tokens and derives stable session keys', () => {
    const token = generateSessionToken();
    const nonce = generateNonce();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(generateSessionToken()).not.toBe(token);
    expect(deriveSessionKey(token, 'client', 'server')).toEqual(
      deriveSessionKey(token, 'client', 'server'),
    );
    expect(deriveSessionKey(token, 'client', 'server')).not.toEqual(
      deriveSessionKey(token, 'client', 'other-server'),
    );
    expect(constantTimeEqual('same', 'same')).toBe(true);
    expect(constantTimeEqual('same', 'different')).toBe(false);
  });
});

describe('authenticated frames', () => {
  const key = Buffer.from('5f'.repeat(32), 'hex');
  const sessionId = '3d92f007-90e2-4bce-9e2f-75d99c152ce9';
  const now = Date.parse('2026-07-28T10:00:00.000Z');

  const body = (
    sequence: number,
    nonce = `AAECAwQFBgcICQoLDA0O${sequence.toString().padStart(2, '0')}`,
  ): AuthenticatedFrameBody => ({
    protocolVersion: '1.0',
    sessionId,
    sequence,
    timestamp: new Date(now).toISOString(),
    nonce,
    message: {
      jsonrpc: '2.0',
      id: sequence,
      method: 'tabs.list',
    },
  });

  it('signs, validates, and advances strict sequence state', () => {
    const verifier = new FrameVerifier(key, {
      expectedSessionId: sessionId,
      now: () => now,
    });
    const frame0 = signAuthenticatedFrame(body(0), key);
    const frame1 = signAuthenticatedFrame(body(1), key);
    expect(verifier.verify(frame0)).toEqual(frame0);
    expect(verifier.nextSequence).toBe(1);
    expect(verifier.verify(frame1)).toEqual(frame1);
    expect(verifier.nextSequence).toBe(2);
  });

  it('rejects replay without changing verifier state', () => {
    const verifier = new FrameVerifier(key, {
      expectedSessionId: sessionId,
      now: () => now,
    });
    const frame = signAuthenticatedFrame(body(0), key);
    verifier.verify(frame);
    expect(() => verifier.verify(frame)).toThrowError(
      expect.objectContaining({ code: 'REPLAY_DETECTED' }),
    );
    expect(verifier.nextSequence).toBe(1);
  });

  it('rejects gaps, repeated nonces, invalid MACs, sessions, and stale timestamps', () => {
    const verifier = new FrameVerifier(key, {
      expectedSessionId: sessionId,
      now: () => now,
      maxClockSkewMs: 1_000,
    });
    expect(() => verifier.verify(signAuthenticatedFrame(body(1), key))).toThrowError(
      expect.objectContaining({ code: 'SEQUENCE_ERROR', recoverable: true }),
    );

    const valid = signAuthenticatedFrame(body(0), key);
    expect(() => verifier.verify({ ...valid, mac: 'A'.repeat(43) })).toThrowError(
      expect.objectContaining({ code: 'AUTHENTICATION_FAILED' }),
    );
    expect(() =>
      verifier.verify(
        signAuthenticatedFrame(
          { ...body(0), sessionId: '9cc199a5-4553-4a32-b287-608eceb5eb61' },
          key,
        ),
      ),
    ).toThrowError(expect.objectContaining({ code: 'AUTHENTICATION_FAILED' }));

    verifier.verify(valid);
    expect(() => verifier.verify(signAuthenticatedFrame(body(1, valid.nonce), key))).toThrowError(
      expect.objectContaining({ code: 'REPLAY_DETECTED' }),
    );

    const staleVerifier = new FrameVerifier(key, {
      expectedSessionId: sessionId,
      now: () => now + 5_000,
      maxClockSkewMs: 1_000,
    });
    expect(() => staleVerifier.verify(valid)).toThrow(FrameVerificationError);
    expect(() => staleVerifier.verify(valid)).toThrowError(
      expect.objectContaining({ code: 'AUTHENTICATION_FAILED', recoverable: true }),
    );
  });
});
