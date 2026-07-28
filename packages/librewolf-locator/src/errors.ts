import type {
  LibreWolfDiscoveryDiagnostic,
  NodeEngineCompatibility,
  ProfileOwnerMetadata,
} from './types.js';

export type LibreWolfDiscoveryErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'INVALID_MANUAL_PATH'
  | 'INVALID_ENVIRONMENT_PATH'
  | 'LIBREWOLF_NOT_FOUND';

export class LibreWolfDiscoveryError extends Error {
  public override readonly name = 'LibreWolfDiscoveryError';

  public constructor(
    public readonly code: LibreWolfDiscoveryErrorCode,
    message: string,
    public readonly diagnostics: readonly LibreWolfDiscoveryDiagnostic[],
  ) {
    super(message);
  }
}

export class NodeEngineCompatibilityError extends Error {
  public override readonly name = 'NodeEngineCompatibilityError';

  public constructor(public readonly compatibility: NodeEngineCompatibility) {
    super(compatibility.message);
  }
}

export class ProfileInUseError extends Error {
  public override readonly name = 'ProfileInUseError';
  public readonly code = 'PROFILE_IN_USE';

  public constructor(
    message: string,
    public readonly owner: ProfileOwnerMetadata | null,
  ) {
    super(message);
  }
}

export class UnsafeProfilePathError extends Error {
  public override readonly name = 'UnsafeProfilePathError';
  public readonly code = 'UNSAFE_PROFILE_PATH';
}

export class ProfileOwnershipError extends Error {
  public override readonly name = 'ProfileOwnershipError';
  public readonly code = 'PROFILE_OWNERSHIP_MISMATCH';
}
