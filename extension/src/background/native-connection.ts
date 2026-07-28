import {
  INTERNAL_PROTOCOL_VERSION,
  NATIVE_HOST_NAME,
  isRecord,
  type CompanionCapabilities,
} from '../shared/protocol.js';

export type NativeConnectionState = 'disconnected' | 'connecting' | 'connected' | 'degraded';

export interface NativeConnectionSnapshot {
  state: NativeConnectionState;
  attempt: number;
  lastError?: string;
  serverInstanceId?: string;
}

export class NativeConnection {
  readonly #listeners = new Set<(message: unknown) => void>();
  readonly #statusListeners = new Set<(status: NativeConnectionSnapshot) => void>();
  #port: BrowserNativePort | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #lastPong = 0;
  #attempt = 0;
  #stopped = false;
  #snapshot: NativeConnectionSnapshot = { state: 'disconnected', attempt: 0 };

  constructor(private readonly capabilities: CompanionCapabilities) {}

  start(): void {
    this.#stopped = false;
    this.#connect();
    browser.alarms.create('bridge-reconnect', { periodInMinutes: 1 });
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#port?.disconnect();
    this.#port = undefined;
    void browser.alarms.clear('bridge-reconnect');
    this.#setSnapshot({ state: 'disconnected', attempt: this.#attempt });
  }

  reconnectFromAlarm(): void {
    if (!this.#port && !this.#stopped) this.#connect();
  }

  onMessage(listener: (message: unknown) => void): void {
    this.#listeners.add(listener);
  }

  onStatus(listener: (snapshot: NativeConnectionSnapshot) => void): void {
    this.#statusListeners.add(listener);
  }

  status(): NativeConnectionSnapshot {
    return { ...this.#snapshot };
  }

  send(message: unknown): void {
    if (!this.#port) throw new Error('Native messaging host is disconnected.');
    this.#port.postMessage(message);
  }

  #connect(): void {
    if (this.#stopped || this.#port || this.#snapshot.state === 'connecting') return;
    this.#setSnapshot({ state: 'connecting', attempt: this.#attempt });
    try {
      const port = browser.runtime.connectNative(NATIVE_HOST_NAME);
      this.#port = port;
      this.#lastPong = Date.now();
      port.onMessage.addListener((message) => this.#handleMessage(message));
      port.onDisconnect.addListener(() => this.#handleDisconnect());
      const manifest = browser.runtime.getManifest();
      port.postMessage({
        jsonrpc: '2.0',
        method: 'extension.hello',
        params: {
          protocolVersion: INTERNAL_PROTOCOL_VERSION,
          extensionId: 'librewolf-agent-bridge@librewolf-agent-bridge.org',
          extensionVersion: manifest.version,
          manifestVersion: manifest.manifest_version,
          capabilities: this.capabilities,
        },
      });
      this.#setSnapshot({ state: 'connected', attempt: this.#attempt });
      this.#attempt = 0;
      this.#heartbeat = setInterval(() => this.#tickHeartbeat(), 5_000);
    } catch (error) {
      this.#port = undefined;
      this.#scheduleReconnect(errorMessage(error));
    }
  }

  #handleMessage(message: unknown): void {
    if (isRecord(message) && message['method'] === 'host.pong') {
      this.#lastPong = Date.now();
      return;
    }
    if (isRecord(message) && message['method'] === 'host.status' && isRecord(message['params'])) {
      const params = message['params'];
      const connected = params['connected'] === true;
      const next: NativeConnectionSnapshot = {
        state: connected ? 'connected' : 'degraded',
        attempt: this.#attempt,
        ...(typeof params['error'] === 'string' ? { lastError: params['error'] } : {}),
        ...(typeof params['serverInstanceId'] === 'string'
          ? { serverInstanceId: params['serverInstanceId'] }
          : {}),
      };
      this.#setSnapshot(next);
    }
    for (const listener of this.#listeners) listener(message);
  }

  #handleDisconnect(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    this.#port = undefined;
    const lastError = browser.runtime.lastError?.message ?? this.#snapshot.lastError;
    this.#scheduleReconnect(lastError ?? 'Native messaging host disconnected.');
  }

  #tickHeartbeat(): void {
    if (!this.#port) return;
    if (Date.now() - this.#lastPong > 15_000) {
      this.#port.disconnect();
      return;
    }
    this.#port.postMessage({
      jsonrpc: '2.0',
      method: 'extension.ping',
      params: { at: new Date().toISOString() },
    });
  }

  #scheduleReconnect(message: string): void {
    if (this.#stopped) return;
    this.#attempt += 1;
    const maximum = Math.min(30_000, 250 * 2 ** Math.min(this.#attempt, 7));
    const delay = Math.floor(maximum / 2 + Math.random() * (maximum / 2));
    this.#setSnapshot({
      state: 'disconnected',
      attempt: this.#attempt,
      lastError: message,
    });
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#connect();
    }, delay);
  }

  #setSnapshot(snapshot: NativeConnectionSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#statusListeners) listener({ ...snapshot });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
