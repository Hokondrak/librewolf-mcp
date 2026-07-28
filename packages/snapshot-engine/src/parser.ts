import { SnapshotParseError } from './errors.js';
import type {
  MozillaCompactSnapshotInput,
  MozillaElementMetadata,
  ParsedMozillaSnapshot,
  ParsedSnapshotElement,
  SelectorFingerprint,
} from './types.js';

function tokenize(line: string, lineNumber: number): string[] {
  const tokens: string[] = [];
  let cursor = 0;

  while (cursor < line.length) {
    while (cursor < line.length && /\s/u.test(line[cursor] ?? '')) {
      cursor += 1;
    }
    if (cursor >= line.length) {
      break;
    }

    const start = cursor;
    let quoted = false;
    let escaped = false;
    while (cursor < line.length) {
      const character = line[cursor] ?? '';
      if (escaped) {
        escaped = false;
      } else if (character === '\\' && quoted) {
        escaped = true;
      } else if (character === '"') {
        quoted = !quoted;
      } else if (/\s/u.test(character) && !quoted) {
        break;
      }
      cursor += 1;
    }
    if (quoted) {
      throw new SnapshotParseError('Unterminated quoted value', lineNumber);
    }
    tokens.push(line.slice(start, cursor));
  }
  return tokens;
}

function decodeQuoted(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }
  return value.slice(1, -1).replace(/\\"/gu, '"').replace(/\\\\/gu, '\\');
}

function parseKeyValue(token: string): { key: string; value: string } | null {
  const separator = token.indexOf('=');
  if (separator <= 0) {
    return null;
  }
  return {
    key: token.slice(0, separator),
    value: decodeQuoted(token.slice(separator + 1)),
  };
}

function normalizeMetadata(
  metadata: readonly MozillaElementMetadata[] | undefined,
): Map<string, MozillaElementMetadata> {
  const map = new Map<string, MozillaElementMetadata>();
  for (const item of metadata ?? []) {
    if (map.has(item.upstreamUid)) {
      throw new SnapshotParseError(`Duplicate metadata for UID ${item.upstreamUid}`);
    }
    map.set(item.upstreamUid, item);
  }
  return map;
}

export function classifySelectorFingerprint(selector: string): SelectorFingerprint {
  const value = selector.trim();
  const optionalTag = '(?:[A-Za-z][A-Za-z0-9_-]*)?';
  const strong =
    new RegExp(`^${optionalTag}#[A-Za-z_][\\w:.-]*$`, 'u').test(value) ||
    new RegExp(
      `^${optionalTag}\\[(?:data-testid|data-test-id|data-test|data-qa|name)="[^"]+"\\]$`,
      'u',
    ).test(value) ||
    new RegExp(`^${optionalTag}\\[role="[^"]+"\\]\\[aria-label="[^"]+"\\]$`, 'u').test(value);
  return { value, strength: strong ? 'strong' : 'weak' };
}

export function metadataSelectorFingerprint(
  metadata: MozillaElementMetadata | undefined,
): SelectorFingerprint | undefined {
  const value = metadata?.selectorFingerprint;
  if (typeof value === 'string') {
    return classifySelectorFingerprint(value);
  }
  return value;
}

export function parseMozillaCompactSnapshot(
  input: MozillaCompactSnapshotInput | string,
): ParsedMozillaSnapshot {
  const normalizedInput: MozillaCompactSnapshotInput =
    typeof input === 'string' ? { text: input } : input;
  const metadata = normalizeMetadata(normalizedInput.metadata);
  const elements: ParsedSnapshotElement[] = [];
  const ancestry: string[] = [];
  const seen = new Set<string>();

  const lines = normalizedInput.text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? '';
    if (rawLine.trim() === '') {
      continue;
    }

    const indentation = rawLine.match(/^\s*/u)?.[0] ?? '';
    if (indentation.includes('\t')) {
      throw new SnapshotParseError('Tabs are not valid snapshot indentation', index + 1);
    }
    if (indentation.length % 2 !== 0) {
      throw new SnapshotParseError('Snapshot indentation must use two-space levels', index + 1);
    }
    const depth = indentation.length / 2;
    if (depth > ancestry.length) {
      throw new SnapshotParseError('Snapshot depth skipped a parent level', index + 1);
    }

    const tokens = tokenize(rawLine.trim(), index + 1);
    const uidToken = tokens.shift();
    const role = tokens.shift();
    if (!uidToken?.startsWith('uid=') || !role) {
      throw new SnapshotParseError('Expected "uid=<id> <role>"', index + 1);
    }

    const upstreamUid = uidToken.slice(4);
    if (upstreamUid.length === 0 || seen.has(upstreamUid)) {
      throw new SnapshotParseError(`Invalid or duplicate UID "${upstreamUid}"`, index + 1);
    }
    seen.add(upstreamUid);

    let name: string | undefined;
    let tag: string | undefined;
    let text: string | undefined;
    let value: string | undefined;
    let href: string | undefined;
    let src: string | undefined;
    const states: Record<string, string | boolean | number> = {};

    for (const token of tokens) {
      if (token.startsWith('"') && token.endsWith('"') && name === undefined) {
        name = decodeQuoted(token);
        continue;
      }
      const pair = parseKeyValue(token);
      if (pair) {
        switch (pair.key) {
          case 'tag':
            tag = pair.value;
            break;
          case 'text':
            text = pair.value;
            break;
          case 'value':
            value = pair.value;
            break;
          case 'href':
            href = pair.value;
            break;
          case 'src':
            src = pair.value;
            break;
          case 'level':
            states[pair.key] = Number.isFinite(Number(pair.value))
              ? Number(pair.value)
              : pair.value;
            break;
          default:
            states[pair.key] = pair.value;
        }
        continue;
      }

      switch (token) {
        case 'collapsed':
          states['expanded'] = false;
          break;
        case 'unchecked':
          states['checked'] = false;
          break;
        case 'unpressed':
          states['pressed'] = false;
          break;
        case 'invisible':
          states['visible'] = false;
          break;
        case 'inaccessible':
          states['accessible'] = false;
          break;
        case '[iframe':
        case ']':
          break;
        default:
          states[token] = true;
      }
    }

    const parentUpstreamUid = depth === 0 ? undefined : ancestry[depth - 1];
    const element: ParsedSnapshotElement = {
      upstreamUid,
      depth,
      role,
      states,
      ...(parentUpstreamUid === undefined ? {} : { parentUpstreamUid }),
      ...(tag === undefined ? {} : { tag }),
      ...(name === undefined ? {} : { name }),
      ...(text === undefined ? {} : { text }),
      ...(value === undefined ? {} : { value }),
      ...(href === undefined ? {} : { href }),
      ...(src === undefined ? {} : { src }),
      ...(metadata.has(upstreamUid) ? { metadata: metadata.get(upstreamUid)! } : {}),
    };
    elements.push(element);
    ancestry.length = depth;
    ancestry.push(upstreamUid);
  }

  return { elements };
}
