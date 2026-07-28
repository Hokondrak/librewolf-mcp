import { promises as fs } from 'node:fs';
import { delimiter as defaultDelimiter, isAbsolute, join, resolve } from 'node:path';
import { LibreWolfDiscoveryError } from './errors.js';
import { WindowsRegistryProvider } from './registry.js';
import type {
  FileInspection,
  LibreWolfDiscoveryDiagnostic,
  LibreWolfDiscoveryResult,
  LibreWolfDiscoveryStage,
  LibreWolfLocatorOptions,
  LocatorFileSystem,
  RegistryCandidate,
} from './types.js';

export const LIBREWOLF_PATH_ENV = 'LIBREWOLF_PATH';

class NodeLocatorFileSystem implements LocatorFileSystem {
  public async inspect(path: string): Promise<FileInspection> {
    try {
      const stats = await fs.stat(path);
      const resolvedPath = await fs.realpath(path);
      return { exists: true, isFile: stats.isFile(), resolvedPath };
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : undefined;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { exists: false, isFile: false };
      }
      throw error;
    }
  }
}

function diagnostic(
  stage: LibreWolfDiscoveryStage,
  status: LibreWolfDiscoveryDiagnostic['status'],
  message: string,
  candidate?: string,
  cause?: string,
): LibreWolfDiscoveryDiagnostic {
  return {
    stage,
    status,
    message,
    ...(candidate === undefined ? {} : { candidate }),
    ...(cause === undefined ? {} : { cause }),
  };
}

function defaultCommonPaths(env: Readonly<Record<string, string | undefined>>): string[] {
  const paths: string[] = [];
  const add = (base: string | undefined, ...parts: string[]) => {
    if (base) {
      paths.push(join(base, ...parts));
    }
  };

  add(env['ProgramFiles'], 'LibreWolf', 'librewolf.exe');
  add(env['PROGRAMFILES'], 'LibreWolf', 'librewolf.exe');
  add(env['ProgramFiles(x86)'], 'LibreWolf', 'librewolf.exe');
  add(env['PROGRAMFILES(X86)'], 'LibreWolf', 'librewolf.exe');
  add(env['LOCALAPPDATA'], 'Programs', 'LibreWolf', 'librewolf.exe');
  add(env['USERPROFILE'], 'scoop', 'apps', 'librewolf', 'current', 'librewolf.exe');

  return [...new Set(paths)];
}

