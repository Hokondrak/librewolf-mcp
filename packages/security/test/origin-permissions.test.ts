import { describe, expect, it } from 'vitest';

import {
  InvalidOriginError,
  OPERATION_RISK_REGISTRY,
  PermissionManager,
  canonicalizeHostname,
  canonicalizeOrigin,
  getOperationRisk,
  isSameOrigin,
} from '../src/index.js';

describe('origin canonicalization', () => {
  it.each([
    ['HTTPS://Example.COM:443/path?q=1#x', 'https://example.com'],
    ['http://Example.COM:80/', 'http://example.com'],
    ['https://Example.COM.:8443/path', 'https://example.com:8443'],
    ['https://bücher.example/path', 'https://xn--bcher-kva.example'],
    ['http://[2001:db8::1]:8080/path', 'http://[2001:db8::1]:8080'],
  ])('canonicalizes %s', (input, expected) => {
    expect(canonicalizeOrigin(input)).toBe(expected);
  });

  it('extracts normalized IPv6 and IDNA hostnames', () => {
    expect(canonicalizeHostname('https://bücher.example')).toBe('xn--bcher-kva.example');
    expect(canonicalizeHostname('http://[::1]:3000')).toBe('::1');
  });

  it('compares scheme, host, and effective port', () => {
    expect(isSameOrigin('https://EXAMPLE.com:443/a', 'https://example.com/b')).toBe(true);
    expect(isSameOrigin('http://example.com', 'https://example.com')).toBe(false);
    expect(isSameOrigin('https://example.com', 'https://example.com:444')).toBe(false);
  });

  it.each([
    '/relative',
    'javascript:alert(1)',
    'file:///tmp/test',
    'https://user:secret@example.com',
    'https://.',
  ])('rejects unsafe or invalid origin %s', (input) => {
    expect(() => canonicalizeOrigin(input)).toThrow(InvalidOriginError);
  });
});

describe('operation risk registry', () => {
  it('covers the public MCP operations and exposes immutable descriptors', () => {
    expect(Object.keys(OPERATION_RISK_REGISTRY)).toHaveLength(25);
    expect(getOperationRisk('browser_snapshot')).toMatchObject({
      risk: 'read',
      readOnly: true,
      permissions: ['page-content'],
    });
    expect(getOperationRisk('browser_close_tab')).toMatchObject({
      destructive: true,
      requiresUserConfirmation: true,
    });
    expect(getOperationRisk('unknown')).toBeUndefined();
    expect(Object.isFrozen(OPERATION_RISK_REGISTRY)).toBe(true);
  });
});

describe('PermissionManager', () => {
  const origin = 'https://Example.COM:443/account';

  it('defaults to ask and consumes a once grant', () => {
    const manager = new PermissionManager({ now: () => 1_000 });
    expect(manager.evaluate(origin, 'interaction')).toMatchObject({ effect: 'ask' });
    manager.setPermission({
      origin,
      category: 'interaction',
      effect: 'allow',
      scope: 'once',
    });
    expect(manager.evaluate(origin, 'interaction')).toMatchObject({
      effect: 'allow',
      scope: 'once',
      origin: 'https://example.com',
    });
    expect(manager.evaluate(origin, 'interaction')).toMatchObject({ effect: 'ask' });
  });

  it('applies deny-before-allow and scope precedence', () => {
    const manager = new PermissionManager({ now: () => 1_000 });
    manager.setPermission({
      origin,
      category: 'page-content',
      effect: 'allow',
      scope: 'always',
    });
    manager.setPermission({
      origin,
      category: 'page-content',
      effect: 'allow',
      scope: 'session',
      sessionId: 'session-1',
    });
    manager.setPermission({
      origin,
      category: 'page-content',
      effect: 'deny',
      scope: 'once',
      sessionId: 'session-1',
    });

    expect(
      manager.evaluate(origin, 'page-content', {
        sessionId: 'session-1',
        consume: false,
      }),
    ).toMatchObject({ effect: 'deny', scope: 'once' });
    expect(
      manager.evaluate(origin, 'page-content', {
        sessionId: 'session-2',
        consume: false,
      }),
    ).toMatchObject({ effect: 'allow', scope: 'always' });

    manager.setPermission({
      origin,
      category: 'page-content',
      effect: 'deny',
      scope: 'always',
    });
    expect(
      manager.evaluate(origin, 'page-content', {
        sessionId: 'session-1',
        consume: false,
      }),
    ).toMatchObject({ effect: 'deny', scope: 'always' });
  });

  it('expires rules and clears session grants deterministically', () => {
    let now = 1_000;
    const manager = new PermissionManager({ now: () => now, onceTtlMs: 100 });
    manager.setPermission({
      origin,
      category: 'download',
      effect: 'allow',
      scope: 'once',
    });
    now = 1_101;
    expect(manager.evaluate(origin, 'download')).toMatchObject({ effect: 'ask' });

    manager.setPermission({
      origin,
      category: 'upload',
      effect: 'allow',
      scope: 'session',
      sessionId: 'session-1',
    });
    expect(manager.clearSession('session-1')).toBe(1);
    expect(manager.evaluate(origin, 'upload', { sessionId: 'session-1' })).toMatchObject({
      effect: 'ask',
    });
  });

  it('exports and imports only persistent domain decisions', () => {
    const source = new PermissionManager({ now: () => 1_000 });
    source.setPermission({
      origin,
      category: 'sensitive-action',
      effect: 'deny',
      scope: 'always',
    });
    source.setPermission({
      origin,
      category: 'interaction',
      effect: 'allow',
      scope: 'session',
      sessionId: 'session-1',
    });
    const persistent = source.exportPersistentPermissions();
    expect(persistent).toHaveLength(1);

    const target = new PermissionManager({ now: () => 2_000 });
    target.importPersistentPermissions(persistent);
    expect(target.evaluate(origin, 'sensitive-action')).toMatchObject({
      effect: 'deny',
      scope: 'always',
    });
  });

  it('replaces an earlier decision at the same scope and freezes rules', () => {
    const manager = new PermissionManager({ now: () => 1_000 });
    const allowed = manager.setPermission({
      origin,
      category: 'interaction',
      effect: 'allow',
      scope: 'always',
    });
    expect(Object.isFrozen(allowed)).toBe(true);
    manager.setPermission({
      origin,
      category: 'interaction',
      effect: 'deny',
      scope: 'always',
    });
    expect(manager.listPermissions()).toHaveLength(1);
    expect(manager.evaluate(origin, 'interaction')).toMatchObject({
      effect: 'deny',
      scope: 'always',
    });
  });
});
