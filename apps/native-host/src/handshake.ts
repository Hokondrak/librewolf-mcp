import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { JsonRpcMessageSchema, type JsonRpcMessage } from '@librewolf-agent-bridge/protocol';
import {
  createAuthenticatedFrame,
  deriveSessionKey,
  FrameVerifier,
  hkdfSha256,
} from '@librewolf-agent-bridge/security';

import type {
  AuthenticatedContext,
  DiscoveryRecord,
  MessagePipe,
  NativeHostIdentity,
} from './types.js';

const SUPPORTED_PROTOCOLS = ['1.0.0'] as const;
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class HandshakeError extends Error {
  constructor(
    readonly code: 'INVALID_CHALLENGE' | 'PROTOCOL_MISMATCH' | 'AUTH_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'HandshakeError';
  }
}

export interface OpenAuthenticatedPipeResult {
  context: AuthenticatedContext;
  pipe: MessagePipe;
}

export interface AcceptAuthenticatedPipeResult extends OpenAuthenticatedPipeResult {
  identity: NativeHostIdentity & { hostInstanceId: string };
}

export interface AcceptAuthenticatedPipeOptions {
  authorizeIdentity?: (
    identity: NativeHostIdentity & { hostInstanceId: string },
  ) => boolean | Promise<boolean>;
  nonceFactory?: () => string;
  connectionIdFactory?: () => string;
}

interface ClientHandshakeResult {
  context: AuthenticatedContext;
  clientNonce: string;
  serverNonce: string;
}

/**
 * Backwards-compatible handshake-only entry point. Production callers should
 * use openAuthenticatedPipe so every post-handshake message is MAC-protected.
 */
export async function authenticatePipe(
  pipe: MessagePipe,
  discovery: DiscoveryRecord,
  identity: NativeHostIdentity,
  nonceFactory: () => string = secureNonce,
): Promise<AuthenticatedContext> {
  return (await performClientHandshake(pipe, discovery, identity, nonceFactory)).context;
}

export async function openAuthenticatedPipe(
  pipe: MessagePipe,
  discovery: DiscoveryRecord,
  identity: NativeHostIdentity,
  nonceFactory: () => string = secureNonce,
): Promise<OpenAuthenticatedPipeResult> {
  const handshake = await performClientHandshake(pipe, discovery, identity, nonceFactory);
  return {
    context: handshake.context,
    pipe: authenticatedFrames(pipe, discovery, handshake, 'client'),
  };
}

export async function acceptAuthenticatedPipe(
  pipe: MessagePipe,
  discovery: DiscoveryRecord,
  options: AcceptAuthenticatedPipeOptions = {},
): Promise<AcceptAuthenticatedPipeResult> {
  const serverNonce = (options.nonceFactory ?? secureNonce)();
  assertNonce(serverNonce, 'Server nonce source returned invalid entropy.');
  await pipe.send({
    jsonrpc: '2.0',
    method: 'bridge.challenge',
    params: {
      serverInstanceId: discovery.serverInstanceId,
      serverNonce,
      supportedVersions: [...SUPPORTED_PROTOCOLS],
    },
  });

  const hello = parseHello(await pipe.receive(), discovery.serverInstanceId);
  const selectedProtocol = selectProtocol(
    [hello.selectedProtocolVersion],
    discovery.protocol.min,
    discovery.protocol.max,
  );
  if (selectedProtocol !== hello.selectedProtocolVersion) {
    throw new HandshakeError(
      'PROTOCOL_MISMATCH',
      'Client selected an unexpected protocol version.',
    );
  }
  const expectedClientProof = clientProof(
    discovery.auth.token,
    discovery.serverInstanceId,
    serverNonce,
    hello.clientNonce,
    hello.identity,
    hello.selectedProtocolVersion,
    hello.identity.hostInstanceId,
  );
  if (!safeEqual(expectedClientProof, hello.proof)) {
    throw new HandshakeError('AUTH_FAILED', 'Client authentication proof is invalid.');
  }
  if (options.authorizeIdentity && !(await options.authorizeIdentity(hello.identity))) {
    throw new HandshakeError('AUTH_FAILED', 'Native host identity was not authorized.');
  }

  const connectionId = (options.connectionIdFactory ?? randomUUID)();
  if (!UUID.test(connectionId)) {
    throw new HandshakeError('AUTH_FAILED', 'Connection ID source returned an invalid UUID.');
  }
  await pipe.send({
    jsonrpc: '2.0',
    method: 'bridge.ready',
    params: {
      selectedProtocolVersion: selectedProtocol,
      connectionId,
      proof: serverProof(
        discovery.auth.token,
        discovery.serverInstanceId,
        serverNonce,
        hello.clientNonce,
        connectionId,
        selectedProtocol,
      ),
    },
  });
  const context = {
    connectionId,
    protocolVersion: selectedProtocol,
    serverInstanceId: discovery.serverInstanceId,
  };
  return {
    context,
    identity: hello.identity,
    pipe: authenticatedFrames(
      pipe,
      discovery,
      {
        context,
        clientNonce: hello.clientNonce,
        serverNonce,
      },
      'server',
    ),
  };
}

