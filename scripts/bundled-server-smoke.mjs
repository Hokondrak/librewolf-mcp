import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const serverRoot = resolve(process.argv[2] ?? '');
const manifest = JSON.parse(await readFile(join(serverRoot, 'package.json'), 'utf8'));
const cliPath = join(serverRoot, 'cli.js');
const helperPath = join(serverRoot, 'native', 'secure-pipe-helper.exe');
const mozillaManifest = join(
  serverRoot,
  'node_modules',
  '@mozilla',
  'firefox-devtools-mcp',
  'package.json',
);
const help = spawnSync(process.execPath, [cliPath, '--help'], {
  encoding: 'utf8',
  windowsHide: true,
});
const helper = await stat(helperPath);
const mozilla = JSON.parse(await readFile(mozillaManifest, 'utf8'));
const api = await import(pathToFileURL(join(serverRoot, 'index.js')).href);

const checks = {
  esmBoundary: manifest.type === 'module',
  cliExitZero: help.status === 0,
  stdoutReservedForMcp: Buffer.byteLength(help.stdout ?? '', 'utf8') === 0,
  helpOnStderr: (help.stderr ?? '').includes('Usage:'),
  secureHelperPackaged: helper.isFile() && helper.size > 100_000,
  pinnedMozillaDependency: mozilla.version === '0.9.15',
  runtimeApiLoads:
    typeof api.createBrowserMcpServer === 'function' &&
    typeof api.SecureCompanionTransport === 'function',
};
const failed = Object.entries(checks)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);
const result = {
  serverRoot,
  node: process.version,
  checks,
  helperBytes: helper.size,
  mozillaVersion: mozilla.version,
};
if (failed.length > 0) {
  process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
  throw new Error(`bundled server smoke checks failed: ${failed.join(', ')}`);
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
