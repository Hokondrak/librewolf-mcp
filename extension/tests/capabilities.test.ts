import { describe, expect, it } from 'vitest';

import { companionCapabilities } from '../src/background/capabilities.js';

describe('companion capability reporting', () => {
  it('does not imply BiDi or secure-pipe capabilities are available', () => {
    const capabilities = companionCapabilities();
    expect(capabilities.features['networkInspection']?.level).toBe('unavailable');
    expect(capabilities.features['consoleInspection']?.level).toBe('unavailable');
    expect(capabilities.features['uploadFile']?.level).toBe('unavailable');
    expect(capabilities.features['actionHighlighting']).toMatchObject({
      level: 'available',
      constraints: ['ephemeral_1200ms', 'companion_dom_actions_only'],
    });
    expect(capabilities.features['secureNamedPipeAcl']).toMatchObject({
      level: 'unavailable',
      reason: 'native_windows_acl_component_not_installed',
    });
  });
});
