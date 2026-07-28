import { BASE_HOST_CAPABILITIES } from './capabilities.js';
import type { DiscoveryRecord, MessagePipe, PipeConnector } from './types.js';

export class SecurePipeCapabilityUnavailableError extends Error {
  readonly code = 'SECURE_NAMED_PIPE_UNAVAILABLE';

  constructor() {
    super(
      'Secure Windows named-pipe transport is unavailable until the native ACL component is installed.',
    );
    this.name = 'SecurePipeCapabilityUnavailableError';
  }
}

export class UnavailableSecureWindowsPipeConnector implements PipeConnector {
  readonly capabilities = BASE_HOST_CAPABILITIES;

  async connect(_record: DiscoveryRecord): Promise<MessagePipe> {
    throw new SecurePipeCapabilityUnavailableError();
  }
}
