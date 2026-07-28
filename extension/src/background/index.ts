import { companionCapabilities } from './capabilities.js';
import { ContentInjector } from './content-injector.js';
import { NativeConnection } from './native-connection.js';
import {
  BrowserPermissionStorage,
  PermissionRegistry,
  canonicalHttpOrigin,
  type PermissionCategory,
  type PermissionDecision,
} from './permission-registry.js';
import { ExtensionRouter } from './router.js';
import { isRecord } from '../shared/protocol.js';

const permissions = new PermissionRegistry(new BrowserPermissionStorage());
const connection = new NativeConnection(companionCapabilities());
const router = new ExtensionRouter(permissions, new ContentInjector(), () => connection.status());

void permissions.initialize().then(() => connection.start());

connection.onMessage((message) => {
  if (isRecord(message) && message['method'] === 'host.status' && isRecord(message['params'])) {
    const serverInstanceId = message['params']['serverInstanceId'];
    if (typeof serverInstanceId === 'string') void permissions.setServerInstance(serverInstanceId);
    return;
  }
  void router.handle(message).then((response) => {
    if (!response) return;
    try {
      connection.send(response);
    } catch {
      // The caller receives a disconnect/outcome-unknown error from the MCP-side ledger.
    }
  });
});

connection.onStatus((status) => {
  const action = browser.action ?? browser.browserAction;
  if (!action) return;
  const text = status.state === 'connected' ? '' : status.state === 'degraded' ? '!' : '×';
  void action.setBadgeText({ text });
  void action.setBadgeBackgroundColor({
    color: status.state === 'connected' ? '#2e7d32' : '#b3261e',
  });
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bridge-reconnect') connection.reconnectFromAlarm();
});

browser.runtime.onStartup.addListener(() => {
  permissions.resetTransient();
  void permissions.persist();
  connection.start();
});

browser.permissions.onRemoved.addListener(() => {
  // Browser host permission revocation is checked again for every operation.
});

browser.runtime.onMessage.addListener(async (message, sender) => {
  if (sender.tab || !isRecord(message) || typeof message['type'] !== 'string') return undefined;
  switch (message['type']) {
    case 'bridge.ui.getState':
      return {
        connection: connection.status(),
        pending: permissions.listPending()[0] ?? null,
        capabilities: companionCapabilities(),
      };
    case 'bridge.ui.decide': {
      const requestId = requiredUiString(message, 'requestId');
      const decision = requiredDecision(message['decision']);
      const pending = permissions.listPending().find((item) => item.requestId === requestId);
      if (!pending) throw new Error('Permission request is missing or expired.');
      if (
        decision.startsWith('allow') &&
        pending.hostPermissionRequired &&
        !(await browser.permissions.contains({ origins: [pending.originPattern] }))
      ) {
        throw new Error('Firefox host permission was not granted from the popup.');
      }
      await permissions.decide(requestId, decision);
      return { ok: true };
    }
    case 'bridge.ui.listPolicies':
      return { policies: permissions.listPersistent() };
    case 'bridge.ui.grantPolicy': {
      const origin = canonicalHttpOrigin(requiredUiString(message, 'origin'));
      if (!(await browser.permissions.contains({ origins: [`${origin}/*`] }))) {
        throw new Error('Firefox host permission was not granted from the options page.');
      }
      await permissions.grantPersistent(origin, 'read_page');
      await permissions.grantPersistent(origin, 'interact');
      return { ok: true };
    }
    case 'bridge.ui.removePolicy': {
      const origin = requiredUiString(message, 'origin');
      const category = requiredCategory(message['category']);
      await permissions.removePersistent(origin, category);
      return { ok: true };
    }
    default:
      return undefined;
  }
});

function requiredUiString(message: Record<string, unknown>, key: string): string {
  const value = message[key];
  if (typeof value !== 'string' || !value) throw new Error(`Missing ${key}.`);
  return value;
}

function requiredDecision(value: unknown): PermissionDecision {
  if (
    value === 'allow_once' ||
    value === 'allow_session' ||
    value === 'always_allow' ||
    value === 'deny_once' ||
    value === 'always_deny'
  ) {
    return value;
  }
  throw new Error('Invalid permission decision.');
}

function requiredCategory(value: unknown): PermissionCategory {
  if (
    value === 'read_page' ||
    value === 'interact' ||
    value === 'download' ||
    value === 'upload_file' ||
    value === 'clipboard_read' ||
    value === 'sensitive_action' ||
    value === 'destructive_action'
  ) {
    return value;
  }
  throw new Error('Invalid permission category.');
}
