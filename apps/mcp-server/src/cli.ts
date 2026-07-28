#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';

import { Command, CommanderError, Option } from 'commander';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  CompanionBrowserSession,
  ControlledBrowserSession,
  type BrowserSession,
  type CompanionBrowserSessionOptions,
  type ControlledBrowserSessionOptions,
} from '@librewolf-agent-bridge/browser-core';
import {
  LibreWolfDiscoveryError,
  NodeEngineCompatibilityError,
  checkNodeEngine,
  discoverLibreWolf,
  type LibreWolfDiscoveryResult,
} from '@librewolf-agent-bridge/librewolf-locator';

import { createBrowserMcpServer } from './server.js';
import { SecureCompanionTransport } from './companion-transport.js';

const VERSION = '0.1.0';
const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;
const execFileAsync = promisify(execFile);

export interface CliOptions {
  readonly mode: 'controlled' | 'attached' | 'companion';
  readonly marionettePort?: number;
  readonly librewolfPath?: string;
  readonly profileRoot: string;
  readonly profileName: string;
  readonly outputDirectory: string;
  readonly nodePath?: string;
  readonly headless: boolean;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly startUrl?: string;
}

interface RawCliOptions {
  mode: 'controlled' | 'attached' | 'companion';
  librewolfPath?: string;
  profilePath?: string;
  profileRoot?: string;
  profile?: string;
  output?: string;
  outputDirectory?: string;
  runtime?: string;
  nodePath?: string;
  headless?: boolean;
  viewport?: string;
  startUrl?: string;
  marionettePort?: string;
}

export interface CliIo {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
}

export interface CliDependencies {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly nodeVersion?: string;
  readonly runtimeVersion?: (runtimePath: string) => Promise<string>;
  readonly discover?: (manualPath?: string) => Promise<LibreWolfDiscoveryResult>;
  readonly controlledSessionFactory?: (options: ControlledBrowserSessionOptions) => BrowserSession;
  readonly companionSessionFactory?: (options: CompanionBrowserSessionOptions) => BrowserSession;
  readonly transportFactory?: (io: CliIo) => StdioServerTransport;
  readonly io?: CliIo;
  readonly windowsJobSupervisorPath?: string;
}

export interface RunningCli {
  readonly options: CliOptions;
  readonly session: BrowserSession;
  readonly shutdown: (reason?: string) => Promise<void>;
}

export class CliConfigurationError extends Error {
  public override readonly name = 'CliConfigurationError';
}

const writeLine = (output: Pick<Writable, 'write'>, message: string): void => {
  output.write(`[librewolf-agent-bridge] ${message.replace(/\r?\n/gu, ' ')}\n`);
};

const defaultDataRoot = (environment: Readonly<Record<string, string | undefined>>): string => {
  const localAppData = environment['LOCALAPPDATA'];
  if (localAppData && isAbsolute(localAppData)) {
    return join(localAppData, 'LibreWolfAgentBridge');
  }
  return join(tmpdir(), 'LibreWolfAgentBridge');
};

const safeDirectory = (path: string, label: string, cwd: string): string => {
  const absolute = resolve(cwd, path);
  if (dirname(absolute) === absolute) {
    throw new CliConfigurationError(`${label} cannot be a filesystem root.`);
  }
  return absolute;
};

const optionalPath = (path: string | undefined, label: string, cwd: string): string | undefined =>
  path === undefined ? undefined : safeDirectory(path, label, cwd);

const startUrl = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliConfigurationError('--start-url must be an absolute URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && value !== 'about:blank') {
    throw new CliConfigurationError('--start-url supports http, https, or about:blank only.');
  }
  return value;
};

const viewport = (
  value: string | undefined,
): { readonly width: number; readonly height: number } | undefined => {
  if (value === undefined) return undefined;
  const match = /^(\d{2,5})x(\d{2,5})$/u.exec(value);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 200 ||
    height < 200 ||
    width > 16_384 ||
    height > 16_384
  ) {
    throw new CliConfigurationError(
      '--viewport must use WIDTHxHEIGHT with each dimension between 200 and 16384.',
    );
  }
  return { width, height };
};

