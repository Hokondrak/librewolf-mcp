import type { JsonValue } from './schemas.js';

const hasLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
};

const serializeString = (value: string): string => {
  if (hasLoneSurrogate(value)) {
    throw new TypeError('Canonical JSON does not permit lone Unicode surrogates.');
  }
  return JSON.stringify(value);
};

const serialize = (value: unknown, ancestors: Set<object>): string => {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('Canonical JSON only supports finite numbers.');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return serializeString(value);
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Canonical JSON cannot encode ${typeof value}.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError('Canonical JSON cannot encode cyclic structures.');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new TypeError('Canonical JSON does not permit sparse arrays or undefined.');
        }
      }
      const entries = value.map((entry) => {
        if (entry === undefined) {
          throw new TypeError('Canonical JSON does not permit sparse arrays or undefined.');
        }
        return serialize(entry, ancestors);
      });
      return `[${entries.join(',')}]`;
    }

    const prototype: object | null = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON only supports plain objects.');
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const fields = keys.map((key) => {
      const field = record[key];
      if (field === undefined) {
        throw new TypeError('Canonical JSON does not permit undefined object values.');
      }
      return `${serializeString(key)}:${serialize(field, ancestors)}`;
    });
    return `{${fields.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
};

export const canonicalJson = (value: JsonValue | unknown): string =>
  serialize(value, new Set<object>());

export const canonicalJsonBytes = (value: JsonValue | unknown): Uint8Array =>
  new TextEncoder().encode(canonicalJson(value));
