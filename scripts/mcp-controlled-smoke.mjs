import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const workspaceRoot = resolve(import.meta.dirname, '..');
const outputRoot = resolve(workspaceRoot, '.temp', 'mcp-controlled-smoke');
const resultPath = resolve(outputRoot, 'latest.json');
const browserPath = process.env.LIBREWOLF_PATH ?? 'C:\\Program Files\\LibreWolf\\librewolf.exe';
const runId = randomUUID().slice(0, 12);
const profileRoot = resolve(outputRoot, 'profiles');
const sessionOutput = resolve(outputRoot, 'output');
const screenshotPath = resolve(sessionOutput, `mcp-${runId}.png`);

const expectedTools = [
  'browser_status',
  'browser_list_tabs',
  'browser_select_tab',
  'browser_open_tab',
  'browser_close_tab',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_snapshot',
  'browser_find',
  'browser_get_text',
  'browser_click',
  'browser_hover',
  'browser_fill',
  'browser_fill_form',
  'browser_select_option',
  'browser_press_key',
  'browser_scroll',
  'browser_upload_file',
  'browser_screenshot',
  'browser_get_console',
  'browser_get_network',
  'browser_get_request',
  'browser_get_downloads',
  'browser_batch',
];

const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>MCP controlled smoke</title></head>
  <body>
    <main>
      <h1>MCP controlled smoke</h1>
      <form id="fixture-form">
        <label>Display name <input name="displayName" data-testid="display-name" aria-label="Display name"></label>
        <label>Password <input name="password" data-testid="password" type="password" aria-label="Password"></label>
        <button type="submit" data-testid="submit">Submit fixture</button>
      </form>
      <p role="status" id="result">Waiting</p>
    </main>
    <script>
      document.querySelector('#fixture-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        document.querySelector('#result').textContent = 'Submitted';
        console.error('mcp-controlled-smoke-error');
        await fetch('/failure?access_token=query-secret', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer header-secret'
          },
          body: JSON.stringify({ password: event.currentTarget.password.value })
        });
      });
    </script>
  </body>
</html>`;

const fixture = createServer((request, response) => {
  if (request.url?.startsWith('/failure')) {
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
  new Promise((resolveListen, rejectListen) => {
    fixture.once('error', rejectListen);
    fixture.listen(0, '127.0.0.1', resolveListen);
  });

const closeFixture = () => new Promise((resolveClose) => fixture.close(resolveClose));

const textContent = (response) =>
  (response.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');

const assertSuccess = (name, response) => {
  if (response.isError) {
    throw new Error(`${name} failed: ${textContent(response)}`);
  }
  return response;
};

const jsonResult = (name, response) => JSON.parse(textContent(assertSuccess(name, response)));

const uidFor = (snapshot, label) => {
  const line = snapshot.split(/\r?\n/u).find((candidate) => candidate.includes(`"${label}"`));
  const uid = line?.match(/\[uid=([^\]]+)\]/u)?.[1];
  if (!uid) {
    throw new Error(`No UID for ${label} in snapshot:\n${snapshot}`);
  }
  return uid;
};

const poll = async (operation, predicate, timeoutMs = 5_000) => {
  const deadline = performance.now() + timeoutMs;
  let latest;
  while (performance.now() < deadline) {
    latest = await operation();
    if (predicate(latest)) {
      return latest;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return latest;
};

const findRequestId = (value) => {
  if (Array.isArray(value)) {
    return value.map(findRequestId).find(Boolean);
  }
  if (value && typeof value === 'object') {
    if (typeof value.id === 'string') {
      return value.id;
    }
    return Object.values(value).map(findRequestId).find(Boolean);
  }
  return undefined;
};

await mkdir(sessionOutput, { recursive: true });
await listen();
const address = fixture.address();
if (!address || typeof address === 'string') {
  throw new Error('Fixture did not expose a TCP address.');
}
const fixtureUrl = `http://127.0.0.1:${address.port}/?run=${runId}`;
const stderr = [];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    resolve(workspaceRoot, 'apps', 'mcp-server', 'dist', 'cli.js'),
    '--mode',
    'controlled',
    '--librewolf-path',
    browserPath,
    '--profile-root',
    profileRoot,
    '--profile',
    `mcp-${runId}`,
    '--output',
    sessionOutput,
    '--headless',
    '--viewport',
    '1280x720',
    '--start-url',
    'about:blank',
  ],
  cwd: workspaceRoot,
  stderr: 'pipe',
});
transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
const client = new Client(
  { name: 'librewolf-agent-bridge-mcp-smoke', version: '0.1.0' },
  { capabilities: {} },
);
const result = {
  startedAt: new Date().toISOString(),
  environment: { node: process.version, browserPath, fixtureUrl },
  checks: {},
  measurements: {},
};

