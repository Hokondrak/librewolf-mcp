import { PassThrough } from 'node:stream';
import { mkdir, lstat, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  NativeHostRuntime,
  decodeNativeMessages,
  encodeNativeMessage,
  loadDiscoveryRecord,
} from '../apps/native-host/dist/index.js';
import { SecureCompanionTransport } from '../apps/mcp-server/dist/index.js';
import { CompanionBrowserSession } from '../packages/browser-core/dist/index.js';

const workspaceRoot = resolve(import.meta.dirname, '..');
const outputRoot = resolve(workspaceRoot, '.temp', 'companion-secure-smoke');
const runtimeRoot = resolve(outputRoot, 'runtime-root');
const discoveryPath = resolve(runtimeRoot, 'runtime', 'discovery-v1.json');
const resultPath = resolve(outputRoot, 'latest.json');
const extensionId = 'librewolf-agent-bridge@librewolf-agent-bridge.org';

const waitForDiscovery = async () => {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await lstat(discoveryPath);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  throw lastError ?? new Error('Discovery record was not published.');
};

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const transport = new SecureCompanionTransport({
  discoveryPath,
  connectTimeoutMs: 10_000,
});
const extensionToHost = new PassThrough();
const hostToExtension = new PassThrough();
const hostMessages = decodeNativeMessages(hostToExtension)[Symbol.asyncIterator]();
const runtime = new NativeHostRuntime({
  input: extensionToHost,
  output: hostToExtension,
  identity: {
    extensionId,
    extensionVersion: '0.1.0',
    manifestVersion: 3,
    hostVersion: '0.1.0',
    browserName: 'LibreWolf',
    browserVersion: '146.0',
  },
  loadDiscovery: () => loadDiscoveryRecord(discoveryPath),
});
const result = {
  startedAt: new Date().toISOString(),
  checks: {},
};
let runtimePromise;
let session;

try {
  const connectionPromise = transport.connect();
  await waitForDiscovery();
  const published = await loadDiscoveryRecord(discoveryPath);
  result.checks.discoveryPublishedAndFresh =
    published.serverInstanceId.length > 0 &&
    published.ownerPid > 0 &&
    Date.parse(published.expiresAt) > Date.now();

  extensionToHost.write(
    encodeNativeMessage({
      jsonrpc: '2.0',
      method: 'extension.hello',
      params: {
        protocolVersion: '1.0.0',
        extensionId,
        extensionVersion: '0.1.0',
        manifestVersion: 3,
        capabilities: {
          mode: 'companion_extension',
          protocolVersion: '1.0.0',
          features: {
            tabs: { level: 'available' },
            snapshots: { level: 'available' },
          },
        },
      },
    }),
  );
  runtimePromise = runtime.run();
  const connection = await connectionPromise;
  result.connection = connection;
  result.checks.authenticatedSameUserPipe =
    connection.security.local === true &&
    connection.security.authenticated === true &&
    connection.security.peerAccessRestricted === true &&
    connection.security.kind === 'named-pipe';

  const hostStatus = await hostMessages.next();
  result.hostStatus = hostStatus.value;
  result.checks.nativeHostConnected =
    !hostStatus.done &&
    hostStatus.value?.method === 'host.status' &&
    hostStatus.value?.params?.connected === true;

  session = new CompanionBrowserSession({
    transport,
    requestTimeoutMs: 5_000,
  });
  const tabsPromise = session.listTabs();
  const request = await hostMessages.next();
  result.extensionRequest = request.value;
  if (
    request.done ||
    request.value?.jsonrpc !== '2.0' ||
    request.value?.method !== 'extension.execute' ||
    request.value?.params?.operation !== 'tabs.list'
  ) {
    throw new Error(`Unexpected companion request: ${JSON.stringify(request.value)}`);
  }
  extensionToHost.write(
    encodeNativeMessage({
      jsonrpc: '2.0',
      id: request.value.id,
      result: [
        {
          tabId: 42,
          active: true,
          highlighted: true,
          pinned: false,
          status: 'complete',
          access: 'allowed',
          title: 'Existing LibreWolf tab',
          url: 'https://example.test/',
          origin: 'https://example.test',
        },
      ],
    }),
  );
  const tabs = await tabsPromise;
  result.tabs = tabs;
  result.checks.companionRoundTrip =
    tabs.length === 1 &&
    tabs[0]?.selected === true &&
    tabs[0]?.title === 'Existing LibreWolf tab' &&
    tabs[0]?.url === 'https://example.test/';

  const status = await session.status();
  result.status = status;
  result.checks.companionCapabilities =
    status.state === 'ready' &&
    status.capabilities.tabs.level === 'available' &&
    status.capabilities.console.level === 'unavailable';

  extensionToHost.end();
  await session.close();
  await runtimePromise;
  await expectMissing(discoveryPath);
  result.checks.discoveryRemovedOnClose = true;
  result.completedAt = new Date().toISOString();

  const failed = Object.entries(result.checks)
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(`Secure companion smoke checks failed: ${failed.join(', ')}`);
  }
} catch (error) {
  result.error = error instanceof Error ? { message: error.message, stack: error.stack } : error;
  throw error;
} finally {
  extensionToHost.end();
  await session?.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
  await runtimePromise?.catch(() => undefined);
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

async function expectMissing(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Expected discovery record to be removed: ${path}`);
}
