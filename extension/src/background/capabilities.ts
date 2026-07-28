import { INTERNAL_PROTOCOL_VERSION, type CompanionCapabilities } from '../shared/protocol.js';

export function companionCapabilities(): CompanionCapabilities {
  return {
    mode: 'companion_extension',
    protocolVersion: INTERNAL_PROTOCOL_VERSION,
    features: {
      tabManagement: { level: 'available' },
      domSnapshot: { level: 'available' },
      domActions: {
        level: 'degraded',
        reason: 'synthetic_dom_events',
        constraints: ['events_have_isTrusted_false', 'site_code_may_reject_synthetic_input'],
      },
      batch: {
        level: 'available',
        constraints: ['maximum_25_actions', 'not_transactional', 'stops_on_first_error_by_default'],
      },
      actionHighlighting: {
        level: 'available',
        constraints: ['ephemeral_1200ms', 'companion_dom_actions_only'],
      },
      screenshot: {
        level: 'degraded',
        reason: 'active_visible_tab_only',
        constraints: ['requires_toolbar_activeTab_grant'],
      },
      downloads: {
        level: 'conditional',
        reason: 'optional_downloads_permission',
        constraints: ['bridge_initiated_downloads_only'],
      },
      uploadFile: {
        level: 'unavailable',
        reason: 'safe_os_file_selection_requires_controlled_profile',
      },
      consoleInspection: {
        level: 'unavailable',
        reason: 'requires_controlled_profile_bidi',
      },
      networkInspection: {
        level: 'unavailable',
        reason: 'requires_controlled_profile_bidi',
      },
      secureNamedPipeAcl: {
        level: 'unavailable',
        reason: 'native_windows_acl_component_not_installed',
      },
    },
  };
}
