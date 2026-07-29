import {
  acceptAuthenticatedPipe,
  createSecureWindowsPipeServer,
  defaultDiscoveryPath,
  type AcceptAuthenticatedPipeResult,
  type DiscoveryRecord,
  type MessagePipe,
  type SecureWindowsPipeServer,
  type SecureWindowsPipeServerOptions,
} from '@librewolf-agent-bridge/native-host';
import {
  BrowserBridgeError,
  type CompanionConnection,
  type CompanionRpcRequest,
  type CompanionTransport,
} from '@librewolf-agent-bridge/browser-core';

const EXPECTED_EXTENSION_ID = 'librewolf-agent-bridge@librewolf-agent-bridge.org';
const COMPANION_PROTOCOL_VERSION = '1.0.0';

interface SecureCompanionServer {
  readonly discovery: DiscoveryRecord;
  accept(): Promise<MessagePipe>;
  publishDiscovery(path: string): Promise<void>;
  close(): Promise<void>;
}

export interface SecureCompanionTransportOptions {
  readonly platform?: NodeJS.Platform;
  readonly discoveryPath?: string;
  readonly helperPath?: string;
  readonly connectTimeoutMs?: number;
  readonly expectedExtensionId?: string;
  readonly serverFactory?: (
    options: SecureWindowsPipeServerOptions,
  ) => Promise<SecureCompanionServer>;
  readonly authenticate?: (
    pipe: MessagePipe,
    discovery: DiscoveryRecord,
    options: {
      authorizeIdentity: (identity: AcceptAuthenticatedPipeResult['identity']) => boolean;
    },
  ) => Promise<AcceptAuthenticatedPipeResult>;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class SecureCompanionTransport implements CompanionTransport {
  public readonly capabilities: CompanionTransport['capabilities'];

  private readonly options: SecureCompanionTransportOptions;
  private readonly pending = new Map<string, PendingRequest>();
  private server: SecureCompanionServer | undefined;
  private pipe: MessagePipe | undefined;
  private connectionPromise: Promise<CompanionConnection> | undefined;
  private receivePump: Promise<void> | undefined;
  private closed = false;

  public constructor(options: SecureCompanionTransportOptions = {}) {
    this.options = options;
    this.capabilities = {
      discoveryValidation: { level: 'available' },
      authenticatedHandshake: { level: 'available' },
      secureLocalEndpoint:
        (options.platform ?? process.platform) === 'win32'
          ? { level: 'available' }
          : {
              level: 'unavailable',
              reason: 'secure_named_pipe_is_windows_only',
            },
    };
  }

  public async connect(): Promise<CompanionConnection> {
    if (this.closed) {
      throw new BrowserBridgeError('SHUTDOWN', 'Companion transport is closed.', {
        stage: 'transport',
      });
    }
    if (this.capabilities.secureLocalEndpoint.level !== 'available') {
      throw new BrowserBridgeError(
        'CAPABILITY_UNAVAILABLE',
        'The secure companion endpoint is unavailable on this platform.',
        {
          stage: 'transport',
          recoverable: true,
          reason: this.capabilities.secureLocalEndpoint.reason,
        },
      );
    }
    this.connectionPromise ??= this.acceptConnection();
    return this.withConnectTimeout(this.connectionPromise);
  }

  public async request(request: CompanionRpcRequest): Promise<unknown> {
    await this.connect();
    const pipe = this.pipe;
    if (!pipe) {
      throw this.connectionLost('Authenticated companion pipe is unavailable.');
    }
    if (this.pending.has(request.id)) {
      throw new BrowserBridgeError(
        'INVALID_ARGUMENT',
        `Duplicate companion request ID: ${request.id}`,
        { stage: 'protocol', recoverable: false },
      );
    }
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
    });
    try {
      await pipe.send(request);
    } catch (error) {
      this.pending.delete(request.id);
      throw this.connectionLost(
        `Could not send companion request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return response;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(this.connectionLost('Companion transport closed.'));
    const pipe = this.pipe;
    const server = this.server;
    this.pipe = undefined;
    this.server = undefined;
    await Promise.allSettled([pipe?.close(), server?.close()]);
    await this.receivePump?.catch(() => undefined);
  }

  private async acceptConnection(): Promise<CompanionConnection> {
    const serverFactory =
      this.options.serverFactory ??
      ((options: SecureWindowsPipeServerOptions) =>
        createSecureWindowsPipeServer(options) as Promise<SecureWindowsPipeServer>);
    const server = await serverFactory({
      ...(this.options.helperPath ? { helperPath: this.options.helperPath } : {}),
    });
    this.server = server;
    try {
      await server.publishDiscovery(this.options.discoveryPath ?? defaultDiscoveryPath());
      const rawPipe = await server.accept();
      const expectedExtensionId = this.options.expectedExtensionId ?? EXPECTED_EXTENSION_ID;
      const authenticate = this.options.authenticate ?? acceptAuthenticatedPipe;
      const accepted = await authenticate(rawPipe, server.discovery, {
        authorizeIdentity: (identity) => identity.extensionId === expectedExtensionId,
      });
      if (accepted.identity.extensionId !== expectedExtensionId) {
        throw new BrowserBridgeError(
          'PERMISSION_DENIED',
          'The native host was launched by an unauthorized extension.',
          { stage: 'transport', recoverable: false },
        );
      }
      const hello = await this.receiveWithTimeout(
        accepted.pipe,
        this.options.connectTimeoutMs ?? 45_000,
        'Timed out waiting for the companion extension hello.',
      );
      const extensionCapabilities = this.validateExtensionHello(
        hello,
        accepted,
        expectedExtensionId,
      );
      this.pipe = accepted.pipe;
      this.receivePump = this.pumpResponses(accepted.pipe);
      void this.receivePump.catch(() => undefined);
      return {
        serverInstanceId: accepted.context.serverInstanceId,
        protocolVersion: accepted.context.protocolVersion,
        security: {
          local: true,
          authenticated: true,
          peerAccessRestricted: true,
          kind: 'named-pipe',
        },
        extensionCapabilities,
      };
    } catch (error) {
      await server.close().catch(() => undefined);
      throw error;
    }
  }

  private validateExtensionHello(
    value: unknown,
    accepted: AcceptAuthenticatedPipeResult,
    expectedExtensionId: string,
  ): unknown {
    if (!isRecord(value) || value['jsonrpc'] !== '2.0' || value['method'] !== 'extension.hello') {
      throw new BrowserBridgeError(
        'BROWSER_TOOL_CONTRACT_MISMATCH',
        'The first authenticated extension message was not extension.hello.',
        { stage: 'tool-contract', recoverable: false },
      );
    }
    const params = value['params'];
    if (
      !isRecord(params) ||
      params['protocolVersion'] !== COMPANION_PROTOCOL_VERSION ||
      params['extensionId'] !== expectedExtensionId ||
      params['extensionVersion'] !== accepted.identity.extensionVersion ||
      params['manifestVersion'] !== accepted.identity.manifestVersion
    ) {
      throw new BrowserBridgeError(
        'BROWSER_TOOL_CONTRACT_MISMATCH',
        'The companion extension hello does not match the authenticated native-host identity.',
        {
          stage: 'tool-contract',
          recoverable: false,
          expectedProtocol: COMPANION_PROTOCOL_VERSION,
        },
      );
    }
    return params['capabilities'];
  }

  private async pumpResponses(pipe: MessagePipe): Promise<void> {
    try {
      while (!this.closed) {
        const value = await pipe.receive();
        if (value === null) {
          throw this.connectionLost('Companion extension disconnected.');
        }
        if (!isRecord(value) || value['jsonrpc'] !== '2.0') {
          throw new BrowserBridgeError(
            'UPSTREAM_ERROR',
            'Companion extension returned a malformed JSON-RPC message.',
            { stage: 'protocol', recoverable: false },
          );
        }
        const id = value['id'];
        if (typeof id !== 'string') continue;
        const pending = this.pending.get(id);
        if (!pending) continue;
        this.pending.delete(id);
        pending.resolve(value);
      }
    } catch (error) {
      const bridgeError =
        error instanceof BrowserBridgeError
          ? error
          : this.connectionLost(error instanceof Error ? error.message : String(error));
      this.rejectPending(bridgeError);
      if (!this.closed) {
        await pipe.close().catch(() => undefined);
      }
      throw bridgeError;
    }
  }

  private rejectPending(error: unknown): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async withConnectTimeout(
    connection: Promise<CompanionConnection>,
  ): Promise<CompanionConnection> {
    const timeoutMs = this.options.connectTimeoutMs ?? 45_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        connection,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new BrowserBridgeError(
                  'TIMEOUT',
                  `No authenticated LibreWolf companion connected within ${timeoutMs} ms.`,
                  {
                    stage: 'transport',
                    recoverable: true,
                    hint: 'Install and enable the companion extension, then retry.',
                  },
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async receiveWithTimeout(
    pipe: MessagePipe,
    timeoutMs: number,
    message: string,
  ): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        pipe.receive(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new BrowserBridgeError('TIMEOUT', message, {
                  stage: 'transport',
                  recoverable: true,
                }),
              ),
            timeoutMs,
          );
        }),
      ]);
      if (value === null) {
        throw this.connectionLost('Companion extension disconnected before hello.');
      }
      return value;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private connectionLost(message: string): BrowserBridgeError {
    return new BrowserBridgeError('BROWSER_CONNECTION_FAILED', message, {
      stage: 'transport',
      recoverable: true,
    });
  }
}
