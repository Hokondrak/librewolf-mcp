import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { BrowserBridgeError } from './errors.js';
import { GracefulStdioClientTransport } from './graceful-stdio.js';
import type { StartupDiagnostic } from './types.js';

const require = createRequire(import.meta.url);

const REQUIRED_UPSTREAM_TOOLS = new Set([
  'list_pages',
  'new_page',
  'navigate_page',
  'select_page',
  'close_page',
  'take_snapshot',
  'resolve_uid_to_selector',
  'clear_snapshot',
  'click_by_uid',
  'hover_by_uid',
  'fill_by_uid',
  'fill_form_by_uid',
  'upload_file_by_uid',
  'list_network_requests',
  'get_network_request',
  'list_console_messages',
  'clear_console_messages',
  'screenshot_page',
  'screenshot_by_uid',
  'list_downloads',
  'clear_downloads',
  'navigate_history',
  'set_viewport_size',
  'evaluate_script',
]);

export interface MozillaUpstreamOptions {
  readonly firefoxPath: string;
  readonly profileParent: string;
  readonly outputDirectory: string;
  readonly nodePath?: string;
  readonly headless?: boolean;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly startUrl?: string;
  readonly preferences?: Readonly<Record<string, string | number | boolean>>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly connectTimeoutMs?: number;
  readonly windowsJobSupervisorPath?: string;
}

export interface UpstreamCallResult {
  readonly text: string;
  readonly images: readonly { readonly data: string; readonly mimeType: string }[];
  readonly raw: unknown;
}

type McpToolResult = {
  readonly content?: readonly Record<string, unknown>[];
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
};

export class MozillaUpstreamClient {
  public readonly sessionId = randomUUID();
  public readonly diagnostics: StartupDiagnostic[] = [];

  private readonly options: MozillaUpstreamOptions;
  private state: 'idle' | 'starting' | 'ready' | 'failed' | 'closed' = 'idle';
  private client: Client | undefined;
  private transport: GracefulStdioClientTransport | undefined;
  private startPromise: Promise<void> | undefined;
  private readonly stderrLines: string[] = [];

  public constructor(options: MozillaUpstreamOptions) {
    this.options = options;
    this.addDiagnostic('idle', true, 'Mozilla adapter created.');
  }

  public getState(): 'idle' | 'starting' | 'ready' | 'failed' | 'closed' {
    return this.state;
  }

  public getRecentStderr(limit = 100): readonly string[] {
    return this.stderrLines.slice(-Math.max(1, Math.min(limit, 500)));
  }

  public getProcessId(): number | null {
    return this.transport?.pid ?? null;
  }

