import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserBridgeError, type BrowserSession } from '@librewolf-agent-bridge/browser-core';

import { createBrowserMcpServer } from './server.js';

const expectedTools = [
  'browser_status',
  'browser_list_tabs',
  'browser_select_tab',
  'browser_open_tab',
  'browser_close_tab',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_snapshot',
  'browser_find',
  'browser_get_text',
  'browser_click',
  'browser_hover',
  'browser_fill',
  'browser_fill_form',
  'browser_select_option',
  'browser_press_key',
  'browser_scroll',
  'browser_upload_file',
  'browser_screenshot',
  'browser_get_console',
  'browser_get_network',
  'browser_get_request',
  'browser_get_downloads',
  'browser_batch',
] as const;

const createStubSession = (): BrowserSession => ({
  status: vi.fn(async () => ({
    mode: 'controlled' as const,
    state: 'idle' as const,
    sessionId: 'test-session',
    capabilities: {
      tabs: { level: 'available' as const },
      snapshots: { level: 'available' as const },
      nativeInput: { level: 'available' as const },
      screenshots: { level: 'available' as const },
      console: { level: 'available' as const },
      network: { level: 'available' as const },
      downloads: { level: 'available' as const },
      upload: { level: 'available' as const },
      batch: { level: 'available' as const },
      deltaSnapshots: { level: 'available' as const },
      screenRecording: { level: 'unavailable' as const, reason: 'test' },
      highlighting: { level: 'unavailable' as const, reason: 'test' },
    },
    diagnostics: [],
  })),
  listTabs: vi.fn(async () => []),
  selectTab: vi.fn(async () => action()),
  openTab: vi.fn(async () => action()),
  closeTab: vi.fn(async () => action()),
  navigate: vi.fn(async () => action()),
  back: vi.fn(async () => action()),
  forward: vi.fn(async () => action()),
  snapshot: vi.fn(async () => ({
    snapshotId: 'snap_1',
    tabId: 'tab_1',
    navigationGeneration: 1,
    mutationGeneration: 1,
    text: 'BEGIN UNTRUSTED WEBPAGE CONTENT\nEND UNTRUSTED WEBPAGE CONTENT',
    elementCount: 0,
    bytes: 63,
    truncated: false,
  })),
  find: vi.fn(async () => []),
  getText: vi.fn(async () => ({ text: '' })),
  click: vi.fn(async () => action()),
  hover: vi.fn(async () => action()),
  fill: vi.fn(async () => action()),
  fillForm: vi.fn(async () => action()),
  selectOption: vi.fn(async () => action()),
  pressKey: vi.fn(async () => action()),
  scroll: vi.fn(async () => action()),
  uploadFile: vi.fn(async () => action()),
  screenshot: vi.fn(async () => ({ mimeType: 'image/png', bytes: 1, data: 'AA==' })),
  getConsole: vi.fn(async () => []),
  getNetwork: vi.fn(async () => []),
  getRequest: vi.fn(async () => ({})),
  getDownloads: vi.fn(async () => []),
  batch: vi.fn(async () => ({ results: [], transportCalls: 1 })),
  close: vi.fn(async () => undefined),
});

const action = () => ({
  ok: true as const,
  tabId: 'tab_1',
  navigationGeneration: 1,
  message: 'ok',
});

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const connect = async (session: BrowserSession) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createBrowserMcpServer(session);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanup = async () => {
    await client.close();
    await server.close();
  };
  return client;
};

describe('browser MCP surface', () => {
  it('advertises exactly the compact 25-tool contract with safety annotations', async () => {
    const client = await connect(createStubSession());
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);

    expect(names).toEqual(expectedTools);
    expect(listed.tools.find((tool) => tool.name === 'browser_status')?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(
      listed.tools.find((tool) => tool.name === 'browser_close_tab')?.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(listed.tools.find((tool) => tool.name === 'browser_batch')?._meta).toMatchObject({
      'librewolf-agent-bridge/tool': {
        requiresUserConfirmation: true,
        destructive: true,
      },
    });
  });

  it('returns structured bridge errors without leaking thrown stack text', async () => {
    const session = createStubSession();
    session.getRequest = vi.fn(async () => {
      throw new BrowserBridgeError('PERMISSION_DENIED', 'Request access denied.', {
        recoverable: true,
      });
    });
    const client = await connect(session);
    const result = (await client.callTool({
      name: 'browser_get_request',
      arguments: { request_id: 'request-1' },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    const text = result.content.find((item) => item.type === 'text');
    expect(text).toMatchObject({ type: 'text' });
    expect(text && text.type === 'text' ? JSON.parse(text.text) : undefined).toEqual({
      code: 'PERMISSION_DENIED',
      message: 'Request access denied.',
      details: { recoverable: true },
    });
  });
});
