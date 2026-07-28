import { randomUUID } from 'node:crypto';

import { executeBrowserBatch } from './batch.js';
import { BrowserBridgeError, asBridgeError } from './errors.js';
import type {
  BrowserActionResult,
  BrowserBatchAction,
  BrowserBatchResult,
  BrowserCapabilities,
  BrowserSession,
  BrowserStatus,
  BrowserTab,
  ConsoleFilters,
  NetworkFilters,
  SnapshotOptions,
  SnapshotResult,
  StartupDiagnostic,
} from './types.js';

const COMPANION_PROTOCOL_VERSION = '1.0.0';
const SECURE_TRANSPORT_UNAVAILABLE_REASON = 'native_windows_acl_component_not_installed';

export interface CompanionTransportCapability {
  readonly level: 'available' | 'degraded' | 'unavailable';
  readonly reason?: string;
}

export interface CompanionTransportSecurity {
  /**
   * The transport implementation must set these fields from verified transport
   * state. Merely requesting a named pipe or completing a TCP connection is not
   * sufficient.
   */
  readonly local: true;
  readonly authenticated: true;
  readonly peerAccessRestricted: true;
  readonly kind: 'named-pipe' | 'unix-socket';
}

export interface CompanionConnection {
  readonly serverInstanceId: string;
  readonly protocolVersion: string;
  readonly security: CompanionTransportSecurity;
  readonly extensionCapabilities?: unknown;
}

export interface CompanionRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: string;
  readonly method: 'extension.execute';
  readonly params: {
    readonly requestId: string;
    readonly operation: string;
    readonly deadlineAt: string;
    readonly target?: {
      readonly tabId?: number;
      readonly frameId?: number;
      readonly documentId?: string;
      readonly navigationGeneration?: number;
    };
    readonly arguments?: Readonly<Record<string, unknown>>;
  };
}

/**
 * Server-side companion transport boundary.
 *
 * A production implementation owns discovery-record publication, a
 * same-user-only local endpoint, and the authenticated native-host handshake.
 * Browser-core deliberately does not downgrade to an ordinary named pipe,
 * loopback TCP, or an unauthenticated test channel.
 */
export interface CompanionTransport {
  readonly capabilities: Readonly<{
    discoveryValidation: CompanionTransportCapability;
    authenticatedHandshake: CompanionTransportCapability;
    secureLocalEndpoint: CompanionTransportCapability;
  }>;
  connect(): Promise<CompanionConnection>;
  request(request: CompanionRpcRequest): Promise<unknown>;
  close(): Promise<void>;
}

export interface CompanionBrowserSessionOptions {
  readonly transport?: CompanionTransport;
  readonly requestTimeoutMs?: number;
  readonly sessionIdFactory?: () => string;
  readonly now?: () => Date;
}

interface CompanionTabState {
  readonly nativeId: number;
  id: string;
  index: number;
  title: string;
  url?: string;
  selected: boolean;
  navigationGeneration: number;
  mutationGeneration: number;
  documentId?: string;
}

interface RpcErrorData {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly recoverable?: unknown;
  readonly details?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const unavailableState = (reason: string) => ({
  level: 'unavailable' as const,
  reason,
});

const disconnectedCapabilities = (): BrowserCapabilities => ({
  tabs: unavailableState('secure_companion_transport_unavailable'),
  snapshots: unavailableState('secure_companion_transport_unavailable'),
  nativeInput: unavailableState('secure_companion_transport_unavailable'),
  screenshots: unavailableState('secure_companion_transport_unavailable'),
  console: unavailableState('requires_controlled_profile_bidi'),
  network: unavailableState('requires_controlled_profile_bidi'),
  downloads: unavailableState('optional_downloads_support_not_enabled'),
  upload: unavailableState('safe_os_file_selection_requires_controlled_profile'),
  batch: unavailableState('secure_companion_transport_unavailable'),
  deltaSnapshots: unavailableState('companion_delta_snapshots_not_implemented'),
  screenRecording: unavailableState('companion_screen_recording_not_implemented'),
  highlighting: unavailableState('secure_companion_transport_unavailable'),
});

const connectedCapabilities = (): BrowserCapabilities => ({
  tabs: { level: 'available' },
  snapshots: { level: 'available' },
  nativeInput: {
    level: 'degraded',
    reason: 'synthetic_dom_events_are_not_trusted_native_input',
  },
  screenshots: {
    level: 'degraded',
    reason: 'active_visible_tab_only_and_requires_toolbar_grant',
  },
  console: unavailableState('requires_controlled_profile_bidi'),
  network: unavailableState('requires_controlled_profile_bidi'),
  downloads: unavailableState('optional_downloads_support_not_enabled'),
  upload: unavailableState('safe_os_file_selection_requires_controlled_profile'),
  batch: { level: 'available' },
  deltaSnapshots: unavailableState('companion_delta_snapshots_not_implemented'),
  screenRecording: unavailableState('companion_screen_recording_not_implemented'),
  highlighting: { level: 'available' },
});

export class UnavailableCompanionTransport implements CompanionTransport {
  public readonly capabilities = {
    discoveryValidation: { level: 'available' as const },
    authenticatedHandshake: { level: 'available' as const },
    secureLocalEndpoint: {
      level: 'unavailable' as const,
      reason: SECURE_TRANSPORT_UNAVAILABLE_REASON,
    },
  };

