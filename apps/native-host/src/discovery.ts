import { lstat, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';

import type { DiscoveryRecord } from './types.js';

const MAX_DISCOVERY_BYTES = 64 * 1024;
const PIPE_PREFIX = '\\\\.\\pipe\\librewolf-agent-bridge\\';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const discoverySources = new WeakMap<DiscoveryRecord, string>();

export class DiscoveryError extends Error {
  constructor(
    readonly code:
      | 'RUNTIME_DIRECTORY_UNAVAILABLE'
      | 'DISCOVERY_PATH_UNSAFE'
      | 'DISCOVERY_NOT_FOUND'
      | 'DISCOVERY_TOO_LARGE'
      | 'DISCOVERY_INVALID'
      | 'DISCOVERY_STALE',
    message: string,
  ) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

/**
 * Rendezvous location for the discovery record, deliberately outside `%LOCALAPPDATA%`.
 *
 * The MCP server and the native host are started by different parents: the server by the MCP
 * client, the host by LibreWolf. When that client is an MSIX-packaged application — Claude
 * Desktop is — Windows redirects its `%LOCALAPPDATA%` writes into
 * `...\Packages\<package>\LocalCache\Local\...`. The server then publishes inside its package
 * container while the host, running outside it, reads the real `%LOCALAPPDATA%` and finds
 * nothing. The redirection is silent and is not a reparse point, so neither side can detect it
 * by inspecting the directory.
 *
 * MSIX redirects the AppData and ProgramData subtrees only, so a directory directly under the
 * user's home resolves to the same file for packaged and unpackaged processes alike.
 */
export function defaultDiscoveryPath(environment: NodeJS.ProcessEnv = process.env): string {
  const home = environment['USERPROFILE'] ?? homedir();
  if (!home || !isAbsolute(home)) {
    throw new DiscoveryError(
      'RUNTIME_DIRECTORY_UNAVAILABLE',
      'USERPROFILE is unavailable or is not an absolute path.',
    );
  }
  return join(home, '.librewolf-agent-bridge', 'runtime', 'discovery-v1.json');
}

export async function loadDiscoveryRecord(
  path = defaultDiscoveryPath(),
  now = Date.now(),
): Promise<DiscoveryRecord> {
  const absolute = resolve(path);
  if (!isAbsolute(path) || normalize(path) !== normalize(absolute)) {
    throw new DiscoveryError('DISCOVERY_PATH_UNSAFE', 'Discovery path must be absolute.');
  }

  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch {
    throw new DiscoveryError('DISCOVERY_NOT_FOUND', 'No MCP bridge discovery record was found.');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new DiscoveryError(
      'DISCOVERY_PATH_UNSAFE',
      'Discovery record must be a regular, non-symbolic-link file.',
    );
  }
  if (metadata.size > MAX_DISCOVERY_BYTES) {
    throw new DiscoveryError('DISCOVERY_TOO_LARGE', 'Discovery record exceeds 64 KiB.');
  }

  const canonical = await realpath(absolute);
  if (normalize(canonical).toLowerCase() !== normalize(absolute).toLowerCase()) {
    throw new DiscoveryError(
      'DISCOVERY_PATH_UNSAFE',
      'Discovery record resolves through an unexpected path.',
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(await readFile(absolute, 'utf8')) as unknown;
  } catch {
    throw new DiscoveryError('DISCOVERY_INVALID', 'Discovery record is not valid JSON.');
  }
  const record = parseDiscoveryRecord(value);
  if (Date.parse(record.expiresAt) <= now || now - Date.parse(record.updatedAt) > 30_000) {
    throw new DiscoveryError('DISCOVERY_STALE', 'Discovery record heartbeat is stale.');
  }
  discoverySources.set(record, absolute);
  return record;
}

/**
 * Returns the canonical file that was validated while loading this exact record.
 * Parsed or programmatically-created records intentionally have no trusted source.
 */
export function discoverySourcePath(record: DiscoveryRecord): string | undefined {
  return discoverySources.get(record);
}

export function parseDiscoveryRecord(value: unknown): DiscoveryRecord {
  const record = asRecord(value, 'discovery record');
  assertOnlyKeys(record, [
    'schemaVersion',
    'serverInstanceId',
    'ownerPid',
    'ownerCreatedAtFiletime',
    'pipeName',
    'protocol',
    'auth',
    'createdAt',
    'updatedAt',
    'expiresAt',
  ]);
  const protocol = asRecord(record['protocol'], 'protocol');
  const auth = asRecord(record['auth'], 'auth');
  assertOnlyKeys(protocol, ['min', 'max']);
  assertOnlyKeys(auth, ['scheme', 'token']);

  if (record['schemaVersion'] !== 1) invalid('Unsupported discovery schema version.');
  const serverInstanceId = requiredString(record, 'serverInstanceId');
  if (!UUID.test(serverInstanceId)) invalid('serverInstanceId must be a UUID.');
  const ownerPid = record['ownerPid'];
  if (!Number.isSafeInteger(ownerPid) || (ownerPid as number) <= 0) {
    invalid('ownerPid must be a positive integer.');
  }
  const pipeName = requiredString(record, 'pipeName');
  if (
    !pipeName.startsWith(PIPE_PREFIX) ||
    pipeName.length > 240 ||
    !/^[A-Za-z0-9_.\\-]+$/u.test(pipeName.slice(PIPE_PREFIX.length)) ||
    pipeName.includes('..')
  ) {
    invalid('pipeName is outside the LibreWolf Agent Bridge namespace.');
  }
  if (auth['scheme'] !== 'hmac-sha256-v1') invalid('Unsupported authentication scheme.');
  const token = requiredString(auth, 'token');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    invalid('Authentication token must encode exactly 32 random bytes.');
  }
  const createdAt = requiredDate(record, 'createdAt');
  const updatedAt = requiredDate(record, 'updatedAt');
  const expiresAt = requiredDate(record, 'expiresAt');
  const minimum = requiredVersion(protocol, 'min');
  const maximum = requiredVersion(protocol, 'max');
  if (compareVersions(minimum, maximum) > 0) invalid('Protocol range is inverted.');
  const ownerCreatedAtFiletime = record['ownerCreatedAtFiletime'];
  if (
    ownerCreatedAtFiletime !== undefined &&
    (typeof ownerCreatedAtFiletime !== 'string' || !/^\d{10,20}$/u.test(ownerCreatedAtFiletime))
  ) {
    invalid('ownerCreatedAtFiletime must be an unsigned Windows FILETIME value.');
  }
  if (
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    Date.parse(expiresAt) <= Date.parse(updatedAt)
  ) {
    invalid('Discovery timestamps are not monotonic.');
  }

  return {
    schemaVersion: 1,
    serverInstanceId,
    ownerPid: ownerPid as number,
    ...(typeof ownerCreatedAtFiletime === 'string' ? { ownerCreatedAtFiletime } : {}),
    pipeName,
    protocol: { min: minimum, max: maximum },
    auth: { scheme: 'hmac-sha256-v1', token },
    createdAt,
    updatedAt,
    expiresAt,
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== 'string' || candidate.length === 0) invalid(`${key} is required.`);
  return candidate;
}

function requiredDate(value: Record<string, unknown>, key: string): string {
  const candidate = requiredString(value, key);
  if (!Number.isFinite(Date.parse(candidate))) invalid(`${key} must be an ISO timestamp.`);
  return candidate;
}

function requiredVersion(value: Record<string, unknown>, key: string): string {
  const candidate = requiredString(value, key);
  if (!/^\d+\.\d+\.\d+$/.test(candidate)) invalid(`${key} must be a semantic protocol version.`);
  return candidate;
}

function assertOnlyKeys(value: Record<string, unknown>, keys: string[]): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) invalid(`Unknown discovery field: ${unknown}`);
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function invalid(message: string): never {
  throw new DiscoveryError('DISCOVERY_INVALID', message);
}
