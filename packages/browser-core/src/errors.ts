export type BrowserErrorCode =
  | 'BROWSER_NOT_FOUND'
  | 'BROWSER_LAUNCH_FAILED'
  | 'BROWSER_CONNECTION_FAILED'
  | 'BROWSER_TOOL_CONTRACT_MISMATCH'
  | 'CAPABILITY_UNAVAILABLE'
  | 'INVALID_ARGUMENT'
  | 'INVALID_TAB'
  | 'PERMISSION_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'STALE_REFERENCE'
  | 'ACTION_BLOCKED'
  | 'TIMEOUT'
  | 'OUTCOME_UNKNOWN'
  | 'UPSTREAM_ERROR'
  | 'SHUTDOWN';

export interface BrowserErrorDetails {
  readonly stage?: string;
  readonly recoverable?: boolean;
  readonly hint?: string;
  readonly cause?: string;
  readonly [key: string]: unknown;
}

export class BrowserBridgeError extends Error {
  public readonly code: BrowserErrorCode;
  public readonly details: BrowserErrorDetails;

  public constructor(code: BrowserErrorCode, message: string, details: BrowserErrorDetails = {}) {
    super(message);
    this.name = 'BrowserBridgeError';
    this.code = code;
    this.details = details;
  }

  public toJSON(): {
    code: BrowserErrorCode;
    message: string;
    details: BrowserErrorDetails;
  } {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export const asBridgeError = (
  error: unknown,
  fallbackCode: BrowserErrorCode = 'UPSTREAM_ERROR',
): BrowserBridgeError => {
  if (error instanceof BrowserBridgeError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new BrowserBridgeError(fallbackCode, message, {
    ...(error instanceof Error && error.stack ? { cause: error.stack } : {}),
  });
};