  public async connect(): Promise<CompanionConnection> {
    throw new BrowserBridgeError(
      'CAPABILITY_UNAVAILABLE',
      'Companion mode requires a same-user authenticated local transport; the secure Windows named-pipe ACL component is not installed.',
      {
        stage: 'transport',
        recoverable: true,
        reason: SECURE_TRANSPORT_UNAVAILABLE_REASON,
        hint: 'Use controlled mode until the secure companion transport component is installed.',
      },
    );
  }

  public async request(_request: CompanionRpcRequest): Promise<unknown> {
    return this.connect();
  }

  public async close(): Promise<void> {}
}

export class CompanionBrowserSession implements BrowserSession {
  private readonly transport: CompanionTransport;
  private readonly requestTimeoutMs: number;
  private readonly now: () => Date;
  private readonly sessionId: string;
  private readonly diagnostics: StartupDiagnostic[] = [];
  private readonly tabs = new Map<number, CompanionTabState>();
  private state: BrowserStatus['state'] = 'idle';
  private selectedNativeTabId: number | undefined;
  private connection: CompanionConnection | undefined;
  private connectPromise: Promise<void> | undefined;
  private requestSequence = 0;
  private closing = false;

  public constructor(options: CompanionBrowserSessionOptions = {}) {
    this.transport = options.transport ?? new UnavailableCompanionTransport();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
    this.sessionId = (options.sessionIdFactory ?? randomUUID)();

    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 100 ||
      this.requestTimeoutMs > 300_000
    ) {
      throw new BrowserBridgeError(
        'INVALID_ARGUMENT',
        'Companion requestTimeoutMs must be an integer between 100 and 300000.',
        { stage: 'configuration' },
      );
    }

    this.addDiagnostic('idle', true, 'Companion session configured.', {
      transportCapabilities: this.transport.capabilities,
      permissionAuthority: 'librewolf_extension_ui_only',
    });
  }

  public async status(): Promise<BrowserStatus> {
    if (this.state !== 'closed' && this.state !== 'ready') {
      await this.ensureConnected().catch(() => undefined);
    }
    return {
      mode: 'companion',
      state: this.state,
      sessionId: this.sessionId,
      ...(this.selectedNativeTabId !== undefined
        ? { selectedTabId: this.publicTabId(this.selectedNativeTabId) }
        : {}),
      capabilities: this.state === 'ready' ? connectedCapabilities() : disconnectedCapabilities(),
      diagnostics: [...this.diagnostics],
    };
  }

  public async listTabs(): Promise<readonly BrowserTab[]> {
    const result = await this.execute('tabs.list');
    return this.reconcileTabs(result);
  }

  public async selectTab(input: {
    tabId?: string;
    index?: number;
    title?: string;
    url?: string;
  }): Promise<BrowserActionResult> {
    const tab = await this.resolveTab(input);
    await this.execute('tabs.select', {}, tab);
    this.selectLocalTab(tab.nativeId);
    return this.action(tab, `Selected tab ${tab.id}.`);
  }

  public async openTab(url: string): Promise<BrowserActionResult> {
    const result = await this.execute('tabs.open', { url });
    const nativeId = this.extractNativeTabId(result);
    if (nativeId === undefined) {
      await this.listTabs();
      const selected = this.selectedTab();
      if (!selected) {
        throw new BrowserBridgeError(
          'UPSTREAM_ERROR',
          'The companion extension did not identify the newly opened tab.',
          { stage: 'tabs', recoverable: true },
        );
      }
      return this.action(selected, `Opened ${url}.`);
    }
    const tab = this.upsertTab(nativeId, {
      index: this.tabs.size,
      title: this.readString(result, 'title') ?? 'Untitled',
      url,
      selected: true,
    });
    this.selectLocalTab(nativeId);
    return this.action(tab, `Opened ${url}.`);
  }

  public async closeTab(input: { tabId?: string; index?: number }): Promise<BrowserActionResult> {
    const tab = await this.resolveTab(input);
    await this.execute('tabs.close', {}, tab);
    this.tabs.delete(tab.nativeId);
    if (this.selectedNativeTabId === tab.nativeId) {
      this.selectedNativeTabId = undefined;
    }
    return {
      ok: true,
      tabId: tab.id,
      navigationGeneration: tab.navigationGeneration,
      message: `Closed tab ${tab.id}.`,
    };
  }

