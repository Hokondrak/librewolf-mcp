import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type {
  AcceptAuthenticatedPipeResult,
  DiscoveryRecord,
  MessagePipe,
} from '@librewolf-agent-bridge/native-host';
import type { CompanionRpcRequest } from '@librewolf-agent-bridge/browser-core';

import {
  SecureCompanionTransport,
  type SecureCompanionTransportOptions,
} from './companion-transport.js';

const extensionId = 'librewolf-agent-bridge@librewolf-agent-bridge.org';

const discovery = (): DiscoveryRecord => {
  const now = new Date();
  return {
    schemaVersion: 1,
    serverInstanceId: randomUUID(),
    ownerPid: process.pid,
    pipeName: `\\\\.\\pipe\\librewolf-agent-bridge\\${randomBytes(16).toString('hex')}`,
    protocol: { min: '1.0.0', max: '1.0.0' },
    auth: {
      scheme: 'hmac-sha256-v1',
      token: randomBytes(32).toString('base64url'),
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30_000).toISOString(),
  };
};

class ScriptedPipe implements MessagePipe {
  public readonly sent: unknown[] = [];
  private readonly queue: (unknown | null)[] = [];
  private readonly waiters: ((value: unknown | null) => void)[] = [];

  public push(value: unknown | null): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.queue.push(value);
  }

  public async send(message: unknown): Promise<void> {
    this.sent.push(message);
    if (
      typeof message === 'object' &&
      message !== null &&
      'id' in message &&
      typeof message.id === 'string'
    ) {
      this.push({
        jsonrpc: '2.0',
        id: message.id,
        result: { ok: true, result: [{ tabId: 1, active: true }] },
      });
    }
  }

  public async receive(): Promise<unknown | null> {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  public async close(): Promise<void> {
    this.push(null);
  }
}

const setup = (
  helloOverrides: Readonly<Record<string, unknown>> = {},
): {
  options: SecureCompanionTransportOptions;
  pipe: ScriptedPipe;
  published: string[];
  serverClosed: { value: boolean };
} => {
  const record = discovery();
  const pipe = new ScriptedPipe();
  pipe.push({
    jsonrpc: '2.0',
    method: 'extension.hello',
    params: {
      protocolVersion: '1.0.0',
      extensionId,
      extensionVersion: '0.1.0',
      manifestVersion: 3,
      capabilities: { mode: 'companion_extension' },
      ...helloOverrides,
    },
  });
  const published: string[] = [];
  const serverClosed = { value: false };
  const accepted: AcceptAuthenticatedPipeResult = {
    context: {
      connectionId: randomUUID(),
      protocolVersion: '1.0.0',
      serverInstanceId: record.serverInstanceId,
    },
    identity: {
      hostInstanceId: randomUUID(),
      extensionId,
      extensionVersion: '0.1.0',
      manifestVersion: 3,
      hostVersion: '0.1.0',
      browserName: 'LibreWolf',
      browserVersion: '146.0',
    },
    pipe,
  };
  return {
    pipe,
    published,
    serverClosed,
    options: {
      platform: 'win32',
      discoveryPath: 'C:\\safe\\runtime\\discovery-v1.json',
      serverFactory: async () => ({
        discovery: record,
        accept: async () => pipe,
        publishDiscovery: async (path) => {
          published.push(path);
        },
        close: async () => {
          serverClosed.value = true;
        },
      }),
      authenticate: async (_raw, _record, { authorizeIdentity }) => {
        if (!authorizeIdentity(accepted.identity)) {
          throw new Error('identity rejected');
        }
        return accepted;
      },
    },
  };
};

describe('SecureCompanionTransport', () => {
  it('publishes discovery, validates hello, and correlates authenticated responses', async () => {
    const fixture = setup();
    const transport = new SecureCompanionTransport(fixture.options);
    try {
      await expect(transport.connect()).resolves.toMatchObject({
        protocolVersion: '1.0.0',
        security: {
          local: true,
          authenticated: true,
          peerAccessRestricted: true,
          kind: 'named-pipe',
        },
        extensionCapabilities: { mode: 'companion_extension' },
      });
      expect(fixture.published).toEqual(['C:\\safe\\runtime\\discovery-v1.json']);

      const request: CompanionRpcRequest = {
        jsonrpc: '2.0',
        id: 'request-1',
        method: 'extension.execute',
        params: {
          requestId: 'request-1',
          operation: 'tabs.list',
          deadlineAt: new Date(Date.now() + 10_000).toISOString(),
          arguments: {},
        },
      };
      await expect(transport.request(request)).resolves.toMatchObject({
        jsonrpc: '2.0',
        id: 'request-1',
      });
      expect(fixture.pipe.sent).toContainEqual(request);
    } finally {
      await transport.close();
    }
    expect(fixture.serverClosed.value).toBe(true);
  });

  it('rejects a hello that disagrees with the authenticated host identity', async () => {
    const fixture = setup({ extensionVersion: '9.9.9' });
    const transport = new SecureCompanionTransport(fixture.options);
    await expect(transport.connect()).rejects.toMatchObject({
      code: 'BROWSER_TOOL_CONTRACT_MISMATCH',
    });
    await transport.close();
  });

  it('reports the secure local endpoint as unavailable off Windows', () => {
    const transport = new SecureCompanionTransport({ platform: 'linux' });
    expect(transport.capabilities.secureLocalEndpoint).toEqual({
      level: 'unavailable',
      reason: 'secure_named_pipe_is_windows_only',
    });
  });
});
