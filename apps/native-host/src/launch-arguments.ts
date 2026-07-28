import { isAbsolute, normalize } from 'node:path';

const EXPECTED_EXTENSION_ID = 'librewolf-agent-bridge@librewolf-agent-bridge.org';

export interface NativeLaunchContext {
  manifestPath: string;
  extensionId: string;
}

export function validateLaunchArguments(args: string[]): NativeLaunchContext {
  const extensionId = args.at(-1);
  const manifestPath = args.at(-2);
  if (extensionId !== EXPECTED_EXTENSION_ID) {
    throw new Error('Native host was launched by an unexpected extension ID.');
  }
  if (!manifestPath || !isAbsolute(manifestPath) || !manifestPath.toLowerCase().endsWith('.json')) {
    throw new Error('Native host manifest path is missing or invalid.');
  }
  return { manifestPath: normalize(manifestPath), extensionId };
}
