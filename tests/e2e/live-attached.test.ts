import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Live attached-mode coverage: the bridge joins a LibreWolf the user already started, keeping
 * their profile and therefore their signed-in sessions, while still driving it over WebDriver
 * BiDi. That combination is what companion mode cannot offer — input stays native rather than
 * synthetic, and console and network capture keep working.
 *
 *   npm run build
 *   $env:LIBREWOLF_AGENT_BRIDGE_E2E = '1'; npm run test:e2e
 *
 * The browser is started here exactly as packaging/windows/enable-attached-mode.ps1's shortcut
 * does: with --marionette and --remote-debugging-port. Firefox only starts Marionette from the
 * command line, so no preference can substitute for those flags.
 */

const workspaceRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const cliPath = resolve(workspaceRoot, 'apps', 'mcp-server', 'dist', 'cli.js');
const browserPath = process.env['LIBREWOLF_PATH'] ?? 'C:\\Program Files\\LibreWolf\\librewolf.exe';
const MARIONETTE_PORT = 2828;

const requested = process.env['LIBREWOLF_AGENT_BRIDGE_E2E'] === '1';
const skipReason = !requested
  ? 'set LIBREWOLF_AGENT_BRIDGE_E2E=1 to run the live suite'
  : !existsSync(cliPath)
    ? `no built CLI at ${cliPath}; run npm run build first`
    : !existsSync(browserPath)
      ? `no LibreWolf at ${browserPath}; set LIBREWOLF_PATH`
      : undefined;

const textOf = (result: CallToolResult): string =>
  result.content
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text)
    .join('\n');

describe.skipIf(skipReason !== undefined)('live attached LibreWolf session', () => {
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
    profile = join(tmpdir(), `lw-attached-${Date.now()}`);
    await mkdir(profile, { recursive: true });
    await writeFile(
      join(profile, 'user.js'),
      'user_pref("browser.shell.checkDefaultBrowser", false);\n',
      'utf8',
    );

    const browser = spawn(
      browserPath,
      [
        '-profile',
        profile,
        '-no-remote',
        '--marionette',
        '--remote-debugging-port',
        '9222',
        'https://example.com',
      ],
      { stdio: 'ignore' },
    );
    browserPid = browser.pid;
    await new Promise((resolveWait) => setTimeout(resolveWait, 12_000));

    client = new Client({ name: 'attached-e2e', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cliPath, '--mode', 'attached', '--marionette-port', String(MARIONETTE_PORT)],
        cwd: workspaceRoot,
        stderr: 'pipe',
      }),
      { timeout: 120_000 },
    );
  }, 180_000);

  afterAll(async () => {
    await client?.close();
    if (browserPid !== undefined) {
      spawn('taskkill', ['/PID', String(browserPid), '/T', '/F'], { stdio: 'ignore' });
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }, 30_000);

  it('reports attached mode with the capabilities companion mode lacks', async () => {
    const status = JSON.parse((await call('browser_status')).text) as {
      mode: string;
      capabilities: Record<string, { level: string }>;
    };
    expect(status.mode).toBe('attached');
    // The point of attached mode: BiDi-backed capabilities on the user's own browser.
    expect(status.capabilities['console']?.level).toBe('available');
    expect(status.capabilities['network']?.level).toBe('available');
    expect(status.capabilities['upload']?.level).toBe('available');
  });

  it('sees the already-open tab rather than a dedicated profile', async () => {
    const tabs = JSON.parse((await call('browser_list_tabs')).text) as {
      title: string;
      selected: boolean;
    }[];
    expect(tabs.find((tab) => tab.selected)?.title).toBe('Example Domain');
  });

  it('snapshots and clicks through the same UID contract as controlled mode', async () => {
    const snapshot = await call('browser_snapshot', { max_chars: 20_000 });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.text).toContain('Example Domain');

    const uid = snapshot.text.match(/\[uid=([^\]]+)\] link "Learn more"/u)?.[1];
    expect(uid).toBeTruthy();
    const clicked = JSON.parse((await call('browser_click', { uid: uid! })).text) as {
      ok: boolean;
    };
    expect(clicked.ok).toBe(true);
  }, 60_000);

  it('reads console and network from the attached session', async () => {
    expect((await call('browser_get_console', { limit: 5 })).ok).toBe(true);
    expect((await call('browser_get_network', { limit: 5 })).ok).toBe(true);
  }, 30_000);
});
