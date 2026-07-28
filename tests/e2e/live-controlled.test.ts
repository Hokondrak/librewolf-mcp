import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startFixtureServer, type FixtureServer } from '../fixtures/fixture-server.js';

/**
 * Live end-to-end coverage: the built MCP CLI over stdio, driving a real LibreWolf process in a
 * dedicated headless profile. These are the acceptance criteria that cannot be proven without a
 * browser, so the suite is opt-in.
 *
 *   $env:LIBREWOLF_AGENT_BRIDGE_E2E = '1'; npm run build; npm run test:e2e
 *
 * Without the flag, or without a built CLI, the suite skips instead of failing, so `npm test`
 * stays hermetic on machines that have no LibreWolf installed.
 */

const workspaceRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const cliPath = resolve(workspaceRoot, 'apps', 'mcp-server', 'dist', 'cli.js');
const browserPath = process.env['LIBREWOLF_PATH'] ?? 'C:\\Program Files\\LibreWolf\\librewolf.exe';
const runId = randomUUID().slice(0, 12);
const outputRoot = resolve(workspaceRoot, '.temp', 'e2e', runId);

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

const uidFor = (snapshot: string, label: string): string => {
  const line = snapshot.split(/\r?\n/u).find((candidate) => candidate.includes(`"${label}"`));
  const uid = line?.match(/\[uid=([^\]]+)\]/u)?.[1];
  if (!uid) {
    throw new Error(`No UID for "${label}" in snapshot:\n${snapshot}`);
  }
  return uid;
};

const poll = async <T>(
  operation: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let latest = await operation();
  while (!predicate(latest) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    latest = await operation();
  }
  return latest;
};

