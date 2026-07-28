import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it } from 'vitest';

import { GracefulStdioClientTransport } from '../src/index.js';

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error('Timed out waiting for process fixture state.');
};

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const windowsIt = process.platform === 'win32' ? it : it.skip;

windowsIt(
  'terminates the whole child tree when graceful shutdown exceeds its deadline',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'librewolf-bridge-shutdown-'));
    const grandchildPidPath = join(root, 'grandchild.pid');
    const grandchildSource = 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);';
    const parentSource = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], {
        stdio: 'ignore',
        windowsHide: true
      });
      writeFileSync(process.argv[1], String(grandchild.pid));
      process.stdin.resume();
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `;
    const transport = new GracefulStdioClientTransport({
      command: process.execPath,
      args: ['-e', parentSource, grandchildPidPath],
      stderr: 'pipe',
      gracefulCloseMs: 50,
    });
    let parentPid: number | null = null;
    let grandchildPid: number | null = null;
    try {
      await transport.start();
      parentPid = transport.pid;
      await waitFor(async () => {
        try {
          grandchildPid = Number.parseInt(await readFile(grandchildPidPath, 'utf8'), 10);
          return Number.isSafeInteger(grandchildPid) && grandchildPid > 0;
        } catch {
          return false;
        }
      });

      await transport.close();
      await waitFor(async () => !processExists(parentPid!) && !processExists(grandchildPid!));
      expect(processExists(parentPid!)).toBe(false);
      expect(processExists(grandchildPid!)).toBe(false);
    } finally {
      await transport.close().catch(() => undefined);
      for (const pid of [grandchildPid, parentPid]) {
        if (pid && processExists(pid)) {
          process.kill(pid, 'SIGKILL');
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);

windowsIt(
  'uses a Job Object to terminate descendants after the supervised child exits cleanly',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'librewolf-bridge-job-shutdown-'));
    const processIdsPath = join(root, 'processes.json');
    const helperPath = resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'apps',
      'native-host',
      'dist',
      'native',
      'secure-pipe-helper.exe',
    );
    const grandchildSource = 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);';
    const parentSource = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], {
        stdio: 'ignore',
        windowsHide: true
      });
      writeFileSync(
        process.argv[1],
        JSON.stringify({ parentPid: process.pid, grandchildPid: grandchild.pid })
      );
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'fixture/ready' }) + '\\n'
      );
      process.stderr.write('fixture-ready\\n');
      process.stdin.resume();
      process.stdin.once('end', () => process.exit(0));
    `;
    const transport = new GracefulStdioClientTransport({
      command: process.execPath,
      args: ['-e', parentSource, processIdsPath],
      stderr: 'pipe',
      gracefulCloseMs: 2_000,
      windowsJobSupervisorPath: helperPath,
    });
    let supervisorPid: number | null = null;
    let parentPid: number | null = null;
    let grandchildPid: number | null = null;
    let notificationSeen = false;
    let stderr = '';
    transport.onmessage = (message) => {
      notificationSeen = 'method' in message && message.method === 'fixture/ready';
    };
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    try {
      await transport.start();
      supervisorPid = transport.pid;
      await waitFor(async () => {
        try {
          const parsed = JSON.parse(await readFile(processIdsPath, 'utf8')) as {
            parentPid?: number;
            grandchildPid?: number;
          };
          parentPid = parsed.parentPid ?? null;
          grandchildPid = parsed.grandchildPid ?? null;
          return Boolean(parentPid && grandchildPid);
        } catch {
          return false;
        }
      });
      await waitFor(async () => notificationSeen && stderr.includes('fixture-ready'));

      await transport.close();
      await waitFor(
        async () =>
          !processExists(supervisorPid!) &&
          !processExists(parentPid!) &&
          !processExists(grandchildPid!),
      );
      expect(processExists(supervisorPid!)).toBe(false);
      expect(processExists(parentPid!)).toBe(false);
      expect(processExists(grandchildPid!)).toBe(false);
      expect(notificationSeen).toBe(true);
      expect(stderr).toContain('fixture-ready');
    } finally {
      await transport.close().catch(() => undefined);
      for (const pid of [grandchildPid, parentPid, supervisorPid]) {
        if (pid && processExists(pid)) {
          process.kill(pid, 'SIGKILL');
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);

windowsIt(
  'closes the Job Object when the bridge parent dies without closing stdio',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'librewolf-bridge-parent-death-'));
    const helperPidPath = join(root, 'helper.pid');
    const descendantsPath = join(root, 'descendants.json');
    const helperPath = resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'apps',
      'native-host',
      'dist',
      'native',
      'secure-pipe-helper.exe',
    );
    const grandchildSource = 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);';
    const supervisedSource = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], {
        stdio: 'ignore',
        windowsHide: true
      });
      writeFileSync(
        process.argv[1],
        JSON.stringify({ directPid: process.pid, grandchildPid: grandchild.pid })
      );
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `;
    const bridgeParentSource = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const helper = spawn(
        process.argv[1],
        [
          'supervise',
          '--parent-pid',
          String(process.pid),
          '--',
          process.execPath,
          '-e',
          ${JSON.stringify(supervisedSource)},
          process.argv[3]
        ],
        { stdio: 'ignore', windowsHide: true }
      );
      writeFileSync(process.argv[2], String(helper.pid));
      setInterval(() => {}, 1000);
    `;
    const bridgeParent = spawn(
      process.execPath,
      ['-e', bridgeParentSource, helperPath, helperPidPath, descendantsPath],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    const bridgeParentPid = bridgeParent.pid ?? null;
    let helperPid: number | null = null;
    let directPid: number | null = null;
    let grandchildPid: number | null = null;
    try {
      await waitFor(async () => {
        try {
          helperPid = Number.parseInt(await readFile(helperPidPath, 'utf8'), 10);
          const descendants = JSON.parse(await readFile(descendantsPath, 'utf8')) as {
            directPid?: number;
            grandchildPid?: number;
          };
          directPid = descendants.directPid ?? null;
          grandchildPid = descendants.grandchildPid ?? null;
          return Boolean(helperPid && directPid && grandchildPid);
        } catch {
          return false;
        }
      });
      expect(bridgeParentPid).not.toBeNull();
      expect(processExists(helperPid!)).toBe(true);
      expect(processExists(directPid!)).toBe(true);
      expect(processExists(grandchildPid!)).toBe(true);

      process.kill(bridgeParentPid!, 'SIGKILL');
      await waitFor(
        async () =>
          !processExists(bridgeParentPid!) &&
          !processExists(helperPid!) &&
          !processExists(directPid!) &&
          !processExists(grandchildPid!),
      );
    } finally {
      for (const pid of [grandchildPid, directPid, helperPid, bridgeParentPid]) {
        if (pid && processExists(pid)) {
          process.kill(pid, 'SIGKILL');
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
