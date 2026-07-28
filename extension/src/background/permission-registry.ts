export type PermissionCategory =
  | 'read_page'
  | 'interact'
  | 'download'
  | 'upload_file'
  | 'clipboard_read'
  | 'sensitive_action'
  | 'destructive_action';

export type PermissionDecision =
  'allow_once' | 'allow_session' | 'always_allow' | 'deny_once' | 'always_deny';

export interface PendingPermission {
  requestId: string;
  origin: string;
  originPattern: string;
  categories: PermissionCategory[];
  operation: string;
  hostPermissionRequired: boolean;
  createdAt: number;
  expiresAt: number;
}

export interface PermissionEvaluation {
  allowed: boolean;
  pending?: PendingPermission;
  denial?: 'always_denied' | 'denied_once';
}

export interface PersistedPolicy {
  origin: string;
  category: PermissionCategory;
  decision: 'always_allow' | 'always_deny';
}

export interface PersistedState {
  version: 1;
  policies: PersistedPolicy[];
  session?: {
    serverInstanceId: string;
    grants: Array<{ origin: string; category: PermissionCategory }>;
  };
}

export interface PermissionStorage {
  load(): Promise<PersistedState | undefined>;
  save(state: PersistedState): Promise<void>;
}

const POLICY_KEY = 'bridge.permissions.v1';

export class BrowserPermissionStorage implements PermissionStorage {
  async load(): Promise<PersistedState | undefined> {
    const value = (await browser.storage.local.get(POLICY_KEY))[POLICY_KEY];
    return isPersistedState(value) ? value : undefined;
  }

  async save(state: PersistedState): Promise<void> {
    await browser.storage.local.set({ [POLICY_KEY]: state });
  }
}

export class PermissionRegistry {
  readonly #persistent = new Map<string, 'always_allow' | 'always_deny'>();
  readonly #session = new Set<string>();
  readonly #once = new Map<string, Set<string>>();
  readonly #deniedOnce = new Set<string>();
  readonly #pending = new Map<string, PendingPermission>();
  #serverInstanceId = '';

