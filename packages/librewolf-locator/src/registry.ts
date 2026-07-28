import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { LibreWolfRegistryProvider, RegistryCandidate } from './types.js';

const execFile = promisify(execFileCallback);

export interface RegistryCommandRunner {
  run(file: string, args: readonly string[]): Promise<string>;
}

class DefaultRegistryCommandRunner implements RegistryCommandRunner {
  public async run(file: string, args: readonly string[]): Promise<string> {
    const result = await execFile(file, [...args], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return result.stdout;
  }
}

const APP_PATH_KEYS = [
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\librewolf.exe',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\librewolf.exe',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\librewolf.exe',
] as const;

function parseDefaultRegistryValue(output: string): string | null {
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(?:\(Default\)|<NO NAME>)\s+REG_\w+\s+(.+?)\s*$/iu.exec(line);
    if (match?.[1]) {
      return match[1].trim().replace(/^"(.*)"$/u, '$1');
    }
  }
  return null;
}

export class WindowsRegistryProvider implements LibreWolfRegistryProvider {
  public constructor(
    private readonly runner: RegistryCommandRunner = new DefaultRegistryCommandRunner(),
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  public async getCandidates(): Promise<readonly RegistryCandidate[]> {
    if (this.platform !== 'win32') {
      return [];
    }

    const candidates: RegistryCandidate[] = [];
    for (const key of APP_PATH_KEYS) {
      try {
        const output = await this.runner.run('reg.exe', ['query', key, '/ve']);
        const path = parseDefaultRegistryValue(output);
        if (path) {
          candidates.push({ path, key });
        }
      } catch {
        // A missing registry key is expected; the locator records the empty stage.
      }
    }
    return candidates;
  }
}
