import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASE_HOST_CAPABILITIES } from './capabilities.js';
import { discoverySourcePath } from './discovery.js';
import { decodeNativeMessages, encodeNativeMessage } from './framing.js';
import type { DiscoveryRecord, HostCapability, MessagePipe, PipeConnector } from './types.js';

const PIPE_PREFIX = '\\\\.\\pipe\\librewolf-agent-bridge\\';
const DEFAULT_START_TIMEOUT_MS = 10_000;
const MAX_HELPER_ERROR_BYTES = 16 * 1024;

export class SecureWindowsPipeError extends Error {
  constructor(
    readonly code:
      | 'UNSUPPORTED_PLATFORM'
      | 'NATIVE_HELPER_NOT_FOUND'
      | 'NATIVE_HELPER_START_FAILED'
      | 'NATIVE_HELPER_PROTOCOL_ERROR'
      | 'NATIVE_HELPER_REJECTED_ENDPOINT'
      | 'PIPE_CLOSED',
    message: string,
  ) {
    super(message);
    this.name = 'SecureWindowsPipeError';
  }
}

export interface SecureWindowsPipeConnectorOptions {
  helperPath?: string;
  connectTimeoutMs?: number;
  startTimeoutMs?: number;
  /**
   * Production connections require a record returned by loadDiscoveryRecord so
   * the native helper can verify the discovery file's current-user-only ACL.
   * Tests that intentionally construct records in memory may disable this.
   */
  verifyDiscoveryFileAcl?: boolean;
}

export interface SecureWindowsPipeServerOptions {
  helperPath?: string;
  pipeName?: string;
  token?: string;
  serverInstanceId?: string;
  startTimeoutMs?: number;
  now?: () => number;
}

export interface DiscoveryPublicationOptions {
  /**
   * Private directory boundary created and verified by the native helper.
   * Defaults to the parent of the discovery file's containing directory.
   */
  rootDirectory?: string;
  heartbeatIntervalMs?: number;
  ttlMs?: number;
}

export interface SecureWindowsPipeServer {
  readonly discovery: DiscoveryRecord;
  readonly capabilities: Readonly<Record<string, HostCapability>>;
  accept(): Promise<MessagePipe>;
  publishDiscovery(path: string, options?: DiscoveryPublicationOptions): Promise<void>;
  heartbeat(): Promise<void>;
  unpublishDiscovery(): Promise<void>;
  close(): Promise<void>;
}

interface HelperControl {
  event: 'listening' | 'connected' | 'published' | 'removed';
  version: 1;
  mode: 'server' | 'client' | 'file';
  pipeName?: string;
  ownerPid?: number;
  ownerCreatedAtFiletime?: string;
  clientPid?: number;
  serverPid?: number;
  currentUserSid: string;
  dacl?: 'current-user-only';
  remoteClientsRejected?: true;
  daclVerified?: true;
  transportPrefaceVerified?: true;
}

const SECURE_CAPABILITIES: Readonly<Record<string, HostCapability>> = Object.freeze({
  ...BASE_HOST_CAPABILITIES,
  secureNamedPipeAcl: { level: 'available' },
  discoveryRecordAclVerification: { level: 'available' },
  remoteClientRejection: { level: 'available' },
  nativePeerProcessVerification: { level: 'available' },
  authenticatedMessageFrames: { level: 'available' },
});

const UNSUPPORTED_CAPABILITIES: Readonly<Record<string, HostCapability>> = Object.freeze({
  ...BASE_HOST_CAPABILITIES,
  secureNamedPipeAcl: { level: 'unavailable', reason: 'windows_only' },
  discoveryRecordAclVerification: { level: 'unavailable', reason: 'windows_only' },
  remoteClientRejection: { level: 'unavailable', reason: 'windows_only' },
  nativePeerProcessVerification: { level: 'unavailable', reason: 'windows_only' },
  authenticatedMessageFrames: { level: 'available' },
});

export class SecureWindowsPipeConnector implements PipeConnector {
  readonly capabilities: Readonly<Record<string, HostCapability>>;
  readonly #options: SecureWindowsPipeConnectorOptions;

