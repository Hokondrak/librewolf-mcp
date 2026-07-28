import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const require = createRequire(import.meta.url);
const mozillaEntry = require.resolve('@mozilla/firefox-devtools-mcp');
const workspaceRoot = resolve(import.meta.dirname, '..');
const outputRoot = resolve(workspaceRoot, '.temp', 'compatibility');
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const profileParent = resolve(outputRoot, `profile-${runId}`);
const screenshotPath = resolve(outputRoot, `spike-${runId}.png`);
const resultPath = resolve(outputRoot, 'latest.json');
const librewolfPath = process.env.LIBREWOLF_PATH ?? 'C:\\Program Files\\LibreWolf\\librewolf.exe';

await mkdir(profileParent, { recursive: true });

const fixtureHtml = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>LibreWolf MCP compatibility spike</title>
    <style>
      body { font: 16px system-ui; max-width: 42rem; margin: 3rem auto; padding: 1rem; }
      label { display: block; margin: 1rem 0; }
      input { width: 100%; padding: .6rem; }
      button { padding: .7rem 1rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>LibreWolf compatibility spike</h1>
      <form id="profile-form">
        <label>Display name <input name="displayName" aria-label="Display name" required></label>
        <label>Email <input name="email" type="email" aria-label="Email" required></label>
        <button type="submit">Save profile</button>
      </form>
      <p id="result" role="status">Not saved</p>
    </main>
    <script>
      console.info('librewolf-spike-ready');
      document.querySelector('#profile-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        document.querySelector('#result').textContent = 'Saved';
        console.error('librewolf-spike-intentional-console-error');
        await fetch('/api/fail', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'authorization': 'Bearer compatibility-spike-secret'
          },
          body: JSON.stringify({ email: event.currentTarget.email.value })
        });
      });
    </script>
  </body>
</html>`;

const fixtureServer = createServer((request, response) => {
  if (request.url === '/api/fail') {
    request.resume();
    response.writeHead(503, {
      'content-type': 'application/json',
      'x-spike-token': 'compatibility-spike-secret',
    });
    response.end('{"error":"intentional compatibility response"}');
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(fixtureHtml);
});

const listen = () =>
  new Promise((resolveListen, reject) => {
    fixtureServer.once('error', reject);
    fixtureServer.listen(0, '127.0.0.1', () => resolveListen());
  });

const closeFixture = () => new Promise((resolveClose) => fixtureServer.close(() => resolveClose()));

const textContent = (result) =>
  (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');

const assertToolSuccess = (name, result) => {
  if (result.isError) {
    throw new Error(`${name} failed: ${textContent(result)}`);
  }
  return result;
};

const uidFromLine = (snapshot, labelPattern) => {
  const line = snapshot.split(/\r?\n/u).find((candidate) => labelPattern.test(candidate));
  const match = line?.match(/\buid=([^\s]+)/u);
  if (!match?.[1]) {
    throw new Error(`Could not find UID matching ${labelPattern} in snapshot:\n${snapshot}`);
  }
  return match[1];
};

const poll = async (operation, predicate, timeoutMs = 10_000) => {
  const deadline = performance.now() + timeoutMs;
  let latest;
  while (performance.now() < deadline) {
    latest = await operation();
    if (predicate(latest)) {
      return latest;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for expected browser signal. Last result: ${latest}`);
};

await listen();
const address = fixtureServer.address();
if (!address || typeof address === 'string') {
  throw new Error('Fixture server did not expose a TCP address.');
}
const fixtureUrl = `http://127.0.0.1:${address.port}/`;
const navigationUrl = `${fixtureUrl}?navigation=1`;

const stderr = [];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    mozillaEntry,
    '--firefox-path',
    librewolfPath,
    '--profile-path',
    profileParent,
    '--headless',
    '--viewport',
    '1280x720',
    '--start-url',
    fixtureUrl,
    '--tools',
    'pages',
    'snapshot',
    'input',
    'network',
    'console',
    'screenshot',
    'utilities',
    'management',
    '--unrestricted-save-paths',
  ],
  cwd: workspaceRoot,
  stderr: 'pipe',
});
transport.stderr?.on('data', (chunk) => {
  const value = String(chunk);
  stderr.push(value);
  process.stderr.write(value);
});

