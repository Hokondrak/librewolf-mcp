import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Live companion-mode coverage: the built MCP CLI drives a real LibreWolf session through the
 * native messaging host and the companion extension, rather than a dedicated profile.
 *
 *   npm run build
 *   npm run package:all
 *   pwsh packaging/windows/install-native-host.ps1 -PayloadRoot <payload> -Apply
 *   $env:LIBREWOLF_AGENT_BRIDGE_COMPANION_E2E = '1'; npm run test:e2e
 *
 * The suite builds its own scratch profile: it sideloads the MV2 build, disables signature
 * enforcement, and pre-grants both the bridge's own per-origin permissions and the browser-level
 * optional host permissions. Those grants normally come from the extension popup; seeding them
 * keeps the run non-interactive without weakening the product default, which still refuses page
 * reads until the user approves an origin.
 *
 * Skips unless explicitly requested and the native host is registered, so `npm test` stays
 * hermetic.
 */

const EXTENSION_ID = 'librewolf-agent-bridge@librewolf-agent-bridge.org';
const ORIGINS = ['https://example.com', 'https://www.iana.org'];

const workspaceRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const cliPath = resolve(workspaceRoot, 'apps', 'mcp-server', 'dist', 'cli.js');
const browserPath = process.env['LIBREWOLF_PATH'] ?? 'C:\\Program Files\\LibreWolf\\librewolf.exe';
const xpiPath = resolve(
  workspaceRoot,
  'artifacts',
  'librewolf-agent-bridge-extension-mv2-0.1.0.xpi',
);
const nativeHostManifest = join(
  homedir(),
  'AppData',
  'Local',
  'LibreWolfAgentBridge',
  'native-host',
  'org.librewolf_agent_bridge.native.json',
);

const requested = process.env['LIBREWOLF_AGENT_BRIDGE_COMPANION_E2E'] === '1';
const skipReason = !requested
  ? 'set LIBREWOLF_AGENT_BRIDGE_COMPANION_E2E=1 to run the live companion suite'
  : process.platform !== 'win32'
    ? 'the hardened companion transport is Windows-only'
    : !existsSync(cliPath)
      ? `no built CLI at ${cliPath}; run npm run build`
      : !existsSync(xpiPath)
        ? `no packaged extension at ${xpiPath}; run npm run package:all`
        : !existsSync(nativeHostManifest)
          ? 'native messaging host is not registered; run packaging/windows/install-native-host.ps1 -Apply'
          : undefined;

const textOf = (result: CallToolResult): string =>
  result.content
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text)
    .join('\n');

