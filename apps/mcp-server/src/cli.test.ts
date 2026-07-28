import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type {
  BrowserSession,
  ControlledBrowserSessionOptions,
} from '@librewolf-agent-bridge/browser-core';

import { CliConfigurationError, createSessionForCli, parseCliOptions } from './cli.js';

describe('MCP CLI configuration', () => {
  it('uses managed local defaults and resolves explicit controlled flags', () => {
    const stderr = new PassThrough();
    const options = parseCliOptions(
      [
        '--mode',
        'controlled',
        '--librewolf-path',
        '.\\bin\\librewolf.exe',
        '--profile-path',
        '.\\profiles\\automation',
        '--output',
        '.\\artifacts',
        '--runtime',
        '.\\runtime\\node.exe',
        '--headless',
        '--viewport',
        '1440x900',
        '--start-url',
        'https://example.test/start',
      ],
      {
        cwd: 'C:\\bridge',
        env: { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' },
        stderr,
      },
    );

    expect(options).toEqual({
      mode: 'controlled',
      librewolfPath: 'C:\\bridge\\bin\\librewolf.exe',
      profileRoot: 'C:\\bridge\\profiles',
      profileName: 'automation',
      outputDirectory: 'C:\\bridge\\artifacts',
      nodePath: 'C:\\bridge\\runtime\\node.exe',
      headless: true,
      viewport: { width: 1440, height: 900 },
      startUrl: 'https://example.test/start',
    });
  });

  it('rejects controlled-only flags in companion mode', () => {
    expect(() =>
      parseCliOptions(['--mode', 'companion', '--headless'], {
        cwd: 'C:\\bridge',
        env: { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' },
        stderr: new PassThrough(),
      }),
    ).toThrow(CliConfigurationError);
  });

  it('uses injected discovery and session factories without filesystem mutation', async () => {
    let received: ControlledBrowserSessionOptions | undefined;
    const fakeSession = { close: async () => undefined } as BrowserSession;
    const options = parseCliOptions(['--librewolf-path', 'C:\\LibreWolf\\librewolf.exe'], {
      cwd: 'C:\\bridge',
      env: { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' },
      stderr: new PassThrough(),
    });

    const session = await createSessionForCli(options, {
      nodeVersion: '24.14.0',
      discover: async (manualPath) => ({
        executablePath: manualPath ?? 'missing',
        source: 'manual',
        diagnostics: [],
      }),
      windowsJobSupervisorPath: 'C:\\bridge\\secure-pipe-helper.exe',
      controlledSessionFactory: (sessionOptions) => {
        received = sessionOptions;
        return fakeSession;
      },
    });

    expect(session).toBe(fakeSession);
    expect(received).toMatchObject({
      browserPath: 'C:\\LibreWolf\\librewolf.exe',
      profileRoot: 'C:\\Users\\Test\\AppData\\Local\\LibreWolfAgentBridge\\profiles',
      profileName: 'default',
      outputDirectory: 'C:\\Users\\Test\\AppData\\Local\\LibreWolfAgentBridge\\output',
      windowsJobSupervisorPath: 'C:\\bridge\\secure-pipe-helper.exe',
      removeProfileOnClose: false,
    });
  });

  it('checks the Node engine before discovery', async () => {
    let discoveryCalled = false;
    const options = parseCliOptions([], {
      cwd: 'C:\\bridge',
      env: { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' },
      stderr: new PassThrough(),
    });

    await expect(
      createSessionForCli(options, {
        nodeVersion: '20.18.2',
        discover: async () => {
          discoveryCalled = true;
          throw new Error('not expected');
        },
      }),
    ).rejects.toMatchObject({
      name: 'NodeEngineCompatibilityError',
      compatibility: {
        compatible: false,
        minimumVersion: '20.19.0',
      },
    });
    expect(discoveryCalled).toBe(false);
  });

  it('checks an explicit child runtime instead of rejecting the launcher runtime', async () => {
    const fakeSession = { close: async () => undefined } as BrowserSession;
    const options = parseCliOptions(['--runtime', 'C:\\Runtime\\node.exe'], {
      cwd: 'C:\\bridge',
      env: { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' },
      stderr: new PassThrough(),
    });
    let checkedPath: string | undefined;

    await expect(
      createSessionForCli(options, {
        runtimeVersion: async (path) => {
          checkedPath = path;
          return 'v24.14.0';
        },
        discover: async () => ({
          executablePath: 'C:\\LibreWolf\\librewolf.exe',
          source: 'common-paths',
          diagnostics: [],
        }),
        controlledSessionFactory: () => fakeSession,
      }),
    ).resolves.toBe(fakeSession);
    expect(checkedPath).toBe('C:\\Runtime\\node.exe');
  });

  it('rejects malformed or impractical viewports', () => {
    for (const value of ['wide', '100x800', '800x99999']) {
      expect(() =>
        parseCliOptions(['--viewport', value], {
          cwd: 'C:\\bridge',
          env: { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' },
          stderr: new PassThrough(),
        }),
      ).toThrow(CliConfigurationError);
    }
  });
});
