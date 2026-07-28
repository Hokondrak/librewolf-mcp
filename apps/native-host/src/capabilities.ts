import type { HostCapability } from './types.js';

export const BASE_HOST_CAPABILITIES: Record<string, HostCapability> = {
  nativeMessageFraming: { level: 'available' },
  discoveryValidation: { level: 'available' },
  authenticatedHandshake: { level: 'available' },
  secureNamedPipeAcl: {
    level: 'unavailable',
    reason: 'native_windows_acl_component_not_installed',
  },
  discoveryRecordAclVerification: {
    level: 'unavailable',
    reason: 'native_windows_acl_component_not_installed',
  },
};
