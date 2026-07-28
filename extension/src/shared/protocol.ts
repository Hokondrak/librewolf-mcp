export const NATIVE_HOST_NAME = 'org.librewolf_agent_bridge.native';
export const INTERNAL_PROTOCOL_VERSION = '1.0.0';

export type CapabilityLevel = 'available' | 'degraded' | 'conditional' | 'unavailable';

export interface FeatureCapability {
  level: CapabilityLevel;
  reason?: string;
  constraints?: string[];
}

export interface CompanionCapabilities {
  mode: 'companion_extension';
  protocolVersion: string;
  features: Record<string, FeatureCapability>;
}

export interface ExtensionRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: 'extension.execute';
  params: {
    requestId: string;
    operation: string;
    deadlineAt?: string;
    target?: {
      tabId?: number;
      frameId?: number;
      documentId?: string;
      navigationGeneration?: number;
    };
    arguments?: Record<string, unknown>;
    idempotencyKey?: string;
  };
}

export interface RpcErrorData {
  code: string;
  message: string;
  recoverable: boolean;
  details?: Record<string, unknown>;
}

export function isExtensionRequest(value: unknown): value is ExtensionRequest {
  if (!isRecord(value) || value['jsonrpc'] !== '2.0' || value['method'] !== 'extension.execute') {
    return false;
  }
  const params = value['params'];
  return (
    (typeof value['id'] === 'string' || typeof value['id'] === 'number') &&
    isRecord(params) &&
    typeof params['requestId'] === 'string' &&
    typeof params['operation'] === 'string'
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function rpcSuccess(id: string | number, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

export function rpcFailure(
  id: string | number | null,
  error: RpcErrorData,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: error.message,
      data: error,
    },
  };
}
