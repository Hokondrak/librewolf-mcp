import { createServer } from 'node:http';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { ControlledBrowserSession } from '../packages/browser-core/dist/index.js';

const workspaceRoot = resolve(import.meta.dirname, '..');
const outputRoot = resolve(workspaceRoot, '.temp', 'controlled-smoke');
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const browserPath = process.env.LIBREWOLF_PATH ?? 'C:\\Program Files\\LibreWolf\\librewolf.exe';
const profileRoot = resolve(outputRoot, 'profiles');
const sessionOutput = resolve(outputRoot, 'output');
const resultPath = resolve(outputRoot, 'latest.json');
const windowsJobSupervisorPath = resolve(
  workspaceRoot,
  'apps',
  'native-host',
  'dist',
  'native',
  'secure-pipe-helper.exe',
);

const html = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>LibreWolf Agent Bridge smoke test</title>
  </head>
  <body>
    <main>
      <h1>Bridge smoke test</h1>
      <form id="profile-form">
        <label>Display name <input name="displayName" data-testid="display-name" aria-label="Display name"></label>
        <label>Password <input name="password" data-testid="password" type="password" aria-label="Password"></label>
        <button type="submit" data-testid="save-profile">Save profile</button>
      </form>
      <p id="result" role="status">Not saved</p>
    </main>
    <script>
      document.querySelector('#profile-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        document.querySelector('#result').textContent = 'Saved';
        console.error('controlled-smoke-intentional-error');
        await fetch('/api/fail?access_token=query-secret', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'authorization': 'Bearer header-secret',
            'x-api-key': 'header-secret'
          },
          body: JSON.stringify({ password: event.currentTarget.password.value })
        });
      });
    </script>
  </body>
</html>`;

const fixture = createServer((request, response) => {
  if (request.url?.startsWith('/api/fail')) {
    request.resume();
    response.writeHead(503, {
      'content-type': 'application/json',
      'set-cookie': 'session=header-secret; HttpOnly',
    });
    response.end('{"error":"intentional"}');
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(html);
});

const listen = () =>
  new Promise((resolveListen, reject) => {
    fixture.once('error', reject);
    fixture.listen(0, '127.0.0.1', () => resolveListen());
  });

const closeFixture = () => new Promise((resolveClose) => fixture.close(() => resolveClose()));

const uidFor = (content, label) => {
  const line = content.split(/\r?\n/u).find((candidate) => candidate.includes(`"${label}"`));
  const uid = line?.match(/\[uid=([^\]]+)\]/u)?.[1];
  if (!uid) {
    throw new Error(`Could not find bridge UID for ${label}:\n${content}`);
  }
  return uid;
};

const poll = async (operation, predicate, timeoutMs = 5_000) => {
  const deadline = performance.now() + timeoutMs;
  let value;
  while (performance.now() < deadline) {
    value = await operation();
    if (predicate(value)) {
      return value;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return value;
};

const findFirstRequestId = (value) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstRequestId(item);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    if (typeof value.id === 'string' && value.id.length > 0) {
      return value.id;
    }
    for (const item of Object.values(value)) {
      const found = findFirstRequestId(item);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
};

await mkdir(outputRoot, { recursive: true });
await listen();
const address = fixture.address();
if (!address || typeof address === 'string') {
  throw new Error('Fixture did not expose an address.');
}
const fixtureUrl = `http://127.0.0.1:${address.port}/?run=${encodeURIComponent(runId)}`;

const session = new ControlledBrowserSession({
  browserPath,
  profileRoot,
  profileName: `smoke-${runId}`,
  outputDirectory: sessionOutput,
  headless: true,
  viewport: { width: 1280, height: 720 },
  startUrl: 'about:blank',
  ...(process.platform === 'win32' ? { windowsJobSupervisorPath } : {}),
  removeProfileOnClose: true,
});

const result = {
  startedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    browserPath,
    fixtureUrl,
  },
  checks: {},
  measurements: {},
};

