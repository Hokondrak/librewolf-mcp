import {
  isExtensionRequest,
  isRecord,
  rpcFailure,
  rpcSuccess,
  type ExtensionRequest,
  type RpcErrorData,
} from '../shared/protocol.js';
import { companionCapabilities } from './capabilities.js';
import { ContentInjector, ContentOperationError, StaleDocumentError } from './content-injector.js';
import {
  PermissionRegistry,
  canonicalHttpOrigin,
  type PendingPermission,
} from './permission-registry.js';

const TOOL_OPERATION_MAP: Record<string, string> = {
  browser_list_tabs: 'tabs.list',
  browser_select_tab: 'tabs.select',
  browser_open_tab: 'tabs.open',
  browser_close_tab: 'tabs.close',
  browser_navigate: 'tabs.navigate',
  browser_back: 'tabs.back',
  browser_forward: 'tabs.forward',
  browser_snapshot: 'dom.snapshot',
  browser_find: 'dom.find',
  browser_get_text: 'dom.getText',
  browser_click: 'dom.click',
  browser_hover: 'dom.hover',
  browser_fill: 'dom.fill',
  browser_fill_form: 'dom.fillForm',
  browser_select_option: 'dom.selectOption',
  browser_press_key: 'dom.pressKey',
  browser_scroll: 'dom.scroll',
  browser_screenshot: 'page.screenshot',
  browser_get_downloads: 'downloads.read',
  browser_upload_file: 'files.upload',
  browser_get_console: 'console.read',
  browser_get_network: 'network.read',
  browser_get_request: 'network.request',
  browser_batch: 'batch.execute',
};

const BATCH_OPERATION_MAP: Record<string, string> = {
  list_tabs: 'tabs.list',
  select_tab: 'tabs.select',
  open_tab: 'tabs.open',
  close_tab: 'tabs.close',
  navigate: 'tabs.navigate',
  back: 'tabs.back',
  forward: 'tabs.forward',
  snapshot: 'dom.snapshot',
  find: 'dom.find',
  get_text: 'dom.getText',
  click: 'dom.click',
  hover: 'dom.hover',
  fill: 'dom.fill',
  fill_form: 'dom.fillForm',
  select_option: 'dom.selectOption',
  press_key: 'dom.pressKey',
  scroll: 'dom.scroll',
  screenshot: 'page.screenshot',
};

export class ExtensionRouter {
  constructor(
    private readonly permissions: PermissionRegistry,
    private readonly content: ContentInjector,
    private readonly connectionStatus: () => unknown,
  ) {}

  async handle(message: unknown): Promise<Record<string, unknown> | undefined> {
    if (!isExtensionRequest(message)) return undefined;
    try {
      const result = await this.#execute(message);
      return rpcSuccess(message.id, result);
    } catch (error) {
      return rpcFailure(message.id, toRpcError(error));
    }
  }

  async #execute(request: ExtensionRequest): Promise<unknown> {
    const { params } = request;
    if (params.deadlineAt && Date.parse(params.deadlineAt) <= Date.now()) {
      throw new OperationError('DEADLINE_EXCEEDED', 'The request deadline elapsed.', true);
    }
    const operation = TOOL_OPERATION_MAP[params.operation] ?? params.operation;
    const args = params.arguments ?? {};

    if (operation === 'browser.status' || params.operation === 'browser_status') {
      return {
        connected: true,
        connection: this.connectionStatus(),
        capabilities: companionCapabilities(),
      };
    }
    if (operation === 'batch.execute') return this.#executeBatch(request, args);
    if (operation === 'tabs.list') return this.#listTabs();
    if (
      operation === 'console.read' ||
      operation === 'network.read' ||
      operation === 'network.request'
    ) {
      throw unavailable(operation, 'requires_controlled_profile_bidi');
    }
    if (operation === 'files.upload') {
      throw unavailable(operation, 'safe_os_file_selection_requires_controlled_profile');
    }
    if (operation === 'downloads.read') {
      throw unavailable(operation, 'optional_downloads_support_not_enabled');
    }