  public async navigate(url: string): Promise<BrowserActionResult> {
    const tab = await this.requireSelectedTab();
    await this.execute('tabs.navigate', { url }, tab);
    this.invalidateNavigation(tab, url);
    return this.action(tab, `Navigated to ${url}.`);
  }

  public async back(): Promise<BrowserActionResult> {
    return this.navigateHistory('tabs.back', 'back');
  }

  public async forward(): Promise<BrowserActionResult> {
    return this.navigateHistory('tabs.forward', 'forward');
  }

  public async snapshot(options: SnapshotOptions): Promise<SnapshotResult> {
    if (options.changedSinceSnapshot) {
      this.capabilityUnavailable('delta snapshots', 'companion_delta_snapshots_not_implemented');
    }
    if (options.saveToFile) {
      this.capabilityUnavailable(
        'snapshot file output',
        'companion_snapshot_file_output_not_implemented',
      );
    }

    const tab = await this.requireSelectedTab();
    const result = await this.execute(
      'dom.snapshot',
      {
        ...(options.selector ? { selector: options.selector } : {}),
        interactive_only: options.interactiveOnly ?? false,
        include_text: options.includeText ?? true,
        include_attributes: options.includeAttributes
          ? ['aria-label', 'aria-describedby', 'href', 'type', 'name']
          : [],
        include_bounds: options.includeBounds ?? false,
        ...(options.maxDepth !== undefined ? { max_depth: options.maxDepth } : {}),
        max_chars: options.maxChars ?? 20_000,
        max_elements: options.maxElements ?? 500,
      },
      tab,
    );
    const content = this.requireRecord(result, 'companion snapshot');
    const text = this.requireString(content, 'text', 'companion snapshot');
    const documentId =
      this.readString(content, 'documentId') ?? tab.documentId ?? 'unknown-document';
    const mutationGeneration =
      this.readSafeInteger(content, 'mutationGeneration') ?? tab.mutationGeneration + 1;
    tab.documentId = documentId;
    tab.mutationGeneration = mutationGeneration;
    const snapshotId = `companion:${documentId}:${mutationGeneration}`;
    return {
      snapshotId,
      tabId: tab.id,
      navigationGeneration: tab.navigationGeneration,
      mutationGeneration,
      text,
      elementCount: this.readSafeInteger(content, 'elementCount') ?? 0,
      bytes: Buffer.byteLength(text, 'utf8'),
      truncated: content['truncated'] === true,
    };
  }

  public async find(input: {
    text: string;
    exact?: boolean;
    role?: string;
    limit?: number;
  }): Promise<unknown> {
    const tab = await this.requireSelectedTab();
    const result = await this.execute(
      'dom.find',
      { text: input.text, limit: input.limit ?? 20 },
      tab,
    );
    if (!input.exact && !input.role) {
      return result;
    }
    const root = this.requireRecord(result, 'companion find result');
    const matches = Array.isArray(root['matches']) ? root['matches'] : [];
    const filtered = matches.filter((match) => {
      if (!isRecord(match)) return false;
      if (
        input.role &&
        this.readString(match, 'role')?.toLocaleLowerCase('en-US') !==
          input.role.toLocaleLowerCase('en-US')
      ) {
        return false;
      }
      if (!input.exact) return true;
      const expected = input.text.toLocaleLowerCase('en-US');
      return ['name', 'text'].some(
        (key) => this.readString(match, key)?.toLocaleLowerCase('en-US') === expected,
      );
    });
    return { ...root, matches: filtered };
  }

  public async getText(input: {
    uid?: string;
    selector?: string;
    maxChars?: number;
  }): Promise<unknown> {
    const tab = await this.requireSelectedTab();
    return this.execute(
      'dom.getText',
      {
        ...(input.uid ? { uid: input.uid } : {}),
        ...(input.selector ? { selector: input.selector } : {}),
        maxChars: input.maxChars ?? 20_000,
      },
      tab,
    );
  }

  public async click(input: { uid: string; doubleClick?: boolean }): Promise<BrowserActionResult> {
    if (input.doubleClick) {
      this.capabilityUnavailable(
        'companion double click',
        'companion_double_click_not_implemented',
      );
    }
    return this.domAction('dom.click', { uid: input.uid }, `Clicked ${input.uid}.`);
  }

  public async hover(uid: string): Promise<BrowserActionResult> {
    return this.domAction('dom.hover', { uid }, `Hovered ${uid}.`);
  }

  public async fill(input: { uid: string; value: string }): Promise<BrowserActionResult> {
    return this.domAction(
      'dom.fill',
      { uid: input.uid, value: input.value },
      `Filled ${input.uid}.`,
    );
  }

  public async fillForm(
    fields: readonly { uid: string; value: string }[],
  ): Promise<BrowserActionResult> {
    return this.domAction(
      'dom.fillForm',
      { fields: fields.map((field) => ({ ...field })) },
      `Filled ${fields.length} fields.`,
    );
  }