describe.skipIf(skipReason !== undefined)('live companion LibreWolf session', () => {
  let client: Client;
  let profile: string;
  let browserPid: number | undefined;

  const call = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; text: string }> => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    return { ok: !result.isError, text: textOf(result) };
  };

  beforeAll(async () => {
    profile = join(tmpdir(), `lw-companion-${Date.now()}`);
    await mkdir(join(profile, 'extensions'), { recursive: true });
    await writeFile(
      join(profile, 'user.js'),
      [
        'user_pref("xpinstall.signatures.required", false);',
        'user_pref("extensions.autoDisableScopes", 0);',
        'user_pref("extensions.enabledScopes", 15);',
        'user_pref("extensions.webextensions.ExtensionStorageIDB.enabled", false);',
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(join(profile, 'extensions', `${EXTENSION_ID}.xpi`), await readFile(xpiPath));

    // Grants the extension popup would otherwise collect interactively.
    const categories = ['read_page', 'interact', 'download', 'sensitive_action'];
    await mkdir(join(profile, 'browser-extension-data', EXTENSION_ID), { recursive: true });
    await writeFile(
      join(profile, 'browser-extension-data', EXTENSION_ID, 'storage.js'),
      JSON.stringify({
        'bridge.permissions.v1': {
          version: 1,
          policies: ORIGINS.flatMap((origin) =>
            categories.map((category) => ({ origin, category, decision: 'always_allow' })),
          ),
        },
      }),
      'utf8',
    );
    await writeFile(
      join(profile, 'extension-preferences.json'),
      JSON.stringify({
        [EXTENSION_ID]: { permissions: [], origins: ORIGINS.map((o) => `${o}/*`) },
      }),
      'utf8',
    );

    client = new Client({ name: 'companion-e2e', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cliPath, '--mode', 'companion'],
        cwd: workspaceRoot,
        stderr: 'pipe',
      }),
      { timeout: 60_000 },
    );

    // Publication is lazy: the first call opens the transport and writes the discovery record,
    // which the extension's native host then reads. Start it before launching the browser.
    const ready = call('browser_status');
    await new Promise((resolveWait) => setTimeout(resolveWait, 3000));
    const browser = spawn(browserPath, ['-profile', profile, '-no-remote', ORIGINS[0]!], {
      stdio: 'ignore',
    });
    browserPid = browser.pid;
    const status = await ready;
    expect(JSON.parse(status.text).state).toBe('ready');
  }, 180_000);

  afterAll(async () => {
    await client?.close();
    if (browserPid !== undefined) {
      spawn('taskkill', ['/PID', String(browserPid), '/T', '/F'], { stdio: 'ignore' });
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }, 30_000);

  it('reports companion mode with honest capability levels', async () => {
    const status = JSON.parse((await call('browser_status')).text) as {
      mode: string;
      capabilities: Record<string, { level: string }>;
    };
    expect(status.mode).toBe('companion');
    expect(status.capabilities['tabs']?.level).toBe('available');
    // Console and network need WebDriver BiDi, which companion mode does not have.
    expect(status.capabilities['console']?.level).toBe('unavailable');
    expect(status.capabilities['network']?.level).toBe('unavailable');
    expect(status.capabilities['nativeInput']?.level).toBe('degraded');
  });

  it('lists the real session tabs with their titles and URLs', async () => {
    const tabs = JSON.parse((await call('browser_list_tabs')).text) as {
      title: string;
      url?: string;
      selected: boolean;
    }[];
    const selected = tabs.find((tab) => tab.selected);
    expect(selected?.url).toContain('example.com');
    expect(selected?.title).toBe('Example Domain');
  });

  it('snapshots a real page behind the untrusted-content boundary', async () => {
    const snapshot = await call('browser_snapshot', { max_chars: 4000 });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.text).toContain('untrusted data');
    expect(snapshot.text).toContain('Example Domain');
    expect(snapshot.text).toMatch(/\[uid=[^\]]+\] link "Learn more"/u);
  });

  it('clicks a UID and moves the real tab, reporting the synthetic-event caveat', async () => {
    const snapshot = await call('browser_snapshot', { max_chars: 4000 });
    const uid = snapshot.text.match(/\[uid=([^\]]+)\] link "Learn more"/u)?.[1];
    expect(uid).toBeTruthy();

    const clicked = JSON.parse((await call('browser_click', { uid: uid! })).text) as {
      ok: boolean;
      data?: { degraded?: boolean };
    };
    expect(clicked.ok).toBe(true);
    // Companion input is synthetic; the bridge says so rather than implying a trusted event.
    expect(clicked.data?.degraded).toBe(true);

    await new Promise((resolveWait) => setTimeout(resolveWait, 3000));
    const tabs = JSON.parse((await call('browser_list_tabs')).text) as {
      url?: string;
      selected: boolean;
    }[];
    expect(tabs.find((tab) => tab.selected)?.url).toContain('iana.org');
  }, 60_000);

  it('refuses an origin the user has not approved, and says how to approve it', async () => {
    // The gate is on the operation, not only on reading the result: an unapproved origin cannot
    // be navigated to either. Approval is the user's to give, in the extension popup.
    const navigated = await call('browser_navigate', { url: 'https://example.net' });
    expect(navigated.ok).toBe(false);

    const error = JSON.parse(navigated.text) as {
      code: string;
      details?: { remoteDetails?: { origin?: string; approvalSurface?: string } };
    };
    expect(error.code).toBe('PERMISSION_REQUIRED');
    expect(error.details?.remoteDetails?.origin).toBe('https://example.net');
    expect(error.details?.remoteDetails?.approvalSurface).toBe('extension_popup');
  }, 60_000);
});
