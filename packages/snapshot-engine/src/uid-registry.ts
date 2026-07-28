import { StaleUidError } from './errors.js';
import type {
  SelectorFingerprint,
  SnapshotScope,
  UidBinding,
  UidElementInput,
  UidResolutionContext,
} from './types.js';

interface UidRecord {
  readonly uid: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly frameId: string;
  readonly navigationGeneration: number;
  readonly createdSequence: number;
  sourceUid: string;
  lastSeenDomGeneration: number;
  elementReference?: unknown;
  elementReferenceKey?: string;
  selectorFingerprint?: SelectorFingerprint;
  removed: boolean;
  navigationInvalidated: boolean;
}

export interface RegisterSnapshotOptions {
  readonly complete?: boolean;
}

export interface StableUidRegistryOptions {
  readonly maxRecords?: number;
}

function scopePrefix(scope: SnapshotScope, frameId: string): string {
  return JSON.stringify([scope.sessionId, scope.tabId, frameId, scope.navigationGeneration]);
}

export class StableUidRegistry {
  private readonly records = new Map<string, UidRecord>();
  private readonly identityIndex = new Map<string, string>();
  private readonly objectIds = new WeakMap<object, number>();
  private nextObjectId = 1;
  private nextUid = 1;
  private sequence = 1;
  private readonly maxRecords: number;