try {
  const start = performance.now();
  const tabs = await session.listTabs();
  result.measurements.connectMs = Number((performance.now() - start).toFixed(1));
  result.checks.listTabs = tabs.length === 1 && tabs[0]?.selected === true;
  const cachedTabsStart = performance.now();
  await session.listTabs();
  result.measurements.cachedListTabsMs = Number((performance.now() - cachedTabsStart).toFixed(1));
  result.checks.cachedListTabsUnder100Ms = result.measurements.cachedListTabsMs < 100;

  const navigateStart = performance.now();
  await session.navigate(fixtureUrl);
  result.measurements.navigateMs = Number((performance.now() - navigateStart).toFixed(1));
  result.checks.navigate = true;

  const snapshotStart = performance.now();
  const first = await session.snapshot({ maxElements: 100, maxChars: 50_000 });
  result.measurements.firstSnapshotMs = Number((performance.now() - snapshotStart).toFixed(1));
  const second = await session.snapshot({ maxElements: 100, maxChars: 50_000 });
  const firstDisplayNameUid = uidFor(first.text, 'Display name');
  const secondDisplayNameUid = uidFor(second.text, 'Display name');
  const passwordUid = uidFor(second.text, 'Password');
  const saveUid = uidFor(second.text, 'Save profile');
  result.checks.snapshotBoundary =
    second.text.includes('BEGIN UNTRUSTED WEBPAGE CONTENT') && !second.text.includes('📸 Snapshot');
  result.checks.compactSnapshotUnder20Kb = second.bytes < 20_000;
  result.checks.stableStrongUid = firstDisplayNameUid === secondDisplayNameUid;

  const fillStart = performance.now();
  await session.fill({ uid: secondDisplayNameUid, value: 'Smoke User' });
  result.measurements.fillMs = Number((performance.now() - fillStart).toFixed(1));
  await session.fill({ uid: passwordUid, value: 'form-secret' });
  await session.click({ uid: saveUid });
  result.checks.actions = true;

  const consoleOutput = await session.getConsole({ errorsOnly: true, limit: 20 });
  const networkOutput = await poll(
    () => session.getNetwork({ errorsOnly: true, limit: 20 }),
    (value) => JSON.stringify(value).includes('503'),
  );
  const serializedNetwork = JSON.stringify(networkOutput);
  const requestId = findFirstRequestId(networkOutput);
  const requestOutput = requestId ? await session.getRequest({ requestId }) : undefined;
  const serializedRequest = JSON.stringify(requestOutput);
  result.observations = { consoleOutput, networkOutput, requestOutput };
  result.checks.console = JSON.stringify(consoleOutput).includes(
    'controlled-smoke-intentional-error',
  );
  result.checks.network = serializedNetwork.includes('503');
  result.checks.requestInspection =
    typeof requestId === 'string' &&
    serializedRequest.length > 2 &&
    !serializedRequest.includes('query-secret') &&
    !serializedRequest.includes('header-secret') &&
    !serializedRequest.includes('form-secret');
  result.checks.redaction =
    !serializedNetwork.includes('query-secret') &&
    !serializedNetwork.includes('header-secret') &&
    !serializedNetwork.includes('form-secret');

  const screenshotPath = resolve(sessionOutput, `smoke-${runId}.png`);
  const screenshot = await session.screenshot({ path: screenshotPath });
  const screenshotStats = await stat(screenshotPath);
  result.checks.screenshot =
    screenshot.mimeType === 'image/png' &&
    screenshot.bytes > 1_000 &&
    screenshot.savedTo === screenshotPath &&
    screenshotStats.size === screenshot.bytes;
  result.measurements.screenshotBytes = screenshot.bytes;

  let staleCode;
  try {
    await session.click({ uid: saveUid });
  } catch (error) {
    staleCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined;
  }
  const refreshed = await session.snapshot({ maxElements: 100, maxChars: 20_000 });
  result.checks.staleUidRecovery =
    staleCode === 'STALE_REFERENCE' && uidFor(refreshed.text, 'Save profile').length > 0;
  result.checks.passwordSnapshotRedaction =
    refreshed.text.includes('[REDACTED]') && !refreshed.text.includes('form-secret');

  const batchStart = performance.now();
  const batch = await session.batch(Array.from({ length: 10 }, () => ({ op: 'status' })));
  result.measurements.batchMs = Number((performance.now() - batchStart).toFixed(1));
  result.checks.tenActionBatch =
    batch.results.length === 10 &&
    batch.results.every((item) => item.ok) &&
    batch.transportCalls === 1;
  result.checks.batchUnder100Ms = result.measurements.batchMs < 100;

  result.status = await session.status();
  result.telemetry = session.telemetry();
  result.checks.noSecretInLocalDiagnostics = !JSON.stringify({
    status: result.status,
    telemetry: result.telemetry,
    observations: result.observations,
  }).includes('form-secret');
  result.completedAt = new Date().toISOString();
  const failed = Object.entries(result.checks)
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(`Controlled smoke checks failed: ${failed.join(', ')}`);
  }
} catch (error) {
  result.error = error instanceof Error ? { message: error.message, stack: error.stack } : error;
  throw error;
} finally {
  await session.close().catch(() => undefined);
  await closeFixture();
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
