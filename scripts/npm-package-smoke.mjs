import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const installRoot = resolve(process.argv[2] ?? '');
const packageRoot = join(installRoot, 'node_modules', 'librewolf-agent-bridge');
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const cliPath = join(packageRoot, 'dist', 'cli.js');
const helperPath = join(packageRoot, 'dist', 'native', 'secure-pipe-helper.exe');
const help = spawnSync(process.execPath, [cliPath, '--help'], {
  encoding: 'utf8',
  windowsHide: true,
});
const api = await import(pathToFileURL(join(packageRoot, 'dist', 'index.js')).href);
const internalDependencies = Object.keys(manifest.dependencies ?? {}).filter((name) =>
  name.startsWith('@librewolf-agent-bridge/'),
);
const helper = await stat(helperPath);

const checks = {
  cliExitZero: help.status === 0,
  stdoutReservedForMcp: Buffer.byteLength(help.stdout ?? '', 'utf8') === 0,
  helpOnStderr: (help.stderr ?? '').includes('Usage:'),
  noPrivateWorkspaceDependencies: internalDependencies.length === 0,
  secureHelperPackaged: helper.isFile() && helper.size > 100_000,
  runtimeApiLoads:
    typeof api.createBrowserMcpServer === 'function' &&
    typeof api.SecureCompanionTransport === 'function',
};
const failed = Object.entries(checks)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);
const result = {
  package: `${manifest.name}@${manifest.version}`,
  node: process.version,
  checks,
  helperBytes: helper.size,
  internalDependencies,
};
if (failed.length > 0) {
  process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
  throw new Error(`npm package smoke checks failed: ${failed.join(', ')}`);
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
