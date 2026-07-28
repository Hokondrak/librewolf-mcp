import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BrowserBridgeError,
  ControlledBrowserSession,
  MozillaUpstreamClient,
  type MozillaUpstreamOptions,
  type UpstreamCallResult,
} from '../src/index.js';

const textResult = (text: string): UpstreamCallResult => ({
  text,
  images: [],
  raw: text,
});

class FakeUpstream extends MozillaUpstreamClient {
  public readonly calls: {
    readonly name: string;
    readonly args: Readonly<Record<string, unknown>>;
  }[] = [];
  public navigationTimeoutUrl: string | undefined;
  public closeFailure: Error | undefined;
  private readonly snapshots: string[];
  private snapshotIndex = 0;
  private fakeState: 'idle' | 'ready' | 'closed' = 'idle';
  private pages = '📄 1 pages (selected: 0)\n>[0] Fixture';

  public constructor(options: MozillaUpstreamOptions, snapshots: readonly string[]) {
    super(options);
    this.snapshots = [...snapshots];
  }

  public override getState(): 'idle' | 'starting' | 'ready' | 'failed' | 'closed' {
    return this.fakeState;
  }

  public override async ensureStarted(): Promise<void> {
    this.fakeState = 'ready';
  }

  public override async call(
    name: string,
    args: Readonly<Record<string, unknown>> = {},
  ): Promise<UpstreamCallResult> {
    this.calls.push({ name, args });
    switch (name) {
      case 'list_pages':
        return textResult(this.pages);
      case 'take_snapshot': {
        const snapshot = this.snapshots[this.snapshotIndex];
        if (!snapshot) {
          throw new Error('No fake snapshot remains.');
        }
        this.snapshotIndex += 1;
        return textResult(snapshot);
      }
      case 'resolve_uid_to_selector': {
        const uid = String(args['uid']);
        const local = uid.split('_')[1];
        const selector =
          local === '0'
            ? '#profile-form'
            : local === '1'
              ? '[name="displayName"]'
              : 'body > main:nth-of-type(1) > button:nth-of-type(1)';
        return textResult(`${uid} → ${selector}`);
      }
      case 'evaluate_script':
        if (String(args['function']).includes('window.location.href')) {
          return textResult(
            'Script ran on page and returned:\n```json\n' +
              JSON.stringify(this.navigationTimeoutUrl ?? 'about:blank') +
              '\n```',
          );
        }
        return textResult(
          'Script ran on page and returned:\n```json\n' +
            JSON.stringify(
              Array.isArray(args['args'])
                ? args['args'].map((value) => {
                    const uid =
                      value && typeof value === 'object' && 'uid' in value ? String(value.uid) : '';
                    return uid.endsWith('_3')
                      ? {
                          type: 'password',
                          name: 'credential',
                          autocomplete: 'current-password',
                        }
                      : { type: 'text', name: 'displayName', autocomplete: '' };
                  })
                : [],
            ) +
            '\n```',
        );
      case 'navigate_page':
        if (this.navigationTimeoutUrl) {
          throw new BrowserBridgeError(
            'TIMEOUT',
            'BiDi command timeout: browsingContext.navigate',
            { stage: 'action', recoverable: true },
          );
        }
        this.pages = '📄 1 pages (selected: 0)\n>[0] Navigated';
        return textResult('Navigated');
      case 'close_page':
        this.pages = '📄 0 pages (selected: -1)';
        return textResult('Closed');
      case 'list_network_requests':
        return textResult(
          JSON.stringify([
            {
              id: 'request-1',
              url: 'https://example.test/api?access_token=top-secret',
              headers: {
                authorization: 'Bearer top-secret',
                'x-api-key': 'top-secret',
              },
            },
          ]),
        );
      default:
        return textResult('ok');
    }
  }

  public override async close(): Promise<void> {
    this.fakeState = 'closed';
    if (this.closeFailure) {
      throw this.closeFailure;
    }
  }
}

const firstSnapshot = `📸 Snapshot (id=1)

uid=1_0 form
  uid=1_1 input "Display name" focusable interactive name="displayName"
  uid=1_2 button "Save profile" text="Save profile" focusable interactive
`;

const secondSnapshot = `📸 Snapshot (id=2)

uid=2_0 form
  uid=2_1 input "Display name" focusable interactive name="displayName"
  uid=2_2 button "Save profile" text="Save profile" focusable interactive
`;

