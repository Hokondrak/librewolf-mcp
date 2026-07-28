import {
  PermissionCategorySchema,
  PermissionScopeSchema,
  type PermissionCategory,
  type PermissionEffect,
  type PermissionScope,
} from '@librewolf-agent-bridge/protocol';

import { canonicalizeOrigin } from './origin.js';

type StoredPermissionEffect = Exclude<PermissionEffect, 'ask'>;

export interface PermissionRule {
  readonly id: string;
  readonly origin: string;
  readonly category: PermissionCategory;
  readonly effect: StoredPermissionEffect;
  readonly scope: PermissionScope;
  readonly sessionId?: string;
  readonly createdAt: number;
  readonly expiresAt?: number;
}

export interface SetPermissionInput {
  readonly origin: string | URL;
  readonly category: PermissionCategory;
  readonly effect: StoredPermissionEffect;
  readonly scope: PermissionScope;
  readonly sessionId?: string;
  readonly expiresAt?: number | Date;
}

export interface EvaluatePermissionOptions {
  readonly sessionId?: string;
  readonly consume?: boolean;
}

export interface PermissionEvaluation {
  readonly effect: PermissionEffect;
  readonly origin: string;
  readonly category: PermissionCategory;
  readonly scope?: PermissionScope;
  readonly ruleId?: string;
  readonly reason: string;
}

export interface PermissionManagerOptions {
  readonly now?: () => number;
  readonly onceTtlMs?: number;
}

const scopeRank: Readonly<Record<PermissionScope, number>> = {
  once: 1,
  session: 2,
  always: 3,
};

const isFiniteTimestamp = (value: number): boolean =>
  Number.isFinite(value) && Number.isSafeInteger(value) && value >= 0;

export class PermissionManager {
  readonly #now: () => number;
  readonly #onceTtlMs: number;
  readonly #rules = new Map<string, PermissionRule>();
  #nextId = 1;

  public constructor(options: PermissionManagerOptions = {}) {
    const onceTtlMs = options.onceTtlMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(onceTtlMs) || onceTtlMs <= 0) {
      throw new RangeError('onceTtlMs must be a positive safe integer.');
    }
    this.#now = options.now ?? Date.now;
    this.#onceTtlMs = onceTtlMs;
  }

  public get size(): number {
    this.purgeExpired();
    return this.#rules.size;
  }

  public setPermission(input: SetPermissionInput): PermissionRule {
    const origin = canonicalizeOrigin(input.origin);
    const category = PermissionCategorySchema.parse(input.category);
    const scope = PermissionScopeSchema.parse(input.scope);
    if (input.effect !== 'allow' && input.effect !== 'deny') {
      throw new TypeError('Permission effect must be allow or deny.');
    }
    if (scope === 'session' && (input.sessionId === undefined || input.sessionId === '')) {
      throw new TypeError('Session-scoped permissions require a non-empty sessionId.');
    }
    if (scope === 'always' && input.sessionId !== undefined) {
      throw new TypeError('Always-scoped permissions cannot be bound to a session.');
    }

    const now = this.#now();
    let expiresAt: number | undefined;
    if (input.expiresAt instanceof Date) {
      expiresAt = input.expiresAt.getTime();
    } else {
      expiresAt = input.expiresAt;
    }
    if (expiresAt === undefined && scope === 'once') {
      expiresAt = now + this.#onceTtlMs;
    }
    if (expiresAt !== undefined && (!isFiniteTimestamp(expiresAt) || expiresAt <= now)) {
      throw new RangeError('Permission expiry must be a future timestamp.');
    }

    this.purgeExpired();
    for (const [id, existing] of this.#rules) {
      if (
        existing.origin === origin &&
        existing.category === category &&
        existing.scope === scope &&
        existing.sessionId === input.sessionId
      ) {
        this.#rules.delete(id);
      }
    }

    const id = `permission-${this.#nextId}`;
    this.#nextId += 1;
    const rule: PermissionRule = Object.freeze({
      id,
      origin,
      category,
      effect: input.effect,
      scope,
      createdAt: now,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    this.#rules.set(id, rule);
    return rule;
  }

  public evaluate(
    originInput: string | URL,
    categoryInput: PermissionCategory,
    options: EvaluatePermissionOptions = {},
  ): PermissionEvaluation {
    const origin = canonicalizeOrigin(originInput);
    const category = PermissionCategorySchema.parse(categoryInput);
    this.purgeExpired();
    const candidates = [...this.#rules.values()].filter(
      (rule) =>
        rule.origin === origin &&
        rule.category === category &&
        (rule.scope !== 'session' || rule.sessionId === options.sessionId) &&
        (rule.scope !== 'once' ||
          rule.sessionId === undefined ||
          rule.sessionId === options.sessionId),
    );

    // A live explicit denial always outranks a grant. Among denials, broader
    // choices rank first; among grants, the narrowest choice ranks first.
    candidates.sort((left, right) => {
      if (left.effect !== right.effect) {
        return left.effect === 'deny' ? -1 : 1;
      }
      const rankDifference =
        left.effect === 'deny'
          ? scopeRank[right.scope] - scopeRank[left.scope]
          : scopeRank[left.scope] - scopeRank[right.scope];
      return rankDifference === 0 ? right.createdAt - left.createdAt : rankDifference;
    });

    const selected = candidates[0];
    if (selected === undefined) {
      return {
        effect: 'ask',
        origin,
        category,
        reason: 'No matching permission has been granted or denied.',
      };
    }
    if (selected.scope === 'once' && options.consume !== false) {
      this.#rules.delete(selected.id);
    }
    return {
      effect: selected.effect,
      origin,
      category,
      scope: selected.scope,
      ruleId: selected.id,
      reason: `${selected.effect === 'allow' ? 'Allowed' : 'Denied'} by ${
        selected.scope
      } permission.`,
    };
  }

  public revoke(ruleId: string): boolean {
    return this.#rules.delete(ruleId);
  }

  public clearSession(sessionId: string): number {
    let removed = 0;
    for (const [id, rule] of this.#rules) {
      if (rule.sessionId === sessionId) {
        this.#rules.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  public purgeExpired(): number {
    const now = this.#now();
    let removed = 0;
    for (const [id, rule] of this.#rules) {
      if (rule.expiresAt !== undefined && rule.expiresAt <= now) {
        this.#rules.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  public listPermissions(): readonly PermissionRule[] {
    this.purgeExpired();
    return [...this.#rules.values()];
  }

  public exportPersistentPermissions(): readonly PermissionRule[] {
    this.purgeExpired();
    return [...this.#rules.values()].filter((rule) => rule.scope === 'always');
  }

  public importPersistentPermissions(rules: readonly PermissionRule[]): void {
    for (const rule of rules) {
      if (rule.scope !== 'always' || rule.sessionId !== undefined) {
        throw new TypeError('Only session-independent always permissions can be imported.');
      }
      this.setPermission({
        origin: rule.origin,
        category: rule.category,
        effect: rule.effect,
        scope: rule.scope,
        ...(rule.expiresAt === undefined ? {} : { expiresAt: rule.expiresAt }),
      });
    }
  }
}
