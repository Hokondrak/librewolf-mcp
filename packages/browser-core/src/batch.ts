import { BrowserBridgeError, asBridgeError } from './errors.js';
import type {
  BrowserBatchAction,
  BrowserBatchResult,
  BrowserSession,
  SnapshotResult,
} from './types.js';

const MAX_BATCH_ACTIONS = 25;

const lookupPath = (root: unknown, path: readonly string[]): unknown => {
  let current = root;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  return current;
};

const resolveReference = (value: unknown, references: ReadonlyMap<string, unknown>): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => resolveReference(item, references));
  }
  if (value !== null && typeof value === 'object') {
    const object = value as Readonly<Record<string, unknown>>;
    if (typeof object['$ref'] === 'string' && Object.keys(object).length === 1) {
      return resolveReferenceString(`$${object['$ref']}`, references);
    }
    return Object.fromEntries(
      Object.entries(object).map(([key, item]) => [key, resolveReference(item, references)]),
    );
  }
  if (typeof value === 'string' && value.startsWith('$')) {
    return resolveReferenceString(value, references);
  }
  return value;
};

const resolveReferenceString = (
  reference: string,
  references: ReadonlyMap<string, unknown>,
): unknown => {
  const path = reference.slice(1).split('.');
  const name = path.shift();
  if (!name || !references.has(name)) {
    throw new BrowserBridgeError('INVALID_ARGUMENT', `Unknown batch reference: ${reference}`, {
      stage: 'batch',
      recoverable: false,
    });
  }
  return lookupPath(references.get(name), path);
};

const stringValue = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BrowserBridgeError('INVALID_ARGUMENT', `${name} must be a non-empty string.`, {
      stage: 'batch',
    });
  }
  return value;
};

const numberValue = (value: unknown, name: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BrowserBridgeError('INVALID_ARGUMENT', `${name} must be a finite number.`, {
      stage: 'batch',
    });
  }
  return value;
};

const booleanValue = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

/**
 * Indexes the UIDs a snapshot just issued, keyed by accessible name and by `role:name`.
 *
 * A snapshot taken inside a batch supersedes the UIDs of any earlier snapshot, so actions later
 * in the same batch cannot reuse UIDs captured before it. This index is what makes the
 * documented pattern work: `{"op":"snapshot","as":"page"}` followed by
 * `{"op":"fill","uid":{"$ref":"page.uids.Email"}}`. First occurrence wins; ambiguous names are
 * left to the caller to disambiguate with the `role:name` key.
 */
const indexSnapshotUids = (content: string): Readonly<Record<string, string>> => {
  const index: Record<string, string> = {};
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/\[uid=([^\]]+)\]\s+(\S+)\s+"((?:[^"\\]|\\.)*)"/u);
    const [, uid, role, name] = match ?? [];
    if (!uid || !role || name === undefined) {
      continue;
    }
    const decoded = name.replace(/\\"/gu, '"').replace(/\\\\/gu, '\\');
    index[decoded] ??= uid;
    index[`${role}:${decoded}`] ??= uid;
  }
  return index;
};