try {
  const connectStart = performance.now();
  await client.connect(transport, { timeout: 90_000 });
  result.measurements.connectMs = Number((performance.now() - connectStart).toFixed(1));

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  result.checks.exactToolContract =
    names.length === expectedTools.length &&
    expectedTools.every((name, index) => names[index] === name);
  result.checks.annotations =
    listed.tools.find((tool) => tool.name === 'browser_status')?.annotations?.readOnlyHint ===
      true &&
    listed.tools.find((tool) => tool.name === 'browser_close_tab')?.annotations?.destructiveHint ===
      true;

  const initialStatus = jsonResult(
    'browser_status',
    await client.callTool({ name: 'browser_status', arguments: {} }),
  );
  result.checks.status = initialStatus.mode === 'controlled';
  const tabs = jsonResult(
    'browser_list_tabs',
    await client.callTool({ name: 'browser_list_tabs', arguments: {} }),
  );
  result.checks.tabs = tabs.length === 1 && tabs[0]?.selected === true;

  assertSuccess(
    'browser_navigate',
    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: fixtureUrl },
    }),
  );
  const snapshot = textContent(
    assertSuccess(
      'browser_snapshot',
      await client.callTool({
        name: 'browser_snapshot',
        arguments: { max_chars: 20_000, max_elements: 100 },
      }),
    ),
  );
  result.checks.snapshot =
    snapshot.includes('BEGIN UNTRUSTED WEBPAGE CONTENT') &&
    snapshot.includes('MCP controlled smoke');
  const displayUid = uidFor(snapshot, 'Display name');
  const passwordUid = uidFor(snapshot, 'Password');
  const submitUid = uidFor(snapshot, 'Submit fixture');

  assertSuccess(
    'browser_fill_form',
    await client.callTool({
      name: 'browser_fill_form',
      arguments: {
        fields: [
          { uid: displayUid, value: 'MCP User' },
          { uid: passwordUid, value: 'form-secret' },
        ],
      },
    }),
  );
  assertSuccess(
    'browser_click',
    await client.callTool({
      name: 'browser_click',
      arguments: { uid: submitUid },
    }),
  );
  result.checks.actions = true;

  const consoleOutput = jsonResult(
    'browser_get_console',
    await client.callTool({
      name: 'browser_get_console',
      arguments: { errors_only: true, limit: 20 },
    }),
  );
  const networkOutput = await poll(
    async () =>
      jsonResult(
        'browser_get_network',
        await client.callTool({
          name: 'browser_get_network',
          arguments: { errors_only: true, limit: 20 },
        }),
      ),
    (value) => JSON.stringify(value).includes('503'),
  );
  const requestId = findRequestId(networkOutput);
  const requestOutput =
    typeof requestId === 'string'
      ? jsonResult(
          'browser_get_request',
          await client.callTool({
            name: 'browser_get_request',
            arguments: { request_id: requestId },
          }),
        )
      : undefined;
  const serializedSignals = JSON.stringify({
    consoleOutput,
    networkOutput,
    requestOutput,
  });
  result.checks.console = serializedSignals.includes('mcp-controlled-smoke-error');
  result.checks.networkAndRequest =
    serializedSignals.includes('503') &&
    typeof requestId === 'string' &&
    !serializedSignals.includes('query-secret') &&
    !serializedSignals.includes('header-secret') &&
    !serializedSignals.includes('form-secret');

  const screenshot = jsonResult(
    'browser_screenshot',
    await client.callTool({
      name: 'browser_screenshot',
      arguments: { path: screenshotPath },
    }),
  );
  result.checks.screenshot =
    screenshot.savedTo === screenshotPath && screenshot.bytes === (await stat(screenshotPath)).size;

  const batchStart = performance.now();
  const batch = jsonResult(
    'browser_batch',
    await client.callTool({
      name: 'browser_batch',
      arguments: {
        actions: Array.from({ length: 10 }, () => ({ op: 'status' })),
      },
    }),
  );
  result.measurements.batchMs = Number((performance.now() - batchStart).toFixed(1));
  result.checks.batch =
    batch.transportCalls === 1 &&
    batch.results?.length === 10 &&
    batch.results.every((entry) => entry.ok);
  result.checks.batchUnder100Ms = result.measurements.batchMs < 100;
  result.completedAt = new Date().toISOString();

  const failed = Object.entries(result.checks)
    .filter(([, value]) => value !== true)
    .map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(`MCP controlled smoke checks failed: ${failed.join(', ')}`);
  }
} catch (error) {
  result.error = error instanceof Error ? { message: error.message, stack: error.stack } : error;
  throw error;
} finally {
  await client.close().catch(() => undefined);
  await closeFixture();
  result.stderr = stderr.join('').slice(0, 20_000);
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
