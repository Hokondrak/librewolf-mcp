import { NodeEngineCompatibilityError } from './errors.js';
import type { NodeEngineCompatibility } from './types.js';

export const MINIMUM_NODE_VERSION = '20.19.0';

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseVersion(version: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) {
    return null;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return null;
  }

  return { major, minor, patch };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

export function checkNodeEngine(
  currentVersion = process.versions.node,
  minimumVersion = MINIMUM_NODE_VERSION,
): NodeEngineCompatibility {
  const current = parseVersion(currentVersion);
  const minimum = parseVersion(minimumVersion);

  if (!current) {
    return {
      compatible: false,
      currentVersion,
      minimumVersion,
      message: `Unable to parse Node.js version "${currentVersion}".`,
    };
  }
  if (!minimum) {
    return {
      compatible: false,
      currentVersion,
      minimumVersion,
      message: `Unable to parse required Node.js version "${minimumVersion}".`,
    };
  }

  const compatible = compareVersions(current, minimum) >= 0;
  return {
    compatible,
    currentVersion,
    minimumVersion,
    message: compatible
      ? `Node.js ${currentVersion} satisfies the minimum ${minimumVersion}.`
      : `Node.js ${currentVersion} is unsupported; install Node.js ${minimumVersion} or newer.`,
  };
}

export function assertNodeEngine(
  currentVersion = process.versions.node,
  minimumVersion = MINIMUM_NODE_VERSION,
): NodeEngineCompatibility {
  const compatibility = checkNodeEngine(currentVersion, minimumVersion);
  if (!compatibility.compatible) {
    throw new NodeEngineCompatibilityError(compatibility);
  }
  return compatibility;
}
