export type StaleUidErrorCode =
  | 'UID_UNKNOWN'
  | 'UID_STALE_SESSION'
  | 'UID_STALE_TAB'
  | 'UID_STALE_FRAME'
  | 'UID_STALE_NAVIGATION'
  | 'UID_STALE_DOM'
  | 'UID_STALE_REMOVED';

export class StaleUidError extends Error {
  public override readonly name = 'StaleUidError';
  public readonly recoverable = true;

  public constructor(
    public readonly code: StaleUidErrorCode,
    public readonly uid: string,
    message: string,
  ) {
    super(`${message} Take a new browser snapshot and retry with a current UID.`);
  }
}

export class SnapshotParseError extends Error {
  public override readonly name = 'SnapshotParseError';
  public readonly code = 'SNAPSHOT_PARSE_ERROR';

  public constructor(
    message: string,
    public readonly line?: number,
  ) {
    super(line === undefined ? message : `${message} (line ${line})`);
  }
}

export class SnapshotDeltaError extends Error {
  public override readonly name = 'SnapshotDeltaError';
  public readonly code = 'SNAPSHOT_DELTA_UNAVAILABLE';
}

export class SnapshotPolicyError extends Error {
  public override readonly name = 'SnapshotPolicyError';
  public readonly code = 'SNAPSHOT_SAVE_DENIED';
}

export class SnapshotOptionError extends Error {
  public override readonly name = 'SnapshotOptionError';
  public readonly code = 'INVALID_SNAPSHOT_OPTIONS';
}
