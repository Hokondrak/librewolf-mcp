import { describe, expect, it } from 'vitest';

import { authenticatePipe, serverProof } from './handshake.js';
import type { DiscoveryRecord, MessagePipe, NativeHostIdentity } from './types.js';

const token = Buffer.alloc(32, 9).toString('base64url');
const serverNonce = Buffer.alloc(32, 8).toString('base64url');
const clientNonce = Buffer.alloc(32, 7).toString('base64url');
const serverInstanceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const connectionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const discovery: DiscoveryRecord = {
  schemaVersion: 1,
  serverInstanceId,
  ownerPid: 10,
  pipeName: '\\\\.\\pipe\\librewolf-agent-bridge\\user\\random',
  protocol: { min: '1.0.0', max: '1.0.0' },
  auth: { scheme: 'hmac-sha256-v1', token },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 30_000).toISOString(),
};

const identity: NativeHostIdentity = {
  extensionId: 'librewolf-agent-bridge@librewolf-agent-bridge.org',
  extensionVersion: '0.1.0',
  manifestVersion: 3,
  hostVersion: '0.1.0',
  browserName: 'LibreWolf',
  browserVersion: 'test',
};

class HandshakePipe implements MessagePipe {
  readonly sent: unknown[] = [];
  #step = 0;

  async send(message: unknown): Promise<void> {
    this.sent.push(message);
  }

  async receive(): Promise<unknown> {
    this.#step += 1;
    if (this.#step === 1) {
      return {
        jsonrpc: '2.0',
        method: 'bridge.challenge',
        params: {
          serverInstanceId,
          serverNonce,
          supportedVersions: ['1.0.0'],
        },
      };
    }
    return {
      jsonrpc: '2.0',
      method: 'bridge.ready',
      params: {
        selectedProtocolVersion: '1.0.0',
        connectionId,
        proof: serverProof(
          token,
          serverInstanceId,
          serverNonce,
          clientNonce,
          connectionId,
          '1.0.0',
        ),
      },
    };
  }

  async close(): Promise<void> {}
}

describe('authenticated pipe handshake', () => {
  it('negotiates a version and verifies mutual HMAC proof', async () => {
    const pipe = new HandshakePipe();
    await expect(authenticatePipe(pipe, discovery, identity, () => clientNonce)).resolves.toEqual({
      connectionId,
      protocolVersion: '1.0.0',
      serverInstanceId,
    });
    expect(pipe.sent[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'bridge.hello',
      params: {
        serverInstanceId,
        selectedProtocolVersion: '1.0.0',
      },
    });
  });

  it('rejects a forged server proof', async () => {
    class ForgedPipe extends HandshakePipe {
      override async receive(): Promise<unknown> {
        const value = await super.receive();
        if (
          typeof value === 'object' &&
          value !== null &&
          (value as Record<string, unknown>)['method'] === 'bridge.ready'
        ) {
          const root = value as { params: Record<string, unknown> };
          root.params['proof'] = Buffer.alloc(32, 1).toString('base64url');
        }
        return value;
      }
    }
    await expect(
      authenticatePipe(new ForgedPipe(), discovery, identity, () => clientNonce),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });
});