  constructor(options: SecureWindowsPipeConnectorOptions = {}) {
    this.#options = options;
    this.capabilities =
      process.platform === 'win32' ? SECURE_CAPABILITIES : UNSUPPORTED_CAPABILITIES;
  }

  async connect(record: DiscoveryRecord): Promise<MessagePipe> {
    assertWindows();
    const sourcePath = discoverySourcePath(record);
    if ((this.#options.verifyDiscoveryFileAcl ?? true) && sourcePath === undefined) {
      throw new SecureWindowsPipeError(
        'NATIVE_HELPER_REJECTED_ENDPOINT',
        'Secure pipe connection requires a discovery record loaded from a verified file.',
      );
    }
    const channel = await HelperChannel.start(
      [
        'client',
        '--pipe-name',
        record.pipeName,
        '--expected-server-pid',
        String(record.ownerPid),
        ...(record.ownerCreatedAtFiletime
          ? ['--expected-server-created-at', record.ownerCreatedAtFiletime]
          : []),
        '--connect-timeout-ms',
        String(normalizeTimeout(this.#options.connectTimeoutMs, DEFAULT_START_TIMEOUT_MS)),
        '--parent-pid',
        String(process.pid),
        ...(sourcePath ? ['--discovery-path', sourcePath] : []),
      ],
      {
        ...(this.#options.helperPath ? { helperPath: this.#options.helperPath } : {}),
        ...(this.#options.startTimeoutMs !== undefined
          ? { startTimeoutMs: this.#options.startTimeoutMs }
          : {}),
      },
    );
    const control = await channel.readControl('connected');
    if (
      control.mode !== 'client' ||
      control.serverPid !== record.ownerPid ||
      control.daclVerified !== true ||
      control.transportPrefaceVerified !== true
    ) {
      await channel.close();
      throw new SecureWindowsPipeError(
        'NATIVE_HELPER_PROTOCOL_ERROR',
        'Native helper did not confirm the expected secure server endpoint.',
      );
    }
    return channel;
  }
}

export async function createSecureWindowsPipeServer(
  options: SecureWindowsPipeServerOptions = {},
): Promise<SecureWindowsPipeServer> {
  assertWindows();
  const pipeName = options.pipeName ?? `${PIPE_PREFIX}${randomBytes(24).toString('hex')}`;
  const token = options.token ?? randomBytes(32).toString('base64url');
  const serverInstanceId = options.serverInstanceId ?? randomUUID();
  assertGeneratedSecrets(pipeName, token, serverInstanceId);

  const channel = await HelperChannel.start(
    ['server', '--pipe-name', pipeName, '--parent-pid', String(process.pid)],
    {
      ...(options.helperPath ? { helperPath: options.helperPath } : {}),
      ...(options.startTimeoutMs !== undefined ? { startTimeoutMs: options.startTimeoutMs } : {}),
    },
  );
  const listening = await channel.readControl('listening');
  if (
    listening.mode !== 'server' ||
    listening.pipeName !== pipeName ||
    listening.dacl !== 'current-user-only' ||
    listening.remoteClientsRejected !== true ||
    listening.ownerPid === undefined ||
    listening.ownerCreatedAtFiletime === undefined
  ) {
    await channel.close();
    throw new SecureWindowsPipeError(
      'NATIVE_HELPER_PROTOCOL_ERROR',
      'Native helper did not attest a hardened server endpoint.',
    );
  }

  const now = options.now?.() ?? Date.now();
  const createdAt = new Date(now).toISOString();
  const discovery: DiscoveryRecord = {
    schemaVersion: 1,
    serverInstanceId,
    ownerPid: listening.ownerPid,
    ownerCreatedAtFiletime: listening.ownerCreatedAtFiletime,
    pipeName,
    protocol: { min: '1.0.0', max: '1.0.0' },
    auth: { scheme: 'hmac-sha256-v1', token },
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  let accepted = false;
  let publication:
    | {
        path: string;
        rootDirectory: string;
        interval: ReturnType<typeof setInterval>;
        ttlMs: number;
        latestWrite: Promise<void>;
        error?: unknown;
      }
    | undefined;
  let closing: Promise<void> | undefined;

  const writeHeartbeat = async (): Promise<void> => {
    if (!publication) {
      throw new SecureWindowsPipeError(
        'NATIVE_HELPER_PROTOCOL_ERROR',
        'Discovery has not been published.',
      );
    }
    const active = publication;
    if (active.error) throw active.error;
    active.latestWrite = active.latestWrite.then(async () => {
      const heartbeatAt = options.now?.() ?? Date.now();
      discovery.updatedAt = new Date(heartbeatAt).toISOString();
      discovery.expiresAt = new Date(heartbeatAt + active.ttlMs).toISOString();
      await runOneShotHelper(
        [
          'write-discovery',
          '--path',
          active.path,
          '--root',
          active.rootDirectory,
          '--parent-pid',
          String(process.pid),
        ],
        discovery,
        'published',
        options.helperPath,
      );
    });
    try {
      await active.latestWrite;
    } catch (error) {
      active.error = error;
      clearInterval(active.interval);
      await channel.close().catch(() => undefined);
      throw error;
    }
  };

  const unpublish = async (): Promise<void> => {
    if (!publication) return;
    const active = publication;
    publication = undefined;
    clearInterval(active.interval);
    await active.latestWrite;
    await runOneShotHelper(
      [
        'remove-discovery',
        '--path',
        active.path,
        '--root',
        active.rootDirectory,
        '--parent-pid',
        String(process.pid),
      ],
      discovery,
      'removed',
      options.helperPath,
    );
  };

  return {
    discovery,
    capabilities: SECURE_CAPABILITIES,
    async accept(): Promise<MessagePipe> {
      if (accepted) {
        throw new SecureWindowsPipeError(
          'NATIVE_HELPER_PROTOCOL_ERROR',
          'Secure named-pipe server accepts exactly one client.',
        );
      }
      accepted = true;
      const connected = await channel.readControl('connected');
      if (
        connected.mode !== 'server' ||
        connected.clientPid === undefined ||
        connected.daclVerified !== true ||
        connected.transportPrefaceVerified !== true
      ) {
        await channel.close();
        throw new SecureWindowsPipeError(
          'NATIVE_HELPER_PROTOCOL_ERROR',
          'Native helper did not confirm a same-user client.',
        );
      }
      return channel;
    },
    async publishDiscovery(
      path: string,
      publicationOptions: DiscoveryPublicationOptions = {},
    ): Promise<void> {
      if (publication) {
        throw new SecureWindowsPipeError(
          'NATIVE_HELPER_PROTOCOL_ERROR',
          'This server already owns a published discovery record.',
        );
      }
      if (!isAbsolute(path)) {
        throw new SecureWindowsPipeError(
          'NATIVE_HELPER_REJECTED_ENDPOINT',
          'Discovery path must be absolute.',
        );
      }
      const heartbeatIntervalMs = normalizeBoundedMilliseconds(
        publicationOptions.heartbeatIntervalMs,
        10_000,
        1_000,
        25_000,
        'Discovery heartbeat interval',
      );
      const ttlMs = normalizeBoundedMilliseconds(
        publicationOptions.ttlMs,
        30_000,
        heartbeatIntervalMs + 1_000,
        120_000,
        'Discovery TTL',
      );
      // The private root is the discovery file's own directory, not its grandparent. The
      // grandparent is the shared application directory that the native-host installer also
      // creates, so it carries inherited ACLs; requiring it to be inheritance-protected made
      // the helper reject every real installation with
      // DISCOVERY_DIRECTORY_SECURITY_FAILED. Hardening the runtime directory itself keeps the
      // same guarantee — the discovery record still lives behind a current-user-only,
      // inheritance-protected DACL that the helper re-verifies on every connection.
      const rootDirectory = publicationOptions.rootDirectory ?? dirname(resolve(path));
      const state = {
        path: resolve(path),
        rootDirectory: resolve(rootDirectory),
        ttlMs,
        latestWrite: Promise.resolve(),
        interval: setInterval(() => undefined, 0),
      };
      clearInterval(state.interval);
      publication = {
        ...state,
        interval: setInterval(() => {
          void writeHeartbeat().catch(() => undefined);
        }, heartbeatIntervalMs),
      };
      publication.interval.unref();
      try {
        await writeHeartbeat();
      } catch (error) {
        publication = undefined;
        throw error;
      }
    },
    heartbeat: writeHeartbeat,
    unpublishDiscovery: unpublish,
    async close(): Promise<void> {
      if (closing) return closing;
      closing = (async () => {
        let cleanupError: unknown;
        try {
          await unpublish();
        } catch (error) {
          cleanupError = error;
        }
        await channel.close();
        if (cleanupError) throw cleanupError;
      })();
      return closing;
    },
  };
}

class HelperChannel implements MessagePipe {
  readonly #iterator: AsyncIterator<unknown>;
  readonly #child: ChildProcessWithoutNullStreams;
  #stderr = '';
  #closed = false;
  #writeChain: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    this.#iterator = decodeNativeMessages(child.stdout)[Symbol.asyncIterator]();
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (process.env['LIBREWOLF_SECURE_PIPE_DEBUG'] === '1') {
        process.stderr.write(chunk);
      }
      if (this.#stderr.length >= MAX_HELPER_ERROR_BYTES) return;
      this.#stderr += Buffer.from(chunk).toString(
        'utf8',
        0,
        Math.min(Buffer.byteLength(chunk), MAX_HELPER_ERROR_BYTES - this.#stderr.length),
      );
    });
  }

  static async start(
    arguments_: string[],
    options: { helperPath?: string; startTimeoutMs?: number },
  ): Promise<HelperChannel> {
    const helperPath = resolveHelperPath(options.helperPath);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(helperPath, arguments_, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      throw new SecureWindowsPipeError(
        'NATIVE_HELPER_START_FAILED',
        `Unable to start secure pipe helper: ${safeError(error)}`,
      );
    }
    const channel = new HelperChannel(child);
    try {
      await channel.waitForSpawn(
        normalizeTimeout(options.startTimeoutMs, DEFAULT_START_TIMEOUT_MS),
      );
      return channel;
    } catch (error) {
      await channel.close();
      throw error;
    }
  }

  async readControl(expectedEvent: HelperControl['event']): Promise<HelperControl> {
    const next = await this.#iterator.next();
    if (next.done) {
      throw this.#closedError('Native helper closed before reporting readiness.');
    }
    const control = parseHelperControl(next.value);
    if (control.event !== expectedEvent) {
      throw new SecureWindowsPipeError(
        'NATIVE_HELPER_PROTOCOL_ERROR',
        `Expected native helper ${expectedEvent} event, received ${control.event}.`,
      );
    }
    return control;
  }

  async send(message: unknown): Promise<void> {
    if (this.#closed || this.#child.stdin.destroyed) {
      throw this.#closedError('Secure named pipe is closed.');
    }
    const frame = encodeNativeMessage(message);
    if (process.env['LIBREWOLF_SECURE_PIPE_DEBUG'] === '1') {
      process.stderr.write(`[secure-pipe-node] writing ${frame.length} bytes\n`);
    }
    this.#writeChain = this.#writeChain.then(async () => {
      // Windows child stdio can be message-backed. Keep the framing prefix and
      // body as distinct writes so a short prefix read never consumes a whole
      // message and discards the unread body.
      await writeChildBytes(this.#child, frame.subarray(0, 4));
      if (process.env['LIBREWOLF_SECURE_PIPE_DEBUG'] === '1') {
        process.stderr.write('[secure-pipe-node] wrote prefix\n');
      }
      await writeChildBytes(this.#child, frame.subarray(4));
      if (process.env['LIBREWOLF_SECURE_PIPE_DEBUG'] === '1') {
        process.stderr.write('[secure-pipe-node] wrote body\n');
      }
    });
    return this.#writeChain;
  }

  async receive(): Promise<unknown | null> {
    if (this.#closed) return null;
    const next = await this.#iterator.next();
    if (!next.done) return next.value;
    if (this.#child.exitCode !== null && this.#child.exitCode !== 0) {
      throw this.#closedError('Secure pipe helper exited unexpectedly.');
    }
    return null;
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      if (!this.#child.stdin.destroyed) {
        this.#child.stdin.end();
      }
      if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
      const exited = new Promise<void>((resolveExit) => {
        this.#child.once('close', () => resolveExit());
      });
      const graceful = await Promise.race([
        exited.then(() => true),
        delay(2_000).then(() => false),
      ]);
      if (!graceful && this.#child.exitCode === null && this.#child.signalCode === null) {
        this.#child.kill();
        await exited;
      }
    })();
    return this.#closePromise;
  }

  async waitForSpawn(timeoutMs: number): Promise<void> {
    if (this.#child.pid !== undefined) return;
    await Promise.race([
      new Promise<void>((resolveSpawn, rejectSpawn) => {
        this.#child.once('spawn', resolveSpawn);
        this.#child.once('error', (error) => {
          rejectSpawn(
            new SecureWindowsPipeError(
              'NATIVE_HELPER_START_FAILED',
              `Unable to start secure pipe helper: ${safeError(error)}`,
            ),
          );
        });
      }),
      delay(timeoutMs).then(() => {
        throw new SecureWindowsPipeError(
          'NATIVE_HELPER_START_FAILED',
          'Timed out starting secure pipe helper.',
        );
      }),
    ]);
  }

  #closedError(prefix: string): SecureWindowsPipeError {
    const detail = this.#stderr.trim().slice(0, 1_000);
    return new SecureWindowsPipeError('PIPE_CLOSED', detail ? `${prefix} ${detail}` : prefix);
  }
}

function parseHelperControl(value: unknown): HelperControl {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw protocolError();
  }
  const envelope = (value as Record<string, unknown>)['$securePipeHelper'];
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw protocolError();
  }
  const item = envelope as Record<string, unknown>;
  if (
    (item['event'] !== 'listening' &&
      item['event'] !== 'connected' &&
      item['event'] !== 'published' &&
      item['event'] !== 'removed') ||
    item['version'] !== 1 ||
    (item['mode'] !== 'server' && item['mode'] !== 'client' && item['mode'] !== 'file') ||
    typeof item['currentUserSid'] !== 'string'
  ) {
    throw protocolError();
  }
  return {
    event: item['event'],
    version: 1,
    mode: item['mode'],
    currentUserSid: item['currentUserSid'],
    ...(typeof item['pipeName'] === 'string' ? { pipeName: item['pipeName'] } : {}),
    ...(typeof item['ownerPid'] === 'number' ? { ownerPid: item['ownerPid'] } : {}),
    ...(typeof item['ownerCreatedAtFiletime'] === 'string'
      ? { ownerCreatedAtFiletime: item['ownerCreatedAtFiletime'] }
      : {}),
    ...(typeof item['clientPid'] === 'number' ? { clientPid: item['clientPid'] } : {}),
    ...(typeof item['serverPid'] === 'number' ? { serverPid: item['serverPid'] } : {}),
    ...(item['dacl'] === 'current-user-only' ? { dacl: item['dacl'] } : {}),
    ...(item['remoteClientsRejected'] === true ? { remoteClientsRejected: true } : {}),
    ...(item['daclVerified'] === true ? { daclVerified: true } : {}),
    ...(item['transportPrefaceVerified'] === true ? { transportPrefaceVerified: true } : {}),
  };
}

