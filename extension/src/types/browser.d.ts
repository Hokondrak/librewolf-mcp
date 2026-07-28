type BrowserListener<T> = {
  addListener(listener: T): void;
};

interface BrowserNativePort {
  onMessage: BrowserListener<(message: unknown) => void>;
  onDisconnect: BrowserListener<() => void>;
  postMessage(message: unknown): void;
  disconnect(): void;
}

interface BrowserRuntime {
  lastError?: { message?: string };
  onMessage: BrowserListener<
    (message: unknown, sender: BrowserMessageSender) => unknown | Promise<unknown>
  >;
  onStartup: BrowserListener<() => void>;
  connectNative(application: string): BrowserNativePort;
  getManifest(): { version: string; manifest_version: number };
  sendMessage(message: unknown): Promise<unknown>;
  openOptionsPage(): Promise<void>;
}

interface BrowserMessageSender {
  tab?: BrowserTab;
  frameId?: number;
}

interface BrowserTab {
  id?: number;
  windowId?: number;
  active?: boolean;
  highlighted?: boolean;
  pinned?: boolean;
  title?: string;
  url?: string;
  status?: string;
}

interface BrowserTabs {
  query(query: Record<string, unknown>): Promise<BrowserTab[]>;
  get(tabId: number): Promise<BrowserTab>;
  update(tabId: number, properties: Record<string, unknown>): Promise<BrowserTab>;
  create(properties: Record<string, unknown>): Promise<BrowserTab>;
  remove(tabId: number): Promise<void>;
  goBack(tabId: number): Promise<void>;
  goForward(tabId: number): Promise<void>;
  sendMessage(tabId: number, message: unknown, options?: { frameId?: number }): Promise<unknown>;
  captureVisibleTab(windowId?: number, options?: Record<string, unknown>): Promise<string>;
  onUpdated: BrowserListener<
    (tabId: number, changeInfo: Record<string, unknown>, tab: BrowserTab) => void
  >;
  onRemoved: BrowserListener<(tabId: number) => void>;
}

interface BrowserStorageArea {
  get(keys?: string | string[] | Record<string, unknown>): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

interface BrowserPermissions {
  contains(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
  request(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
  remove(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
  getAll(): Promise<{ origins?: string[]; permissions?: string[] }>;
  onRemoved: BrowserListener<(permissions: { origins?: string[]; permissions?: string[] }) => void>;
}

interface BrowserScripting {
  executeScript(injection: {
    target: { tabId: number; frameIds?: number[] };
    files: string[];
  }): Promise<unknown[]>;
}

interface BrowserAlarms {
  create(name: string, alarmInfo: Record<string, unknown>): void;
  clear(name: string): Promise<boolean>;
  onAlarm: BrowserListener<(alarm: { name: string }) => void>;
}

interface BrowserAction {
  setBadgeText(details: { text: string }): Promise<void>;
  setBadgeBackgroundColor(details: { color: string }): Promise<void>;
}

interface BrowserApi {
  runtime: BrowserRuntime;
  tabs: BrowserTabs;
  storage: { local: BrowserStorageArea };
  permissions: BrowserPermissions;
  scripting: BrowserScripting;
  alarms: BrowserAlarms;
  action?: BrowserAction;
  browserAction?: BrowserAction;
}

declare const browser: BrowserApi;
