import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type IOType,
} from 'node:child_process';
import { resolve } from 'node:path';
import { PassThrough, type Stream } from 'node:stream';

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export interface GracefulStdioServerParameters {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly stderr?: IOType | Stream | number;
  readonly cwd?: string;
  readonly maxBufferSize?: number;
  readonly gracefulCloseMs?: number;
  readonly windowsJobSupervisorPath?: string;
}

const waitForClose = async (process: ChildProcess, timeoutMs: number): Promise<boolean> => {
  if (process.exitCode !== null || process.signalCode !== null) {
    return true;
  }
  return new Promise<boolean>((resolveWait) => {
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      process.off('close', onClose);
      resolveWait(closed);
    };
    const onClose = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    process.once('close', onClose);
  });
};

const terminateProcessTree = async (
  processToTerminate: ChildProcessWithoutNullStreams,
): Promise<boolean> => {
  if (process.platform !== 'win32' || !processToTerminate.pid) {
    return false;
  }
  const systemRoot = process.env['SystemRoot'] ?? process.env['WINDIR'] ?? 'C:\\Windows';
  const taskkill = resolve(systemRoot, 'System32', 'taskkill.exe');
  const killer = spawn(taskkill, ['/PID', String(processToTerminate.pid), '/T', '/F'], {
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
  });
  await waitForClose(killer, 2_000);
  return waitForClose(processToTerminate, 1_000);
};

/**
 * SDK-compatible stdio transport. On Windows, the optional native supervisor
 * owns Mozilla and all descendants in a kill-on-close Job Object. The bounded
 * graceful window and exact-PID taskkill path remain secondary cleanup layers
 * within common MCP clients' short shutdown deadline.
 */
export class GracefulStdioClientTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (message: JSONRPCMessage) => void;

  private readonly parameters: GracefulStdioServerParameters;
  private readonly readBuffer: ReadBuffer;
  private readonly stderrStream: PassThrough | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private closing = false;

  public constructor(parameters: GracefulStdioServerParameters) {
    this.parameters = parameters;
    this.readBuffer = new ReadBuffer({
      ...(parameters.maxBufferSize === undefined
        ? {}
        : { maxBufferSize: parameters.maxBufferSize }),
    });
    this.stderrStream =
      parameters.stderr === 'pipe' || parameters.stderr === 'overlapped'
        ? new PassThrough()
        : undefined;
  }

  public get stderr(): Stream | null {
    return this.stderrStream ?? this.child?.stderr ?? null;
  }

  public get pid(): number | null {
    return this.child?.pid ?? null;
  }

  public async start(): Promise<void> {
    if (this.child) {
      throw new Error('GracefulStdioClientTransport is already started.');
    }
    this.closing = false;
    await new Promise<void>((resolveStart, rejectStart) => {
      const windowsSupervisor =
        process.platform === 'win32' ? this.parameters.windowsJobSupervisorPath : undefined;
      const command = windowsSupervisor ?? this.parameters.command;
      const args = windowsSupervisor
        ? [
            'supervise',
            '--parent-pid',
            String(process.pid),
            '--',
            this.parameters.command,
            ...(this.parameters.args ?? []),
          ]
        : [...(this.parameters.args ?? [])];
      const child = spawn(command, args, {
        cwd: this.parameters.cwd,
        env: this.parameters.env ? { ...this.parameters.env } : process.env,
        shell: false,
        windowsHide: process.platform === 'win32',
        stdio: ['pipe', 'pipe', this.parameters.stderr ?? 'inherit'],
      });
      if (!child.stdin || !child.stdout || !child.stderr) {
        child.kill();
        rejectStart(new Error('Could not create stdio pipes for the Mozilla MCP child.'));
        return;
      }
      this.child = child as ChildProcessWithoutNullStreams;
      child.once('spawn', () => resolveStart());
      child.once('error', (error) => {
        rejectStart(error);
        this.onerror?.(error);
      });
      child.once('close', () => {
        if (this.child === child) {
          this.child = undefined;
        }
        this.onclose?.();
      });
      child.stdin.on('error', (error) => {
        if (!this.closing) {
          this.onerror?.(error);
        }
      });
      child.stdout.on('data', (chunk: Buffer) => {
        try {
          this.readBuffer.append(chunk);
          this.processReadBuffer();
        } catch (error) {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
          void this.close();
        }
      });
      child.stdout.on('error', (error) => this.onerror?.(error));
      if (this.stderrStream) {
        child.stderr.pipe(this.stderrStream);
      }
    });
  }

  public async close(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.readBuffer.clear();
      return;
    }
    this.closing = true;
    try {
      child.stdin.end();
    } catch {
      // A concurrent child exit is already a successful close.
    }
    let closed = await waitForClose(child, this.parameters.gracefulCloseMs ?? 2_500);
    if (!closed && child.exitCode === null) {
      closed = await terminateProcessTree(child);
    }
    if (!closed && child.exitCode === null) {
      child.kill('SIGTERM');
      closed = await waitForClose(child, 750);
      if (!closed && child.exitCode === null) {
        child.kill('SIGKILL');
        closed = await waitForClose(child, 750);
      }
    }
    closed = closed || child.exitCode !== null || child.signalCode !== null;
    if (!closed) {
      this.readBuffer.clear();
      throw new Error(
        `Supervised MCP process PID ${String(child.pid ?? 'unknown')} did not terminate.`,
      );
    }
    if (this.child === child) {
      this.child = undefined;
    }
    this.readBuffer.clear();
  }

  public async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || this.closing) {
      throw new Error('Mozilla MCP transport is not connected.');
    }
    const serialized = serializeMessage(message);
    if (stdin.write(serialized)) {
      return;
    }
    await new Promise<void>((resolveDrain, rejectDrain) => {
      const onDrain = (): void => {
        stdin.off('error', onError);
        resolveDrain();
      };
      const onError = (error: Error): void => {
        stdin.off('drain', onDrain);
        rejectDrain(error);
      };
      stdin.once('drain', onDrain);
      stdin.once('error', onError);
    });
  }

  private processReadBuffer(): void {
    while (true) {
      const message = this.readBuffer.readMessage();
      if (message === null) {
        return;
      }
      this.onmessage?.(message);
    }
  }
}