async function performClientHandshake(
  pipe: MessagePipe,
  discovery: DiscoveryRecord,
  identity: NativeHostIdentity,
  nonceFactory: () => string,
): Promise<ClientHandshakeResult> {
  const challenge = parseChallenge(await pipe.receive(), discovery.serverInstanceId);
  const protocolVersion = selectProtocol(
    challenge.supportedVersions,
    discovery.protocol.min,
    discovery.protocol.max,
  );
  const clientNonce = nonceFactory();
  assertNonce(clientNonce, 'Client nonce source returned invalid entropy.');
  const hostInstanceId = randomUUID();
  const proof = clientProof(
    discovery.auth.token,
    discovery.serverInstanceId,
    challenge.serverNonce,
    clientNonce,
    identity,
    protocolVersion,
    hostInstanceId,
  );
  await pipe.send({
    jsonrpc: '2.0',
    method: 'bridge.hello',
    params: {
      serverInstanceId: discovery.serverInstanceId,
      clientNonce,
      hostInstanceId,
      hostVersion: identity.hostVersion,
      extension: {
        id: identity.extensionId,
        version: identity.extensionVersion,
        manifestVersion: identity.manifestVersion,
      },
      browser: {
        name: identity.browserName,
        version: identity.browserVersion,
      },
      selectedProtocolVersion: protocolVersion,
      proof,
    },
  });

  const ready = parseReady(await pipe.receive());
  if (ready.selectedProtocolVersion !== protocolVersion) {
    throw new HandshakeError(
      'PROTOCOL_MISMATCH',
      'Server selected an unexpected protocol version.',
    );
  }
  const expectedProof = serverProof(
    discovery.auth.token,
    discovery.serverInstanceId,
    challenge.serverNonce,
    clientNonce,
    ready.connectionId,
    protocolVersion,
  );
  if (!safeEqual(expectedProof, ready.proof)) {
    throw new HandshakeError('AUTH_FAILED', 'Server authentication proof is invalid.');
  }
  return {
    context: {
      connectionId: ready.connectionId,
      protocolVersion,
      serverInstanceId: discovery.serverInstanceId,
    },
    clientNonce,
    serverNonce: challenge.serverNonce,
  };
}

export function clientProof(
  token: string,
  serverInstanceId: string,
  serverNonce: string,
  clientNonce: string,
  identity: NativeHostIdentity,
  protocolVersion: string,
  hostInstanceId: string,
): string {
  return hmac(
    token,
    [
      'client',
      serverInstanceId,
      serverNonce,
      clientNonce,
      protocolVersion,
      hostInstanceId,
      identity.extensionId,
      identity.extensionVersion,
      String(identity.manifestVersion),
      identity.hostVersion,
      identity.browserName,
      identity.browserVersion,
    ].join('\0'),
  );
}

export function serverProof(
  token: string,
  serverInstanceId: string,
  serverNonce: string,
  clientNonce: string,
  connectionId: string,
  protocolVersion: string,
): string {
  return hmac(
    token,
    ['server', serverInstanceId, serverNonce, clientNonce, connectionId, protocolVersion].join(
      '\0',
    ),
  );
}