function toCandidatePath(path: string): string {
  const trimmed = path.trim().replace(/^"(.*)"$/u, '$1');
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

export class WindowsLibreWolfLocator {
  public async discover(options: LibreWolfLocatorOptions = {}): Promise<LibreWolfDiscoveryResult> {
    const platform = options.platform ?? process.platform;
    const diagnostics: LibreWolfDiscoveryDiagnostic[] = [];
    if (platform !== 'win32') {
      diagnostics.push(
        diagnostic('manual', 'error', `Windows discovery is unavailable on ${platform}.`),
      );
      throw new LibreWolfDiscoveryError(
        'UNSUPPORTED_PLATFORM',
        `LibreWolf Windows discovery is unavailable on ${platform}.`,
        diagnostics,
      );
    }

    const env = options.env ?? process.env;
    const fileSystem = options.fileSystem ?? new NodeLocatorFileSystem();

    if (options.manualPath !== undefined) {
      const selected = await this.inspectAuthoritativeCandidate(
        'manual',
        options.manualPath,
        fileSystem,
        diagnostics,
      );
      if (!selected) {
        throw new LibreWolfDiscoveryError(
          'INVALID_MANUAL_PATH',
          `The manual LibreWolf path is not an executable file: ${options.manualPath}`,
          diagnostics,
        );
      }
      return selected;
    }
    diagnostics.push(diagnostic('manual', 'not-configured', 'No manual path was provided.'));

    const environmentPath = env[LIBREWOLF_PATH_ENV];
    if (environmentPath !== undefined && environmentPath.trim() !== '') {
      const selected = await this.inspectAuthoritativeCandidate(
        'environment',
        environmentPath,
        fileSystem,
        diagnostics,
      );
      if (!selected) {
        throw new LibreWolfDiscoveryError(
          'INVALID_ENVIRONMENT_PATH',
          `${LIBREWOLF_PATH_ENV} does not point to an executable file: ${environmentPath}`,
          diagnostics,
        );
      }
      return selected;
    }
    diagnostics.push(
      diagnostic('environment', 'not-configured', `${LIBREWOLF_PATH_ENV} is not set.`),
    );

    const registryProvider =
      options.registryProvider ?? new WindowsRegistryProvider(undefined, platform);
    try {
      const registryCandidates = await registryProvider.getCandidates();
      const selected = await this.inspectCandidates(
        'registry',
        registryCandidates,
        fileSystem,
        diagnostics,
      );
      if (selected) {
        return selected;
      }
      if (registryCandidates.length === 0) {
        diagnostics.push(diagnostic('registry', 'not-found', 'No LibreWolf App Paths keys found.'));
      }
    } catch (error) {
      diagnostics.push(
        diagnostic(
          'registry',
          'error',
          'Registry discovery failed; continuing with filesystem probes.',
          undefined,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }

    const commonPaths = options.commonPaths ?? defaultCommonPaths(env);
    const commonSelected = await this.inspectCandidates(
      'common-paths',
      commonPaths.map((path) => ({ path, key: 'common-path' })),
      fileSystem,
      diagnostics,
    );
    if (commonSelected) {
      return commonSelected;
    }
    if (commonPaths.length === 0) {
      diagnostics.push(
        diagnostic('common-paths', 'not-found', 'No common Windows install roots are configured.'),
      );
    }

    const pathEntries = (env['PATH'] ?? '')
      .split(options.pathDelimiter ?? defaultDelimiter)
      .map((entry) => entry.trim().replace(/^"(.*)"$/u, '$1'))
      .filter((entry) => entry.length > 0);
    const executableNames = options.executableNames ?? ['librewolf.exe', 'librewolf'];
    const pathCandidates = pathEntries.flatMap((entry) =>
      executableNames.map((name) => ({ path: join(entry, name), key: 'PATH' })),
    );
    const pathSelected = await this.inspectCandidates(
      'path',
      pathCandidates,
      fileSystem,
      diagnostics,
    );
    if (pathSelected) {
      return pathSelected;
    }
    if (pathCandidates.length === 0) {
      diagnostics.push(
        diagnostic('path', 'not-found', 'PATH does not contain searchable entries.'),
      );
    }

    throw new LibreWolfDiscoveryError(
      'LIBREWOLF_NOT_FOUND',
      'LibreWolf was not found. Pass --librewolf-path or set LIBREWOLF_PATH.',
      diagnostics,
    );
  }

  private async inspectAuthoritativeCandidate(
    stage: LibreWolfDiscoveryStage,
    path: string,
    fileSystem: LocatorFileSystem,
    diagnostics: LibreWolfDiscoveryDiagnostic[],
  ): Promise<LibreWolfDiscoveryResult | null> {
    const candidate = toCandidatePath(path);
    try {
      const inspection = await fileSystem.inspect(candidate);
      if (!inspection.exists || !inspection.isFile) {
        diagnostics.push(
          diagnostic(stage, 'invalid', 'Configured path is missing or is not a file.', candidate),
        );
        return null;
      }
      const executablePath = inspection.resolvedPath ?? candidate;
      diagnostics.push(
        diagnostic(stage, 'selected', 'Selected LibreWolf executable.', executablePath),
      );
      return { executablePath, source: stage, diagnostics: [...diagnostics] };
    } catch (error) {
      diagnostics.push(
        diagnostic(
          stage,
          'error',
          'Configured path could not be inspected.',
          candidate,
          error instanceof Error ? error.message : String(error),
        ),
      );
      return null;
    }
  }

  private async inspectCandidates(
    stage: LibreWolfDiscoveryStage,
    candidates: readonly RegistryCandidate[],
    fileSystem: LocatorFileSystem,
    diagnostics: LibreWolfDiscoveryDiagnostic[],
  ): Promise<LibreWolfDiscoveryResult | null> {
    const seen = new Set<string>();
    for (const item of candidates) {
      const candidate = toCandidatePath(item.path);
      const key = candidate.toLocaleLowerCase('en-US');
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      try {
        const inspection = await fileSystem.inspect(candidate);
        if (!inspection.exists || !inspection.isFile) {
          diagnostics.push(
            diagnostic(stage, 'not-found', `Candidate from ${item.key} is unavailable.`, candidate),
          );
          continue;
        }
        const executablePath = inspection.resolvedPath ?? candidate;
        diagnostics.push(
          diagnostic(stage, 'selected', `Selected candidate from ${item.key}.`, executablePath),
        );
        return { executablePath, source: stage, diagnostics: [...diagnostics] };
      } catch (error) {
        diagnostics.push(
          diagnostic(
            stage,
            'error',
            `Candidate from ${item.key} could not be inspected.`,
            candidate,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
    return null;
  }
}

export async function discoverLibreWolf(
  options: LibreWolfLocatorOptions = {},
): Promise<LibreWolfDiscoveryResult> {
  return new WindowsLibreWolfLocator().discover(options);
}
