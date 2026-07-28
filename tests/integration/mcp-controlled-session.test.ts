import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import { ControlledBrowserSession } from '@librewolf-agent-bridge/browser-core';
import { createBrowserMcpServer } from 'librewolf-agent-bridge';

import { FakeUpstream } from '../fixtures/fake-upstream.js';
import {
  accountFormAfterSaveSnapshot,
  accountFormSnapshot,
  secondDocumentSnapshot,
} from '../fixtures/upstream-snapshots.js';

/**
 * Cross-package integration: a real MCP client speaks to the real tool surface, which drives a
 * real `ControlledBrowserSession`, snapshot engine, UID registry, and redaction pipeline. Only
 * the Mozilla upstream process is replaced. The per-package unit suites cover these layers in
 * isolation; this suite covers the seams between them.
 */

const teardown: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of teardown.splice(0).reverse()) {
    await dispose();
  }
});

const connect = async (
  snapshots: readonly string[],
): Promise<{ client: Client; upstream: FakeUpstream }> => {
  const root = await mkdtemp(join(tmpdir(), 'librewolf-agent-bridge-integration-'));
  let upstream: FakeUpstream | undefined;
  const session = new ControlledBrowserSession({
    browserPath: 'C:\\Program Files\\LibreWolf\\librewolf.exe',
    profileRoot: join(root, 'profiles'),
    outputDirectory: join(root, 'output'),
    removeProfileOnClose: true,
    upstreamFactory: (options) => {
      upstream = new FakeUpstream(options, snapshots);
      return upstream;
    },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createBrowserMcpServer(session);
  const client = new Client({ name: 'integration-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  teardown.push(async () => {
    await client.close();
    await server.close();
    await session.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  await client.callTool({ name: 'browser_list_tabs', arguments: {} });
  if (!upstream) {
    throw new Error('The fake upstream was never constructed.');
  }
  return { client, upstream };
};

const textOf = (result: CallToolResult): string =>
  result.content
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text)
    .join('\n');

const callOk = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> => {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (result.isError) {
    throw new Error(`${name} failed: ${textOf(result)}`);
  }
  return result;
};

const uidFor = (snapshot: string, label: string): string => {
  const line = snapshot.split(/\r?\n/u).find((candidate) => candidate.includes(`"${label}"`));
  const uid = line?.match(/\[uid=([^\]]+)\]/u)?.[1];
  if (!uid) {
    throw new Error(`No UID for "${label}" in snapshot:\n${snapshot}`);
  }
  return uid;
};

describe('MCP surface over a controlled session', () => {
  it('returns a bounded, normalized, instruction-bounded snapshot instead of upstream text', async () => {
    const { client } = await connect([accountFormSnapshot]);
    const snapshot = textOf(await callOk(client, 'browser_snapshot', { max_chars: 20_000 }));

    expect(snapshot).toContain('BEGIN UNTRUSTED WEBPAGE CONTENT');
    expect(snapshot).toContain('END UNTRUSTED WEBPAGE CONTENT');
    expect(snapshot).not.toContain('📸 Snapshot');
    // COMPATIBILITY.md item 4: upstream reports form controls as `input`.
    expect(snapshot).toContain('textbox "Email"');
    expect(snapshot).toContain('button "Save"');
    // Acceptance criterion 4: a normal page stays far below 20 KB.
    expect(Buffer.byteLength(snapshot, 'utf8')).toBeLessThan(20 * 1024);
  });

  it('fills and submits a multi-field form through UIDs from one snapshot', async () => {
    const { client, upstream } = await connect([accountFormSnapshot, accountFormAfterSaveSnapshot]);
    const snapshot = textOf(await callOk(client, 'browser_snapshot', { max_chars: 20_000 }));

    await callOk(client, 'browser_fill_form', {
      fields: [
        { uid: uidFor(snapshot, 'Email'), value: 'max@example.test' },
        { uid: uidFor(snapshot, 'Password'), value: 'integration-secret' },
      ],
    });
    await callOk(client, 'browser_click', { uid: uidFor(snapshot, 'Save') });

    expect(upstream.callsTo('fill_form_by_uid')).toHaveLength(1);
    expect(upstream.callsTo('click_by_uid')).toHaveLength(1);
    expect(textOf(await callOk(client, 'browser_snapshot', { max_chars: 20_000 }))).toContain(
      'Saved',
    );
  });

  it('answers a stale UID with a recoverable error and never dispatches the action', async () => {
    const { client, upstream } = await connect([accountFormSnapshot, secondDocumentSnapshot]);
    const stale = uidFor(
      textOf(await callOk(client, 'browser_snapshot', { max_chars: 20_000 })),
      'Save',
    );

    await callOk(client, 'browser_navigate', { url: 'https://example.test/second' });
    const failure = (await client.callTool({
      name: 'browser_click',
      arguments: { uid: stale },
    })) as CallToolResult;

    expect(failure.isError).toBe(true);
    const error = JSON.parse(textOf(failure)) as { code: string; message: string };
    expect(error.code).toBe('STALE_REFERENCE');
    expect(error.message.toLowerCase()).toContain('snapshot');
    expect(upstream.callsTo('click_by_uid')).toHaveLength(0);

    // Recovery: a fresh snapshot yields usable UIDs on the new document.
    const recovered = textOf(await callOk(client, 'browser_snapshot', { max_chars: 20_000 }));
    expect(recovered).toContain('Second document');
  });

  it('redacts secrets from network listings and individual request lookups', async () => {
    const { client } = await connect([]);
    const listing = textOf(await callOk(client, 'browser_get_network', { errors_only: true }));

    expect(listing).toContain('[REDACTED]');
    expect(listing).not.toContain('header-secret');
    expect(listing).not.toContain('query-secret');

    const detail = textOf(await callOk(client, 'browser_get_request', { request_id: 'request-1' }));
    expect(detail).not.toContain('cookie-secret');
    expect(detail).not.toContain('body-secret');
    expect(detail).toContain('[REDACTED]');
  });

  it('filters console output to errors only', async () => {
    const { client, upstream } = await connect([]);
    const console = textOf(await callOk(client, 'browser_get_console', { errors_only: true }));

    expect(console).toContain('fixture console failure');
    expect(upstream.callsTo('list_console_messages')[0]?.args).toMatchObject({ level: 'error' });
  });

  it('runs a ten-action batch across a single MCP tool call', async () => {
    const { client } = await connect([accountFormSnapshot, accountFormAfterSaveSnapshot]);
    const snapshot = textOf(await callOk(client, 'browser_snapshot', { max_chars: 20_000 }));

    const batch = JSON.parse(
      textOf(
        await callOk(client, 'browser_batch', {
          actions: [
            { op: 'status' },
            { op: 'list_tabs' },
            { op: 'fill', uid: uidFor(snapshot, 'Email'), value: 'max@example.test' },
            { op: 'fill', uid: uidFor(snapshot, 'Password'), value: 'integration-secret' },
            { op: 'click', uid: uidFor(snapshot, 'Save') },
            { op: 'snapshot', as: 'page' },
            { op: 'get_console', severity: 'error' },
            { op: 'get_network', errors_only: true },
            { op: 'get_request', request_id: 'request-1' },
            { op: 'get_downloads' },
          ],
        }),
      ),
    ) as {
      results: { ok: boolean; op: string; value?: unknown }[];
      transportCalls: number;
      stoppedAt?: number;
    };

    // Acceptance criterion 10: ten actions, one MCP tool call, one transport crossing.
    expect(batch.results).toHaveLength(10);
    expect(batch.transportCalls).toBe(1);
    expect(batch.stoppedAt).toBeUndefined();
    expect(batch.results.every((entry) => entry.ok)).toBe(true);
    // Acceptance criterion 11: batch output carries no secrets either.
    expect(JSON.stringify(batch)).not.toContain('header-secret');
    expect(JSON.stringify(batch)).not.toContain('integration-secret');
  });

  it('lets a batch reference UIDs issued by its own snapshot', async () => {
    const { client, upstream } = await connect([accountFormSnapshot, accountFormAfterSaveSnapshot]);
    const batch = JSON.parse(
      textOf(
        await callOk(client, 'browser_batch', {
          actions: [
            { op: 'snapshot', as: 'page' },
            { op: 'fill', uid: { $ref: 'page.uids.Email' }, value: 'max@example.test' },
            { op: 'click', uid: { $ref: 'page.uids.Save' } },
            { op: 'snapshot' },
          ],
        }),
      ),
    ) as { results: { ok: boolean; error?: unknown }[] };

    expect(batch.results.map((entry) => entry.ok)).toEqual([true, true, true, true]);
    expect(upstream.callsTo('fill_by_uid')).toHaveLength(1);
    expect(upstream.callsTo('click_by_uid')).toHaveLength(1);
  });

  it('stops a batch at the first failure unless continue_on_error is set', async () => {
    const { client, upstream } = await connect([accountFormSnapshot, accountFormSnapshot]);
    const snapshot = textOf(await callOk(client, 'browser_snapshot', { max_chars: 20_000 }));
    const actions = [
      { op: 'status' },
      { op: 'click', uid: 'uid-that-was-never-issued' },
      { op: 'click', uid: uidFor(snapshot, 'Save') },
    ];

    const stopped = JSON.parse(textOf(await callOk(client, 'browser_batch', { actions }))) as {
      results: { ok: boolean }[];
      stoppedAt?: number;
    };
    expect(stopped.stoppedAt).toBe(1);
    expect(stopped.results).toHaveLength(2);
    expect(upstream.callsTo('click_by_uid')).toHaveLength(0);

    const continued = JSON.parse(
      textOf(await callOk(client, 'browser_batch', { actions, continue_on_error: true })),
    ) as { results: { ok: boolean }[]; stoppedAt?: number };
    expect(continued.stoppedAt).toBeUndefined();
    expect(continued.results).toHaveLength(3);
    expect(continued.results.map((entry) => entry.ok)).toEqual([true, false, true]);
    expect(upstream.callsTo('click_by_uid')).toHaveLength(1);
  });
});