const sensitiveSnapshot = `Snapshot (id=3)

uid=3_0 form
  uid=3_1 input "Display name" value="Maxim" focusable interactive
  uid=3_2 input "API token" value="token=visible-secret" focusable interactive
  uid=3_3 input "Credential" value="form-secret" focusable interactive
`;

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const createSession = async (
  snapshots: readonly string[],
): Promise<{ session: ControlledBrowserSession; upstream: FakeUpstream; root: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'librewolf-agent-bridge-test-'));
  temporaryRoots.push(root);
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
  await session.listTabs();
  if (!upstream) {
    throw new Error('Fake upstream was not created.');
  }
  return { session, upstream, root };
};

const uids = (snapshot: string): readonly string[] =>
  [...snapshot.matchAll(/\[uid=([^\]]+)\]/gu)].map((match) => match[1] ?? '');

describe('ControlledBrowserSession', () => {
  it('normalizes Mozilla wrappers and only preserves UIDs backed by strong selectors', async () => {
    const { session } = await createSession([firstSnapshot, secondSnapshot]);
    try {
      const first = await session.snapshot({ maxElements: 20, maxChars: 20_000 });
      const second = await session.snapshot({ maxElements: 20, maxChars: 20_000 });
      const firstUids = uids(first.text);
      const secondUids = uids(second.text);

      expect(first.text).toContain('BEGIN UNTRUSTED WEBPAGE CONTENT');
      expect(first.text).not.toContain('📸 Snapshot');
      expect(firstUids).toHaveLength(3);
      expect(secondUids).toHaveLength(3);
      expect(secondUids.slice(0, 2)).toEqual(firstUids.slice(0, 2));
      expect(secondUids[2]).not.toBe(firstUids[2]);
    } finally {
      await session.close();
    }
  });

  it('invalidates prior UIDs on navigation before dispatching an action', async () => {
    const { session, upstream } = await createSession([firstSnapshot]);
    try {
      const snapshot = await session.snapshot({ maxElements: 20, maxChars: 20_000 });
      const uid = uids(snapshot.text)[1];
      expect(uid).toBeTruthy();

      await session.navigate('https://example.test/next');
      await expect(session.click({ uid: uid! })).rejects.toMatchObject({
        code: 'STALE_REFERENCE',
      } satisfies Partial<BrowserBridgeError>);
      expect(upstream.calls.filter((call) => call.name === 'click_by_uid')).toHaveLength(0);
    } finally {
      await session.close();
    }
  });

  it('verifies the final URL instead of repeating a navigation that timed out', async () => {
    const { session, upstream } = await createSession([]);
    upstream.navigationTimeoutUrl = 'https://example.test/recovered';
    try {
      await expect(session.navigate('https://example.test/recovered')).resolves.toMatchObject({
        ok: true,
        message: expect.stringContaining('verified after an upstream timeout'),
      });
      expect(upstream.calls.filter((call) => call.name === 'navigate_page')).toHaveLength(1);
      expect(
        upstream.calls.some(
          (call) =>
            call.name === 'evaluate_script' &&
            String(call.args['function']).includes('window.location.href'),
        ),
      ).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('redacts network secrets and can report closing the final tab', async () => {
    const { session } = await createSession([]);
    try {
      const network = await session.getNetwork({});
      expect(JSON.stringify(network)).not.toContain('top-secret');
      expect(JSON.stringify(network)).toContain('[REDACTED]');

      await expect(session.closeTab({ index: 0 })).resolves.toMatchObject({
        ok: true,
        tabId: 'tab_1',
      });
    } finally {
      await session.close();
    }
  });

  it('redacts sensitive form values before snapshot content is stored or returned', async () => {
    const { session, upstream } = await createSession([sensitiveSnapshot]);
    try {
      const snapshot = await session.snapshot({
        includeAttributes: true,
        maxElements: 20,
        maxChars: 20_000,
      });

      expect(snapshot.text).toContain('Maxim');
      expect(snapshot.text).not.toContain('visible-secret');
      expect(snapshot.text).not.toContain('form-secret');
      expect(snapshot.text).toContain('[REDACTED]');
      const metadataProbe = upstream.calls.find((call) => call.name === 'evaluate_script');
      expect(JSON.stringify(metadataProbe?.args)).not.toContain('form-secret');
    } finally {
      await session.close();
    }
  });

  it('reports incomplete process cleanup while still releasing its dedicated profile', async () => {
    const { session, upstream, root } = await createSession([]);
    upstream.closeFailure = new Error('supervisor remained alive');

    await expect(session.close()).rejects.toMatchObject({
      code: 'SHUTDOWN',
      details: {
        failures: [expect.stringContaining('supervisor remained alive')],
      },
    } satisfies Partial<BrowserBridgeError>);
    await expect(access(join(root, 'profiles', 'default'))).rejects.toThrow();
  });
});