const readRuntimeVersion = async (runtimePath: string): Promise<string> => {
  try {
    const { stdout } = await execFileAsync(runtimePath, ['--version'], {
      windowsHide: true,
      timeout: 5_000,
      encoding: 'utf8',
    });
    return stdout.trim();
  } catch (error) {
    throw new CliConfigurationError(
      `Could not execute the configured Node runtime: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const resolveWindowsJobSupervisor = (): string | undefined => {
  if (process.platform !== 'win32') {
    return undefined;
  }
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, 'native', 'secure-pipe-helper.exe'),
    resolve(moduleDirectory, '..', '..', 'native-host', 'dist', 'native', 'secure-pipe-helper.exe'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new CliConfigurationError(
      'The Windows process supervisor is missing; rebuild the native-host workspace.',
    );
  }
  return found;
};

export const createCliProgram = (stderr: Pick<Writable, 'write'> = process.stderr): Command => {
  const program = new Command()
    .name('librewolf-agent-bridge')
    .description('Local-first MCP automation for LibreWolf.')
    .version(VERSION)
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      // stdout is reserved exclusively for MCP JSON-RPC frames.
      writeOut: (text) => stderr.write(text),
      writeErr: (text) => stderr.write(text),
    })
    .addOption(
      new Option('--mode <mode>', 'browser connection mode')
        .choices(['controlled', 'attached', 'companion'])
        .default('controlled'),
    )
    .option('--librewolf-path <path>', 'explicit LibreWolf executable path')
    .option(
      '--profile-path <path>',
      'dedicated controlled-profile parent (cannot be a normal user profile)',
    )
    .option('--profile-root <path>', 'root for managed controlled profiles')
    .option('--profile <name>', 'managed profile name (default: default)')
    .option('--output <path>', 'snapshot and screenshot output directory')
    .option('--output-directory <path>', 'alias for --output')
    .option('--runtime <path>', 'Node.js executable for the pinned Mozilla child')
    .option('--node-path <path>', 'alias for --runtime')
    .option('--headless', 'run the controlled LibreWolf profile headlessly', false)
    .option('--viewport <width>x<height>', 'controlled browser viewport (for example 1280x720)')
    .option('--start-url <url>', 'initial controlled-profile URL')
    .option('--marionette-port <port>', 'Marionette port for --mode attached (default 2828)');
  return program;
};

export const parseCliOptions = (
  argv: readonly string[],
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly cwd?: string;
    readonly stderr?: Pick<Writable, 'write'>;
  } = {},
): CliOptions => {
  const environment = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const program = createCliProgram(options.stderr ?? process.stderr);
  program.parse(['node', 'librewolf-agent-bridge', ...argv], { from: 'node' });
  const raw = program.opts<RawCliOptions>();

  if (raw.output && raw.outputDirectory) {
    throw new CliConfigurationError('Use only one of --output and --output-directory.');
  }
  if (raw.runtime && raw.nodePath) {
    throw new CliConfigurationError('Use only one of --runtime and --node-path.');
  }
  if (raw.profilePath && (raw.profileRoot || raw.profile)) {
    throw new CliConfigurationError(
      '--profile-path cannot be combined with --profile-root or --profile.',
    );
  }

  const controlledOnlyConfigured =
    raw.librewolfPath !== undefined ||
    raw.profilePath !== undefined ||
    raw.profileRoot !== undefined ||
    raw.profile !== undefined ||
    raw.output !== undefined ||
    raw.outputDirectory !== undefined ||
    raw.runtime !== undefined ||
    raw.nodePath !== undefined ||
    raw.headless === true ||
    raw.viewport !== undefined ||
    raw.startUrl !== undefined;
  if (raw.mode === 'companion' && controlledOnlyConfigured) {
    throw new CliConfigurationError(
      'LibreWolf, profile, output, runtime, headless, viewport, and start URL flags apply only to --mode controlled.',
    );
  }

  const dataRoot = defaultDataRoot(environment);
  let profileRoot = safeDirectory(
    raw.profileRoot ?? join(dataRoot, 'profiles'),
    '--profile-root',
    cwd,
  );
  let profileName = raw.profile ?? 'default';
  if (raw.profilePath) {
    const profilePath = safeDirectory(raw.profilePath, '--profile-path', cwd);
    profileRoot = dirname(profilePath);
    profileName = basename(profilePath);
  }
  if (!PROFILE_NAME_PATTERN.test(profileName) || profileName === '.' || profileName === '..') {
    throw new CliConfigurationError(
      '--profile must contain 1-64 letters, numbers, dots, underscores, or hyphens.',
    );
  }

  const librewolfPath = optionalPath(raw.librewolfPath, '--librewolf-path', cwd);
  const nodePath = optionalPath(raw.runtime ?? raw.nodePath, '--runtime', cwd);
  const outputDirectory = safeDirectory(
    raw.output ?? raw.outputDirectory ?? join(dataRoot, 'output'),
    '--output',
    cwd,
  );
  const initialUrl = startUrl(raw.startUrl);
  const initialViewport = viewport(raw.viewport);
  const marionettePort = raw.marionettePort === undefined ? undefined : Number(raw.marionettePort);
  if (
    marionettePort !== undefined &&
    (!Number.isInteger(marionettePort) || marionettePort < 1 || marionettePort > 65535)
  ) {
    throw new CliConfigurationError('--marionette-port must be a TCP port between 1 and 65535.');
  }

  return {
    mode: raw.mode,
    ...(marionettePort !== undefined ? { marionettePort } : {}),
    ...(librewolfPath ? { librewolfPath } : {}),
    profileRoot,
    profileName,
    outputDirectory,
    ...(nodePath ? { nodePath } : {}),
    headless: raw.headless === true,
    ...(initialViewport ? { viewport: initialViewport } : {}),
    ...(initialUrl ? { startUrl: initialUrl } : {}),
  };
};

export const createSessionForCli = async (
  options: CliOptions,
  dependencies: CliDependencies = {},
): Promise<BrowserSession> => {
  const selectedNodeVersion =
    dependencies.nodeVersion ??
    (options.nodePath
      ? await (dependencies.runtimeVersion ?? readRuntimeVersion)(options.nodePath)
      : process.versions.node);
  const compatibility = checkNodeEngine(selectedNodeVersion);
  if (!compatibility.compatible) {
    throw new NodeEngineCompatibilityError(compatibility);
  }

  if (options.mode === 'companion') {
    return (
      dependencies.companionSessionFactory?.({}) ??
      new CompanionBrowserSession({
        transport: new SecureCompanionTransport(),
      })
    );
  }

  const discovery = dependencies.discover
    ? await dependencies.discover(options.librewolfPath)
    : await discoverLibreWolf(options.librewolfPath ? { manualPath: options.librewolfPath } : {});
  const windowsJobSupervisorPath =
    dependencies.windowsJobSupervisorPath ??
    (dependencies.controlledSessionFactory ? undefined : resolveWindowsJobSupervisor());
  const sessionOptions: ControlledBrowserSessionOptions = {
    browserPath: discovery.executablePath,
    profileRoot: options.profileRoot,
    profileName: options.profileName,
    outputDirectory: options.outputDirectory,
    allowedOutputRoots: [options.outputDirectory],
    ...(options.nodePath ? { nodePath: options.nodePath } : {}),
    headless: options.headless,
    ...(options.viewport ? { viewport: options.viewport } : {}),
    ...(options.startUrl ? { startUrl: options.startUrl } : {}),
    ...(windowsJobSupervisorPath ? { windowsJobSupervisorPath } : {}),
    ...(options.mode === 'attached'
      ? {
          connectExisting: true,
          ...(options.marionettePort !== undefined
            ? { marionettePort: options.marionettePort }
            : {}),
        }
      : {}),
    removeProfileOnClose: false,
  };
  return (
    dependencies.controlledSessionFactory?.(sessionOptions) ??
    new ControlledBrowserSession(sessionOptions)
  );
};

export const runCli = async (
  argv: readonly string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<RunningCli> => {
  const io = dependencies.io ?? {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
  const options = parseCliOptions(argv, {
    ...(dependencies.env ? { env: dependencies.env } : {}),
    ...(dependencies.cwd ? { cwd: dependencies.cwd } : {}),
    stderr: io.stderr,
  });
  const session = await createSessionForCli(options, dependencies);
  const server = createBrowserMcpServer(session);
  const transport =
    dependencies.transportFactory?.(io) ?? new StdioServerTransport(io.stdin, io.stdout);

  let shutdownPromise: Promise<void> | undefined;
  const onSigint = (): void => {
    void shutdown('SIGINT');
  };
  const onSigterm = (): void => {
    void shutdown('SIGTERM');
  };
  const onInputEnd = (): void => {
    void shutdown('stdin closed');
  };
  const removeLifecycleListeners = (): void => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    io.stdin.off('end', onInputEnd);
  };
  const shutdown = async (reason = 'shutdown requested'): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      removeLifecycleListeners();
      writeLine(io.stderr, `shutdown: ${reason}`);
      const [serverResult, sessionResult] = await Promise.allSettled([
        server.close(),
        session.close(),
      ]);
      if (serverResult.status === 'rejected') {
        writeLine(io.stderr, `MCP transport close failed: ${safeError(serverResult.reason)}`);
      }
      if (sessionResult.status === 'rejected') {
        writeLine(io.stderr, `browser session close failed: ${safeError(sessionResult.reason)}`);
      }
    })();
    return shutdownPromise;
  };

  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  io.stdin.once('end', onInputEnd);

  try {
    await server.connect(transport);
  } catch (error) {
    removeLifecycleListeners();
    await session.close().catch(() => undefined);
    throw error;
  }
  writeLine(io.stderr, `ready: mode=${options.mode}; protocol=stdio; stdout=MCP-only`);
  return { options, session, shutdown };
};

const safeError = (error: unknown): string => {
  if (error instanceof LibreWolfDiscoveryError) {
    const stages = error.diagnostics.map((item) => `${item.stage}:${item.status}`).join(',');
    return `${error.code}: ${error.message} (${stages})`.slice(0, 2_000);
  }
  if (error instanceof NodeEngineCompatibilityError) {
    return error.compatibility.message.slice(0, 2_000);
  }
  return (error instanceof Error ? error.message : String(error))
    .replace(/\r?\n/gu, ' ')
    .slice(0, 2_000);
};

const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  void runCli().catch((error: unknown) => {
    if (error instanceof CommanderError && error.exitCode === 0) {
      return;
    }
    writeLine(process.stderr, safeError(error));
    process.exitCode = error instanceof CommanderError ? error.exitCode : 1;
  });
}