  public constructor(options: StableUidRegistryOptions = {}) {
    this.maxRecords = options.maxRecords ?? 10_000;
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1) {
      throw new RangeError('maxRecords must be a positive integer.');
    }
  }

  public registerSnapshot(
    scope: SnapshotScope,
    elements: readonly UidElementInput[],
    options: RegisterSnapshotOptions = {},
  ): readonly UidBinding[] {
    const strongSelectorCounts = new Map<string, number>();
    for (const element of elements) {
      const selector = element.selectorFingerprint;
      if (selector?.strength === 'strong') {
        const key = `${scopePrefix(scope, element.frameId)}:${selector.value}`;
        strongSelectorCounts.set(key, (strongSelectorCounts.get(key) ?? 0) + 1);
      }
    }

    const seen = new Set<string>();
    const bindings: UidBinding[] = [];
    for (const element of elements) {
      const identity = this.identityFor(scope, element, strongSelectorCounts);
      const indexedUid = this.identityIndex.get(identity);
      const indexed = indexedUid ? this.records.get(indexedUid) : undefined;
      const record =
        indexed &&
        !indexed.removed &&
        !indexed.navigationInvalidated &&
        indexed.sessionId === scope.sessionId &&
        indexed.tabId === scope.tabId &&
        indexed.frameId === element.frameId &&
        indexed.navigationGeneration === scope.navigationGeneration
          ? indexed
          : this.createRecord(scope, element, identity);

      record.sourceUid = element.sourceUid;
      record.lastSeenDomGeneration = scope.domGeneration;
      record.removed = false;
      if (element.elementReference !== undefined) {
        record.elementReference = element.elementReference;
      }
      if (element.elementReferenceKey !== undefined) {
        record.elementReferenceKey = element.elementReferenceKey;
      }
      if (element.selectorFingerprint !== undefined) {
        record.selectorFingerprint = element.selectorFingerprint;
      }
      seen.add(record.uid);
      bindings.push(this.toBinding(record));
    }

    if (options.complete !== false) {
      for (const record of this.records.values()) {
        if (
          record.sessionId === scope.sessionId &&
          record.tabId === scope.tabId &&
          record.navigationGeneration === scope.navigationGeneration &&
          record.lastSeenDomGeneration < scope.domGeneration &&
          !seen.has(record.uid)
        ) {
          record.removed = true;
        }
      }
    }

    this.prune();
    return bindings;
  }

  public resolve(uid: string, context: UidResolutionContext): UidBinding {
    const record = this.records.get(uid);
    if (!record) {
      throw new StaleUidError('UID_UNKNOWN', uid, `UID "${uid}" is unknown or expired.`);
    }
    if (record.sessionId !== context.sessionId) {
      throw new StaleUidError('UID_STALE_SESSION', uid, `UID "${uid}" belongs to another session.`);
    }
    if (record.tabId !== context.tabId) {
      throw new StaleUidError('UID_STALE_TAB', uid, `UID "${uid}" belongs to another tab.`);
    }
    if (context.frameId !== undefined && record.frameId !== context.frameId) {
      throw new StaleUidError('UID_STALE_FRAME', uid, `UID "${uid}" belongs to another frame.`);
    }
    if (
      record.navigationInvalidated ||
      record.navigationGeneration !== context.navigationGeneration
    ) {
      throw new StaleUidError(
        'UID_STALE_NAVIGATION',
        uid,
        `UID "${uid}" was invalidated by navigation.`,
      );
    }
    if (record.removed) {
      throw new StaleUidError(
        'UID_STALE_REMOVED',
        uid,
        `UID "${uid}" no longer identifies a present element.`,
      );
    }
    if (record.lastSeenDomGeneration !== context.domGeneration) {
      throw new StaleUidError(
        'UID_STALE_DOM',
        uid,
        `UID "${uid}" has not been verified in the current DOM generation.`,
      );
    }
    return this.toBinding(record);
  }

  public invalidateNavigation(
    sessionId: string,
    tabId: string,
    newNavigationGeneration: number,
  ): void {
    for (const record of this.records.values()) {
      if (
        record.sessionId === sessionId &&
        record.tabId === tabId &&
        record.navigationGeneration < newNavigationGeneration
      ) {
        record.navigationInvalidated = true;
      }
    }
  }

  public clearTab(sessionId: string, tabId: string): void {
    for (const [uid, record] of this.records) {
      if (record.sessionId === sessionId && record.tabId === tabId) {
        this.records.delete(uid);
      }
    }
    this.rebuildIdentityIndex();
  }

  public clearSession(sessionId: string): void {
    for (const [uid, record] of this.records) {
      if (record.sessionId === sessionId) {
        this.records.delete(uid);
      }
    }
    this.rebuildIdentityIndex();
  }

  private identityFor(
    scope: SnapshotScope,
    element: UidElementInput,
    strongSelectorCounts: ReadonlyMap<string, number>,
  ): string {
    const prefix = scopePrefix(scope, element.frameId);
    if (element.elementReferenceKey) {
      return `${prefix}:reference-key:${element.elementReferenceKey}`;
    }
    if (
      typeof element.elementReference === 'string' ||
      typeof element.elementReference === 'number'
    ) {
      return `${prefix}:reference:${String(element.elementReference)}`;
    }
    if (typeof element.elementReference === 'object' && element.elementReference !== null) {
      let objectId = this.objectIds.get(element.elementReference);
      if (objectId === undefined) {
        objectId = this.nextObjectId;
        this.nextObjectId += 1;
        this.objectIds.set(element.elementReference, objectId);
      }
      return `${prefix}:object:${objectId}`;
    }

    const selector = element.selectorFingerprint;
    if (selector?.strength === 'strong') {
      const selectorCountKey = `${prefix}:${selector.value}`;
      if (strongSelectorCounts.get(selectorCountKey) === 1) {
        return `${prefix}:selector:${selector.value}`;
      }
    }

    return `${prefix}:ephemeral:${scope.domGeneration}:${element.sourceUid}`;
  }

  private createRecord(
    scope: SnapshotScope,
    element: UidElementInput,
    identity: string,
  ): UidRecord {
    const uid = `lw${this.nextUid.toString(36)}`;
    this.nextUid += 1;
    const record: UidRecord = {
      uid,
      sessionId: scope.sessionId,
      tabId: scope.tabId,
      frameId: element.frameId,
      navigationGeneration: scope.navigationGeneration,
      sourceUid: element.sourceUid,
      lastSeenDomGeneration: scope.domGeneration,
      removed: false,
      navigationInvalidated: false,
      createdSequence: this.sequence,
      ...(element.elementReference === undefined
        ? {}
        : { elementReference: element.elementReference }),
      ...(element.elementReferenceKey === undefined
        ? {}
        : { elementReferenceKey: element.elementReferenceKey }),
      ...(element.selectorFingerprint === undefined
        ? {}
        : { selectorFingerprint: element.selectorFingerprint }),
    };
    this.sequence += 1;
    this.records.set(uid, record);
    this.identityIndex.set(identity, uid);
    return record;
  }

  private toBinding(record: UidRecord): UidBinding {
    return {
      uid: record.uid,
      sourceUid: record.sourceUid,
      scope: {
        sessionId: record.sessionId,
        tabId: record.tabId,
        frameId: record.frameId,
        navigationGeneration: record.navigationGeneration,
        domGeneration: record.lastSeenDomGeneration,
      },
      ...(record.elementReference === undefined
        ? {}
        : { elementReference: record.elementReference }),
      ...(record.elementReferenceKey === undefined
        ? {}
        : { elementReferenceKey: record.elementReferenceKey }),
      ...(record.selectorFingerprint === undefined
        ? {}
        : { selectorFingerprint: record.selectorFingerprint }),
    };
  }

  private prune(): void {
    if (this.records.size <= this.maxRecords) {
      return;
    }
    const ordered = [...this.records.values()].sort(
      (left, right) => left.createdSequence - right.createdSequence,
    );
    const removeCount = this.records.size - this.maxRecords;
    for (const record of ordered.slice(0, removeCount)) {
      this.records.delete(record.uid);
    }
    this.rebuildIdentityIndex();
  }

  private rebuildIdentityIndex(): void {
    for (const [identity, uid] of this.identityIndex) {
      if (!this.records.has(uid)) {
        this.identityIndex.delete(identity);
      }
    }
  }
}
