import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(import.meta.dirname, '..');
const outputRoot = resolve(workspaceRoot, '.temp', 'performance');
const resultPath = resolve(outputRoot, 'latest.json');
const browserPath = process.env.LIBREWOLF_PATH ?? 'C:\\Program Files\\LibreWolf\\librewolf.exe';
const runId = randomUUID().slice(0, 12);
const profileRoot = resolve(outputRoot, 'profiles');
const sessionOutput = resolve(outputRoot, 'output');

const fixtureHtml = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Bridge performance fixture</title></head>
  <body>
    <main>
      <h1>Bridge performance fixture</h1>
      <label>Display name <input aria-label="Display name" name="displayName"></label>
      <button type="button" aria-label="Save" id="save">Save</button>
      <p role="status" id="status">Waiting</p>
    </main>
    <script>
      document.querySelector('#save').addEventListener('click', () => {
        document.querySelector('#status').textContent = 'Saved';
      });
    </script>
  </body>
</html>`;

const fixture = createServer((_request, response) => {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(fixtureHtml);
});

const listen = () =>
  new Promise((resolveListen, rejectListen) => {
    fixture.once('error', rejectListen);
    fixture.listen(0, '127.0.0.1', resolveListen);
  });

const closeFixture = () => new Promise((resolveClose) => fixture.close(resolveClose));

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

const responseText = (response) =>
  (response.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');

const successfulText = (name, response) => {
  const text = responseText(response);
  if (response.isError) {
    throw new Error(`${name} failed: ${text}`);
  }
  return text;
};

const successfulJson = (name, response) => JSON.parse(successfulText(name, response));

const uidFor = (snapshot, label) => {
  const line = snapshot.split(/\r?\n/u).find((candidate) => candidate.includes(`"${label}"`));
  const uid = line?.match(/\[uid=([^\]]+)\]/u)?.[1];
  if (!uid) {
    throw new Error(`No UID for ${label} in snapshot:\n${snapshot}`);
  }
  return uid;
};

const windowsProcessTree = async (rootPid) => {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const powershell = resolve(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = String.raw`
$bridgeRootPid = ${rootPid}
$bridgeAll = @(Get-CimInstance Win32_Process)
$bridgeIds = [System.Collections.Generic.HashSet[int]]::new()
[void]$bridgeIds.Add($bridgeRootPid)
do {
  $bridgeAdded = $false
  foreach ($bridgeProcess in $bridgeAll) {
    if ($bridgeIds.Contains([int]$bridgeProcess.ParentProcessId) -and $bridgeIds.Add([int]$bridgeProcess.ProcessId)) {
      $bridgeAdded = $true
    }
  }
} while ($bridgeAdded)
$bridgeRows = @(
  $bridgeAll |
    Where-Object { $bridgeIds.Contains([int]$_.ProcessId) -and $_.Name -notmatch '^librewolf(\.exe)?$' } |
    ForEach-Object {
      [PSCustomObject]@{
        pid = [int]$_.ProcessId
        parentPid = [int]$_.ParentProcessId
        name = [string]$_.Name
        rssBytes = [int64]$_.WorkingSetSize
      }
    }
)
ConvertTo-Json -InputObject $bridgeRows -Compress
`;
  const { stdout } = await execFileAsync(
    powershell,
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      windowsHide: true,
      maxBuffer: 1_048_576,
    },
  );
  const parsed = JSON.parse(stdout.trim() || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
};

const posixProcessTree = async (rootPid) => {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,comm=']);
  const rows = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      name: match[4],
    }));
  const ids = new Set([rootPid]);
  let added;
  do {
    added = false;
    for (const row of rows) {
      if (ids.has(row.parentPid) && !ids.has(row.pid)) {
        ids.add(row.pid);
        added = true;
      }
    }
  } while (added);
  return rows.filter(
    (row) => ids.has(row.pid) && !/^librewolf(?:\.exe)?$/iu.test(basename(row.name)),
  );
};

const bridgeProcessTree = (rootPid) =>
  process.platform === 'win32' ? windowsProcessTree(rootPid) : posixProcessTree(rootPid);

const timed = async (operation) => {
  const started = performance.now();
  const value = await operation();
  return {
    value,
    milliseconds: Number((performance.now() - started).toFixed(1)),
  };
};

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
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
    `performance-${runId}`,
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
  { name: 'librewolf-agent-bridge-performance', version: '0.1.0' },
  { capabilities: {} },
);
const result = {
  startedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    browserPath,
    fixtureUrl,
  },
  targets: {
    cachedTabListMs: 100,
    cachedSnapshotMs: 200,
    actionAcknowledgementMs: 150,
    batchTransportMs: 100,
    idleBridgeRssMiB: 150,
  },
  measurements: {},
  checks: {},
};

try {
  const connected = await timed(() => client.connect(transport, { timeout: 90_000 }));
  result.measurements.connectMs = connected.milliseconds;
  const serverPid = transport.pid;
  if (!serverPid) {
    throw new Error('MCP stdio transport did not expose its child process ID.');
  }
  result.environment.serverPid = serverPid;

  await client.callTool({ name: 'browser_list_tabs', arguments: {} });
  const tabs = await timed(() => client.callTool({ name: 'browser_list_tabs', arguments: {} }));
  successfulJson('browser_list_tabs', tabs.value);
  result.measurements.cachedTabListMs = tabs.milliseconds;

  successfulJson(
    'browser_navigate',
    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: fixtureUrl },
    }),
  );
  successfulText(
    'browser_snapshot',
    await client.callTool({
      name: 'browser_snapshot',
      arguments: { max_chars: 20_000, max_elements: 100 },
    }),
  );
  const cachedSnapshot = await timed(() =>
    client.callTool({
      name: 'browser_snapshot',
      arguments: { max_chars: 20_000, max_elements: 100 },
    }),
  );
  const cachedSnapshotText = successfulText('browser_snapshot', cachedSnapshot.value);
  result.measurements.cachedSnapshotMs = cachedSnapshot.milliseconds;
  result.measurements.snapshotBytes = Buffer.byteLength(cachedSnapshotText, 'utf8');

  const displayNameUid = uidFor(cachedSnapshotText, 'Display name');
  const saveUid = uidFor(cachedSnapshotText, 'Save');
  const coldFill = await timed(() =>
    client.callTool({
      name: 'browser_fill',
      arguments: { uid: displayNameUid, value: 'Performance warm-up' },
    }),
  );
  successfulJson('browser_fill', coldFill.value);
  result.measurements.coldFillAcknowledgementMs = coldFill.milliseconds;
  const fillSamples = [];
  for (let index = 0; index < 5; index += 1) {
    const fill = await timed(() =>
      client.callTool({
        name: 'browser_fill',
        arguments: { uid: displayNameUid, value: `Performance User ${index}` },
      }),
    );
    successfulJson('browser_fill', fill.value);
    fillSamples.push(fill.milliseconds);
  }
  result.measurements.fillAcknowledgementSamplesMs = fillSamples;
  result.measurements.fillAcknowledgementMedianMs = Number(median(fillSamples).toFixed(1));

  const coldClick = await timed(() =>
    client.callTool({
      name: 'browser_click',
      arguments: { uid: saveUid },
    }),
  );
  successfulJson('browser_click', coldClick.value);
  result.measurements.coldClickAcknowledgementMs = coldClick.milliseconds;
  const clickSamples = [];
  for (let index = 0; index < 5; index += 1) {
    const freshSnapshot = successfulText(
      'browser_snapshot',
      await client.callTool({
        name: 'browser_snapshot',
        arguments: { max_chars: 20_000, max_elements: 100 },
      }),
    );
    const freshSaveUid = uidFor(freshSnapshot, 'Save');
    const click = await timed(() =>
      client.callTool({
        name: 'browser_click',
        arguments: { uid: freshSaveUid },
      }),
    );
    successfulJson('browser_click', click.value);
    clickSamples.push(click.milliseconds);
  }
  result.measurements.clickAcknowledgementSamplesMs = clickSamples;
  result.measurements.clickAcknowledgementMedianMs = Number(median(clickSamples).toFixed(1));

  const batch = await timed(() =>
    client.callTool({
      name: 'browser_batch',
      arguments: {
        actions: Array.from({ length: 10 }, () => ({ op: 'status' })),
      },
    }),
  );
  const batchValue = successfulJson('browser_batch', batch.value);
  result.measurements.batchTransportMs = batch.milliseconds;
  result.checks.singleBoundaryBatch =
    batchValue.transportCalls === 1 &&
    batchValue.results?.length === 10 &&
    batchValue.results.every((entry) => entry.ok === true);

  await wait(500);
  const memorySamples = [];
  for (let index = 0; index < 5; index += 1) {
    const processes = await bridgeProcessTree(serverPid);
    const fullDescendantRssBytes = processes.reduce(
      (total, processInfo) => total + Number(processInfo.rssBytes),
      0,
    );
    const applicationProcesses = processes.filter(
      (processInfo) => !/^conhost(?:\.exe)?$/iu.test(processInfo.name),
    );
    const applicationRssBytes = applicationProcesses.reduce(
      (total, processInfo) => total + Number(processInfo.rssBytes),
      0,
    );
    memorySamples.push({
      applicationRssMiB: Number((applicationRssBytes / 1024 / 1024).toFixed(1)),
      fullDescendantRssMiB: Number((fullDescendantRssBytes / 1024 / 1024).toFixed(1)),
      processes,
    });
    await wait(100);
  }
  const applicationMemoryValues = memorySamples.map((sample) => sample.applicationRssMiB);
  const fullDescendantMemoryValues = memorySamples.map((sample) => sample.fullDescendantRssMiB);
  result.measurements.idleBridgeApplicationRssMiB = Number(
    median(applicationMemoryValues).toFixed(1),
  );
  result.measurements.peakIdleBridgeApplicationRssMiB = Math.max(...applicationMemoryValues);
  result.measurements.idleFullDescendantRssMiB = Number(
    median(fullDescendantMemoryValues).toFixed(1),
  );
  result.measurements.peakIdleFullDescendantRssMiB = Math.max(...fullDescendantMemoryValues);
  result.measurements.memorySamples = memorySamples;

  result.checks.cachedTabListUnder100Ms =
    result.measurements.cachedTabListMs < result.targets.cachedTabListMs;
  result.checks.cachedSnapshotUnder200Ms =
    result.measurements.cachedSnapshotMs < result.targets.cachedSnapshotMs;
  result.checks.snapshotUnder20KiB = result.measurements.snapshotBytes < 20 * 1024;
  result.checks.fillAcknowledgementUnder150Ms =
    result.measurements.fillAcknowledgementMedianMs < result.targets.actionAcknowledgementMs;
  result.checks.clickAcknowledgementUnder150Ms =
    result.measurements.clickAcknowledgementMedianMs < result.targets.actionAcknowledgementMs;
  result.checks.batchTransportUnder100Ms =
    result.measurements.batchTransportMs < result.targets.batchTransportMs;
  result.checks.idleBridgeMemoryUnder150MiB =
    result.measurements.idleBridgeApplicationRssMiB < result.targets.idleBridgeRssMiB;
  result.completedAt = new Date().toISOString();
} catch (error) {
  result.error = error instanceof Error ? { message: error.message, stack: error.stack } : error;
  throw error;
} finally {
  await client.close().catch(() => undefined);
  await closeFixture();
  result.stderr = stderr.join('').slice(0, 20_000);
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

const failed = Object.entries(result.checks)
  .filter(([, passed]) => passed !== true)
  .map(([name]) => name);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (failed.length > 0) {
  throw new Error(`Performance targets failed: ${failed.join(', ')}`);
}
