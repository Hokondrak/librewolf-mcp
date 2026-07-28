import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ProfileInUseError, ProfileOwnershipError, UnsafeProfilePathError } from './errors.js';
import type {
  AcquireProfileOptions,
  Clock,
  ProcessInspector,
  ProfileManagerOptions,
  ProfileOwnerMetadata,
  ReleaseProfileOptions,
} from './types.js';

export const UPSTREAM_PROFILE_DIRECTORY_NAME = 'firefox_devtools_mcp_profile';
export const PROFILE_LOCK_FILE_NAME = '.librewolf-agent-bridge.lock';
export const PROFILE_OWNER_FILE_NAME = '.librewolf-agent-bridge.owner.json';
const PROFILE_MARKER_FILE_NAME = '.librewolf-agent-bridge.profile.json';

const DEFAULT_STALE_LOCK_MS = 30_000;
const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;

class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}

class SystemProcessInspector implements ProcessInspector {
  public isAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : undefined;
      return code === 'EPERM';
    }
  }
}

function assertSafeProfileName(profileName: string): void {
  if (!PROFILE_NAME_PATTERN.test(profileName) || profileName === '.' || profileName === '..') {
    throw new UnsafeProfilePathError(
      'Profile names may contain only letters, numbers, dots, underscores, and hyphens.',
    );
  }
}

function isContained(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation);
}

function assertDirectChild(root: string, parent: string, profileName: string): void {
  if (!isContained(root, parent) || dirname(parent) !== root || basename(parent) !== profileName) {
    throw new UnsafeProfilePathError(`Refusing unsafe profile path: ${parent}`);
  }
}

async function readOwner(path: string): Promise<ProfileOwnerMetadata | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('schemaVersion' in parsed) ||
      parsed.schemaVersion !== 1 ||
      !('ownerId' in parsed) ||
      typeof parsed.ownerId !== 'string' ||
      !('pid' in parsed) ||
      typeof parsed.pid !== 'number' ||
      !('acquiredAt' in parsed) ||
      typeof parsed.acquiredAt !== 'string' ||
      !('profileName' in parsed) ||
      typeof parsed.profileName !== 'string' ||
      !('parentDirectory' in parsed) ||
      typeof parsed.parentDirectory !== 'string' ||
      !('effectiveDirectory' in parsed) ||
      typeof parsed.effectiveDirectory !== 'string'
    ) {
      return null;
    }
    return parsed as ProfileOwnerMetadata;
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export class ProfileLease {
  private released = false;

  public readonly upstreamProfilePath: string;
  public readonly lockPath: string;
  public readonly ownerPath: string;

  public constructor(
    public readonly parentDirectory: string,
    public readonly effectiveDirectory: string,
    public readonly owner: ProfileOwnerMetadata,
    private readonly rootDirectory: string,
  ) {
    this.upstreamProfilePath = parentDirectory;
    this.lockPath = join(parentDirectory, PROFILE_LOCK_FILE_NAME);
    this.ownerPath = join(parentDirectory, PROFILE_OWNER_FILE_NAME);
  }

  public async release(options: ReleaseProfileOptions = {}): Promise<void> {
    if (this.released) {
      return;
    }

    assertDirectChild(this.rootDirectory, this.parentDirectory, this.owner.profileName);
    if (this.effectiveDirectory !== join(this.parentDirectory, UPSTREAM_PROFILE_DIRECTORY_NAME)) {
      throw new UnsafeProfilePathError(
        `Unexpected effective profile path: ${this.effectiveDirectory}`,
      );
    }

    const lockOwner = await readOwner(this.lockPath);
    const metadataOwner = await readOwner(this.ownerPath);
    if (
      lockOwner?.ownerId !== this.owner.ownerId ||
      metadataOwner?.ownerId !== this.owner.ownerId
    ) {
      throw new ProfileOwnershipError(
        'Profile ownership changed; refusing to release another process owner.',
      );
    }

    if (options.removeProfile === true) {
      const parentStats = await fs.lstat(this.parentDirectory);
      if (parentStats.isSymbolicLink()) {
        throw new UnsafeProfilePathError('Refusing to remove a symlinked profile directory.');
      }
      const canonicalParent = await fs.realpath(this.parentDirectory);
      const canonicalRoot = await fs.realpath(this.rootDirectory);
      assertDirectChild(canonicalRoot, canonicalParent, this.owner.profileName);
      await fs.rm(canonicalParent, { recursive: true, force: false });
    } else {
      await fs.unlink(this.ownerPath);
      await fs.unlink(this.lockPath);
    }
    this.released = true;
  }
}

export class DedicatedProfileManager {
  private readonly rootDirectory: string;
  private readonly processInspector: ProcessInspector;
  private readonly clock: Clock;
  private readonly ownerIdFactory: () => string;
  private readonly staleLockMs: number;

