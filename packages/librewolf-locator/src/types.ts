export type LibreWolfDiscoveryStage =
  'manual' | 'environment' | 'registry' | 'common-paths' | 'path';

export type LibreWolfDiscoveryStatus =
  'selected' | 'not-configured' | 'not-found' | 'invalid' | 'error';

export interface LibreWolfDiscoveryDiagnostic {
  readonly stage: LibreWolfDiscoveryStage;
  readonly status: LibreWolfDiscoveryStatus;
  readonly message: string;
  readonly candidate?: string;
  readonly cause?: string;
}

export interface RegistryCandidate {
  readonly path: string;
  readonly key: string;
}

export interface LibreWolfRegistryProvider {
  getCandidates(): Promise<readonly RegistryCandidate[]>;
}

export interface FileInspection {
  readonly exists: boolean;
  readonly isFile: boolean;
  readonly resolvedPath?: string;
}

export interface LocatorFileSystem {
  inspect(path: string): Promise<FileInspection>;
}

export interface LibreWolfLocatorOptions {
  readonly manualPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly registryProvider?: LibreWolfRegistryProvider;
  readonly fileSystem?: LocatorFileSystem;
  readonly commonPaths?: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly pathDelimiter?: string;
  readonly executableNames?: readonly string[];
}

export interface LibreWolfDiscoveryResult {
  readonly executablePath: string;
  readonly source: LibreWolfDiscoveryStage;
  readonly diagnostics: readonly LibreWolfDiscoveryDiagnostic[];
}

export interface NodeEngineCompatibility {
  readonly compatible: boolean;
  readonly currentVersion: string;
  readonly minimumVersion: string;
  readonly message: string;
}

export interface ProfileOwnerMetadata {
  readonly schemaVersion: 1;
  readonly ownerId: string;
  readonly pid: number;
  readonly acquiredAt: string;
  readonly profileName: string;
  readonly parentDirectory: string;
  readonly effectiveDirectory: string;
}

export interface ProcessInspector {
  isAlive(pid: number): boolean;
}

export interface Clock {
  now(): Date;
}

export interface ProfileManagerOptions {
  readonly rootDirectory: string;
  readonly processInspector?: ProcessInspector;
  readonly clock?: Clock;
  readonly ownerIdFactory?: () => string;
  readonly staleLockMs?: number;
}

export interface AcquireProfileOptions {
  readonly pid?: number;
}

export interface ReleaseProfileOptions {
  readonly removeProfile?: boolean;
}