function authenticatedFrames(
  rawPipe: MessagePipe,
  discovery: DiscoveryRecord,
  handshake: ClientHandshakeResult,
  role: 'client' | 'server',
): MessagePipe {
  if (!UUID.test(discovery.serverInstanceId)) {
    throw new HandshakeError(
      'AUTH_FAILED',
      'Server instance ID must be a UUID for authenticated message frames.',
    );
  }
  const baseKey = deriveSessionKey(
    Buffer.from(discovery.auth.token, 'base64url'),
    Buffer.from(handshake.clientNonce, 'base64url'),
    Buffer.from(handshake.serverNonce, 'base64url'),
  );
  const salt = [
    discovery.serverInstanceId,
    handshake.context.connectionId,
    handshake.context.protocolVersion,
  ].join('\0');
  const clientToServer = hkdfSha256(
    baseKey,
    salt,
    'librewolf-agent-bridge frame key client-to-server v1',
  );
  const serverToClient = hkdfSha256(
    baseKey,
    salt,
    'librewolf-agent-bridge frame key server-to-client v1',
  );
  return new AuthenticatedMessagePipe(
    rawPipe,
    discovery.serverInstanceId,
    role === 'client' ? clientToServer : serverToClient,
    role === 'client' ? serverToClient : clientToServer,
  );
}

class AuthenticatedMessagePipe implements MessagePipe {
  readonly #verifier: FrameVerifier;
  #sendSequence = 0;

  constructor(
    private readonly rawPipe: MessagePipe,
    private readonly sessionId: string,
    private readonly sendKey: Uint8Array,
    receiveKey: Uint8Array,
  ) {
    this.#verifier = new FrameVerifier(receiveKey, {
      expectedSessionId: sessionId,
      firstSequence: 0,
    });
  }

  async send(message: unknown): Promise<void> {
    const parsed: JsonRpcMessage = JsonRpcMessageSchema.parse(message);
    await this.rawPipe.send(
      createAuthenticatedFrame({
        sessionId: this.sessionId,
        sequence: this.#sendSequence,
        message: parsed,
        key: this.sendKey,
      }),
    );
    this.#sendSequence += 1;
  }

  async receive(): Promise<unknown | null> {
    const value = await this.rawPipe.receive();
    if (value === null) return null;
    return this.#verifier.verify(value).message;
  }

  close(): Promise<void> {
    return this.rawPipe.close();
  }
}

function parseChallenge(
  value: unknown,
  expectedServerInstanceId: string,
): { serverNonce: string; supportedVersions: string[] } {
  const root = asRecord(value);
  const params = asRecord(root['params']);
  if (root['jsonrpc'] !== '2.0' || root['method'] !== 'bridge.challenge') {
    throw new HandshakeError('INVALID_CHALLENGE', 'First pipe message is not a challenge.');
  }
  if (params['serverInstanceId'] !== expectedServerInstanceId) {
    throw new HandshakeError('AUTH_FAILED', 'Challenge server instance does not match discovery.');
  }
  const serverNonce = params['serverNonce'];
  const supportedVersions = params['supportedVersions'];
  if (
    typeof serverNonce !== 'string' ||
    !BASE64URL_32_BYTES.test(serverNonce) ||
    !Array.isArray(supportedVersions) ||
    supportedVersions.length === 0 ||
    !supportedVersions.every((item) => typeof item === 'string' && /^\d+\.\d+\.\d+$/u.test(item))
  ) {
    throw new HandshakeError('INVALID_CHALLENGE', 'Challenge fields are invalid.');
  }
  return { serverNonce, supportedVersions };
}

