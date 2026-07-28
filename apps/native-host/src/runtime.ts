import type { Writable } from 'node:stream';

import { BASE_HOST_CAPABILITIES } from './capabilities.js';
import { loadDiscoveryRecord } from './discovery.js';
import { decodeNativeMessages, NativeMessageWriter } from './framing.js';
import { openAuthenticatedPipe } from './handshake.js';
import { relayMessages } from './relay.js';
import { SecureWindowsPipeConnector, SecureWindowsPipeError } from './secure-windows-pipe.js';
import { SecurePipeCapabilityUnavailableError } from './unavailable-pipe.js';
import type { DiscoveryRecord, NativeHostIdentity, PipeConnector } from './types.js';

export interface NativeHostRuntimeOptions {
  input: AsyncIterable<Uint8Array | string>;
  output: Writable;
  identity: NativeHostIdentity;
  connector?: PipeConnector;
  loadDiscovery?: () => Promise<DiscoveryRecord>;
}

export class NativeHostRuntime {
  readonly #writer: NativeMessageWriter;
  readonly #connector: PipeConnector;
  readonly #loadDiscovery: () => Promise<DiscoveryRecord>;

  constructor(private readonly options: NativeHostRuntimeOptions) {
    this.#writer = new NativeMessageWriter(options.output);
    this.#connector = options.connector ?? new SecureWindowsPipeConnector();
    this.#loadDiscovery = options.loadDiscovery ?? (() => loadDiscoveryRecord());
  }

  async run(): Promise<void> {
    let discovery: DiscoveryRecord;
    try {
      discovery = await this.#loadDiscovery();
    } catch (error) {
      await this.#writeUnavailable('discovery_record_invalid', safeError(error));
      this.#writer.close();
      return;
    }

    let pipe;
    try {
      pipe = await this.#connector.connect(discovery);
      const decoded = decodeNativeMessages(this.options.input);
      const iterator = decoded[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done) throw new Error('Extension closed native messaging before sending hello.');
      const identity = identityFromExtensionHello(first.value, this.options.identity);
      const authenticated = await openAuthenticatedPipe(pipe, discovery, identity);
      pipe = authenticated.pipe;
      await pipe.send(first.value);
      await this.#writer.write({
        jsonrpc: '2.0',
        method: 'host.status',
        params: {
          connected: true,
          serverInstanceId: authenticated.context.serverInstanceId,
          protocolVersion: authenticated.context.protocolVersion,
          capabilities: {
            ...BASE_HOST_CAPABILITIES,
            ...this.#connector.capabilities,
          },
        },
      });
      await relayMessages(remainingMessages(iterator), this.#writer, pipe);
    } catch (error) {
      if (pipe) await pipe.close().catch(() => undefined);
      const reason =
        error instanceof SecurePipeCapabilityUnavailableError
          ? 'native_windows_acl_component_not_installed'
          : error instanceof SecureWindowsPipeError && error.code === 'UNSUPPORTED_PLATFORM'
            ? 'unsupported_platform'
            : error instanceof SecureWindowsPipeError && error.code === 'NATIVE_HELPER_NOT_FOUND'
              ? 'native_windows_acl_component_not_installed'
              : 'pipe_connection_or_authentication_failed';
      await this.#writeUnavailable(reason, safeError(error));
    } finally {
      this.#writer.close();
    }
  }

  async #writeUnavailable(reason: string, error: string): Promise<void> {
    await this.#writer.write({
      jsonrpc: '2.0',
      method: 'host.status',
      params: {
        connected: false,
        reason,
        error,
        capabilities: {
          ...BASE_HOST_CAPABILITIES,
          ...this.#connector.capabilities,
        },
      },
    });
  }
}

function identityFromExtensionHello(
  value: unknown,
  fallback: NativeHostIdentity,
): NativeHostIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Extension hello must be an object.');
  }
  const root = value as Record<string, unknown>;
  const params =
    typeof root['params'] === 'object' && root['params'] !== null && !Array.isArray(root['params'])
      ? (root['params'] as Record<string, unknown>)
      : undefined;
  if (root['method'] !== 'extension.hello' || !params) {
    throw new Error('First extension message must be extension.hello.');
  }
  if (params['extensionId'] !== fallback.extensionId) {
    throw new Error('Extension hello ID does not match the launching extension.');
  }
  const extensionVersion = params['extensionVersion'];
  const manifestVersion = params['manifestVersion'];
  if (typeof extensionVersion !== 'string' || (manifestVersion !== 2 && manifestVersion !== 3)) {
    throw new Error('Extension hello version metadata is invalid.');
  }
  return { ...fallback, extensionVersion, manifestVersion };
}

async function* remainingMessages(iterator: AsyncIterator<unknown>): AsyncGenerator<unknown> {
  while (true) {
    const item = await iterator.next();
    if (item.done) return;
    yield item.value;
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[A-Za-z0-9_-]{43}/g, '[REDACTED_TOKEN]').slice(0, 500);
}
