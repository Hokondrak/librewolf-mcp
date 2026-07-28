export interface BoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type SelectorStrength = 'strong' | 'weak';

export interface SelectorFingerprint {
  readonly value: string;
  readonly strength: SelectorStrength;
}

export interface MozillaElementMetadata {
  readonly upstreamUid: string;
  readonly frameId?: string;
  readonly selectorFingerprint?: SelectorFingerprint | string;
  readonly elementReference?: unknown;
  readonly elementReferenceKey?: string;
  readonly bounds?: BoundingBox;
  readonly visible?: boolean;
  readonly interactive?: boolean;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
  readonly matchesSelectors?: readonly string[];
}

export interface MozillaCompactSnapshotInput {
  readonly text: string;
  readonly metadata?: readonly MozillaElementMetadata[];
  readonly appliedSelector?: string;
}

export interface ParsedSnapshotElement {
  readonly upstreamUid: string;
  readonly depth: number;
  readonly parentUpstreamUid?: string;
  readonly role: string;
  readonly tag?: string;
  readonly name?: string;
  readonly text?: string;
  readonly value?: string;
  readonly href?: string;
  readonly src?: string;
  readonly states: Readonly<Record<string, string | boolean | number>>;
  readonly metadata?: MozillaElementMetadata;
}

export interface ParsedMozillaSnapshot {
  readonly elements: readonly ParsedSnapshotElement[];
}

export interface SnapshotScope {
  readonly sessionId: string;
  readonly tabId: string;
  readonly frameId: string;
  readonly navigationGeneration: number;
  readonly domGeneration: number;
}

export interface UidResolutionContext {
  readonly sessionId: string;
  readonly tabId: string;
  readonly frameId?: string;
  readonly navigationGeneration: number;
  readonly domGeneration: number;
}

export interface UidElementInput {
  readonly sourceUid: string;
  readonly frameId: string;
  readonly elementReference?: unknown;
  readonly elementReferenceKey?: string;
  readonly selectorFingerprint?: SelectorFingerprint;
}

export interface UidBinding {
  readonly uid: string;
  readonly sourceUid: string;
  readonly scope: SnapshotScope;
  readonly elementReference?: unknown;
  readonly elementReferenceKey?: string;
  readonly selectorFingerprint?: SelectorFingerprint;
}

export interface SnapshotOptions {
  readonly selector?: string;
  readonly interactiveOnly?: boolean;
  readonly includeText?: boolean;
  readonly includeAttributes?: boolean;
  readonly includeBounds?: boolean;
  readonly maxDepth?: number;
  readonly maxChars?: number;
  readonly maxElements?: number;
  readonly changedSinceSnapshot?: string;
  readonly saveToFile?: boolean | string;
}

export interface CompactSnapshotElement {
  readonly uid: string;
  readonly sourceUid: string;
  readonly depth: number;
  readonly role: string;
  readonly tag?: string;
  readonly name?: string;
  readonly text?: string;
  readonly value?: string;
  readonly href?: string;
  readonly frameId: string;
  readonly interactive: boolean;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
  readonly bounds?: BoundingBox;
}

export interface SnapshotDelta {
  readonly baseSnapshotId: string;
  readonly added: readonly CompactSnapshotElement[];
  readonly removed: readonly CompactSnapshotElement[];
  readonly changed: readonly CompactSnapshotElement[];
}

export interface SavedSnapshotFile {
  readonly path: string;
  readonly bytes: number;
}

export interface SnapshotResult {
  readonly snapshotId: string;
  readonly scope: SnapshotScope;
  readonly content: string;
  readonly elements: readonly CompactSnapshotElement[];
  readonly truncated: boolean;
  readonly delta?: SnapshotDelta;
  readonly savedFile?: SavedSnapshotFile;
}

export interface SnapshotSaveRequest {
  readonly destination: boolean | string;
  readonly content: string;
  readonly snapshotId: string;
}

export interface SnapshotSavePolicy {
  save(request: SnapshotSaveRequest): Promise<SavedSnapshotFile>;
}