function parseHello(
  value: unknown,
  expectedServerInstanceId: string,
): {
  clientNonce: string;
  selectedProtocolVersion: string;
  proof: string;
  identity: NativeHostIdentity & { hostInstanceId: string };
} {
  const root = asRecord(value);
  const params = asRecord(root['params']);
  const extension = asRecord(params['extension']);
  const browser = asRecord(params['browser']);
  if (
    root['jsonrpc'] !== '2.0' ||
    root['method'] !== 'bridge.hello' ||
    params['serverInstanceId'] !== expectedServerInstanceId
  ) {
    throw new HandshakeError('AUTH_FAILED', 'Client hello does not match this server session.');
  }
  const clientNonce = params['clientNonce'];
  const selectedProtocolVersion = params['selectedProtocolVersion'];
  const proof = params['proof'];
  const hostInstanceId = params['hostInstanceId'];
  const hostVersion = params['hostVersion'];
  if (
    typeof clientNonce !== 'string' ||
    !BASE64URL_32_BYTES.test(clientNonce) ||
    typeof selectedProtocolVersion !== 'string' ||
    !/^\d+\.\d+\.\d+$/u.test(selectedProtocolVersion) ||
    typeof proof !== 'string' ||
    !BASE64URL_32_BYTES.test(proof) ||
    typeof hostInstanceId !== 'string' ||
    !UUID.test(hostInstanceId) ||
    typeof hostVersion !== 'string' ||
    typeof extension['id'] !== 'string' ||
    typeof extension['version'] !== 'string' ||
    (extension['manifestVersion'] !== 2 && extension['manifestVersion'] !== 3) ||
    typeof browser['name'] !== 'string' ||
    typeof browser['version'] !== 'string'
  ) {
    throw new HandshakeError('AUTH_FAILED', 'Client hello fields are invalid.');
  }
  return {
    clientNonce,
    selectedProtocolVersion,
    proof,
    identity: {
      hostInstanceId,
      hostVersion,
      extensionId: extension['id'],
      extensionVersion: extension['version'],
      manifestVersion: extension['manifestVersion'],
      browserName: browser['name'],
      browserVersion: browser['version'],
    },
  };
}

function parseReady(value: unknown): {
  selectedProtocolVersion: string;
  connectionId: string;
  proof: string;
} {
  const root = asRecord(value);
  const params = asRecord(root['params']);
  if (root['jsonrpc'] !== '2.0' || root['method'] !== 'bridge.ready') {
    throw new HandshakeError('AUTH_FAILED', 'Server did not complete the authenticated handshake.');
  }
  const selectedProtocolVersion = params['selectedProtocolVersion'];
  const connectionId = params['connectionId'];
  const proof = params['proof'];
  if (
    typeof selectedProtocolVersion !== 'string' ||
    typeof connectionId !== 'string' ||
    !UUID.test(connectionId) ||
    typeof proof !== 'string' ||
    !BASE64URL_32_BYTES.test(proof)
  ) {
    throw new HandshakeError('AUTH_FAILED', 'Handshake completion fields are invalid.');
  }
  return { selectedProtocolVersion, connectionId, proof };
}

function selectProtocol(supported: string[], minimum: string, maximum: string): string {
  const selected = [...SUPPORTED_PROTOCOLS]
    .reverse()
    .find(
      (candidate) =>
        supported.includes(candidate) &&
        compareVersions(candidate, minimum) >= 0 &&
        compareVersions(candidate, maximum) <= 0,
    );
  if (!selected) {
    throw new HandshakeError('PROTOCOL_MISMATCH', 'No mutually supported protocol version.');
  }
  return selected;
}

function hmac(token: string, input: string): string {
  return createHmac('sha256', Buffer.from(token, 'base64url'))
    .update(input, 'utf8')
    .digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  if (!BASE64URL_32_BYTES.test(left) || !BASE64URL_32_BYTES.test(right)) return false;
  const a = Buffer.from(left, 'base64url');
  const b = Buffer.from(right, 'base64url');
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertNonce(value: string, message: string): void {
  if (!BASE64URL_32_BYTES.test(value)) {
    throw new HandshakeError('AUTH_FAILED', message);
  }
}

function secureNonce(): string {
  return randomBytes(32).toString('base64url');
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HandshakeError('AUTH_FAILED', 'Handshake message must be an object.');
  }
  return value as Record<string, unknown>;
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