    const tabId = await this.#resolveTabId(params.target?.tabId, args);
    const tab = await browser.tabs.get(tabId);
    const origin = targetOrigin(operation, tab, args);
    const requiresHost = operation.startsWith('dom.');
    const hostGranted = requiresHost
      ? await browser.permissions.contains({ origins: [`${origin}/*`] })
      : true;
    const evaluation = this.permissions.evaluate(params.requestId, origin, operation, hostGranted);
    if (!evaluation.allowed) {
      if (evaluation.denial) {
        throw new OperationError('PERMISSION_DENIED', `Permission denied for ${origin}.`, false, {
          origin,
          reason: evaluation.denial,
        });
      }
      throw permissionRequired(evaluation.pending);
    }

    switch (operation) {
      case 'tabs.select':
        return browser.tabs.update(tabId, { active: true });
      case 'tabs.open': {
        const url = requiredString(args, 'url');
        return browser.tabs.create({ url, active: args['active'] !== false });
      }
      case 'tabs.close':
        await browser.tabs.remove(tabId);
        return { closed: true, tabId };
      case 'tabs.navigate': {
        const url = requiredString(args, 'url');
        return browser.tabs.update(tabId, { url });
      }
      case 'tabs.back':
        await browser.tabs.goBack(tabId);
        return { navigated: 'back', tabId };
      case 'tabs.forward':
        await browser.tabs.goForward(tabId);
        return { navigated: 'forward', tabId };
      case 'page.screenshot': {
        if (!tab.active || tab.windowId === undefined) {
          throw unavailable(operation, 'active_visible_tab_only');
        }
        const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, {
          format: args['format'] === 'jpeg' ? 'jpeg' : 'png',
        });
        if (dataUrl.length > 6 * 1024 * 1024) {
          throw new OperationError(
            'FRAME_TOO_LARGE',
            'Screenshot exceeds the companion transport limit.',
            true,
          );
        }
        return { dataUrl, degraded: true, reason: 'active_visible_tab_only' };
      }
      default:
        if (operation.startsWith('dom.')) {
          return this.content.execute(
            tabId,
            {
              channel: 'librewolf-agent-bridge.content.v1',
              operation,
              requestId: params.requestId,
              expectedDocumentId: params.target?.documentId,
              arguments: args,
            },
            params.target?.frameId ?? 0,
          );
        }
        throw new OperationError(
          'CAPABILITY_UNAVAILABLE',
          `Companion operation is not implemented: ${operation}`,
          true,
          { operation },
        );
    }
  }

  async #executeBatch(
    request: ExtensionRequest,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const actions = args['actions'];
    if (!Array.isArray(actions) || actions.length === 0 || actions.length > 25) {
      throw new OperationError(
        'INVALID_REQUEST',
        'A companion batch must contain between 1 and 25 actions.',
        true,
      );
    }
    const continueOnError = args['continue_on_error'] === true;
    const results: unknown[] = [];
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      if (!isRecord(action) || typeof action['op'] !== 'string') {
        throw new OperationError(
          'INVALID_REQUEST',
          `Invalid batch action at index ${index}.`,
          true,
        );
      }
      const operation = BATCH_OPERATION_MAP[action['op']] ?? action['op'];
      if (operation === 'batch.execute') {
        throw new OperationError('INVALID_REQUEST', 'Nested batches are not supported.', true);
      }
      const actionArguments = { ...action };
      delete actionArguments['op'];
      delete actionArguments['as'];
      try {
        const result = await this.#execute({
          jsonrpc: '2.0',
          id: `${String(request.id)}:${index}`,
          method: 'extension.execute',
          params: {
            requestId: `${request.params.requestId}:${index}`,
            operation,
            ...(request.params.deadlineAt ? { deadlineAt: request.params.deadlineAt } : {}),
            ...(request.params.target ? { target: request.params.target } : {}),
            arguments: actionArguments,
          },
        });
        results.push({
          index,
          ...(typeof action['as'] === 'string' ? { as: action['as'] } : {}),
          ok: true,
          result,
        });
      } catch (error) {
        const failure = toRpcError(error);
        results.push({ index, ok: false, error: failure });
        if (!continueOnError) {
          return { results, stoppedAt: index, completed: false };
        }
      }
    }
    return { results, completed: true };
  }

  async #listTabs(): Promise<unknown> {
    const tabs = await browser.tabs.query({});
    return tabs
      .filter((tab): tab is BrowserTab & { id: number } => typeof tab.id === 'number')
      .map((tab) => {
        const origin = safeOrigin(tab.url);
        const readable = origin ? this.permissions.can(origin, 'read_page') : false;
        return {
          tabId: tab.id,
          active: tab.active === true,
          highlighted: tab.highlighted === true,
          pinned: tab.pinned === true,
          status: tab.status ?? 'unknown',
          access: readable ? 'allowed' : 'permission_required',
          ...(readable ? { title: tab.title ?? '', url: tab.url ?? '', origin } : {}),
        };
      });
  }

  async #resolveTabId(
    explicit: number | undefined,
    args: Record<string, unknown>,
  ): Promise<number> {
    if (Number.isInteger(explicit) && (explicit ?? -1) >= 0) return explicit as number;
    if (Number.isInteger(args['tabId']) && (args['tabId'] as number) >= 0) {
      return args['tabId'] as number;
    }
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    if (typeof active?.id !== 'number') {
      throw new OperationError('INVALID_REQUEST', 'No active LibreWolf tab is available.', true);
    }
    return active.id;
  }
}