describe.skipIf(skipReason !== undefined)('live controlled LibreWolf session', () => {
  let client: Client;
  let fixture: FixtureServer;

  const callOk = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<CallToolResult> => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    if (result.isError) {
      throw new Error(`${name} failed: ${textOf(result)}`);
    }
    return result;
  };

  beforeAll(async () => {
    await mkdir(outputRoot, { recursive: true });
    fixture = await startFixtureServer();
    client = new Client({ name: 'librewolf-agent-bridge-e2e', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          cliPath,
          '--mode',
          'controlled',
          '--librewolf-path',
          browserPath,
          '--profile-root',
          resolve(outputRoot, 'profiles'),
          '--profile',
          `e2e-${runId}`,
          '--output',
          resolve(outputRoot, 'output'),
          '--headless',
          '--viewport',
          '1280x720',
          '--start-url',
          'about:blank',
        ],
        cwd: workspaceRoot,
        stderr: 'pipe',
      }),
      { timeout: 120_000 },
    );
    await callOk('browser_navigate', { url: fixture.url });
  }, 180_000);

  afterAll(async () => {
    await client?.close();
    await fixture?.close();
    // LibreWolf can still be releasing profile handles (cert9.db) for a moment after the MCP
    // server exits, so removal is retried and never fails the suite.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await rm(outputRoot, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      }
    }
  }, 30_000);

  it('reports controlled mode with explicit capability levels', async () => {
    const status = JSON.parse(textOf(await callOk('browser_status'))) as {
      mode: string;
      capabilities: Record<string, { level: string }>;
    };
    expect(status.mode).toBe('controlled');
    expect(status.capabilities['snapshots']?.level).toBe('available');
    // Screen recording is gated on Firefox 154+; it must not claim availability on 146.
    expect(['unavailable', 'degraded']).toContain(status.capabilities['screenRecording']?.level);
  });

  it('lists the dedicated tab and keeps a normal-page snapshot under 20 KB', async () => {
    const tabs = JSON.parse(textOf(await callOk('browser_list_tabs'))) as { selected: boolean }[];
    expect(tabs.some((tab) => tab.selected)).toBe(true);

    const snapshot = textOf(await callOk('browser_snapshot'));
    expect(snapshot).toContain('BEGIN UNTRUSTED WEBPAGE CONTENT');
    expect(snapshot).toContain('Account settings');
    expect(Buffer.byteLength(snapshot, 'utf8')).toBeLessThan(20 * 1024);
  });

  it('fills and submits a multi-field form, then observes the resulting DOM change', async () => {
    const snapshot = textOf(await callOk('browser_snapshot'));
    await callOk('browser_fill_form', {
      fields: [
        { uid: uidFor(snapshot, 'Email'), value: 'max@example.test' },
        { uid: uidFor(snapshot, 'Password'), value: 'e2e-form-secret' },
      ],
    });
    await callOk('browser_click', { uid: uidFor(snapshot, 'Save') });

    const settled = await poll(
      async () => textOf(await callOk('browser_snapshot')),
      (text) => text.includes('Saved'),
    );
    expect(settled).toContain('Saved');
  });

  it('filters console output down to the fixture error', async () => {
    const console = await poll(
      async () => textOf(await callOk('browser_get_console', { errors_only: true })),
      (text) => text.includes('fixture-console-failure'),
    );
    expect(console).toContain('fixture-console-failure');
  });

  it('lists the failed request, inspects it individually, and redacts its secrets', async () => {
    const listing = await poll(
      async () => textOf(await callOk('browser_get_network', { errors_only: true })),
      (text) => text.includes('/api/save'),
    );
    expect(listing).toContain('503');
    expect(listing).not.toContain('header-secret');
    expect(listing).not.toContain('query-secret');

    const requestId = listing.match(/"id":\s*"([^"]+)"/u)?.[1] ?? '';
    expect(requestId).not.toBe('');

    const detail = textOf(await callOk('browser_get_request', { request_id: requestId }));
    expect(detail).not.toContain('header-secret');
    expect(detail).not.toContain('e2e-form-secret');
    expect(detail).not.toContain('cookie-secret');
  });

  it('saves a screenshot to a caller-provided path', async () => {
    const target = resolve(outputRoot, `screenshot-${runId}.png`);
    await callOk('browser_screenshot', { path: target });

    const info = await stat(target);
    expect(info.size).toBeGreaterThan(1_000);
    // PNG magic number, so the file is a real image rather than an error page.
    expect((await readFile(target)).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('recovers from a stale UID by taking a new snapshot', async () => {
    const stale = uidFor(textOf(await callOk('browser_snapshot')), 'Save');
    await callOk('browser_navigate', { url: `${fixture.url}&second=1` });

    const failure = (await client.callTool({
      name: 'browser_click',
      arguments: { uid: stale },
    })) as CallToolResult;
    expect(failure.isError).toBe(true);
    expect(JSON.parse(textOf(failure))).toMatchObject({ code: 'STALE_REFERENCE' });

    const fresh = textOf(await callOk('browser_snapshot'));
    await callOk('browser_click', { uid: uidFor(fresh, 'Save') });
  });

  it('executes a self-contained ten-action batch through one MCP tool call', async () => {
    const started = performance.now();
    // The batch takes its own snapshot and references the UIDs it issued, so it does not
    // depend on any UID captured before the call.
    const batch = JSON.parse(
      textOf(
        await callOk('browser_batch', {
          actions: [
            { op: 'status' },
            { op: 'list_tabs' },
            { op: 'snapshot', as: 'page' },
            { op: 'fill', uid: { $ref: 'page.uids.Email' }, value: 'batch@example.test' },
            { op: 'fill', uid: { $ref: 'page.uids.Password' }, value: 'e2e-batch-secret' },
            { op: 'click', uid: { $ref: 'page.uids.Save' } },
            { op: 'wait_for_text', text: 'Saved' },
            { op: 'get_console', severity: 'error' },
            { op: 'get_network', errors_only: true },
            { op: 'get_downloads' },
          ],
        }),
      ),
    ) as { results: { ok: boolean; op: string; error?: unknown }[]; transportCalls: number };

    const failures = batch.results.filter((entry) => !entry.ok);
    expect(JSON.stringify(failures)).toBe('[]');
    expect(batch.results).toHaveLength(10);
    expect(batch.transportCalls).toBe(1);
    expect(JSON.stringify(batch)).not.toContain('e2e-batch-secret');
    // Not a benchmark: a generous ceiling that still fails if a batch degrades into
    // ten separate round trips plus browser waits.
    expect(performance.now() - started).toBeLessThan(30_000);
  });
});

describe.skipIf(skipReason === undefined)('live controlled LibreWolf session', () => {
  it.skip(`skipped: ${skipReason ?? ''}`, () => undefined);
});
