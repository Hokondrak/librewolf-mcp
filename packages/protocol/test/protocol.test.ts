import { describe, expect, it } from 'vitest';

import {
  AuthenticatedFrameSchema,
  CapabilitiesSchema,
  DiscoveryRecordSchema,
  HandshakeRequestSchema,
  JsonRpcMessageSchema,
  PermissionDecisionSchema,
  StructuredErrorSchema,
  canonicalJson,
  canonicalJsonBytes,
} from '../src/index.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively and has stable UTF-8 output', () => {
    const input = {
      z: [3, { y: true, a: null }],
      a: '€',
      number: 1e-7,
    };
    const expected = '{"a":"€","number":1e-7,"z":[3,{"a":null,"y":true}]}';
    expect(canonicalJson(input)).toBe(expected);
    expect(canonicalJsonBytes(input)).toEqual(new TextEncoder().encode(expected));
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it.each([
    [Number.NaN, 'finite numbers'],
    [Number.POSITIVE_INFINITY, 'finite numbers'],
    [{ value: undefined }, 'undefined'],
    [[undefined], 'undefined'],
    [Array(1), 'sparse arrays'],
    [new Date(), 'plain objects'],
    ['\ud800', 'lone Unicode'],
  ])('rejects non-canonical input %#', (input, message) => {
    expect(() => canonicalJson(input)).toThrow(message);
  });

  it('rejects cyclic values', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow('cyclic');
  });
});

describe('protocol schemas', () => {
  const sessionId = '3d92f007-90e2-4bce-9e2f-75d99c152ce9';

  it('validates a complete authenticated JSON-RPC frame', () => {
    const frame = {
      protocolVersion: '1.0',
      sessionId,
      sequence: 0,
      timestamp: '2026-07-28T10:00:00.000Z',
      nonce: 'AAECAwQFBgcICQoLDA0ODw',
      message: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tabs.list',
        params: { includePrivate: false },
      },
      mac: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };
    expect(AuthenticatedFrameSchema.parse(frame)).toEqual(frame);
    expect(JsonRpcMessageSchema.safeParse(frame.message).success).toBe(true);
  });

  it('rejects unknown fields and invalid protocol versions', () => {
    expect(
      HandshakeRequestSchema.safeParse({
        protocolVersion: '2.0',
        sessionId,
        clientName: 'test',
        clientNonce: 'AAECAwQFBgcICQoLDA0ODw',
        tokenProof: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it('validates permission decisions and structured recoverable errors', () => {
    expect(
      PermissionDecisionSchema.parse({
        effect: 'allow',
        scope: 'session',
        expiresAt: '2026-07-28T11:00:00.000Z',
      }),
    ).toMatchObject({ effect: 'allow', scope: 'session' });
    expect(
      StructuredErrorSchema.parse({
        code: 'STALE_UID',
        message: 'The page navigated.',
        recoverable: true,
        suggestedAction: 'Take a fresh snapshot.',
      }),
    ).toMatchObject({ code: 'STALE_UID', recoverable: true });
  });

  it('requires reasons for degraded capabilities and unique names', () => {
    expect(
      CapabilitiesSchema.safeParse({
        browserMode: 'companion',
        capabilities: [{ name: 'console', availability: 'degraded' }],
      }).success,
    ).toBe(false);
    expect(
      CapabilitiesSchema.safeParse({
        browserMode: 'controlled',
        capabilities: [
          { name: 'tabs', availability: 'available' },
          { name: 'tabs', availability: 'available' },
        ],
      }).success,
    ).toBe(false);
  });

  it('validates authenticated discovery records and expiry ordering', () => {
    const record = {
      protocolVersion: '1.0',
      sessionId,
      browserMode: 'controlled',
      transport: {
        kind: 'named-pipe',
        endpoint: '\\\\.\\pipe\\librewolf-agent-bridge-test',
      },
      ownerPid: 42,
      createdAt: '2026-07-28T10:00:00.000Z',
      expiresAt: '2026-07-28T10:05:00.000Z',
      tokenId: 'AAECAwQFBgcICQoL',
      authTag: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };
    expect(DiscoveryRecordSchema.parse(record)).toEqual(record);
    expect(
      DiscoveryRecordSchema.safeParse({
        ...record,
        expiresAt: record.createdAt,
      }).success,
    ).toBe(false);
  });
});
