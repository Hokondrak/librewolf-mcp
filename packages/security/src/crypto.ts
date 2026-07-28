import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export type SecretInput = string | Uint8Array;

const asBytes = (value: SecretInput): Uint8Array =>
  typeof value === 'string' ? new TextEncoder().encode(value) : value;

const concatBytes = (...values: readonly Uint8Array[]): Uint8Array => {
  const length = values.reduce((total, value) => total + value.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
};

export const generateSessionToken = (bytes = 32): string => {
  if (!Number.isSafeInteger(bytes) || bytes < 32 || bytes > 1_024) {
    throw new RangeError('Session tokens must contain between 32 and 1024 random bytes.');
  }
  return randomBytes(bytes).toString('base64url');
};

export const generateNonce = (bytes = 16): string => {
  if (!Number.isSafeInteger(bytes) || bytes < 16 || bytes > 1_024) {
    throw new RangeError('Nonces must contain between 16 and 1024 random bytes.');
  }
  return randomBytes(bytes).toString('base64url');
};

export const hmacSha256 = (key: SecretInput, data: SecretInput): Uint8Array =>
  new Uint8Array(createHmac('sha256', asBytes(key)).update(asBytes(data)).digest());

export const hmacSha256Base64Url = (key: SecretInput, data: SecretInput): string =>
  Buffer.from(hmacSha256(key, data)).toString('base64url');

export const hkdfSha256 = (
  inputKeyMaterial: SecretInput,
  salt: SecretInput,
  info: SecretInput,
  length = 32,
): Uint8Array => {
  if (!Number.isSafeInteger(length) || length <= 0 || length > 255 * 32) {
    throw new RangeError('HKDF output length must be between 1 and 8160 bytes.');
  }
  return new Uint8Array(
    hkdfSync('sha256', asBytes(inputKeyMaterial), asBytes(salt), asBytes(info), length),
  );
};

export const deriveSessionKey = (
  sessionToken: SecretInput,
  clientNonce: SecretInput,
  serverNonce: SecretInput,
): Uint8Array => {
  const separator = new Uint8Array([0]);
  const salt = createHash('sha256')
    .update(concatBytes(asBytes(clientNonce), separator, asBytes(serverNonce)))
    .digest();
  return hkdfSha256(sessionToken, salt, 'librewolf-agent-bridge authenticated frames v1', 32);
};

export const constantTimeEqual = (left: SecretInput, right: SecretInput): boolean => {
  const leftBytes = asBytes(left);
  const rightBytes = asBytes(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    // Do comparable cryptographic work even when lengths differ.
    const leftDigest = createHash('sha256').update(leftBytes).digest();
    const rightDigest = createHash('sha256').update(rightBytes).digest();
    timingSafeEqual(leftDigest, rightDigest);
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
};
