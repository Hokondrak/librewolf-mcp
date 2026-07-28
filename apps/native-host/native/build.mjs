import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const nativeDirectory = dirname(fileURLToPath(import.meta.url));
const appDirectory = resolve(nativeDirectory, '..');
const source = resolve(nativeDirectory, 'src', 'secure_pipe_helper.cpp');
const output = resolve(appDirectory, 'dist', 'native', 'secure-pipe-helper.exe');

if (process.platform !== 'win32') {
  process.stdout.write(
    '[native-host] secure-pipe-helper is Windows-only; native build skipped on this platform.\n',
  );
  process.exit(0);
}

mkdirSync(dirname(output), { recursive: true });

const compiler = process.env['CXX'] || 'g++';
const arguments_ = [
  '-std=c++20',
  '-O2',
  '-Wall',
  '-Wextra',
  '-Wpedantic',
  '-municode',
  '-static',
  '-static-libgcc',
  '-static-libstdc++',
  source,
  '-o',
  output,
  '-ladvapi32',
  '-lbcrypt',
];
const result = spawnSync(compiler, arguments_, {
  cwd: appDirectory,
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) {
  throw new Error(
    `Unable to start ${compiler} while building secure-pipe-helper: ${result.error.message}`,
  );
}
if (result.status !== 0) {
  throw new Error(`secure-pipe-helper build failed with exit code ${String(result.status)}.`);
}

process.stdout.write(`[native-host] built ${output}\n`);
