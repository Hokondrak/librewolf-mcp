import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadDiscoveryRecord } from './discovery.js';
import { acceptAuthenticatedPipe, openAuthenticatedPipe } from './handshake.js';
import {
  createSecureWindowsPipeServer,
  SecureWindowsPipeConnector,
  type SecureWindowsPipeServer,
} from './secure-windows-pipe.js';
import type { NativeHostIdentity } from './types.js';

const windows = process.platform === 'win32' ? describe : describe.skip;
const servers = new Set<SecureWindowsPipeServer>();

const identity: NativeHostIdentity = {
  extensionId: 'librewolf-agent-bridge@librewolf-agent-bridge.org',
  extensionVersion: '0.1.0',
  manifestVersion: 3,
  hostVersion: '0.1.0',
  browserName: 'LibreWolf',
  browserVersion: 'test',
};

afterEach(async () => {
  await Promise.allSettled([...servers].map((server) => server.close()));
  servers.clear();
});

windows('secure Windows named-pipe transport', () => {
  it('creates a random current-user pipe, publishes private discovery, and round-trips', async () => {
    const rootParent = await mkdtemp(join(tmpdir(), 'librewolf-pipe-'));
    const privateRoot = join(rootParent, 'bridge-private');
    const discoveryPath = join(privateRoot, 'runtime', 'discovery-v1.json');
    const server = await createSecureWindowsPipeServer();
    servers.add(server);
    await server.publishDiscovery(discoveryPath, {
      rootDirectory: privateRoot,
      heartbeatIntervalMs: 1_000,
      ttlMs: 5_000,
    });

    const onDisk = JSON.parse(await readFile(discoveryPath, 'utf8')) as unknown;
    expect(onDisk).toEqual(server.discovery);
    expect(server.discovery.pipeName).toMatch(
      /^\\\\\.\\pipe\\librewolf-agent-bridge\\[0-9a-f]{48}$/u,
    );
    expect(server.discovery.auth.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const loaded = await loadDiscoveryRecord(discoveryPath);
    const connector = new SecureWindowsPipeConnector({ connectTimeoutMs: 5_000 });
    const [serverPipe, clientPipe] = await Promise.all([
      server.accept(),
      connector.connect(loaded),
    ]);
    await clientPipe.send({ jsonrpc: '2.0', id: 1, method: 'test.echo', params: { value: 42 } });
    await expect(serverPipe.receive()).resolves.toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'test.echo',
      params: { value: 42 },
    });
    await serverPipe.send({ jsonrpc: '2.0', id: 1, result: { value: 42 } });
    await expect(clientPipe.receive()).resolves.toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { value: 42 },
    });

    await clientPipe.close();
    await server.close();
    servers.delete(server);
    await expect(readFile(discoveryPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('mutually authenticates and MAC-protects every post-handshake JSON-RPC frame', async () => {
    const server = await createSecureWindowsPipeServer();
    servers.add(server);
    const connector = new SecureWindowsPipeConnector({ verifyDiscoveryFileAcl: false });
    const [serverRaw, clientRaw] = await Promise.all([
      server.accept(),
      connector.connect(server.discovery),
    ]);
    const [accepted, opened] = await Promise.all([
      acceptAuthenticatedPipe(serverRaw, server.discovery, {
        authorizeIdentity: (candidate) => candidate.extensionId === identity.extensionId,
      }),
      openAuthenticatedPipe(clientRaw, server.discovery, identity),
    ]);
    expect(accepted.identity).toMatchObject(identity);
    expect(opened.context).toEqual(accepted.context);

    const request = {
      jsonrpc: '2.0' as const,
      id: 'round-trip',
      method: 'browser.status',
      params: {},
    };
    await opened.pipe.send(request);
    await expect(accepted.pipe.receive()).resolves.toEqual(request);
    const response = {
      jsonrpc: '2.0' as const,
      id: 'round-trip',
      result: { connected: true },
    };
    await accepted.pipe.send(response);
    await expect(opened.pipe.receive()).resolves.toEqual(response);

    await clientRaw.send({
      protocolVersion: '1.0',
      sessionId: server.discovery.serverInstanceId,
      sequence: 1,
      timestamp: new Date().toISOString(),
      nonce: Buffer.alloc(16, 1).toString('base64url'),
      message: request,
      mac: Buffer.alloc(32, 2).toString('base64url'),
    });
    await expect(accepted.pipe.receive()).rejects.toThrow(/MAC is invalid/i);
    await opened.pipe.close();
  });

  it('rejects a pipe whose native server PID differs from discovery', async () => {
    const server = await createSecureWindowsPipeServer();
    servers.add(server);
    const forged = { ...server.discovery, ownerPid: process.pid };
    const connector = new SecureWindowsPipeConnector({
      verifyDiscoveryFileAcl: false,
      connectTimeoutMs: 2_000,
    });
    await expect(connector.connect(forged)).rejects.toThrow(/server PID|closed/i);
  });

  it('rejects a discovery file after an extra principal is added to its DACL', async () => {
    const rootParent = await mkdtemp(join(tmpdir(), 'librewolf-acl-'));
    const privateRoot = join(rootParent, 'bridge-private');
    const discoveryPath = join(privateRoot, 'runtime', 'discovery-v1.json');
    const server = await createSecureWindowsPipeServer();
    servers.add(server);
    await server.publishDiscovery(discoveryPath, {
      rootDirectory: privateRoot,
      heartbeatIntervalMs: 10_000,
      ttlMs: 30_000,
    });

    const grant = spawnSync('icacls.exe', [discoveryPath, '/grant', '*S-1-1-0:(R)'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(grant.status, grant.stderr || grant.stdout).toBe(0);
    const widened = await loadDiscoveryRecord(discoveryPath);
    await expect(
      new SecureWindowsPipeConnector({ connectTimeoutMs: 2_000 }).connect(widened),
    ).rejects.toThrow(/DACL|ACL|closed/i);

    // A secure heartbeat replaces, rather than edits, the widened file and
    // therefore restores the exact protected current-user-only descriptor.
    await server.heartbeat();
    const restored = await loadDiscoveryRecord(discoveryPath);
    const [serverPipe, clientPipe] = await Promise.all([
      server.accept(),
      new SecureWindowsPipeConnector().connect(restored),
    ]);
    await clientPipe.close();
    await serverPipe.close();
  });
});