  public constructor(options: ProfileManagerOptions) {
    this.rootDirectory = resolve(options.rootDirectory);
    this.processInspector = options.processInspector ?? new SystemProcessInspector();
    this.clock = options.clock ?? new SystemClock();
    this.ownerIdFactory = options.ownerIdFactory ?? randomUUID;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;

    if (
      this.rootDirectory === dirname(this.rootDirectory) ||
      !Number.isFinite(this.staleLockMs) ||
      this.staleLockMs < 0
    ) {
      throw new UnsafeProfilePathError(
        'A safe profile root and non-negative stale age are required.',
      );
    }
  }

  public async acquire(
    profileName: string,
    options: AcquireProfileOptions = {},
  ): Promise<ProfileLease> {
    assertSafeProfileName(profileName);
    await fs.mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });

    const canonicalRoot = await fs.realpath(this.rootDirectory);
    const requestedParent = join(canonicalRoot, profileName);
    assertDirectChild(canonicalRoot, requestedParent, profileName);
    await fs.mkdir(requestedParent, { recursive: true, mode: 0o700 });

    const parentStats = await fs.lstat(requestedParent);
    if (parentStats.isSymbolicLink()) {
      throw new UnsafeProfilePathError('A profile parent may not be a symbolic link.');
    }
    const parentDirectory = await fs.realpath(requestedParent);
    assertDirectChild(canonicalRoot, parentDirectory, profileName);

    const effectiveDirectory = join(parentDirectory, UPSTREAM_PROFILE_DIRECTORY_NAME);
    await fs.mkdir(effectiveDirectory, { recursive: true, mode: 0o700 });
    const canonicalEffective = await fs.realpath(effectiveDirectory);
    if (
      !isContained(parentDirectory, canonicalEffective) ||
      canonicalEffective !== effectiveDirectory
    ) {
      throw new UnsafeProfilePathError('The effective profile escaped its dedicated parent.');
    }

    const owner: ProfileOwnerMetadata = {
      schemaVersion: 1,
      ownerId: this.ownerIdFactory(),
      pid: options.pid ?? process.pid,
      acquiredAt: this.clock.now().toISOString(),
      profileName,
      parentDirectory,
      effectiveDirectory,
    };
    const lockPath = join(parentDirectory, PROFILE_LOCK_FILE_NAME);
    const ownerPath = join(parentDirectory, PROFILE_OWNER_FILE_NAME);

    await this.acquireLock(lockPath, owner);
    try {
      await this.writeAtomic(ownerPath, owner);
      await this.writeProfileMarker(effectiveDirectory, profileName);
    } catch (error) {
      const lockOwner = await readOwner(lockPath);
      if (lockOwner?.ownerId === owner.ownerId) {
        await fs.unlink(lockPath).catch(() => undefined);
      }
      throw error;
    }

    return new ProfileLease(parentDirectory, effectiveDirectory, owner, canonicalRoot);
  }

  private async acquireLock(path: string, owner: ProfileOwnerMetadata): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(path, 'wx', 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, 'utf8');
        } finally {
          await handle.close();
        }
        return;
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : undefined;
        if (code !== 'EEXIST') {
          throw error;
        }

        const existingOwner = await readOwner(path);
        if (existingOwner && this.processInspector.isAlive(existingOwner.pid)) {
          throw new ProfileInUseError(
            `Profile "${owner.profileName}" is owned by PID ${existingOwner.pid}.`,
            existingOwner,
          );
        }

        if (!existingOwner) {
          const stats = await fs.stat(path);
          const age = this.clock.now().getTime() - stats.mtimeMs;
          if (age < this.staleLockMs) {
            throw new ProfileInUseError(
              `Profile "${owner.profileName}" has a recent unreadable lock.`,
              null,
            );
          }
        }
        await fs.unlink(path);
        const ownerPath = join(dirname(path), PROFILE_OWNER_FILE_NAME);
        if (await pathExists(ownerPath)) {
          const staleOwner = await readOwner(ownerPath);
          if (!staleOwner || staleOwner.ownerId === existingOwner?.ownerId) {
            await fs.unlink(ownerPath).catch(() => undefined);
          }
        }
      }
    }
    throw new ProfileInUseError(`Unable to acquire profile "${owner.profileName}".`, null);
  }

  private async writeAtomic(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${process.pid}.${this.ownerIdFactory()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    try {
      await fs.rename(temporary, path);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async writeProfileMarker(effectiveDirectory: string, profileName: string): Promise<void> {
    const markerPath = join(effectiveDirectory, PROFILE_MARKER_FILE_NAME);
    if (await pathExists(markerPath)) {
      return;
    }
    await this.writeAtomic(markerPath, {
      schemaVersion: 1,
      profileName,
      managedBy: 'librewolf-agent-bridge',
    });
  }
}
