import { describe, expect, it } from 'vitest';

import {
  PermissionRegistry,
  canonicalHttpOrigin,
  type PermissionStorage,
  type PersistedState,
} from '../src/background/permission-registry.js';

class MemoryStorage implements PermissionStorage {
  state?: PersistedState;

  async load(): Promise<PersistedState | undefined> {
    return this.state ? structuredClone(this.state) : undefined;
  }

  async save(state: PersistedState): Promise<void> {
    this.state = structuredClone(state);
  }
}

describe('PermissionRegistry', () => {
  it('requires an explicit grant and consumes allow-once by request ID', async () => {
    const registry = new PermissionRegistry(new MemoryStorage(), () => 100);
    await registry.initialize('server-a');

    const first = registry.evaluate('request-a', 'https://example.com/page', 'dom.snapshot', true);
    expect(first.allowed).toBe(false);
    expect(first.pending?.origin).toBe('https://example.com');

    await registry.decide('request-a', 'allow_once');
    expect(
      registry.evaluate('request-a', 'https://example.com/other', 'dom.snapshot', true).allowed,
    ).toBe(true);
    expect(
      registry.evaluate('request-b', 'https://example.com/other', 'dom.snapshot', true).allowed,
    ).toBe(false);
  });

  it('does not allow an application policy to replace missing Firefox host access', async () => {
    const registry = new PermissionRegistry(new MemoryStorage());
    await registry.initialize('server-a');
    registry.evaluate('request-a', 'https://example.com', 'dom.snapshot', false);
    await registry.decide('request-a', 'always_allow');

    const result = registry.evaluate('request-b', 'https://example.com', 'dom.snapshot', false);
    expect(result.allowed).toBe(false);
    expect(result.pending?.hostPermissionRequired).toBe(true);
  });

  it('isolates exact origins and ports', async () => {
    const registry = new PermissionRegistry(new MemoryStorage());
    await registry.initialize('server-a');
    registry.evaluate('request-a', 'https://example.com', 'dom.snapshot', true);
    await registry.decide('request-a', 'always_allow');

    expect(registry.can('https://example.com/path', 'read_page')).toBe(true);
    expect(registry.can('https://sub.example.com', 'read_page')).toBe(false);
    expect(registry.can('https://example.com:444', 'read_page')).toBe(false);
    expect(registry.can('https://example.com.evil.test', 'read_page')).toBe(false);
  });

  it('clears session grants when the authenticated server instance changes', async () => {
    const registry = new PermissionRegistry(new MemoryStorage());
    await registry.initialize('server-a');
    registry.evaluate('request-a', 'https://example.com', 'dom.snapshot', true);
    await registry.decide('request-a', 'allow_session');
    expect(registry.can('https://example.com', 'read_page')).toBe(true);

    await registry.setServerInstance('server-b');
    expect(registry.can('https://example.com', 'read_page')).toBe(false);
  });

  it('restores session grants across background event-page suspension', async () => {
    const storage = new MemoryStorage();
    const first = new PermissionRegistry(storage);
    await first.initialize('server-a');
    first.evaluate('request-a', 'https://example.com', 'dom.snapshot', true);
    await first.decide('request-a', 'allow_session');

    const restored = new PermissionRegistry(storage);
    await restored.initialize();
    expect(restored.can('https://example.com', 'read_page')).toBe(true);
    await restored.setServerInstance('server-a');
    expect(restored.can('https://example.com', 'read_page')).toBe(true);
  });

  it('gives persistent denial precedence', async () => {
    const registry = new PermissionRegistry(new MemoryStorage());
    await registry.initialize('server-a');
    registry.evaluate('request-a', 'https://example.com', 'dom.snapshot', true);
    await registry.decide('request-a', 'always_deny');

    const result = registry.evaluate('request-b', 'https://example.com', 'dom.snapshot', true);
    expect(result).toMatchObject({ allowed: false, denial: 'always_denied' });
  });
});

describe('canonicalHttpOrigin', () => {
  it('normalizes default ports and paths', () => {
    expect(canonicalHttpOrigin('https://EXAMPLE.com:443/a')).toBe('https://example.com');
  });

  it('rejects restricted schemes and embedded credentials', () => {
    expect(() => canonicalHttpOrigin('file:///tmp/secret')).toThrow(/Restricted/);
    expect(() => canonicalHttpOrigin('https://user:pass@example.com')).toThrow(/credentials/);
  });
});
