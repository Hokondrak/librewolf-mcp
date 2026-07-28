export type BrowserMode = 'controlled' | 'companion';
export type CapabilityLevel = 'available' | 'degraded' | 'unavailable';

export interface CapabilityState {
  readonly level: CapabilityLevel;
  readonly reason?: string;
}

export interface BrowserCapabilities {
  readonly tabs: CapabilityState;
  readonly snapshots: CapabilityState;
  readonly nativeInput: CapabilityState;
  readonly screenshots: CapabilityState;
  readonly console: CapabilityState;
  readonly network: CapabilityState;
  readonly downloads: CapabilityState;
  readonly upload: CapabilityState;
  readonly batch: CapabilityState;
  readonly deltaSnapshots: CapabilityState;
  readonly screenRecording: CapabilityState;
  readonly highlighting: CapabilityState;
}

export interface StartupDiagnostic {
  readonly stage:
    | 'idle'
    | 'runtime'
    | 'locate'
    | 'profile'
    | 'spawn'
    | 'initialize'
    | 'tool-contract'
    | 'ready'
    | 'shutdown'
    | 'failed';
  readonly ok: boolean;
  readonly at: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface BrowserStatus {
  readonly mode: BrowserMode;
  readonly state: 'idle' | 'starting' | 'ready' | 'failed' | 'closed';
  readonly sessionId: string;
  readonly browserPath?: string;
  readonly profilePath?: string;
  readonly browserVersion?: string;
  readonly selectedTabId?: string;
  readonly capabilities: BrowserCapabilities;
  readonly diagnostics: readonly StartupDiagnostic[];
}

export interface BrowserTab {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly url?: string;
  readonly selected: boolean;
}

export interface SnapshotOptions {
  readonly selector?: string;
  readonly interactiveOnly?: boolean;
  readonly includeText?: boolean;
  readonly includeAttributes?: boolean;
  readonly includeBounds?: boolean;
  readonly maxDepth?: number;
  readonly maxChars?: number;
  readonly maxElements?: number;
  readonly changedSinceSnapshot?: string;
  readonly saveToFile?: string;
}

export interface SnapshotResult {
  readonly snapshotId: string;
  readonly tabId: string;
  readonly navigationGeneration: number;
  readonly mutationGeneration: number;
  readonly text: string;
  readonly elementCount: number;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly savedTo?: string;
  readonly delta?: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly string[];
  };
}

export interface BrowserActionResult {
  readonly ok: true;
  readonly tabId: string;
  readonly navigationGeneration: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface ConsoleFilters {
  readonly severity?: 'debug' | 'info' | 'warn' | 'error';
  readonly text?: string;
  readonly source?: string;
  readonly sinceMs?: number;
  readonly limit?: number;
  readonly errorsOnly?: boolean;
  readonly clearAfterReading?: boolean;
}

export interface NetworkFilters {
  readonly resourceType?: string;
  readonly status?: number;
  readonly statusMin?: number;
  readonly statusMax?: number;
  readonly url?: string;
  readonly method?: string;
  readonly sinceMs?: number;
  readonly errorsOnly?: boolean;
  readonly limit?: number;
  readonly clearAfterReading?: boolean;
}

export interface BrowserBatchAction {
  readonly op: string;
  readonly as?: string;
  readonly [key: string]: unknown;
}

export interface BrowserBatchResult {
  readonly results: readonly {
    readonly index: number;
    readonly op: string;
    readonly ok: boolean;
    readonly value?: unknown;
    readonly error?: unknown;
  }[];
  readonly stoppedAt?: number;
  readonly transportCalls: number;
}

export interface BrowserSession {
  status(): Promise<BrowserStatus>;
  listTabs(): Promise<readonly BrowserTab[]>;
  selectTab(input: {
    tabId?: string;
    index?: number;
    title?: string;
    url?: string;
  }): Promise<BrowserActionResult>;
  openTab(url: string): Promise<BrowserActionResult>;
  closeTab(input: { tabId?: string; index?: number }): Promise<BrowserActionResult>;
  navigate(url: string): Promise<BrowserActionResult>;
  back(): Promise<BrowserActionResult>;
  forward(): Promise<BrowserActionResult>;
  snapshot(options: SnapshotOptions): Promise<SnapshotResult>;
  find(input: { text: string; exact?: boolean; role?: string; limit?: number }): Promise<unknown>;
  getText(input: { uid?: string; selector?: string; maxChars?: number }): Promise<unknown>;
  click(input: { uid: string; doubleClick?: boolean }): Promise<BrowserActionResult>;
  hover(uid: string): Promise<BrowserActionResult>;
  fill(input: { uid: string; value: string }): Promise<BrowserActionResult>;
  fillForm(fields: readonly { uid: string; value: string }[]): Promise<BrowserActionResult>;
  selectOption(input: { uid: string; values: readonly string[] }): Promise<BrowserActionResult>;
  pressKey(input: { key: string; uid?: string }): Promise<BrowserActionResult>;
  scroll(input: {
    uid?: string;
    deltaX?: number;
    deltaY?: number;
    direction?: string;
    amount?: number;
  }): Promise<BrowserActionResult>;
  uploadFile(input: { uid: string; path: string }): Promise<BrowserActionResult>;
  screenshot(input: { uid?: string; path?: string }): Promise<unknown>;
  getConsole(filters: ConsoleFilters): Promise<unknown>;
  getNetwork(filters: NetworkFilters): Promise<unknown>;
  getRequest(input: { requestId: string }): Promise<unknown>;
  getDownloads(input: {
    status?: string;
    url?: string;
    limit?: number;
    clearAfterReading?: boolean;
  }): Promise<unknown>;
  batch(
    actions: readonly BrowserBatchAction[],
    continueOnError?: boolean,
  ): Promise<BrowserBatchResult>;
  close(): Promise<void>;
}