  public async selectOption(input: {
    uid: string;
    values: readonly string[];
  }): Promise<BrowserActionResult> {
    if (input.values.length !== 1 || input.values[0] === undefined) {
      this.capabilityUnavailable(
        'companion multi-option selection',
        'companion_select_supports_exactly_one_value',
      );
    }
    return this.domAction(
      'dom.selectOption',
      { uid: input.uid, value: input.values[0] },
      `Selected option on ${input.uid}.`,
    );
  }

  public async pressKey(input: { key: string; uid?: string }): Promise<BrowserActionResult> {
    if (!input.uid) {
      throw new BrowserBridgeError(
        'INVALID_ARGUMENT',
        'Companion key input requires a UID from the current snapshot.',
        {
          stage: 'action',
          recoverable: true,
          hint: 'Take a browser_snapshot and pass the intended element UID.',
        },
      );
    }
    return this.domAction(
      'dom.pressKey',
      { uid: input.uid, key: input.key },
      `Pressed ${input.key}.`,
    );
  }

  public async scroll(input: {
    uid?: string;
    deltaX?: number;
    deltaY?: number;
    direction?: string;
    amount?: number;
  }): Promise<BrowserActionResult> {
    const amount = input.amount ?? 500;
    const directional = this.directionalDelta(input.direction, amount);
    return this.domAction(
      'dom.scroll',
      {
        ...(input.uid ? { uid: input.uid } : {}),
        x: input.deltaX ?? directional.x,
        y: input.deltaY ?? directional.y,
      },
      'Scrolled the selected tab.',
    );
  }

  public async uploadFile(_input: { uid: string; path: string }): Promise<BrowserActionResult> {
    return this.capabilityUnavailable(
      'file upload',
      'safe_os_file_selection_requires_controlled_profile',
    );
  }

  public async screenshot(input: { uid?: string; path?: string }): Promise<unknown> {
    if (input.uid) {
      this.capabilityUnavailable(
        'element screenshots',
        'companion_screenshot_is_active_visible_tab_only',
      );
    }
    if (input.path) {
      this.capabilityUnavailable(
        'screenshot file output',
        'companion_screenshot_file_output_not_implemented',
      );
    }
    const tab = await this.requireSelectedTab();
    return this.execute('page.screenshot', { format: 'png' }, tab);
  }

  public async getConsole(_filters: ConsoleFilters): Promise<unknown> {
    return this.capabilityUnavailable('console inspection', 'requires_controlled_profile_bidi');
  }

  public async getNetwork(_filters: NetworkFilters): Promise<unknown> {
    return this.capabilityUnavailable('network inspection', 'requires_controlled_profile_bidi');
  }

  public async getRequest(_input: { requestId: string }): Promise<unknown> {
    return this.capabilityUnavailable(
      'network request inspection',
      'requires_controlled_profile_bidi',
    );
  }

  public async getDownloads(_input: {
    status?: string;
    url?: string;
    limit?: number;
    clearAfterReading?: boolean;
  }): Promise<unknown> {
    return this.capabilityUnavailable(
      'download inspection',
      'optional_downloads_support_not_enabled',
    );
  }

  public async batch(
    actions: readonly BrowserBatchAction[],
    continueOnError = false,
  ): Promise<BrowserBatchResult> {
    if (actions.some((action) => this.containsBatchReference(action))) {
      // The extension batch protocol intentionally does not resolve wrapper
      // references. Preserve wrapper semantics instead of forwarding strings
      // that a webpage action could misinterpret.
      return executeBrowserBatch(this, actions, continueOnError);
    }
    if (actions.length === 0 || actions.length > 25) {
      throw new BrowserBridgeError('INVALID_ARGUMENT', 'browser_batch requires 1-25 actions.', {
        stage: 'batch',
      });
    }

    const translated = [];
    for (const action of actions) {
      translated.push(await this.translateBatchAction(action));
    }
    const tab = this.selectedTab();
    const result = await this.execute(
      'batch.execute',
      { actions: translated, continue_on_error: continueOnError },
      tab,
    );
    const root = this.requireRecord(result, 'companion batch result');
    const rawResults = Array.isArray(root['results']) ? root['results'] : [];
    const normalized: {
      index: number;
      op: string;
      ok: boolean;
      value?: unknown;
      error?: unknown;
    }[] = rawResults.map((entry, fallbackIndex) => {
      const record = isRecord(entry) ? entry : {};
      const index = this.readSafeInteger(record, 'index') ?? fallbackIndex;
      const op = actions[index]?.op ?? 'unknown';
      if (record['ok'] === true) {
        return { index, op, ok: true, value: record['result'] };
      }
      return {
        index,
        op,
        ok: false,
        error: this.normalizeRemoteError(record['error']).toJSON(),
      };
    });
    const stoppedAt = this.readSafeInteger(root, 'stoppedAt');
    return {
      results: normalized,
      ...(stoppedAt !== undefined ? { stoppedAt } : {}),
      transportCalls: 1,
    };
  }

