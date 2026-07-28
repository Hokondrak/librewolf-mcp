import { describe, expect, it } from 'vitest';

import {
  BrowserBridgeError,
  CompanionBrowserSession,
  type CompanionConnection,
  type CompanionRpcRequest,
  type CompanionTransport,
} from '../src/index.js';

class FakeAuthenticatedTransport implements CompanionTransport {
  readonly capabilities = {
    discoveryValidation: { level: 'available' as const },
    authenticatedHandshake: { level: 'available' as const },
    secureLocalEndpoint: { level: 'available' as const },
  };
  readonly requests: CompanionRpcRequest[] = [];
  closed = false;

  async connect(): Promise<CompanionConnection> {
    return {
      serverInstanceId: 'test-server',
      protocolVersion: '1.0.0',
      security: {
        local: true,
        authenticated: true,
        peerAccessRestricted: true,
        kind: 'named-pipe',
      },
      extensionCapabilities: {
        domActions: { level: 'degraded', reason: 'synthetic_dom_events' },
      },
    };
  }

  async request(request: CompanionRpcRequest): Promise<unknown> {
    this.requests.push(request);
    const operation = request.params.operation;
    if (operation === 'tabs.list') {
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: [
          {
            tabId: 17,
            active: true,
            access: 'allowed',
            title: 'Example',
            url: 'https://example.test/',
          },
          {
            tabId: 29,
            active: false,
            access: 'permission_required',
          },
        ],
      };
    }
    if (operation === 'dom.snapshot') {
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          ok: true,
          documentId: 'b7eb5e53-e102-49e4-9696-01050dca93f6',
          mutationGeneration: 4,
          result: {
            text: '[uid=db7eb5e53:e1] button "Save"',
            documentId: 'b7eb5e53-e102-49e4-9696-01050dca93f6',
            mutationGeneration: 4,
            elementCount: 1,
            truncated: false,
          },
        },
      };
    }
    if (operation === 'dom.fill') {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32000,
          message: 'Approval required.',
          data: {
            code: 'PERMISSION_REQUIRED',
            message: 'Approve this request from the extension popup.',
            recoverable: true,
            details: {
              approvalSurface: 'extension_popup',
              requestId: 'pending-1',
            },
          },
        },
      };
    }
    if (operation === 'batch.execute') {
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          completed: true,
          results: [
            { index: 0, ok: true, result: { scrolled: true } },
            { index: 1, ok: true, result: { matches: [] } },
          ],
        },
      };
    }
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: { ok: true },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe('CompanionBrowserSession', () => {
  it('keeps status useful while the secure native transport is unavailable', async () => {
    const session = new CompanionBrowserSession({
      sessionIdFactory: () => 'session-for-test',
      now: () => new Date('2026-07-28T10:00:00.000Z'),
    });

    const status = await session.status();

    expect(status).toMatchObject({
      mode: 'companion',
      state: 'failed',
      sessionId: 'session-for-test',
      capabilities: {
        tabs: {
          level: 'unavailable',
          reason: 'secure_companion_transport_unavailable',
        },
        console: {
          level: 'unavailable',
          reason: 'requires_controlled_profile_bidi',
        },
      },
    });
    expect(status.diagnostics.at(-1)).toMatchObject({
      stage: 'failed',
      ok: false,
      details: {
        code: 'CAPABILITY_UNAVAILABLE',
        reason: 'native_windows_acl_component_not_installed',
      },
    });

    await expect(session.listTabs()).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    });
  });

  it('uses only a verified authenticated transport and preserves permission gating', async () => {
    const transport = new FakeAuthenticatedTransport();
    const session = new CompanionBrowserSession({
      transport,
      sessionIdFactory: () => 'session-for-test',
      now: () => new Date('2026-07-28T10:00:00.000Z'),
    });

    const tabs = await session.listTabs();
    expect(tabs).toEqual([
      {
        id: 'companion:17',
        index: 0,
        title: 'Example',
        url: 'https://example.test/',
        selected: true,
      },
      {
        id: 'companion:29',
        index: 1,
        title: '[permission required]',
        selected: false,
      },
    ]);

    const snapshot = await session.snapshot({
      interactiveOnly: true,
      includeText: true,
      maxChars: 2_000,
      maxElements: 50,
    });
    expect(snapshot).toMatchObject({
      snapshotId: 'companion:b7eb5e53-e102-49e4-9696-01050dca93f6:4',
      tabId: 'companion:17',
      navigationGeneration: 1,
      mutationGeneration: 4,
      elementCount: 1,
    });
    expect(transport.requests.at(-1)?.params).toMatchObject({
      operation: 'dom.snapshot',
      target: {
        tabId: 17,
        frameId: 0,
        navigationGeneration: 1,
      },
      arguments: {
        interactive_only: true,
        include_text: true,
        max_chars: 2_000,
        max_elements: 50,
      },
    });

    await expect(
      session.fill({ uid: 'db7eb5e53:e1', value: 'not logged or granted' }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_REQUIRED',
      details: {
        upstreamCode: 'PERMISSION_REQUIRED',
        remoteDetails: {
          approvalSurface: 'extension_popup',
          requestId: 'pending-1',
        },
      },
    });
    expect(transport.requests.at(-1)?.params.target).toMatchObject({
      tabId: 17,
      documentId: 'b7eb5e53-e102-49e4-9696-01050dca93f6',
    });

    await session.close();
    expect(transport.closed).toBe(true);
  });

  it('uses the extension batch boundary once when no wrapper references are present', async () => {
    const transport = new FakeAuthenticatedTransport();
    const session = new CompanionBrowserSession({ transport });
    await session.listTabs();
    const requestsBeforeBatch = transport.requests.length;

    const result = await session.batch([
      { op: 'scroll', direction: 'down', amount: 250 },
      { op: 'find', text: 'Saved' },
    ]);

    expect(result).toEqual({
      results: [
        {
          index: 0,
          op: 'scroll',
          ok: true,
          value: { scrolled: true },
        },
        {
          index: 1,
          op: 'find',
          ok: true,
          value: { matches: [] },
        },
      ],
      transportCalls: 1,
    });
    expect(transport.requests).toHaveLength(requestsBeforeBatch + 1);
    expect(transport.requests.at(-1)?.params).toMatchObject({
      operation: 'batch.execute',
      arguments: {
        actions: [
          { op: 'scroll', x: 0, y: 250 },
          { op: 'find', text: 'Saved' },
        ],
        continue_on_error: false,
      },
    });
  });

  it('does not treat structured unavailable features as successful operations', async () => {
    const transport = new FakeAuthenticatedTransport();
    const session = new CompanionBrowserSession({ transport });

    await expect(session.uploadFile({ uid: 'd1:e1', path: 'C:\\private.txt' })).rejects.toEqual(
      expect.objectContaining<Partial<BrowserBridgeError>>({
        code: 'CAPABILITY_UNAVAILABLE',
      }),
    );
    expect(transport.requests).toHaveLength(0);
  });
});