const client = new Client(
  { name: 'librewolf-agent-bridge-compatibility-spike', version: '0.1.0' },
  { capabilities: {} },
);

const startedAt = new Date().toISOString();
const measurements = {};
const checks = {};
const observations = {};
let tools = [];
let failure;

const timed = async (key, operation) => {
  const start = performance.now();
  const value = await operation();
  measurements[key] = Number((performance.now() - start).toFixed(1));
  return value;
};

try {
  await timed('connectMs', () => client.connect(transport, { timeout: 90_000 }));
  const listed = await timed('listToolsMs', () => client.listTools());
  tools = listed.tools.map(({ name, inputSchema, annotations }) => ({
    name,
    inputSchema,
    annotations,
  }));

  checks.launch = true;
  checks.expectedTools = [
    'list_pages',
    'navigate_page',
    'take_snapshot',
    'click_by_uid',
    'fill_by_uid',
    'screenshot_page',
    'list_console_messages',
    'list_network_requests',
    'get_network_request',
  ].every((name) => tools.some((tool) => tool.name === name));

  const firefoxInfo = assertToolSuccess(
    'get_firefox_info',
    await timed('firefoxInfoMs', () =>
      client.callTool({ name: 'get_firefox_info', arguments: {} }),
    ),
  );
  observations.firefoxInfo = textContent(firefoxInfo);
  checks.firefoxInfo = /LibreWolf|146\.0/iu.test(observations.firefoxInfo);

  const pages = assertToolSuccess(
    'list_pages',
    await timed('listPagesMs', () => client.callTool({ name: 'list_pages', arguments: {} })),
  );
  observations.pagesBeforeNavigation = textContent(pages);

  assertToolSuccess(
    'navigate_page',
    await timed('navigateMs', () =>
      client.callTool({ name: 'navigate_page', arguments: { url: navigationUrl } }),
    ),
  );
  checks.navigation = true;
  const pagesAfterNavigation = assertToolSuccess(
    'list_pages',
    await client.callTool({ name: 'list_pages', arguments: {} }),
  );
  observations.pagesAfterNavigation = textContent(pagesAfterNavigation);
  checks.listPages =
    observations.pagesBeforeNavigation.includes('LibreWolf MCP compatibility spike') ||
    observations.pagesAfterNavigation.includes('LibreWolf MCP compatibility spike');

  const snapshotResult = assertToolSuccess(
    'take_snapshot',
    await timed('snapshotMs', () =>
      client.callTool({
        name: 'take_snapshot',
        arguments: { maxLines: 300, includeAttributes: true, includeText: true },
      }),
    ),
  );
  const snapshot = textContent(snapshotResult);
  observations.initialSnapshot = snapshot;
  checks.snapshot = snapshot.includes('LibreWolf compatibility spike');
  measurements.snapshotBytes = Buffer.byteLength(snapshot);

  const displayNameUid = uidFromLine(snapshot, /(?:textbox|input)\s+"Display name"/iu);
  const emailUid = uidFromLine(snapshot, /(?:textbox|input)\s+"Email"/iu);
  const saveUid = uidFromLine(snapshot, /button\s+"Save profile"/iu);

  assertToolSuccess(
    'fill_by_uid',
    await timed('fillMs', () =>
      client.callTool({
        name: 'fill_by_uid',
        arguments: { uid: emailUid, value: 'spike@example.test' },
      }),
    ),
  );
  assertToolSuccess(
    'fill_form_by_uid',
    await timed('fillFormMs', () =>
      client.callTool({
        name: 'fill_form_by_uid',
        arguments: {
          elements: [
            { uid: displayNameUid, value: 'Compatibility User' },
            { uid: emailUid, value: 'spike@example.test' },
          ],
        },
      }),
    ),
  );
  checks.fill = true;

  assertToolSuccess(
    'click_by_uid',
    await timed('clickMs', () =>
      client.callTool({ name: 'click_by_uid', arguments: { uid: saveUid } }),
    ),
  );
  checks.click = true;

  const postActionSnapshot = await poll(
    async () =>
      textContent(
        assertToolSuccess(
          'take_snapshot',
          await client.callTool({
            name: 'take_snapshot',
            arguments: { maxLines: 300, includeText: true },
          }),
        ),
      ),
    (value) => value.includes('Saved'),
  );
  checks.domMutation = postActionSnapshot.includes('Saved');

  const consoleResult = await poll(
    async () =>
      textContent(
        assertToolSuccess(
          'list_console_messages',
          await client.callTool({
            name: 'list_console_messages',
            arguments: {
              level: 'error',
              textContains: 'librewolf-spike-intentional-console-error',
              format: 'json',
            },
          }),
        ),
      ),
    (value) => value.includes('librewolf-spike-intentional-console-error'),
  );
  checks.console = consoleResult.includes('librewolf-spike-intentional-console-error');

  const networkResult = await poll(
    async () =>
      textContent(
        assertToolSuccess(
          'list_network_requests',
          await client.callTool({
            name: 'list_network_requests',
            arguments: {
              urlContains: '/api/fail',
              statusMin: 400,
              format: 'json',
              detail: 'full',
            },
          }),
        ),
      ),
    (value) => value.includes('/api/fail') && value.includes('503'),
  );
  checks.network = networkResult.includes('/api/fail') && networkResult.includes('503');
  checks.upstreamRedactsRequestSecrets =
    !networkResult.includes('compatibility-spike-secret') &&
    !networkResult.includes('spike@example.test');

  const parsedNetwork = JSON.parse(networkResult);
  const networkEntries = Array.isArray(parsedNetwork)
    ? parsedNetwork
    : Array.isArray(parsedNetwork.requests)
      ? parsedNetwork.requests
      : [];
  const requestId = networkEntries.find((entry) => String(entry.url).includes('/api/fail'))?.id;
  if (requestId) {
    const requestResult = assertToolSuccess(
      'get_network_request',
      await client.callTool({
        name: 'get_network_request',
        arguments: { id: requestId, format: 'json' },
      }),
    );
    const requestText = textContent(requestResult);
    checks.getRequest = requestText.includes('/api/fail');
    checks.upstreamRedactsRequestBody =
      !requestText.includes('compatibility-spike-secret') &&
      !requestText.includes('spike@example.test');
  } else {
    checks.getRequest = false;
    checks.upstreamRedactsRequestBody = false;
  }

  const screenshot = assertToolSuccess(
    'screenshot_page',
    await timed('screenshotMs', () =>
      client.callTool({
        name: 'screenshot_page',
        arguments: { saveTo: screenshotPath },
      }),
    ),
  );
  checks.screenshot = textContent(screenshot).includes(screenshotPath);

  const staleResult = await client.callTool({
    name: 'click_by_uid',
    arguments: { uid: 'definitely-stale-uid' },
  });
  const staleText = textContent(staleResult);
  checks.staleUidError =
    staleResult.isError === true &&
    /stale|invalid/iu.test(staleText) &&
    /take_snapshot/iu.test(staleText);
} catch (error) {
  failure =
    error instanceof Error
      ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
      : String(error);
} finally {
  await client.close().catch(() => undefined);
  await closeFixture().catch(() => undefined);
}

const criticalCheckNames = [
  'launch',
  'expectedTools',
  'firefoxInfo',
  'listPages',
  'navigation',
  'snapshot',
  'fill',
  'click',
  'domMutation',
  'console',
  'network',
  'getRequest',
  'screenshot',
  'staleUidError',
];
const report = {
  startedAt,
  completedAt: new Date().toISOString(),
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    librewolfPath,
    mozillaPackage: '@mozilla/firefox-devtools-mcp@0.9.15',
    profileParent,
    effectiveProfile: resolve(profileParent, 'firefox_devtools_mcp_profile'),
    fixtureUrl,
    navigationUrl,
  },
  checks,
  observations,
  measurements,
  screenshotPath,
  tools,
  stderr: stderr.join('').slice(-30_000),
  failure,
  compatibilityGaps: Object.entries(checks)
    .filter(([name, value]) => value === false && !criticalCheckNames.includes(name))
    .map(([name]) => name),
  passed: !failure && criticalCheckNames.every((name) => checks[name] === true),
};

await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.passed ? 0 : 1;
