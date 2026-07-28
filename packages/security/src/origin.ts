export class InvalidOriginError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidOriginError';
  }
}

export interface CanonicalizeOriginOptions {
  readonly allowedProtocols?: readonly string[];
}

const normalizedProtocol = (protocol: string): string =>
  protocol.endsWith(':') ? protocol.toLowerCase() : `${protocol.toLowerCase()}:`;

const parseOrigin = (input: string | URL, options: CanonicalizeOriginOptions = {}): URL => {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch {
    throw new InvalidOriginError('Origin must be an absolute, valid URL.');
  }
  const allowed = (options.allowedProtocols ?? ['http:', 'https:']).map(normalizedProtocol);
  if (!allowed.includes(url.protocol)) {
    throw new InvalidOriginError(`Origin protocol ${url.protocol} is not allowed.`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new InvalidOriginError('Origins containing credentials are not allowed.');
  }
  if (url.hostname === '') {
    throw new InvalidOriginError('Origin must include a hostname.');
  }
  return url;
};

export const canonicalizeOrigin = (
  input: string | URL,
  options: CanonicalizeOriginOptions = {},
): string => {
  const url = parseOrigin(input, options);
  const hostname = url.hostname.endsWith('.') ? url.hostname.slice(0, -1) : url.hostname;
  if (hostname === '') {
    throw new InvalidOriginError('Origin hostname cannot be empty.');
  }
  const port = url.port === '' ? '' : `:${url.port}`;
  return `${url.protocol}//${hostname.toLowerCase()}${port}`;
};

export const canonicalizeHostname = (
  input: string | URL,
  options: CanonicalizeOriginOptions = {},
): string => {
  const canonical = new URL(canonicalizeOrigin(input, options));
  const hostname = canonical.hostname;
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
};

export const isSameOrigin = (
  left: string | URL,
  right: string | URL,
  options: CanonicalizeOriginOptions = {},
): boolean => canonicalizeOrigin(left, options) === canonicalizeOrigin(right, options);
