import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const forbidden = new Set([
  '<all_urls>',
  'history',
  'cookies',
  'bookmarks',
  'webRequest',
  'debugger',
]);

describe.each([
  ['MV3', 'manifest.json'],
  ['MV2', 'manifest.mv2.json'],
])('%s manifest', (variant, filename) => {
  it('uses the stable native-messaging extension ID', async () => {
    const manifest = await readManifest(filename);
    expect(manifest.browser_specific_settings.gecko.id).toBe(
      'librewolf-agent-bridge@librewolf-agent-bridge.org',
    );
  });

  it('does not request forbidden ambient browser data permissions', async () => {
    const manifest = await readManifest(filename);
    const requested = [
      ...(manifest.permissions ?? []),
      ...(manifest.optional_permissions ?? []),
      ...(manifest.host_permissions ?? []),
      ...(manifest.optional_host_permissions ?? []),
    ];
    expect(requested.filter((permission) => forbidden.has(permission))).toEqual([]);
  });

  it('keeps site access optional', async () => {
    const manifest = await readManifest(filename);
    const mandatory = [...(manifest.permissions ?? []), ...(manifest.host_permissions ?? [])];
    expect(mandatory.some((permission) => permission.includes('://'))).toBe(false);
    const optional = [
      ...(manifest.optional_permissions ?? []),
      ...(manifest.optional_host_permissions ?? []),
    ];
    expect(optional).toContain('https://*/*');
  });

  it('uses a Firefox background script rather than a service worker', async () => {
    const manifest = await readManifest(filename);
    expect(manifest.background.scripts).toEqual(['background/index.js']);
    expect(manifest.background.service_worker).toBeUndefined();
    if (variant === 'MV2') expect(manifest.background.persistent).toBe(false);
  });
});

interface TestManifest {
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  background: {
    scripts?: string[];
    service_worker?: string;
    persistent?: boolean;
  };
  browser_specific_settings: { gecko: { id: string } };
}

async function readManifest(filename: string): Promise<TestManifest> {
  return JSON.parse(await readFile(resolve(root, filename), 'utf8')) as TestManifest;
}