async function runOneShotHelper(
  arguments_: string[],
  payload: unknown,
  expectedEvent: 'published' | 'removed',
  explicitHelperPath: string | undefined,
): Promise<void> {
  const helperPath = resolveHelperPath(explicitHelperPath);
  const child = spawn(helperPath, arguments_, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer | string) => {
    if (stderr.length >= MAX_HELPER_ERROR_BYTES) return;
    stderr += Buffer.from(chunk).toString(
      'utf8',
      0,
      Math.min(Buffer.byteLength(chunk), MAX_HELPER_ERROR_BYTES - stderr.length),
    );
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('close', (code, signal) => resolveExit({ code, signal }));
    },
  );
  const frame = encodeNativeMessage(payload);
  await writeChildBytes(child, frame.subarray(0, 4));
  child.stdin.end(frame.subarray(4));
  const iterator = decodeNativeMessages(child.stdout)[Symbol.asyncIterator]();
  const next = await withTimeout(iterator.next(), DEFAULT_START_TIMEOUT_MS, () => child.kill());
  if (next.done) {
    const result = await exit;
    throw new SecureWindowsPipeError(
      'NATIVE_HELPER_REJECTED_ENDPOINT',
      oneShotFailure(
        `Native helper closed before ${expectedEvent}.`,
        stderr,
        result.code,
        result.signal,
      ),
    );
  }
  const control = parseHelperControl(next.value);
  if (control.event !== expectedEvent || control.mode !== 'file') {
    child.kill();
    await exit.catch(() => undefined);
    throw new SecureWindowsPipeError(
      'NATIVE_HELPER_PROTOCOL_ERROR',
      `Native helper returned an unexpected ${control.event} file event.`,
    );
  }
  const result = await withTimeout(exit, DEFAULT_START_TIMEOUT_MS, () => child.kill());
  if (result.code !== 0) {
    throw new SecureWindowsPipeError(
      'NATIVE_HELPER_REJECTED_ENDPOINT',
      oneShotFailure(
        `Native helper failed to ${expectedEvent} discovery.`,
        stderr,
        result.code,
        result.signal,
      ),
    );
  }
}

