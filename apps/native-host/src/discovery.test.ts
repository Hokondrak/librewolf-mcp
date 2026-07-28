import { describe, expect, it } from 'vitest';

import { DiscoveryError, parseDiscoveryRecord } from './discovery.js';

const now = new Date();

function validRecord(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    serverInstanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ownerPid: 123,
    pipeName: '\\\\.\\pipe\\librewolf-agent-bridge\\user\\random',
    protocol: { min: '1.0.0', max: '1.0.0' },
    auth: { scheme: 'hmac-sha256-v1', token: Buffer.alloc(32, 7).toString('base64url') },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30_000).toISOString(),
  };
}

describe('discovery record validation', () => {
  it('accepts a bounded, versioned authenticated record', () => {
    expect(parseDiscoveryRecord(validRecord())).toMatchObject({
      schemaVersion: 1,
      ownerPid: 123,
      auth: { scheme: 'hmac-sha256-v1' },
    });
  });

  it('rejects pipe namespaces that could target another local service', () => {
    const record = validRecord();
    record['pipeName'] = '\\\\.\\pipe\\unrelated';
    expect(() => parseDiscoveryRecord(record)).toThrowError(
      expect.objectContaining<Partial<DiscoveryError>>({ code: 'DISCOVERY_INVALID' }),
    );
  });

  it('rejects weak tokens and unknown fields', () => {
    const weak = validRecord();
    weak['auth'] = { scheme: 'hmac-sha256-v1', token: 'short' };
    expect(() => parseDiscoveryRecord(weak)).toThrow(/32 random bytes/);

    const ambiguous = validRecord();
    ambiguous['unexpected'] = true;
    expect(() => parseDiscoveryRecord(ambiguous)).toThrow(/Unknown discovery field/);
  });

  it('rejects an inverted protocol range', () => {
    const record = validRecord();
    record['protocol'] = { min: '2.0.0', max: '1.0.0' };
    expect(() => parseDiscoveryRecord(record)).toThrow(/inverted/);
  });
});
