export const REDACTED = '[REDACTED]' as const;

const sensitiveNames = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'passphrase',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'xapikey',
  'xauthtoken',
  'csrf',
  'csrftoken',
  'session',
  'sessionid',
  'creditcard',
  'cardnumber',
  'cvv',
]);

const normalizeName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/gu, '');

export const isSensitiveFieldName = (name: string): boolean => {
  const normalized = normalizeName(name);
  return (
    sensitiveNames.has(normalized) ||
    normalized.endsWith('password') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('token') ||
    normalized.endsWith('apikey')
  );
};

const redactString = (value: string): string =>
  value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/._~=-]+/giu, `$1 ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu, REDACTED)
    .replace(
      /\b(password|passwd|passphrase|secret|access[_-]?token|refresh[_-]?token|api[_-]?key)\s*([:=])\s*([^\s&,;]+)/giu,
      (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
    );

export type HeaderInput =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>
  | Iterable<readonly [string, string]>;

export const redactHeaders = (headers: HeaderInput): Record<string, string | readonly string[]> => {
  const result: Record<string, string | readonly string[]> = {};
  const add = (name: string, value: string | readonly string[]): void => {
    result[name] = isSensitiveFieldName(name)
      ? REDACTED
      : typeof value === 'string'
        ? redactString(value)
        : value.map(redactString);
  };

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, name) => {
      add(name, value);
    });
  } else if (Symbol.iterator in Object(headers)) {
    for (const [name, value] of headers as Iterable<readonly [string, string]>) {
      add(name, value);
    }
  } else {
    for (const [name, value] of Object.entries(
      headers as Readonly<Record<string, string | readonly string[] | undefined>>,
    )) {
      if (value !== undefined) {
        add(name, value);
      }
    }
  }
  return result;
};

export const redactUrl = (input: string | URL): string => {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch {
    return redactString(String(input));
  }
  if (url.username !== '') {
    url.username = REDACTED;
  }
  if (url.password !== '') {
    url.password = REDACTED;
  }
  for (const name of [...url.searchParams.keys()]) {
    const values = url.searchParams.getAll(name);
    url.searchParams.delete(name);
    for (const value of values) {
      url.searchParams.append(name, isSensitiveFieldName(name) ? REDACTED : redactString(value));
    }
  }
  url.hash = redactString(url.hash);
  return url.toString();
};

const redactUnknown = (
  value: unknown,
  sensitive: boolean,
  seen: WeakSet<object>,
  depth: number,
): unknown => {
  if (sensitive) {
    return REDACTED;
  }
  if (depth > 32) {
    return '[REDACTED: maximum depth exceeded]';
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'undefined'
  ) {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    return REDACTED;
  }
  if (value instanceof Uint8Array) {
    return `[REDACTED: ${value.byteLength} binary bytes]`;
  }
  if (value instanceof URL) {
    return redactUrl(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (seen.has(value)) {
    return '[REDACTED: circular reference]';
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redactUnknown(entry, false, seen, depth + 1));
    }
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [
        name,
        redactUnknown(entry, isSensitiveFieldName(name), seen, depth + 1),
      ]),
    );
  } finally {
    seen.delete(value);
  }
};

export const redactSecrets = (value: unknown): unknown =>
  redactUnknown(value, false, new WeakSet<object>(), 0);

export const redactBody = (body: unknown): unknown => {
  if (typeof body !== 'string') {
    return redactSecrets(body);
  }
  const trimmed = body.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.stringify(redactSecrets(JSON.parse(body) as unknown));
    } catch {
      // Fall through to plain-text redaction.
    }
  }
  if (trimmed.includes('=') && !trimmed.includes('\n')) {
    try {
      const form = new URLSearchParams(trimmed);
      for (const name of [...form.keys()]) {
        const values = form.getAll(name);
        form.delete(name);
        for (const value of values) {
          form.append(name, isSensitiveFieldName(name) ? REDACTED : redactString(value));
        }
      }
      return form.toString();
    } catch {
      // Fall through to plain-text redaction.
    }
  }
  return redactString(body);
};

export const redactFormValues = (
  values: Readonly<Record<string, unknown>>,
  additionalSensitiveFields: Iterable<string> = [],
): Record<string, unknown> => {
  const additional = new Set([...additionalSensitiveFields].map(normalizeName));
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      isSensitiveFieldName(name) || additional.has(normalizeName(name))
        ? REDACTED
        : redactSecrets(value),
    ]),
  );
};