  public async ensureStarted(): Promise<void> {
    if (this.state === 'ready') {
      return;
    }
    if (this.state === 'closed') {
      throw new BrowserBridgeError('SHUTDOWN', 'The browser adapter has been closed.', {
        stage: 'spawn',
        recoverable: false,
      });
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.start();
    return this.startPromise;
  }

  public async call(
    name: string,
    args: Readonly<Record<string, unknown>> = {},
  ): Promise<UpstreamCallResult> {
    await this.ensureStarted();
    if (!this.client) {
      throw new BrowserBridgeError(
        'BROWSER_CONNECTION_FAILED',
        'Mozilla MCP client is unavailable.',
        {
          stage: 'initialize',
        },
      );
    }

    let result: McpToolResult;
    try {
      result = (await this.client.callTool({ name, arguments: { ...args } }, undefined, {
        timeout: 30_000,
      })) as McpToolResult;
    } catch (error) {
      throw this.translateCallError(name, error);
    }
    const parsed = this.parseResult(result);
    if (result.isError) {
      throw this.translateResultError(name, parsed.text);
    }
    return parsed;
  }

  public async close(): Promise<void> {
    if (this.state === 'closed') {
      return;
    }
    this.state = 'closed';
    this.addDiagnostic('shutdown', true, 'Closing Mozilla MCP child and controlled browser.');
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    let closeFailure: unknown;
    try {
      await client?.close();
    } catch (error) {
      closeFailure = error;
    }
    try {
      await transport?.close();
    } catch (error) {
      closeFailure ??= error;
    }
    if (closeFailure !== undefined) {
      const cause = closeFailure instanceof Error ? closeFailure.message : String(closeFailure);
      this.addDiagnostic('shutdown', false, 'Mozilla MCP process cleanup was not confirmed.', {
        cause,
      });
      throw new BrowserBridgeError('SHUTDOWN', 'Mozilla MCP process cleanup was not confirmed.', {
        stage: 'shutdown',
        recoverable: false,
        cause,
      });
    }
    this.addDiagnostic('shutdown', true, 'Mozilla MCP child and controlled browser closed.');
  }

  private async start(): Promise<void> {
    this.state = 'starting';
    this.addDiagnostic('runtime', true, `Runtime ${process.version} selected.`);

    const version = process.versions.node.split('.').map((part) => Number.parseInt(part, 10));
    const supported =
      (version[0] ?? 0) > 20 ||
      ((version[0] ?? 0) === 20 &&
        ((version[1] ?? 0) > 19 || (version[1] === 19 && (version[2] ?? 0) >= 0)));
    if (!supported && !this.options.nodePath) {
      this.fail('runtime', `Node ${process.versions.node} is below Mozilla's required 20.19.0.`);
      throw new BrowserBridgeError(
        'BROWSER_LAUNCH_FAILED',
        `Node ${process.versions.node} is unsupported; use Node 20.19.0 or newer.`,
        {
          stage: 'runtime',
          recoverable: true,
          hint: 'Set --node-path to a supported Node executable.',
        },
      );
    }

    await mkdir(this.options.profileParent, { recursive: true });
    await mkdir(this.options.outputDirectory, { recursive: true });
    this.addDiagnostic('profile', true, 'Dedicated profile parent is ready.', {
      profileParent: this.options.profileParent,
      effectiveProfile: resolve(this.options.profileParent, 'firefox_devtools_mcp_profile'),
    });

    let entry: string;
    try {
      entry = require.resolve('@mozilla/firefox-devtools-mcp');
    } catch (error) {
      this.fail('spawn', 'Could not resolve @mozilla/firefox-devtools-mcp.', error);
      throw new BrowserBridgeError(
        'BROWSER_LAUNCH_FAILED',
        'The pinned Mozilla Firefox DevTools MCP package is not installed.',
        { stage: 'spawn', recoverable: true, cause: String(error) },
      );
    }

    const args = [
      entry,
      '--firefox-path',
      this.options.firefoxPath,
      '--profile-path',
      this.options.profileParent,
      '--tools',
      'pages,snapshot,input,network,console,screenshot,downloads,utilities,script',
    ];
    if (this.options.headless) {
      args.push('--headless');
    }
    if (this.options.viewport) {
      args.push('--viewport', `${this.options.viewport.width}x${this.options.viewport.height}`);
    }
    if (this.options.startUrl) {
      args.push('--start-url', this.options.startUrl);
    }
    for (const [name, value] of Object.entries(this.options.preferences ?? {})) {
      args.push('--pref', `${name}=${String(value)}`);
    }

    const transport = new GracefulStdioClientTransport({
      command: this.options.nodePath ?? process.execPath,
      args,
      env: this.safeEnvironment(),
      cwd: this.options.outputDirectory,
      stderr: 'pipe',
      gracefulCloseMs: 2_500,
      ...(this.options.windowsJobSupervisorPath
        ? { windowsJobSupervisorPath: this.options.windowsJobSupervisorPath }
        : {}),
    });
    transport.stderr?.on('data', (chunk: Buffer | string) => this.captureStderr(String(chunk)));
    transport.onerror = (error) => {
      this.captureStderr(`[transport] ${error.message}`);
    };
    transport.onclose = () => {
      if (this.state !== 'closed') {
        this.state = 'failed';
        this.fail('connection', 'Mozilla MCP child closed unexpectedly.');
      }
    };

    const client = new Client(
      { name: 'librewolf-agent-bridge-upstream-adapter', version: '0.1.0' },
      { capabilities: {} },
    );
    this.transport = transport;
    this.client = client;
    this.addDiagnostic('spawn', true, 'Starting pinned Mozilla MCP child.', {
      package: '@mozilla/firefox-devtools-mcp@0.9.15',
      executable: this.options.nodePath ?? process.execPath,
      ...(this.options.nodePath === undefined && this.hostIsElectron
        ? { runtimeMode: 'electron-as-node' }
        : {}),
    });

    try {
      await client.connect(transport, {
        timeout: this.options.connectTimeoutMs ?? 90_000,
      });
      this.addDiagnostic('initialize', true, 'Mozilla MCP initialize completed.');
      const listed = await client.listTools(undefined, { timeout: 15_000 });
      const names = new Set(listed.tools.map((tool) => tool.name));
      const missing = [...REQUIRED_UPSTREAM_TOOLS].filter((name) => !names.has(name));
      if (missing.length > 0) {
        throw new BrowserBridgeError(
          'BROWSER_TOOL_CONTRACT_MISMATCH',
          `Mozilla MCP is missing required tools: ${missing.join(', ')}`,
          { stage: 'tool-contract', recoverable: false, missing },
        );
      }
      this.addDiagnostic('tool-contract', true, 'Pinned upstream tool contract verified.', {
        requiredCount: REQUIRED_UPSTREAM_TOOLS.size,
        advertisedCount: names.size,
      });
      this.state = 'ready';
      this.addDiagnostic('ready', true, 'Controlled LibreWolf adapter is ready.');
    } catch (error) {
      this.state = 'failed';
      this.fail('initialize', 'Mozilla MCP initialization failed.', error);
      await client.close().catch(() => undefined);
      throw error instanceof BrowserBridgeError
        ? error
        : new BrowserBridgeError(
            'BROWSER_CONNECTION_FAILED',
            'Could not initialize LibreWolf automation.',
            {
              stage: 'initialize',
              recoverable: true,
              cause: error instanceof Error ? error.message : String(error),
              stderr: this.getRecentStderr(30),
            },
          );
    }
  }

  private parseResult(result: McpToolResult): UpstreamCallResult {
    const text: string[] = [];
    const images: { data: string; mimeType: string }[] = [];
    for (const item of result.content ?? []) {
      if (item['type'] === 'text' && typeof item['text'] === 'string') {
        text.push(item['text']);
      }
      if (
        item['type'] === 'image' &&
        typeof item['data'] === 'string' &&
        typeof item['mimeType'] === 'string'
      ) {
        images.push({ data: item['data'], mimeType: item['mimeType'] });
      }
    }
    return { text: text.join('\n'), images, raw: result.structuredContent ?? result };
  }

  private translateCallError(name: string, error: unknown): BrowserBridgeError {
    const message = error instanceof Error ? error.message : String(error);
    const timeout = /timeout/iu.test(message);
    return new BrowserBridgeError(timeout ? 'TIMEOUT' : 'UPSTREAM_ERROR', `${name}: ${message}`, {
      stage: 'tool-call',
      tool: name,
      recoverable: timeout,
      ...(timeout
        ? { hint: 'Refresh tab state and retry only if the operation is idempotent.' }
        : {}),
    });
  }

  private translateResultError(name: string, message: string): BrowserBridgeError {
    if (/stale|invalid.*uid|take_snapshot/iu.test(message)) {
      return new BrowserBridgeError('STALE_REFERENCE', message, {
        stage: 'action',
        tool: name,
        recoverable: true,
        hint: 'Take a new browser_snapshot and retry using its UID.',
      });
    }
    if (/not visible|not interactable|intercepted|blocked/iu.test(message)) {
      return new BrowserBridgeError('ACTION_BLOCKED', message, {
        stage: 'action',
        tool: name,
        recoverable: true,
      });
    }
    if (/timeout/iu.test(message)) {
      return new BrowserBridgeError('TIMEOUT', message, {
        stage: 'action',
        tool: name,
        recoverable: true,
      });
    }
    return new BrowserBridgeError('UPSTREAM_ERROR', message || `${name} failed.`, {
      stage: 'tool-call',
      tool: name,
      recoverable: false,
    });
  }

  /**
   * True when this process is an Electron host rather than a plain Node binary.
   *
   * An MCP client may launch the server with its own bundled runtime — Claude Desktop runs the
   * packaged extension under `claude.exe`. `process.execPath` is then the desktop application,
   * not a Node interpreter, and spawning it with a JavaScript entry point starts a second copy of
   * the app instead of the Mozilla child. The transport sees no JSON-RPC and reports
   * "Unexpected end of JSON input".
   */
  private get hostIsElectron(): boolean {
    return (
      process.versions['electron'] !== undefined ||
      !/^node(?:\.exe)?$/iu.test(basename(process.execPath))
    );
  }

  /**
   * Electron only behaves as a Node interpreter when `ELECTRON_RUN_AS_NODE` is set, so the child
   * inherits it whenever the host is Electron and no explicit runtime was configured. That keeps
   * the packaged extension self-contained instead of depending on a separate Node install.
   */
  private safeEnvironment(): Record<string, string> {
    const allowed = [
      'PATH',
      'SystemRoot',
      'WINDIR',
      'TEMP',
      'TMP',
      'LOCALAPPDATA',
      'APPDATA',
      'USERPROFILE',
      'ProgramFiles',
      'ProgramFiles(x86)',
      'LANG',
    ];
    const environment: Record<string, string> = {};
    for (const name of allowed) {
      const value = process.env[name];
      if (value !== undefined) {
        environment[name] = value;
      }
    }
    if (this.options.nodePath === undefined && this.hostIsElectron) {
      environment['ELECTRON_RUN_AS_NODE'] = '1';
    }
    Object.assign(environment, this.options.environment ?? {});
    return environment;
  }

  private captureStderr(value: string): void {
    for (const line of value.split(/\r?\n/u)) {
      if (line.length === 0) {
        continue;
      }
      this.stderrLines.push(line.slice(0, 2_000));
    }
    if (this.stderrLines.length > 500) {
      this.stderrLines.splice(0, this.stderrLines.length - 500);
    }
  }

  private addDiagnostic(
    stage: StartupDiagnostic['stage'],
    ok: boolean,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ): void {
    this.diagnostics.push({
      stage,
      ok,
      at: new Date().toISOString(),
      message,
      ...(details ? { details } : {}),
    });
  }

  private fail(stage: string, message: string, error?: unknown): void {
    this.state = 'failed';
    this.addDiagnostic('failed', false, message, {
      failedStage: stage,
      cause:
        error instanceof Error ? error.message : error === undefined ? undefined : String(error),
      stderr: this.getRecentStderr(30),
    });
  }
}

export const resolveMozillaEntry = (): string => require.resolve('@mozilla/firefox-devtools-mcp');
