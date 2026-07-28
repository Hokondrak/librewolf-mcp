import { isRecord } from '../shared/protocol.js';

const form = document.querySelector<HTMLFormElement>('#grant-form');
const input = document.querySelector<HTMLInputElement>('#origin');

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!input) return;
  let origin: string;
  try {
    const parsed = new URL(input.value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only HTTP and HTTPS origins are supported.');
    }
    origin = parsed.origin;
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error));
    return;
  }

  // Keep this as the first asynchronous operation in the direct form-submit
  // handler so Firefox recognizes the request as a user gesture.
  const granted = await browser.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    setMessage('Firefox did not grant access to this origin.');
    return;
  }
  await browser.runtime.sendMessage({ type: 'bridge.ui.grantPolicy', origin });
  input.value = '';
  setMessage(`Granted read and interaction access to ${origin}.`);
  await renderPolicies();
});

document.querySelector('#policies')?.addEventListener('click', async (event) => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>(
    'button[data-origin]',
  );
  if (!button) return;
  const origin = button.dataset['origin'];
  const category = button.dataset['category'];
  if (!origin || !category) return;
  await browser.runtime.sendMessage({
    type: 'bridge.ui.removePolicy',
    origin,
    category,
  });
  await renderPolicies();
});

void renderPolicies();

async function renderPolicies(): Promise<void> {
  const response = await browser.runtime.sendMessage({ type: 'bridge.ui.listPolicies' });
  const list = document.querySelector('#policies');
  if (!list) return;
  list.replaceChildren();
  if (!isRecord(response) || !Array.isArray(response['policies'])) return;
  for (const policy of response['policies']) {
    if (!isRecord(policy)) continue;
    const origin = policy['origin'];
    const category = policy['category'];
    const decision = policy['decision'];
    if (typeof origin !== 'string' || typeof category !== 'string') continue;
    const item = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = `${origin} — ${category} — ${String(decision)}`;
    const button = document.createElement('button');
    button.textContent = 'Remove';
    button.dataset['origin'] = origin;
    button.dataset['category'] = category;
    item.append(code, ' ', button);
    list.append(item);
  }
}

function setMessage(message: string): void {
  const element = document.querySelector('#message');
  if (element) element.textContent = message;
}