export class OperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recoverable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OperationError';
  }
}

function targetOrigin(operation: string, tab: BrowserTab, args: Record<string, unknown>): string {
  if (operation === 'tabs.open' || operation === 'tabs.navigate') {
    return canonicalHttpOrigin(requiredString(args, 'url'));
  }
  if (!tab.url) {
    throw new OperationError('RESTRICTED_PAGE', 'The tab URL is unavailable.', false);
  }
  try {
    return canonicalHttpOrigin(tab.url);
  } catch {
    throw new OperationError(
      'RESTRICTED_PAGE',
      'LibreWolf internal, extension, file, and opaque pages cannot be automated.',
      false,
      { urlScheme: tab.url.split(':', 1)[0] ?? 'unknown' },
    );
  }
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new OperationError('INVALID_REQUEST', `Missing string argument: ${key}`, true);
  }
  return value;
}

function safeOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return canonicalHttpOrigin(url);
  } catch {
    return undefined;
  }
}

function permissionRequired(pending: PendingPermission | undefined): OperationError {
  return new OperationError(
    'PERMISSION_REQUIRED',
    'Approve this request from the LibreWolf Agent Bridge toolbar popup.',
    true,
    pending
      ? {
          requestId: pending.requestId,
          origin: pending.origin,
          originPattern: pending.originPattern,
          categories: pending.categories,
          expiresAt: new Date(pending.expiresAt).toISOString(),
          hostPermissionRequired: pending.hostPermissionRequired,
          approvalSurface: 'extension_popup',
        }
      : undefined,
  );
}

function unavailable(operation: string, reason: string): OperationError {
  return new OperationError(
    'CAPABILITY_UNAVAILABLE',
    `${operation} is unavailable in companion-extension mode.`,
    true,
    { operation, reason, useMode: 'controlled_profile' },
  );
}

function toRpcError(error: unknown): RpcErrorData {
  if (error instanceof OperationError) {
    return {
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  if (error instanceof StaleDocumentError) {
    return {
      code: 'STALE_REFERENCE',
      message: error.message,
      recoverable: true,
      details: {
        expectedDocumentId: error.expectedDocumentId,
        actualDocumentId: error.actualDocumentId,
      },
    };
  }
  if (error instanceof ContentOperationError) {
    return {
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error),
    recoverable: false,
  };
}
