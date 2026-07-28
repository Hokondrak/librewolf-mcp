import {
  MozillaUpstreamClient,
  type MozillaUpstreamOptions,
  type UpstreamCallResult,
} from '@librewolf-agent-bridge/browser-core';

export interface RecordedUpstreamCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

const textResult = (text: string): UpstreamCallResult => ({ text, images: [], raw: text });

const jsonResult = (value: unknown): UpstreamCallResult => textResult(JSON.stringify(value));

/**
 * A scripted stand-in for the Mozilla upstream MCP process.
 *
 * Integration tests use it so the real `ControlledBrowserSession`, snapshot engine, UID
 * registry, and redaction pipeline all run unchanged, without launching LibreWolf. Its
 * responses copy the shapes recorded during the Phase 0 compatibility spike, including the
 * upstream behaviours the bridge exists to correct: `list_pages` omitting URLs and network
 * output carrying unredacted secrets.
 */
export class FakeUpstream extends MozillaUpstreamClient {
  public readonly calls: RecordedUpstreamCall[] = [];
  private readonly snapshots: string[];
  private snapshotIndex = 0;
  private fakeState: 'idle' | 'ready' | 'closed' = 'idle';
  private pages = '📄 1 pages (selected: 0)\n>[0] Account settings';

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

  public callsTo(name: string): readonly RecordedUpstreamCall[] {
    return this.calls.filter((call) => call.name === name);
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
          throw new Error('The fake upstream ran out of scripted snapshots.');
        }
        this.snapshotIndex += 1;
        return textResult(snapshot);
      }
      case 'resolve_uid_to_selector': {
        const uid = String(args['uid']);
        const local = uid.split('_')[1] ?? '';
        const selectors: Record<string, string> = {
          '0': '#account-form',
          '1': '#account-heading',
          '2': '[name="email"]',
          '3': '[name="password"]',
          '4': '#save',
          '5': '#cancel',
        };
        return textResult(`${uid} → ${selectors[local] ?? `#unknown-${local}`}`);
      }
      case 'evaluate_script':
        if (String(args['function']).includes('window.location.href')) {
          return textResult(
            'Script ran on page and returned:\n```json\n"https://example.test/account"\n```',
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
                      ? { type: 'password', name: 'password', autocomplete: 'current-password' }
                      : { type: 'text', name: 'email', autocomplete: 'email' };
                  })
                : [],
            ) +
            '\n```',
        );
      case 'navigate_page':
        this.pages = '📄 1 pages (selected: 0)\n>[0] Second document';
        return textResult('Navigated');
      case 'list_console_messages':
        return jsonResult([
          { level: 'error', text: 'fixture console failure', source: 'javascript' },
          { level: 'info', text: 'fixture console notice', source: 'console-api' },
        ]);
      case 'list_network_requests':
        return jsonResult([
          {
            id: 'request-1',
            method: 'POST',
            status: 503,
            url: 'https://example.test/api/save?access_token=query-secret',
            headers: { authorization: 'Bearer header-secret', 'x-api-key': 'key-secret' },
          },
        ]);
      case 'get_network_request':
        return jsonResult({
          id: String(args['requestId'] ?? args['id'] ?? 'request-1'),
          method: 'POST',
          status: 503,
          url: 'https://example.test/api/save?access_token=query-secret',
          requestHeaders: {
            authorization: 'Bearer header-secret',
            cookie: 'session=cookie-secret',
          },
          requestBody: '{"password":"body-secret"}',
        });
      case 'list_downloads':
        return jsonResult([]);
      case 'screenshot_page':
        return textResult('Saved screenshot');
      default:
        return textResult('ok');
    }
  }

  public override async close(): Promise<void> {
    this.fakeState = 'closed';
  }
}