function protocolError(): SecureWindowsPipeError {
  return new SecureWindowsPipeError(
    'NATIVE_HELPER_PROTOCOL_ERROR',
    'Native helper returned an invalid control frame.',
  );
}

function resolveHelperPath(explicitPath: string | undefined): string {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new SecureWindowsPipeError(
        'NATIVE_HELPER_NOT_FOUND',
        `Secure pipe helper was not found at ${explicitPath}.`,
      );
    }
    return explicitPath;
  }
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, 'native', 'secure-pipe-helper.exe'),
    resolve(moduleDirectory, '..', 'dist', 'native', 'secure-pipe-helper.exe'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new SecureWindowsPipeError(
      'NATIVE_HELPER_NOT_FOUND',
      'Secure pipe helper is missing; run the native-host build on Windows.',
    );
  }
  return found;
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new SecureWindowsPipeError(
      'UNSUPPORTED_PLATFORM',
      'Secure named-pipe transport is supported only on Windows.',
    );
  }
}

function assertGeneratedSecrets(pipeName: string, token: string, serverInstanceId: string): void {
  if (
    !pipeName.startsWith(PIPE_PREFIX) ||
    pipeName.length > 240 ||
    !/^[A-Za-z0-9_.\\-]+$/u.test(pipeName.slice(PIPE_PREFIX.length))
  ) {
    throw new SecureWindowsPipeError(
      'NATIVE_HELPER_REJECTED_ENDPOINT',
      'Pipe name is outside the local LibreWolf Agent Bridge namespace.',
    );
  }
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new SecureWindowsPipeError(
      'NATIVE_HELPER_REJECTED_ENDPOINT',
      'Session token must contain exactly 32 random bytes encoded as base64url.',
    );
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      serverInstanceId,
    )
  ) {
    throw new SecureWindowsPipeError(
      'NATIVE_HELPER_REJECTED_ENDPOINT',
      'Server instance ID must be a random UUID.',
    );
  }
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 120_000) {
    throw new RangeError('Secure pipe timeout must be between 1 and 120000 milliseconds.');
  }
  return value;
}

function normalizeBoundedMilliseconds(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum} milliseconds.`);
  }
  return result;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function writeChildBytes(child: ChildProcessWithoutNullStreams, bytes: Uint8Array): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    child.stdin.write(Buffer.from(bytes), (error?: Error | null) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

async function withTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(
            new SecureWindowsPipeError(
              'NATIVE_HELPER_START_FAILED',
              'Timed out waiting for native helper.',
            ),
          );
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function oneShotFailure(
  prefix: string,
  stderr: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  const detail = stderr.trim().slice(0, 1_000);
  const status = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`;
  return detail ? `${prefix} ${detail}` : `${prefix} (${status})`;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
