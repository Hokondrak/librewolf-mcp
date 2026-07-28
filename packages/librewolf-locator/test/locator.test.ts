import { describe, expect, it, vi } from 'vitest';
import {
  LibreWolfDiscoveryError,
  WindowsLibreWolfLocator,
  WindowsRegistryProvider,
  assertNodeEngine,
  checkNodeEngine,
  type LocatorFileSystem,
} from '../src/index.js';

function fakeFileSystem(files: readonly string[]): LocatorFileSystem {
  const normalized = new Set(files.map((path) => path.toLocaleLowerCase('en-US')));
  return {
    async inspect(path) {
      const exists = normalized.has(path.toLocaleLowerCase('en-US'));
      return exists
        ? { exists: true, isFile: true, resolvedPath: path }
        : { exists: false, isFile: false };
    },
  };
}

describe('WindowsLibreWolfLocator', () => {
  it('gives the manual override absolute precedence', async () => {
    const registryProvider = { getCandidates: vi.fn(async () => []) };
    const locator = new WindowsLibreWolfLocator();
    const result = await locator.discover({
      platform: 'win32',
      manualPath: 'C:\\Manual\\librewolf.exe',
      env: {
        LIBREWOLF_PATH: 'C:\\Environment\\librewolf.exe',
        PATH: 'C:\\Path',
      },
      registryProvider,
      commonPaths: ['C:\\Common\\librewolf.exe'],
      fileSystem: fakeFileSystem([
        'C:\\Manual\\librewolf.exe',
        'C:\\Environment\\librewolf.exe',
        'C:\\Common\\librewolf.exe',
        'C:\\Path\\librewolf.exe',
      ]),
    });

    expect(result.source).toBe('manual');
    expect(result.executablePath).toBe('C:\\Manual\\librewolf.exe');
    expect(registryProvider.getCandidates).not.toHaveBeenCalled();
  });

  it('uses environment before registry, common paths, and PATH', async () => {
    const registryProvider = {
      getCandidates: vi.fn(async () => [
        { path: 'C:\\Registry\\librewolf.exe', key: 'registry-key' },
      ]),
    };
    const result = await new WindowsLibreWolfLocator().discover({
      platform: 'win32',
      env: {
        LIBREWOLF_PATH: 'C:\\Environment\\librewolf.exe',
        PATH: 'C:\\Path',
      },
      registryProvider,
      commonPaths: ['C:\\Common\\librewolf.exe'],
      fileSystem: fakeFileSystem(['C:\\Environment\\librewolf.exe', 'C:\\Registry\\librewolf.exe']),
    });

    expect(result.source).toBe('environment');
    expect(registryProvider.getCandidates).not.toHaveBeenCalled();
  });

  it('fails closed for an invalid explicit override', async () => {
    const locator = new WindowsLibreWolfLocator();
    const failure = await locator
      .discover({
        platform: 'win32',
        manualPath: 'C:\\Wrong\\librewolf.exe',
        env: { LIBREWOLF_PATH: 'C:\\Valid\\librewolf.exe' },
        fileSystem: fakeFileSystem(['C:\\Valid\\librewolf.exe']),
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LibreWolfDiscoveryError);
    expect((failure as LibreWolfDiscoveryError).code).toBe('INVALID_MANUAL_PATH');
    expect((failure as LibreWolfDiscoveryError).diagnostics).toEqual([
      expect.objectContaining({ stage: 'manual', status: 'invalid' }),
    ]);
  });

  it('continues from registry failures through common paths and PATH', async () => {
    const result = await new WindowsLibreWolfLocator().discover({
      platform: 'win32',
      env: { PATH: 'C:\\First;C:\\Second' },
      registryProvider: {
        async getCandidates() {
          throw new Error('registry unavailable');
        },
      },
      commonPaths: ['C:\\Common\\librewolf.exe'],
      fileSystem: fakeFileSystem(['C:\\Second\\librewolf.exe']),
    });

    expect(result.source).toBe('path');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'registry', status: 'error' }),
        expect.objectContaining({ stage: 'common-paths', status: 'not-found' }),
        expect.objectContaining({ stage: 'path', status: 'selected' }),
      ]),
    );
  });

  it('returns ordered diagnostics when discovery is exhausted', async () => {
    const failure = await new WindowsLibreWolfLocator()
      .discover({
        platform: 'win32',
        env: { PATH: 'C:\\Empty' },
        registryProvider: { getCandidates: async () => [] },
        commonPaths: ['C:\\Missing\\librewolf.exe'],
        fileSystem: fakeFileSystem([]),
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LibreWolfDiscoveryError);
    const stages = (failure as LibreWolfDiscoveryError).diagnostics.map((item) => item.stage);
    expect(stages).toEqual(['manual', 'environment', 'registry', 'common-paths', 'path', 'path']);
  });
});

describe('WindowsRegistryProvider', () => {
  it('parses injected reg.exe output without invoking a shell', async () => {
    const provider = new WindowsRegistryProvider(
      {
        async run(_file, args) {
          return args[1]?.startsWith('HKCU')
            ? '    (Default)    REG_SZ    C:\\Program Files\\LibreWolf\\librewolf.exe\r\n'
            : '';
        },
      },
      'win32',
    );

    await expect(provider.getCandidates()).resolves.toEqual([
      {
        key: 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\librewolf.exe',
        path: 'C:\\Program Files\\LibreWolf\\librewolf.exe',
      },
    ]);
  });
});

describe('Node engine compatibility', () => {
  it('checks the precise 20.19.0 floor', () => {
    expect(checkNodeEngine('20.18.2').compatible).toBe(false);
    expect(checkNodeEngine('20.19.0').compatible).toBe(true);
    expect(checkNodeEngine('v24.14.0').compatible).toBe(true);
    expect(() => assertNodeEngine('not-a-version')).toThrow(/parse/u);
  });
});