  public async close(): Promise<void> {
    if (this.closing || this.state === 'closed') return;
    this.closing = true;
    try {
      await this.transport.close();
      this.connection = undefined;
      this.state = 'closed';
      this.addDiagnostic('shutdown', true, 'Companion transport closed.');
    } finally {
      this.closing = false;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.state === 'ready' && this.connection) return;
    if (this.state === 'closed') {
      throw new BrowserBridgeError('SHUTDOWN', 'The companion session is closed.', {
        stage: 'transport',
      });
    }
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  private async connect(): Promise<void> {
    this.state = 'starting';
    this.addDiagnostic('initialize', true, 'Connecting authenticated companion transport.', {
      transportCapabilities: this.transport.capabilities,
    });
    const required = [
      this.transport.capabilities.discoveryValidation,
      this.transport.capabilities.authenticatedHandshake,
      this.transport.capabilities.secureLocalEndpoint,
    ];
    const unavailable = required.find((capability) => capability.level !== 'available');
    if (unavailable) {
      const error = new BrowserBridgeError(
        'CAPABILITY_UNAVAILABLE',
        'Authenticated same-user companion transport is unavailable.',
        {
          stage: 'transport',
          recoverable: true,
          reason: unavailable.reason ?? 'required_transport_capability_unavailable',
          transportCapabilities: this.transport.capabilities,
          hint: 'Use controlled mode until all companion transport security capabilities are available.',
        },
      );
      this.fail(error);
      throw error;
    }

    try {
      const connection = await this.transport.connect();
      this.assertSecureConnection(connection);
      if (connection.protocolVersion !== COMPANION_PROTOCOL_VERSION) {
        throw new BrowserBridgeError(
          'BROWSER_TOOL_CONTRACT_MISMATCH',
          `Unsupported companion protocol ${connection.protocolVersion}.`,
          {
            stage: 'tool-contract',
            recoverable: false,
            expected: COMPANION_PROTOCOL_VERSION,
            actual: connection.protocolVersion,
          },
        );
      }
      this.connection = connection;
      this.state = 'ready';
      this.addDiagnostic('ready', true, 'Authenticated companion extension transport is ready.', {
        serverInstanceId: connection.serverInstanceId,
        protocolVersion: connection.protocolVersion,
        security: connection.security,
        extensionCapabilities: connection.extensionCapabilities,
      });
    } catch (error) {
      const bridgeError = asBridgeError(error, 'BROWSER_CONNECTION_FAILED');
      this.fail(bridgeError);
      throw bridgeError;
    }
  }

  private assertSecureConnection(connection: CompanionConnection): void {
    if (
      !connection.serverInstanceId ||
      connection.security.local !== true ||
      connection.security.authenticated !== true ||
      connection.security.peerAccessRestricted !== true ||
      !['named-pipe', 'unix-socket'].includes(connection.security.kind)
    ) {
      throw new BrowserBridgeError(
        'CAPABILITY_UNAVAILABLE',
        'The companion transport did not prove authentication and same-user endpoint access.',
        {
          stage: 'transport',
          recoverable: false,
          reason: 'transport_security_not_verified',
        },
      );
    }
  }

  private async execute(
    operation: string,
    args: Readonly<Record<string, unknown>> = {},
    tab?: CompanionTabState,
  ): Promise<unknown> {
    await this.ensureConnected();
    const sequence = this.requestSequence++;
    const id = `${this.sessionId}:${sequence}`;
    const deadlineAt = new Date(this.now().getTime() + this.requestTimeoutMs).toISOString();
    const request: CompanionRpcRequest = {
      jsonrpc: '2.0',
      id,
      method: 'extension.execute',
      params: {
        requestId: id,
        operation,
        deadlineAt,
        ...(tab
          ? {
              target: {
                tabId: tab.nativeId,
                frameId: 0,
                ...(tab.documentId ? { documentId: tab.documentId } : {}),
                navigationGeneration: tab.navigationGeneration,
              },
            }
          : {}),
        arguments: { ...args },
      },
    };

    let raw: unknown;
    try {
      raw = await this.withTimeout(this.transport.request(request), operation);
    } catch (error) {
      const bridgeError = asBridgeError(error, 'BROWSER_CONNECTION_FAILED');
      if (bridgeError.code === 'BROWSER_CONNECTION_FAILED' || bridgeError.code === 'SHUTDOWN') {
        this.state = 'failed';
      }
      throw bridgeError;
    }
    const result = this.unwrapRpcResponse(raw, id);
    return this.unwrapContentResponse(result, tab);
  }

  private unwrapRpcResponse(value: unknown, expectedId: string): unknown {
    const response = this.requireRecord(value, 'companion JSON-RPC response');
    if (response['jsonrpc'] !== '2.0' || response['id'] !== expectedId) {
      throw new BrowserBridgeError(
        'UPSTREAM_ERROR',
        'Companion transport returned a mismatched JSON-RPC response.',
        { stage: 'protocol', recoverable: false },
      );
    }
    if (isRecord(response['error'])) {
      throw this.normalizeRemoteError(response['error']);
    }
    if (!Object.prototype.hasOwnProperty.call(response, 'result')) {
      throw new BrowserBridgeError('UPSTREAM_ERROR', 'Companion JSON-RPC response has no result.', {
        stage: 'protocol',
        recoverable: false,
      });
    }
    return response['result'];
  }

  private unwrapContentResponse(value: unknown, tab: CompanionTabState | undefined): unknown {
    if (!isRecord(value) || typeof value['ok'] !== 'boolean') return value;
    if (tab) {
      const documentId = this.readString(value, 'documentId');
      const mutationGeneration = this.readSafeInteger(value, 'mutationGeneration');
      if (documentId) tab.documentId = documentId;
      if (mutationGeneration !== undefined) tab.mutationGeneration = mutationGeneration;
    }
    if (value['ok'] === false) {
      throw this.normalizeRemoteError(value['error']);
    }
    return value['result'];
  }

  private normalizeRemoteError(value: unknown): BrowserBridgeError {
    const root = isRecord(value) ? value : {};
    const data = isRecord(root['data']) ? (root['data'] as RpcErrorData) : (root as RpcErrorData);
    const remoteCode = typeof data.code === 'string' ? data.code : 'INTERNAL_ERROR';
    const message =
      typeof data.message === 'string'
        ? data.message
        : typeof root['message'] === 'string'
          ? root['message']
          : 'The companion extension returned an error.';
    const mappedCode =
      remoteCode === 'CAPABILITY_UNAVAILABLE'
        ? 'CAPABILITY_UNAVAILABLE'
        : remoteCode === 'PERMISSION_REQUIRED' ||
            remoteCode === 'DESTRUCTIVE_ACTION_REQUIRED' ||
            remoteCode === 'SENSITIVE_ACTION_REQUIRED'
          ? 'PERMISSION_REQUIRED'
          : remoteCode === 'PERMISSION_DENIED'
            ? 'PERMISSION_DENIED'
            : remoteCode === 'STALE_REFERENCE' || remoteCode === 'STALE_UID'
              ? 'STALE_REFERENCE'
              : remoteCode === 'TAB_NOT_FOUND'
                ? 'INVALID_TAB'
                : remoteCode === 'TIMEOUT' || remoteCode === 'DEADLINE_EXCEEDED'
                  ? 'TIMEOUT'
                  : remoteCode === 'CONNECTION_LOST'
                    ? 'BROWSER_CONNECTION_FAILED'
                    : remoteCode === 'INVALID_REQUEST' ||
                        remoteCode === 'INVALID_SELECTOR' ||
                        remoteCode === 'NOT_EDITABLE' ||
                        remoteCode === 'NOT_SELECTABLE' ||
                        remoteCode === 'OPTION_NOT_FOUND'
                      ? 'INVALID_ARGUMENT'
                      : remoteCode === 'NOT_INTERACTABLE' ||
                          remoteCode === 'ELEMENT_NOT_INTERACTABLE'
                        ? 'ACTION_BLOCKED'
                        : 'UPSTREAM_ERROR';
    return new BrowserBridgeError(mappedCode, message, {
      stage: 'companion-extension',
      recoverable: data.recoverable === true,
      upstreamCode: remoteCode,
      ...(isRecord(data.details) ? { remoteDetails: data.details } : {}),
      ...(mappedCode === 'PERMISSION_REQUIRED'
        ? {
            hint: 'Approve or deny the pending request in the LibreWolf extension UI. MCP calls and webpage content cannot grant permission.',
          }
        : {}),
    });
  }

  private async resolveTab(input: {
    tabId?: string;
    index?: number;
    title?: string;
    url?: string;
  }): Promise<CompanionTabState> {
    await this.listTabs();
    const values = [...this.tabs.values()];
    const tab =
      (input.tabId ? values.find((candidate) => candidate.id === input.tabId) : undefined) ??
      (input.index !== undefined
        ? values.find((candidate) => candidate.index === input.index)
        : undefined) ??
      (input.url ? values.find((candidate) => candidate.url?.includes(input.url!)) : undefined) ??
      (input.title
        ? values.find((candidate) =>
            candidate.title
              .toLocaleLowerCase('en-US')
              .includes(input.title!.toLocaleLowerCase('en-US')),
          )
        : undefined);
    if (!tab) {
      throw new BrowserBridgeError(
        'INVALID_TAB',
        'No companion tab matched the requested target.',
        {
          stage: 'tabs',
          recoverable: true,
        },
      );
    }
    return tab;
  }

  private async requireSelectedTab(): Promise<CompanionTabState> {
    await this.ensureConnected();
    let tab = this.selectedTab();
    if (!tab) {
      await this.listTabs();
      tab = this.selectedTab();
    }
    if (!tab) {
      throw new BrowserBridgeError('INVALID_TAB', 'No LibreWolf companion tab is selected.', {
        stage: 'tabs',
        recoverable: true,
      });
    }
    return tab;
  }

  private reconcileTabs(value: unknown): readonly BrowserTab[] {
    if (!Array.isArray(value)) {
      throw new BrowserBridgeError('UPSTREAM_ERROR', 'Companion tab listing was not an array.', {
        stage: 'tabs',
        recoverable: true,
      });
    }
    const seen = new Set<number>();
    for (const [index, item] of value.entries()) {
      if (!isRecord(item)) continue;
      const nativeId = this.readSafeInteger(item, 'tabId') ?? this.readSafeInteger(item, 'id');
      if (nativeId === undefined || nativeId < 0) continue;
      seen.add(nativeId);
      const readable = item['access'] !== 'permission_required';
      const readableUrl = readable ? this.readString(item, 'url') : undefined;
      this.upsertTab(nativeId, {
        index,
        title: readable ? (this.readString(item, 'title') ?? 'Untitled') : '[permission required]',
        ...(readableUrl ? { url: readableUrl } : {}),
        selected: item['active'] === true || item['selected'] === true,
      });
    }
    for (const nativeId of this.tabs.keys()) {
      if (!seen.has(nativeId)) this.tabs.delete(nativeId);
    }
    const selected = [...this.tabs.values()].find((tab) => tab.selected);
    this.selectedNativeTabId = selected?.nativeId;
    return [...this.tabs.values()]
      .sort((left, right) => left.index - right.index)
      .map((tab) => ({
        id: tab.id,
        index: tab.index,
        title: tab.title,
        ...(tab.url ? { url: tab.url } : {}),
        selected: tab.selected,
      }));
  }

  private upsertTab(
    nativeId: number,
    value: {
      index: number;
      title: string;
      url?: string;
      selected: boolean;
    },
  ): CompanionTabState {
    const existing = this.tabs.get(nativeId);
    const tab: CompanionTabState = existing ?? {
      nativeId,
      id: this.publicTabId(nativeId),
      index: value.index,
      title: value.title,
      selected: value.selected,
      navigationGeneration: 1,
      mutationGeneration: 0,
    };
    tab.index = value.index;
    tab.title = value.title;
    tab.selected = value.selected;
    if (value.url) tab.url = value.url;
    this.tabs.set(nativeId, tab);
    return tab;
  }

  private selectLocalTab(nativeId: number): void {
    for (const candidate of this.tabs.values()) {
      candidate.selected = candidate.nativeId === nativeId;
    }
    this.selectedNativeTabId = nativeId;
  }

  private selectedTab(): CompanionTabState | undefined {
    return this.selectedNativeTabId === undefined
      ? undefined
      : this.tabs.get(this.selectedNativeTabId);
  }

  private async navigateHistory(
    operation: 'tabs.back' | 'tabs.forward',
    direction: 'back' | 'forward',
  ): Promise<BrowserActionResult> {
    const tab = await this.requireSelectedTab();
    await this.execute(operation, {}, tab);
    this.invalidateNavigation(tab);
    return this.action(tab, `Navigated ${direction}.`);
  }

  private async domAction(
    operation: string,
    args: Readonly<Record<string, unknown>>,
    message: string,
  ): Promise<BrowserActionResult> {
    const tab = await this.requireSelectedTab();
    const result = await this.execute(operation, args, tab);
    return this.action(tab, message, result);
  }

  private invalidateNavigation(tab: CompanionTabState, url?: string): void {
    tab.navigationGeneration += 1;
    tab.mutationGeneration = 0;
    delete tab.documentId;
    if (url) tab.url = url;
  }

  private action(tab: CompanionTabState, message: string, data?: unknown): BrowserActionResult {
    return {
      ok: true,
      tabId: tab.id,
      navigationGeneration: tab.navigationGeneration,
      message,
      ...(data === undefined ? {} : { data }),
    };
  }

  private capabilityUnavailable(label: string, reason: string): never {
    throw new BrowserBridgeError(
      'CAPABILITY_UNAVAILABLE',
      `${label} is unavailable in companion mode.`,
      {
        stage: 'capability',
        recoverable: true,
        reason,
        useMode: 'controlled',
      },
    );
  }

  private fail(error: BrowserBridgeError): void {
    this.state = 'failed';
    this.connection = undefined;
    this.addDiagnostic('failed', false, error.message, {
      code: error.code,
      ...error.details,
    });
  }

  private addDiagnostic(
    stage: StartupDiagnostic['stage'],
    ok: boolean,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ): void {
    this.diagnostics.push({
      stage,
      ok,
      at: this.now().toISOString(),
      message,
      ...(details ? { details } : {}),
    });
    if (this.diagnostics.length > 100) {
      this.diagnostics.splice(0, this.diagnostics.length - 100);
    }
  }

  private publicTabId(nativeId: number): string {
    return `companion:${nativeId}`;
  }

  private extractNativeTabId(value: unknown): number | undefined {
    if (!isRecord(value)) return undefined;
    return this.readSafeInteger(value, 'tabId') ?? this.readSafeInteger(value, 'id');
  }

  private readString(
    value: Readonly<Record<string, unknown>> | unknown,
    key: string,
  ): string | undefined {
    return isRecord(value) && typeof value[key] === 'string' ? (value[key] as string) : undefined;
  }

  private requireString(
    value: Readonly<Record<string, unknown>>,
    key: string,
    label: string,
  ): string {
    const result = this.readString(value, key);
    if (result === undefined) {
      throw new BrowserBridgeError('UPSTREAM_ERROR', `${label} is missing ${key}.`, {
        stage: 'protocol',
        recoverable: false,
      });
    }
    return result;
  }

  private readSafeInteger(
    value: Readonly<Record<string, unknown>>,
    key: string,
  ): number | undefined {
    const result = value[key];
    return Number.isSafeInteger(result) ? (result as number) : undefined;
  }

  private requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!isRecord(value)) {
      throw new BrowserBridgeError('UPSTREAM_ERROR', `${label} was not an object.`, {
        stage: 'protocol',
        recoverable: false,
      });
    }
    return value;
  }

  private directionalDelta(
    direction: string | undefined,
    amount: number,
  ): { x: number; y: number } {
    switch (direction) {
      case 'up':
        return { x: 0, y: -amount };
      case 'down':
        return { x: 0, y: amount };
      case 'left':
        return { x: -amount, y: 0 };
      case 'right':
        return { x: amount, y: 0 };
      default:
        return { x: 0, y: 0 };
    }
  }

  private containsBatchReference(value: unknown): boolean {
    if (typeof value === 'string') return value.startsWith('$');
    if (Array.isArray(value)) return value.some((item) => this.containsBatchReference(item));
    if (!isRecord(value)) return false;
    return Object.values(value).some((item) => this.containsBatchReference(item));
  }

  private async translateBatchAction(action: BrowserBatchAction): Promise<Record<string, unknown>> {
    const translated: Record<string, unknown> = { ...action };
    if (
      typeof action['tab_id'] === 'string' ||
      typeof action['index'] === 'number' ||
      typeof action['title'] === 'string' ||
      (typeof action['url'] === 'string' && ['select_tab', 'close_tab'].includes(action.op))
    ) {
      if (['select_tab', 'close_tab'].includes(action.op)) {
        const tab = await this.resolveTab({
          ...(typeof action['tab_id'] === 'string' ? { tabId: action['tab_id'] } : {}),
          ...(typeof action['index'] === 'number' ? { index: action['index'] } : {}),
          ...(typeof action['title'] === 'string' ? { title: action['title'] } : {}),
          ...(typeof action['url'] === 'string' ? { url: action['url'] } : {}),
        });
        translated['tabId'] = tab.nativeId;
        delete translated['tab_id'];
        delete translated['index'];
        delete translated['title'];
      }
    }
    if (action.op === 'select_option') {
      const values = action['values'];
      if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string') {
        this.capabilityUnavailable(
          'companion multi-option selection',
          'companion_select_supports_exactly_one_value',
        );
      }
      translated['value'] = values[0];
      delete translated['values'];
    }
    if (action.op === 'click' && action['double_click'] === true) {
      this.capabilityUnavailable(
        'companion double click',
        'companion_double_click_not_implemented',
      );
    }
    if (action.op === 'scroll') {
      const direction = typeof action['direction'] === 'string' ? action['direction'] : undefined;
      const amount = typeof action['amount'] === 'number' ? action['amount'] : 500;
      const directional = this.directionalDelta(direction, amount);
      translated['x'] = typeof action['delta_x'] === 'number' ? action['delta_x'] : directional.x;
      translated['y'] = typeof action['delta_y'] === 'number' ? action['delta_y'] : directional.y;
      delete translated['delta_x'];
      delete translated['delta_y'];
      delete translated['direction'];
      delete translated['amount'];
    }
    if (
      ['upload_file', 'get_console', 'get_network', 'get_request', 'get_downloads'].includes(
        action.op,
      )
    ) {
      this.capabilityUnavailable(action.op, 'requires_controlled_profile');
    }
    return translated;
  }

  private async withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new BrowserBridgeError(
                'TIMEOUT',
                `Companion operation ${label} exceeded ${this.requestTimeoutMs} ms.`,
                {
                  stage: 'transport',
                  recoverable: true,
                  operation: label,
                },
              ),
            );
          }, this.requestTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
