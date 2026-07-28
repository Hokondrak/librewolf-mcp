import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DedicatedProfileManager,
  ProfileInUseError,
  UPSTREAM_PROFILE_DIRECTORY_NAME,
  UnsafeProfilePathError,
} from '../src/index.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'librewolf-profile-test-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('DedicatedProfileManager', () => {
  it('models the upstream nested profile and preserves it on normal release', async () => {
    const root = await temporaryRoot();
    const manager = new DedicatedProfileManager({
      rootDirectory: root,
      ownerIdFactory: () => 'owner-1',
    });
    const lease = await manager.acquire('default', { pid: 123 });

    expect(lease.upstreamProfilePath).toBe(lease.parentDirectory);
    expect(lease.effectiveDirectory).toBe(
      join(lease.parentDirectory, UPSTREAM_PROFILE_DIRECTORY_NAME),
    );
    await fs.writeFile(join(lease.effectiveDirectory, 'state.txt'), 'persistent', 'utf8');
    await lease.release();

    await expect(fs.readFile(join(lease.effectiveDirectory, 'state.txt'), 'utf8')).resolves.toBe(
      'persistent',
    );
  });

  it('rejects a second live owner and exposes its metadata', async () => {
    const root = await temporaryRoot();
    const processInspector = { isAlive: (pid: number) => pid === 111 };
    const first = await new DedicatedProfileManager({
      rootDirectory: root,
      processInspector,
      ownerIdFactory: () => 'first',
    }).acquire('default', { pid: 111 });

    const failure = await new DedicatedProfileManager({
      rootDirectory: root,
      processInspector,
      ownerIdFactory: () => 'second',
    })
      .acquire('default', { pid: 222 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProfileInUseError);
    expect((failure as ProfileInUseError).owner?.pid).toBe(111);
    await first.release();
  });

  it('recovers lock metadata from a crashed owner without deleting profile state', async () => {
    const root = await temporaryRoot();
    const crashed = await new DedicatedProfileManager({
      rootDirectory: root,
      processInspector: { isAlive: () => false },
      ownerIdFactory: () => 'crashed',
    }).acquire('default', { pid: 111 });
    await fs.writeFile(join(crashed.effectiveDirectory, 'state.txt'), 'keep', 'utf8');

    const recovered = await new DedicatedProfileManager({
      rootDirectory: root,
      processInspector: { isAlive: () => false },
      ownerIdFactory: () => 'recovered',
    }).acquire('default', { pid: 222 });

    expect(recovered.owner.ownerId).toBe('recovered');
    await expect(
      fs.readFile(join(recovered.effectiveDirectory, 'state.txt'), 'utf8'),
    ).resolves.toBe('keep');
    await recovered.release();
  });

  it('removes only the explicitly leased profile when requested', async () => {
    const root = await temporaryRoot();
    await fs.mkdir(join(root, 'sibling'), { recursive: true });
    const lease = await new DedicatedProfileManager({
      rootDirectory: root,
      ownerIdFactory: () => 'owner',
    }).acquire('remove-me');

    await lease.release({ removeProfile: true });

    await expect(fs.access(lease.parentDirectory)).rejects.toThrow();
    await expect(fs.access(join(root, 'sibling'))).resolves.toBeUndefined();
  });

  it('refuses traversal and ambiguous profile names', async () => {
    const root = await temporaryRoot();
    const manager = new DedicatedProfileManager({ rootDirectory: root });
    await expect(manager.acquire('../outside')).rejects.toBeInstanceOf(UnsafeProfilePathError);
    await expect(manager.acquire('.')).rejects.toBeInstanceOf(UnsafeProfilePathError);
  });
});
