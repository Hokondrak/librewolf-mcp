import { isRecord } from '../shared/protocol.js';

interface PendingUiRequest {
  requestId: string;
  origin: string;
  originPattern: string;
  categories: string[];
  hostPermissionRequired: boolean;
}

let pending: PendingUiRequest | undefined;

void refresh();

document.querySelector('#options')?.addEventListener('click', () => {
  void browser.runtime.openOptionsPage();
});

for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-decision]')) {
  button.addEventListener('click', async () => {
    if (!pending) return;
    const decision = button.dataset['decision'];
    if (!decision) return;

    // This call intentionally happens before the first await: Firefox only permits
    // permissions.request() directly in a bundled extension user-action handler.
    const browserGrant =
      decision.startsWith('allow') && pending.hostPermissionRequired
        ? browser.permissions.request({ origins: [pending.originPattern] })
        : Promise.resolve(true);
    const granted = await browserGrant;
    if (!granted && decision.startsWith('allow')) {
      setStatus('Firefox did not grant access to this origin.');
      return;
    }
    try {
      await browser.runtime.sendMessage({
        type: 'bridge.ui.decide',
        requestId: pending.requestId,
        decision,
      });
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  });
}

async function refresh(): Promise<void> {
  const state = await browser.runtime.sendMessage({ type: 'bridge.ui.getState' });
  if (!isRecord(state)) return;
  const connection = isRecord(state['connection']) ? state['connection'] : {};
  setStatus(`Native bridge: ${String(connection['state'] ?? 'unknown')}`);
  pending = parsePending(state['pending']);

  const section = document.querySelector<HTMLElement>('#request');
  if (!section) return;
  section.hidden = !pending;
  if (!pending) return;
  setText('#origin', pending.origin);
  setText('#categories', `Requested access: ${pending.categories.join(', ')}`);
}

function parsePending(value: unknown): PendingUiRequest | undefined {
  if (
    !isRecord(value) ||
    typeof value['requestId'] !== 'string' ||
    typeof value['origin'] !== 'string' ||
    typeof value['originPattern'] !== 'string' ||
    !Array.isArray(value['categories'])
  ) {
    return undefined;
  }
  return {
    requestId: value['requestId'],
    origin: value['origin'],
    originPattern: value['originPattern'],
    categories: value['categories'].filter((item): item is string => typeof item === 'string'),
    hostPermissionRequired: value['hostPermissionRequired'] === true,
  };
}

function setStatus(value: string): void {
  setText('#status', value);
}

function setText(selector: string, value: string): void {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}
