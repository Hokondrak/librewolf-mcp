export interface DiscoveryRecord {
  schemaVersion: 1;
  serverInstanceId: string;
  ownerPid: number;
  ownerCreatedAtFiletime?: string;
  pipeName: string;
  protocol: {
    min: string;
    max: string;
  };
  auth: {
    scheme: 'hmac-sha256-v1';
    token: string;
  };
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface MessagePipe {
  send(message: unknown): Promise<void>;
  receive(): Promise<unknown | null>;
  close(): Promise<void>;
}

export interface PipeConnector {
  readonly capabilities: Record<string, HostCapability>;
  connect(record: DiscoveryRecord): Promise<MessagePipe>;
}

export interface HostCapability {
  level: 'available' | 'degraded' | 'unavailable';
  reason?: string;
}

export interface AuthenticatedContext {
  connectionId: string;
  protocolVersion: string;
  serverInstanceId: string;
}

export interface NativeHostIdentity {
  extensionId: string;
  extensionVersion: string;
  manifestVersion: 2 | 3;
  hostVersion: string;
  browserName: string;
  browserVersion: string;
}