const pollForText = async (
  session: BrowserSession,
  text: string,
  timeoutMs: number,
): Promise<SnapshotResult> => {
  const deadline = performance.now() + timeoutMs;
  let latest: SnapshotResult | undefined;
  while (performance.now() < deadline) {
    latest = await session.snapshot({
      includeText: true,
      interactiveOnly: false,
      maxChars: 20_000,
      maxElements: 500,
    });
    if (latest.text.includes(text)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new BrowserBridgeError('TIMEOUT', `Timed out waiting for text: ${text}`, {
    stage: 'batch-wait',
    recoverable: true,
  });
};

export const executeBrowserBatch = async (
  session: BrowserSession,
  actions: readonly BrowserBatchAction[],
  continueOnError = false,
): Promise<BrowserBatchResult> => {
  if (actions.length === 0 || actions.length > MAX_BATCH_ACTIONS) {
    throw new BrowserBridgeError(
      'INVALID_ARGUMENT',
      `browser_batch requires 1-${MAX_BATCH_ACTIONS} actions.`,
      { stage: 'batch' },
    );
  }

  const references = new Map<string, unknown>();
  const results: {
    index: number;
    op: string;
    ok: boolean;
    value?: unknown;
    error?: unknown;
  }[] = [];

  for (const [index, original] of actions.entries()) {
    const resolved = resolveReference(original, references) as Readonly<Record<string, unknown>>;
    const op = stringValue(resolved['op'], `actions[${index}].op`);
    try {
      const value = await executeOne(session, op, resolved);
      const entry = { index, op, ok: true as const, value };
      results.push(entry);
      if (typeof original.as === 'string') {
        references.set(original.as, value);
      }
    } catch (error) {
      const bridgeError = asBridgeError(error);
      results.push({ index, op, ok: false, error: bridgeError.toJSON() });
      if (!continueOnError) {
        return { results, stoppedAt: index, transportCalls: 1 };
      }
    }
  }

  return { results, transportCalls: 1 };
};

const executeOne = async (
  session: BrowserSession,
  op: string,
  action: Readonly<Record<string, unknown>>,
): Promise<unknown> => {
  switch (op) {
    case 'status':
      return session.status();
    case 'list_tabs':
      return session.listTabs();
    case 'select_tab':
      return session.selectTab({
        ...(typeof action['tab_id'] === 'string' ? { tabId: action['tab_id'] } : {}),
        ...(typeof action['index'] === 'number' ? { index: action['index'] } : {}),
        ...(typeof action['title'] === 'string' ? { title: action['title'] } : {}),
        ...(typeof action['url'] === 'string' ? { url: action['url'] } : {}),
      });
    case 'open_tab':
      return session.openTab(stringValue(action['url'], 'url'));
    case 'close_tab':
      return session.closeTab({
        ...(typeof action['tab_id'] === 'string' ? { tabId: action['tab_id'] } : {}),
        ...(typeof action['index'] === 'number' ? { index: action['index'] } : {}),
      });
    case 'navigate':
      return session.navigate(stringValue(action['url'], 'url'));
    case 'back':
      return session.back();
    case 'forward':
      return session.forward();
    case 'snapshot': {
      const interactiveOnly = booleanValue(action['interactive_only']);
      const includeText = booleanValue(action['include_text']);
      const maxChars = numberValue(action['max_chars'], 'max_chars');
      const maxElements = numberValue(action['max_elements'], 'max_elements');
      const snapshot = await session.snapshot({
        ...(typeof action['selector'] === 'string' ? { selector: action['selector'] } : {}),
        ...(interactiveOnly !== undefined ? { interactiveOnly } : {}),
        ...(includeText !== undefined ? { includeText } : {}),
        ...(maxChars !== undefined ? { maxChars } : {}),
        ...(maxElements !== undefined ? { maxElements } : {}),
      });
      return { ...snapshot, uids: indexSnapshotUids(snapshot.text) };
    }
    case 'find': {
      const exact = booleanValue(action['exact']);
      return session.find({
        text: stringValue(action['text'], 'text'),
        ...(exact !== undefined ? { exact } : {}),
        ...(typeof action['role'] === 'string' ? { role: action['role'] } : {}),
        ...(typeof action['limit'] === 'number' ? { limit: action['limit'] } : {}),
      });
    }
    case 'get_text':
      return session.getText({
        ...(typeof action['uid'] === 'string' ? { uid: action['uid'] } : {}),
        ...(typeof action['selector'] === 'string' ? { selector: action['selector'] } : {}),
        ...(typeof action['max_chars'] === 'number' ? { maxChars: action['max_chars'] } : {}),
      });
    case 'click': {
      const doubleClick = booleanValue(action['double_click']);
      return session.click({
        uid: stringValue(action['uid'], 'uid'),
        ...(doubleClick !== undefined ? { doubleClick } : {}),
      });
    }
    case 'hover':
      return session.hover(stringValue(action['uid'], 'uid'));
    case 'fill':
      return session.fill({
        uid: stringValue(action['uid'], 'uid'),
        value: stringValue(action['value'], 'value'),
      });
    case 'fill_form': {
      if (!Array.isArray(action['fields'])) {
        throw new BrowserBridgeError('INVALID_ARGUMENT', 'fields must be an array.', {
          stage: 'batch',
        });
      }
      const fields = action['fields'].map((field, index) => {
        if (field === null || typeof field !== 'object') {
          throw new BrowserBridgeError('INVALID_ARGUMENT', `fields[${index}] must be an object.`, {
            stage: 'batch',
          });
        }
        const record = field as Readonly<Record<string, unknown>>;
        return {
          uid: stringValue(record['uid'], `fields[${index}].uid`),
          value: stringValue(record['value'], `fields[${index}].value`),
        };
      });
      return session.fillForm(fields);
    }
    case 'select_option': {
      if (!Array.isArray(action['values'])) {
        throw new BrowserBridgeError('INVALID_ARGUMENT', 'values must be an array.', {
          stage: 'batch',
        });
      }
      return session.selectOption({
        uid: stringValue(action['uid'], 'uid'),
        values: action['values'].map((value, index) => stringValue(value, `values[${index}]`)),
      });
    }
    case 'press_key':
      return session.pressKey({
        key: stringValue(action['key'], 'key'),
        ...(typeof action['uid'] === 'string' ? { uid: action['uid'] } : {}),
      });
    case 'scroll':
      return session.scroll({
        ...(typeof action['uid'] === 'string' ? { uid: action['uid'] } : {}),
        ...(typeof action['delta_x'] === 'number' ? { deltaX: action['delta_x'] } : {}),
        ...(typeof action['delta_y'] === 'number' ? { deltaY: action['delta_y'] } : {}),
        ...(typeof action['direction'] === 'string' ? { direction: action['direction'] } : {}),
        ...(typeof action['amount'] === 'number' ? { amount: action['amount'] } : {}),
      });
    case 'upload_file':
      return session.uploadFile({
        uid: stringValue(action['uid'], 'uid'),
        path: stringValue(action['path'], 'path'),
      });
    case 'screenshot':
      return session.screenshot({
        ...(typeof action['uid'] === 'string' ? { uid: action['uid'] } : {}),
        ...(typeof action['path'] === 'string' ? { path: action['path'] } : {}),
      });
    case 'get_console':
      return session.getConsole({
        ...(typeof action['severity'] === 'string'
          ? {
              severity: action['severity'] as 'debug' | 'info' | 'warn' | 'error',
            }
          : {}),
        ...(typeof action['limit'] === 'number' ? { limit: action['limit'] } : {}),
      });
    case 'get_network':
      return session.getNetwork({
        ...(typeof action['url'] === 'string' ? { url: action['url'] } : {}),
        ...(typeof action['method'] === 'string' ? { method: action['method'] } : {}),
        ...(typeof action['limit'] === 'number' ? { limit: action['limit'] } : {}),
        ...(typeof action['errors_only'] === 'boolean'
          ? { errorsOnly: action['errors_only'] }
          : {}),
      });
    case 'get_request':
      return session.getRequest({
        requestId: stringValue(action['request_id'], 'request_id'),
      });
    case 'get_downloads':
      return session.getDownloads({
        ...(typeof action['status'] === 'string' ? { status: action['status'] } : {}),
        ...(typeof action['url'] === 'string' ? { url: action['url'] } : {}),
        ...(typeof action['limit'] === 'number' ? { limit: action['limit'] } : {}),
      });
    case 'wait_for_text':
      return pollForText(
        session,
        stringValue(action['text'], 'text'),
        numberValue(action['timeout_ms'], 'timeout_ms') ?? 10_000,
      );
    default:
      throw new BrowserBridgeError('INVALID_ARGUMENT', `Unsupported batch operation: ${op}`, {
        stage: 'batch',
        recoverable: false,
      });
  }
};