  constructor(
    private readonly storage: PermissionStorage,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async initialize(serverInstanceId = ''): Promise<void> {
    const state = await this.storage.load();
    const effectiveServerInstanceId = serverInstanceId || state?.session?.serverInstanceId || '';
    this.#persistent.clear();
    this.#session.clear();
    if (state) {
      for (const policy of state.policies) {
        this.#persistent.set(policyKey(policy.origin, policy.category), policy.decision);
      }
      if (
        effectiveServerInstanceId &&
        state.session?.serverInstanceId === effectiveServerInstanceId
      ) {
        for (const grant of state.session.grants) {
          this.#session.add(policyKey(grant.origin, grant.category));
        }
      }
    }
    this.#serverInstanceId = effectiveServerInstanceId;
    await this.#persist();
  }

  async setServerInstance(serverInstanceId: string): Promise<void> {
    if (this.#serverInstanceId === serverInstanceId) return;
    this.#serverInstanceId = serverInstanceId;
    this.#session.clear();
    this.#once.clear();
    this.#pending.clear();
    await this.#persist();
  }

  evaluate(
    requestId: string,
    originInput: string,
    operation: string,
    hostPermissionGranted: boolean,
  ): PermissionEvaluation {
    this.#expire();
    const origin = canonicalHttpOrigin(originInput);
    const categories = categoriesForOperation(operation);

    if (this.#deniedOnce.delete(requestId)) {
      return { allowed: false, denial: 'denied_once' };
    }

    for (const category of categories) {
      const key = policyKey(origin, category);
      if (this.#persistent.get(key) === 'always_deny') {
        return { allowed: false, denial: 'always_denied' };
      }
    }

    const once = this.#once.get(requestId);
    const allAllowed = categories.every((category) => {
      const key = policyKey(origin, category);
      return (
        this.#persistent.get(key) === 'always_allow' ||
        this.#session.has(key) ||
        once?.has(key) === true
      );
    });

    if (allAllowed && hostPermissionGranted) {
      this.#once.delete(requestId);
      this.#pending.delete(requestId);
      return { allowed: true };
    }

    const pending: PendingPermission = {
      requestId,
      origin,
      originPattern: `${origin}/*`,
      categories,
      operation,
      hostPermissionRequired: !hostPermissionGranted,
      createdAt: this.now(),
      expiresAt: this.now() + 60_000,
    };
    this.#pending.set(requestId, pending);
    return { allowed: false, pending };
  }

  can(originInput: string, category: PermissionCategory): boolean {
    const origin = canonicalHttpOrigin(originInput);
    const key = policyKey(origin, category);
    return this.#persistent.get(key) === 'always_allow' || this.#session.has(key);
  }

  listPending(): PendingPermission[] {
    this.#expire();
    return [...this.#pending.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  listPersistent(): PersistedPolicy[] {
    const policies: PersistedPolicy[] = [];
    for (const [key, decision] of this.#persistent) {
      const separator = key.lastIndexOf('|');
      if (separator <= 0) continue;
      const origin = key.slice(0, separator);
      const category = key.slice(separator + 1);
      if (isPermissionCategory(category)) {
        policies.push({ origin, category, decision });
      }
    }
    return policies.sort((a, b) =>
      `${a.origin}|${a.category}`.localeCompare(`${b.origin}|${b.category}`),
    );
  }

  async decide(requestId: string, decision: PermissionDecision): Promise<void> {
    this.#expire();
    const pending = this.#pending.get(requestId);
    if (!pending) throw new Error('Permission request is missing or expired.');
    this.#pending.delete(requestId);

    if (decision === 'deny_once') {
      this.#deniedOnce.add(requestId);
      return;
    }

    for (const category of pending.categories) {
      const key = policyKey(pending.origin, category);
      if (decision === 'allow_once') {
        const grants = this.#once.get(requestId) ?? new Set<string>();
        grants.add(key);
        this.#once.set(requestId, grants);
      } else if (decision === 'allow_session') {
        this.#session.add(key);
      } else {
        this.#persistent.set(key, decision);
      }
    }
    await this.#persist();
  }

  async grantPersistent(originInput: string, category: PermissionCategory): Promise<void> {
    const origin = canonicalHttpOrigin(originInput);
    this.#persistent.set(policyKey(origin, category), 'always_allow');
    await this.#persist();
  }

  async removePersistent(originInput: string, category: PermissionCategory): Promise<void> {
    const origin = canonicalHttpOrigin(originInput);
    this.#persistent.delete(policyKey(origin, category));
    await this.#persist();
  }

  resetTransient(): void {
    this.#session.clear();
    this.#once.clear();
    this.#pending.clear();
    this.#deniedOnce.clear();
  }

  async persist(): Promise<void> {
    await this.#persist();
  }

  #expire(): void {
    const now = this.now();
    for (const [requestId, pending] of this.#pending) {
      if (pending.expiresAt <= now) this.#pending.delete(requestId);
    }
  }

  async #persist(): Promise<void> {
    const policies = this.listPersistent();
    const grants: Array<{ origin: string; category: PermissionCategory }> = [];
    for (const key of this.#session) {
      const separator = key.lastIndexOf('|');
      const origin = key.slice(0, separator);
      const category = key.slice(separator + 1);
      if (separator > 0 && isPermissionCategory(category)) {
        grants.push({ origin, category });
      }
    }
    const state: PersistedState = {
      version: 1,
      policies,
      ...(this.#serverInstanceId
        ? { session: { serverInstanceId: this.#serverInstanceId, grants } }
        : {}),
    };
    await this.storage.save(state);
  }
}

export function canonicalHttpOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Restricted URL scheme: ${url.protocol}`);
  }
  if (url.username || url.password)
    throw new Error('Origins containing credentials are forbidden.');
  return url.origin;
}

export function categoriesForOperation(operation: string): PermissionCategory[] {
  switch (operation) {
    case 'dom.snapshot':
    case 'dom.find':
    case 'dom.getText':
      return ['read_page'];
    case 'dom.click':
    case 'dom.hover':
    case 'dom.fill':
    case 'dom.fillForm':
    case 'dom.selectOption':
    case 'dom.pressKey':
    case 'dom.scroll':
    case 'tabs.select':
    case 'tabs.open':
    case 'tabs.navigate':
    case 'tabs.back':
    case 'tabs.forward':
    case 'page.screenshot':
      return ['interact'];
    case 'tabs.close':
      return ['interact', 'destructive_action'];
    case 'downloads.read':
      return ['download'];
    case 'files.upload':
      return ['upload_file'];
    case 'clipboard.read':
      return ['clipboard_read', 'sensitive_action'];
    default:
      return ['interact'];
  }
}

function policyKey(origin: string, category: PermissionCategory): string {
  return `${origin}|${category}`;
}

function isPermissionCategory(value: string): value is PermissionCategory {
  return [
    'read_page',
    'interact',
    'download',
    'upload_file',
    'clipboard_read',
    'sensitive_action',
    'destructive_action',
  ].includes(value);
}

function isPersistedState(value: unknown): value is PersistedState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<PersistedState>;
  return candidate.version === 1 && Array.isArray(candidate.policies);
}
