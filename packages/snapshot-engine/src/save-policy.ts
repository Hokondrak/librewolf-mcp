import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { SnapshotPolicyError } from './errors.js';
import type { SavedSnapshotFile, SnapshotSavePolicy, SnapshotSaveRequest } from './types.js';

export interface FileSnapshotSavePolicyOptions {
  readonly rootDirectory: string;
  readonly allowedAbsoluteRoots?: readonly string[];
  readonly maxBytes?: number;
  readonly overwrite?: boolean;
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

function safeSnapshotName(snapshotId: string): string {
  return `${snapshotId.replace(/[^a-zA-Z0-9._-]/gu, '_')}.txt`;
}

export class FileSnapshotSavePolicy implements SnapshotSavePolicy {
  private readonly rootDirectory: string;
  private readonly allowedAbsoluteRoots: readonly string[];
  private readonly maxBytes: number;
  private readonly overwrite: boolean;

  public constructor(options: FileSnapshotSavePolicyOptions) {
    this.rootDirectory = resolve(options.rootDirectory);
    this.allowedAbsoluteRoots = [
      this.rootDirectory,
      ...(options.allowedAbsoluteRoots ?? []).map((path) => resolve(path)),
    ];
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.overwrite = options.overwrite ?? false;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new RangeError('maxBytes must be a positive integer.');
    }
  }

  public async save(request: SnapshotSaveRequest): Promise<SavedSnapshotFile> {
    const bytes = Buffer.byteLength(request.content, 'utf8');
    if (bytes > this.maxBytes) {
      throw new SnapshotPolicyError(
        `Snapshot is ${bytes} bytes, exceeding the save limit of ${this.maxBytes}.`,
      );
    }

    if (request.destination === false) {
      throw new SnapshotPolicyError('A false save destination does not request a file.');
    }
    const requestedPath =
      request.destination === true
        ? join(this.rootDirectory, safeSnapshotName(request.snapshotId))
        : request.destination;
    const destination = isAbsolute(requestedPath)
      ? resolve(requestedPath)
      : resolve(this.rootDirectory, requestedPath);

    const lexicalRoot = this.allowedAbsoluteRoots.find((root) =>
      isInsideOrEqual(root, destination),
    );
    if (!lexicalRoot) {
      throw new SnapshotPolicyError(
        `Snapshot destination is outside allowed roots: ${destination}`,
      );
    }

    const parent = dirname(destination);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const canonicalParent = await fs.realpath(parent);
    const canonicalRoots = await Promise.all(
      this.allowedAbsoluteRoots.map(async (root) => {
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        return fs.realpath(root);
      }),
    );
    if (!canonicalRoots.some((root) => isInsideOrEqual(root, canonicalParent))) {
      throw new SnapshotPolicyError('Snapshot destination escapes an allowed root through a link.');
    }

    try {
      const existing = await fs.lstat(destination);
      if (existing.isSymbolicLink()) {
        throw new SnapshotPolicyError('Refusing to overwrite a symbolic link.');
      }
      if (!this.overwrite) {
        throw new SnapshotPolicyError(`Snapshot destination already exists: ${destination}`);
      }
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : undefined;
      if (code !== 'ENOENT' && !(error instanceof SnapshotPolicyError)) {
        throw error;
      }
      if (error instanceof SnapshotPolicyError) {
        throw error;
      }
    }

    const temporary = join(
      canonicalParent,
      `.${safeSnapshotName(request.snapshotId)}.${process.pid}.tmp`,
    );
    await fs.writeFile(temporary, request.content, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    try {
      await fs.rename(temporary, destination);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
    return { path: destination, bytes };
  }
}
