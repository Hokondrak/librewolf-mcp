import {
  AuthenticatedFrameBodySchema,
  AuthenticatedFrameSchema,
  canonicalJsonBytes,
  type AuthenticatedFrame,
  type AuthenticatedFrameBody,
  type StructuredErrorCode,
} from '@librewolf-agent-bridge/protocol';

import { constantTimeEqual, generateNonce, hmacSha256, type SecretInput } from './crypto.js';

const frameMac = (body: AuthenticatedFrameBody, key: SecretInput): string =>
  Buffer.from(hmacSha256(key, canonicalJsonBytes(body))).toString('base64url');

export const signAuthenticatedFrame = (
  body: AuthenticatedFrameBody,
  key: SecretInput,
): AuthenticatedFrame => {
  const parsed = AuthenticatedFrameBodySchema.parse(body);
  return {
    ...parsed,
    mac: frameMac(parsed, key),
  };
};

export interface CreateAuthenticatedFrameOptions {
  readonly protocolVersion?: '1.0';
  readonly sessionId: string;
  readonly sequence: number;
  readonly message: AuthenticatedFrameBody['message'];
  readonly key: SecretInput;
  readonly timestamp?: string;
  readonly nonce?: string;
}

export const createAuthenticatedFrame = (
  options: CreateAuthenticatedFrameOptions,
): AuthenticatedFrame =>
  signAuthenticatedFrame(
    {
      protocolVersion: options.protocolVersion ?? '1.0',
      sessionId: options.sessionId,
      sequence: options.sequence,
      timestamp: options.timestamp ?? new Date().toISOString(),
      nonce: options.nonce ?? generateNonce(),
      message: options.message,
    },
    options.key,
  );

export type FrameVerificationErrorCode = Extract<
  StructuredErrorCode,
  | 'AUTHENTICATION_FAILED'
  | 'INVALID_REQUEST'
  | 'PROTOCOL_MISMATCH'
  | 'REPLAY_DETECTED'
  | 'SEQUENCE_ERROR'
>;

export class FrameVerificationError extends Error {
  public readonly code: FrameVerificationErrorCode;
  public readonly recoverable: boolean;

  public constructor(code: FrameVerificationErrorCode, message: string, recoverable = false) {
    super(message);
    this.name = 'FrameVerificationError';
    this.code = code;
    this.recoverable = recoverable;
  }
}

export interface FrameVerifierOptions {
  readonly expectedSessionId: string;
  readonly firstSequence?: number;
  readonly maxClockSkewMs?: number;
  readonly nonceWindowSize?: number;
  readonly now?: () => number;
}

export class FrameVerifier {
  readonly #key: SecretInput;
  readonly #expectedSessionId: string;
  readonly #maxClockSkewMs: number;
  readonly #nonceWindowSize: number;
  readonly #now: () => number;
  #nextSequence: number;
  readonly #nonceWindow = new Set<string>();
  readonly #nonceOrder: string[] = [];

  public constructor(key: SecretInput, options: FrameVerifierOptions) {
    const firstSequence = options.firstSequence ?? 0;
    const maxClockSkewMs = options.maxClockSkewMs ?? 5 * 60_000;
    const nonceWindowSize = options.nonceWindowSize ?? 4_096;
    if (!Number.isSafeInteger(firstSequence) || firstSequence < 0) {
      throw new RangeError('firstSequence must be a non-negative safe integer.');
    }
    if (!Number.isSafeInteger(maxClockSkewMs) || maxClockSkewMs < 0) {
      throw new RangeError('maxClockSkewMs must be a non-negative safe integer.');
    }
    if (!Number.isSafeInteger(nonceWindowSize) || nonceWindowSize <= 0) {
      throw new RangeError('nonceWindowSize must be a positive safe integer.');
    }
    this.#key = typeof key === 'string' ? key : key.slice();
    this.#expectedSessionId = options.expectedSessionId;
    this.#nextSequence = firstSequence;
    this.#maxClockSkewMs = maxClockSkewMs;
    this.#nonceWindowSize = nonceWindowSize;
    this.#now = options.now ?? Date.now;
  }

  public get nextSequence(): number {
    return this.#nextSequence;
  }

  public verify(input: unknown): AuthenticatedFrame {
    const parsedResult = AuthenticatedFrameSchema.safeParse(input);
    if (!parsedResult.success) {
      throw new FrameVerificationError(
        'INVALID_REQUEST',
        `Authenticated frame schema validation failed: ${parsedResult.error.message}`,
      );
    }
    const frame = parsedResult.data;
    if (frame.sessionId !== this.#expectedSessionId) {
      throw new FrameVerificationError(
        'AUTHENTICATION_FAILED',
        'Frame belongs to a different session.',
      );
    }
    const { mac, ...body } = frame;
    const expectedMac = hmacSha256(this.#key, canonicalJsonBytes(body));
    let suppliedMac: Uint8Array;
    try {
      suppliedMac = Buffer.from(mac, 'base64url');
    } catch {
      throw new FrameVerificationError(
        'AUTHENTICATION_FAILED',
        'Frame MAC is not valid base64url.',
      );
    }
    if (!constantTimeEqual(expectedMac, suppliedMac)) {
      throw new FrameVerificationError('AUTHENTICATION_FAILED', 'Frame MAC is invalid.');
    }

    const timestamp = Date.parse(frame.timestamp);
    if (!Number.isFinite(timestamp) || Math.abs(this.#now() - timestamp) > this.#maxClockSkewMs) {
      throw new FrameVerificationError(
        'AUTHENTICATION_FAILED',
        'Frame timestamp is outside the accepted clock-skew window.',
        true,
      );
    }
    if (this.#nonceWindow.has(frame.nonce) || frame.sequence < this.#nextSequence) {
      throw new FrameVerificationError(
        'REPLAY_DETECTED',
        'Frame sequence or nonce has already been accepted.',
      );
    }
    if (frame.sequence !== this.#nextSequence) {
      throw new FrameVerificationError(
        'SEQUENCE_ERROR',
        `Expected frame sequence ${this.#nextSequence}, received ${frame.sequence}.`,
        true,
      );
    }

    this.#rememberNonce(frame.nonce);
    this.#nextSequence += 1;
    return frame;
  }

  public reset(firstSequence = 0): void {
    if (!Number.isSafeInteger(firstSequence) || firstSequence < 0) {
      throw new RangeError('firstSequence must be a non-negative safe integer.');
    }
    this.#nextSequence = firstSequence;
    this.#nonceWindow.clear();
    this.#nonceOrder.length = 0;
  }

  #rememberNonce(nonce: string): void {
    this.#nonceWindow.add(nonce);
    this.#nonceOrder.push(nonce);
    if (this.#nonceOrder.length > this.#nonceWindowSize) {
      const removed = this.#nonceOrder.shift();
      if (removed !== undefined) {
        this.#nonceWindow.delete(removed);
      }
    }
  }
}
