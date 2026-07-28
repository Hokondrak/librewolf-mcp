import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { NativeMessageDecoder } from './framing.js';
import { NativeHostRuntime } from './runtime.js';
import { UnavailableSecureWindowsPipeConnector } from './unavailable-pipe.js';
import type { DiscoveryRecord } from './types.js';

const record: DiscoveryRecord = {
  schemaVersion: 1,
  serverInstanceId: 'server-a',
  ownerPid: 10,
  pipeName: '\\\\.\\pipe\\librewolf-agent-bridge\\user\\random',
  protocol: { min: '1.0.0', max: '1.0.0' },
  auth: {
    scheme: 'hmac-sha256-v1',
    token: Buffer.alloc(32, 5).toString('base64url'),
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 30_000).toISOString(),
};

describe('native host runtime', () => {
  it('explicitly reports secure named-pipe ACL support as unavailable', async () => {
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    const runtime = new NativeHostRuntime({
      input: emptyInput(),
      output,
      loadDiscovery: async () => record,
      connector: new UnavailableSecureWindowsPipeConnector(),
      identity: {
        extensionId: 'librewolf-agent-bridge@librewolf-agent-bridge.org',
        extensionVersion: '0.1.0',
        manifestVersion: 3,
        hostVersion: '0.1.0',
        browserName: 'LibreWolf',
        browserVersion: 'test',
      },
    });

    await runtime.run();
    const messages = new NativeMessageDecoder().push(Buffer.concat(chunks));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      method: 'host.status',
      params: {
        connected: false,
        reason: 'native_windows_acl_component_not_installed',
        capabilities: {
          secureNamedPipeAcl: {
            level: 'unavailable',
            reason: 'native_windows_acl_component_not_installed',
          },
        },
      },
    });
  });
});

async function* emptyInput(): AsyncGenerator<Uint8Array> {
  return;
}
