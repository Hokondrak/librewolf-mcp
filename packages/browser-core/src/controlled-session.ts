import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  DedicatedProfileManager,
  type ProfileLease,
} from '@librewolf-agent-bridge/librewolf-locator';
import {
  REDACTED,
  isSensitiveFieldName,
  redactBody,
  redactSecrets,
} from '@librewolf-agent-bridge/security';
import {
  FileSnapshotSavePolicy,
  SnapshotEngine,
  StaleUidError,
  classifySelectorFingerprint,
  parseMozillaCompactSnapshot,
  type CompactSnapshotElement,
  type MozillaElementMetadata,
  type ParsedSnapshotElement,
  type SnapshotResult as EngineSnapshotResult,
} from '@librewolf-agent-bridge/snapshot-engine';

import { executeBrowserBatch } from './batch.js';
import { BrowserBridgeError, asBridgeError } from './errors.js';
import type {
  BrowserActionResult,
  BrowserBatchAction,
  BrowserBatchResult,
  BrowserCapabilities,
  BrowserSession,
  BrowserStatus,
  BrowserTab,
  ConsoleFilters,
  NetworkFilters,
  SnapshotOptions,
  SnapshotResult,
  StartupDiagnostic,
} from './types.js';
import {
  MozillaUpstreamClient,
  type MozillaUpstreamOptions,
  type UpstreamCallResult,
} from './upstream.js';

interface TabState {
  id: string;
  index: number;
  title: string;
  url?: string;
  selected: boolean;
  navigationGeneration: number;
  domGeneration: number;
}

export interface ControlledBrowserSessionOptions {
  readonly browserPath: string;
  readonly browserVersion?: string;
  readonly profileRoot: string;
  readonly profileName?: string;
  readonly outputDirectory: string;
  readonly allowedOutputRoots?: readonly string[];
  readonly nodePath?: string;
  readonly headless?: boolean;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly startUrl?: string;
  readonly preferences?: Readonly<Record<string, string | number | boolean>>;
  readonly removeProfileOnClose?: boolean;
  /**
   * Attach to a LibreWolf the user already started rather than launching a dedicated profile.
   * Keeps their signed-in session while still using WebDriver BiDi, so input stays native and
   * console and network capture keep working. The bridge takes no profile lease in this mode.
   */
  readonly connectExisting?: boolean;
  readonly marionettePort?: number;
  readonly windowsJobSupervisorPath?: string;
  readonly upstreamFactory?: (options: MozillaUpstreamOptions) => MozillaUpstreamClient;
}

export interface ScreenshotResult {
  readonly mimeType: 'image/png';
  readonly bytes: number;
  readonly data?: string;
  readonly savedTo?: string;
}

export interface LocalTelemetrySummary {
  readonly totalOperations: number;
  readonly operations: Readonly<
    Record<string, { count: number; meanMs: number; maxMs: number; errors: number }>
  >;
}

const CONTROLLED_CAPABILITIES: BrowserCapabilities = {
  tabs: { level: 'available' },
  snapshots: { level: 'available' },
  nativeInput: {
    level: 'degraded',
    reason:
      'click_fill_hover_upload_are_native; key_select_scroll_use_bounded_bidi_script_fallback',
  },
  screenshots: { level: 'available' },
  console: { level: 'available' },
  network: { level: 'available' },
  downloads: { level: 'available' },
  upload: { level: 'available' },
  batch: { level: 'available' },
  deltaSnapshots: { level: 'available' },
  screenRecording: {
    level: 'unavailable',
    reason: 'upstream_screencast_requires_firefox_154_or_newer',
  },
  highlighting: {
    level: 'degraded',
    reason: 'native_hover_updates_pointer_state_but_no_persistent_browser_overlay',
  },
};

const parseJsonText = (result: UpstreamCallResult): unknown => {
  try {
    return JSON.parse(result.text) as unknown;
  } catch {
    const fenced = result.text.match(/```json\s*([\s\S]*?)\s*```/u)?.[1];
    if (fenced) {
      try {
        return JSON.parse(fenced) as unknown;
      } catch {
        // Keep the original upstream text when its fenced payload is not JSON.
      }
    }
    return result.text;
  }
};

interface SafeFieldMetadata {
  readonly type?: string;
  readonly name?: string;
  readonly autocomplete?: string;
}

const isSafeFieldMetadata = (value: unknown): value is SafeFieldMetadata => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((field) => field === undefined || typeof field === 'string');
};

const isSensitiveFormField = (
  element: ParsedSnapshotElement,
  metadata: SafeFieldMetadata | undefined,
): boolean => {
  if (metadata?.type?.toLocaleLowerCase('en-US') === 'password') {
    return true;
  }
  const autocomplete = metadata?.autocomplete?.toLocaleLowerCase('en-US') ?? '';
  if (
    autocomplete === 'current-password' ||
    autocomplete === 'new-password' ||
    autocomplete === 'one-time-code' ||
    autocomplete.startsWith('cc-')
  ) {
    return true;
  }
  return [element.name, metadata?.name]
    .filter((value): value is string => Boolean(value))
    .some(isSensitiveFieldName);
};

const redactSnapshotValues = (text: string, sensitiveUpstreamUids: ReadonlySet<string>): string =>
  text
    .split(/\r?\n/u)
    .map((line) => {
      const upstreamUid = line.match(/^\s*uid=([^\s]+)\s+/u)?.[1];
      if (!upstreamUid || !sensitiveUpstreamUids.has(upstreamUid)) {
        return line;
      }
      return line.replace(/\bvalue="(?:\\.|[^"\\])*"/gu, `value="${REDACTED}"`);
    })
    .join('\n');

const parseTabs = (
  text: string,
): readonly Omit<TabState, 'id' | 'url' | 'navigationGeneration' | 'domGeneration'>[] => {
  const tabs: Omit<TabState, 'id' | 'url' | 'navigationGeneration' | 'domGeneration'>[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s*(>)?\[(\d+)\]\s+(.+?)\s*$/u);
    if (!match?.[2] || !match[3]) {
      continue;
    }
    tabs.push({
      index: Number.parseInt(match[2], 10),
      title: match[3],
      selected: match[1] === '>',
    });
  }
  return tabs;
};

const extractIndex = (text: string): number | undefined => {
  const match = text.match(/\[(\d+)\]/u);
  return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
};

const extractSnapshotBody = (
  text: string,
): { readonly text: string; readonly sourceTruncated: boolean } => {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^\s*uid=[^\s]+\s+/u.test(line));
  if (start < 0) {
    throw new BrowserBridgeError(
      'UPSTREAM_ERROR',
      'Mozilla returned a snapshot without any parseable elements.',
      {
        stage: 'snapshot',
        preview: text.slice(0, 1_000),
      },
    );
  }
  const body: string[] = [];
  let sourceTruncated = /\[(?:DOM truncated|maxLines capped:)/u.test(text);
  for (const line of lines.slice(start)) {
    if (/^\s*\[\+\d+\s+lines,\s+use maxLines/u.test(line)) {
      sourceTruncated = true;
      break;
    }
    if (line.trim() !== '') {
      body.push(line);
    }
  }
  return { text: body.join('\n'), sourceTruncated };
};

const selectorFromResolution = (uid: string, text: string): string | undefined => {
  const prefix = `${uid} → `;
  if (!text.startsWith(prefix)) {
    return undefined;
  }
  const selector = text.slice(prefix.length).trim();
  return selector.length > 0 ? selector : undefined;
};

const isInsideOrEqual = (root: string, path: string): boolean => {
  const relation = relative(root, path);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
};

/**
 * Field names whose value is a serialized payload rather than a plain scalar. Generic
 * redaction only sees such a value as one opaque string, so `{"password":"..."}` survives it.
 * These fields are handed to `redactBody`, which decodes JSON and form encodings first.
 */
const payloadFieldNames = new Set([
  'body',
  'bodytext',
  'requestbody',
  'responsebody',
  'postdata',
  'postbody',
  'payload',
  'requestpayload',
  'responsepayload',
  'formdata',
  'requestpostdata',
]);

const normalizeFieldName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/gu, '');

const redactParsed = (value: unknown, depth = 0): unknown => {
  if (depth > 32) {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactParsed(entry, depth + 1));
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    !(value instanceof Date) &&
    !(value instanceof URL) &&
    !(value instanceof Uint8Array)
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => {
        if (isSensitiveFieldName(name)) {
          return [name, REDACTED];
        }
        if (payloadFieldNames.has(normalizeFieldName(name))) {
          return [name, redactBody(entry)];
        }
        return [name, redactParsed(entry, depth + 1)];
      }),
    );
  }
  return redactSecrets(value);
};

const normalizeNavigationUrl = (value: string): string => {
  try {
    return new URL(value).href;
  } catch {
    return value;
  }
};

export class ControlledBrowserSession implements BrowserSession {
  private readonly options: ControlledBrowserSessionOptions;
  private readonly profileManager: DedicatedProfileManager;
  private readonly snapshotEngine: SnapshotEngine;
  private readonly sessionId = randomUUID();
  private readonly diagnostics: StartupDiagnostic[] = [];
  private readonly tabs = new Map<string, TabState>();
  private readonly latestSnapshots = new Map<string, EngineSnapshotResult>();
  private readonly metrics = new Map<
    string,
    { count: number; totalMs: number; maxMs: number; errors: number }
  >();
  private upstream: MozillaUpstreamClient | undefined;
  private profileLease: ProfileLease | undefined;
  private selectedTabId: string | undefined;
  private state: BrowserStatus['state'] = 'idle';
  private tabSequence = 1;
  private networkClearedAt: number | undefined;
  private browserVersion: string | undefined;
  private closing = false;

  public constructor(options: ControlledBrowserSessionOptions) {
    this.options = options;
    this.browserVersion = options.browserVersion;
    this.profileManager = new DedicatedProfileManager({
      rootDirectory: options.profileRoot,
    });
    this.snapshotEngine = new SnapshotEngine({
      savePolicy: new FileSnapshotSavePolicy({
        rootDirectory: options.outputDirectory,
        allowedAbsoluteRoots: [process.cwd(), ...(options.allowedOutputRoots ?? [])],
        overwrite: false,
      }),
      maxHistory: 20,
    });
    this.addDiagnostic('idle', true, 'Controlled session configured.', {
      browserPath: options.browserPath,
      profileRoot: options.profileRoot,
    });
  }

  public async status(): Promise<BrowserStatus> {
    return {
      // Attached sessions use the same BiDi stack but join a browser the user owns, so the
      // client must be able to tell the two apart.
      mode: this.options.connectExisting ? 'attached' : 'controlled',
      state: this.state,
      sessionId: this.sessionId,
      browserPath: this.options.browserPath,
      ...(this.profileLease ? { profilePath: this.profileLease.effectiveDirectory } : {}),
      ...(this.browserVersion ? { browserVersion: this.browserVersion } : {}),
      ...(this.selectedTabId ? { selectedTabId: this.selectedTabId } : {}),
      capabilities: CONTROLLED_CAPABILITIES,
      diagnostics: [...this.diagnostics, ...(this.upstream?.diagnostics ?? [])],
    };
  }

  public async listTabs(): Promise<readonly BrowserTab[]> {
    return this.measure('list_tabs', async () => {
      const result = await this.upstreamCall('list_pages', {}, true);
      this.reconcileTabs(parseTabs(result.text));
      return this.tabList();
    });
  }

  public async selectTab(input: {
    tabId?: string;
    index?: number;
    title?: string;
    url?: string;
  }): Promise<BrowserActionResult> {
    return this.measure('select_tab', async () => {
      await this.ensureStarted();
      const tab = this.resolveTab(input);
      await this.upstreamCall('select_page', { pageIdx: tab.index }, false);
      for (const candidate of this.tabs.values()) {
        candidate.selected = candidate.id === tab.id;
      }
      this.selectedTabId = tab.id;
      return this.action(`Selected tab ${tab.id}.`);
    });
  }

  public async openTab(url: string): Promise<BrowserActionResult> {
    return this.measure('open_tab', async () => {
      const result = await this.upstreamCall('new_page', { url }, false);
      const index = extractIndex(result.text);
      if (index === undefined) {
        throw new BrowserBridgeError(
          'UPSTREAM_ERROR',
          'Mozilla did not return the new tab index.',
          {
            stage: 'tabs',
            result: result.text,
          },
        );
      }
      for (const tab of this.tabs.values()) {
        tab.selected = false;
      }
      const tab: TabState = {
        id: this.nextTabId(),
        index,
        title: 'Untitled',
        url,
        selected: true,
        navigationGeneration: 1,
        domGeneration: 0,
      };
      this.tabs.set(tab.id, tab);
      this.selectedTabId = tab.id;
      await this.refreshTabsBestEffort();
      return this.action(`Opened ${url}.`, { tabId: tab.id, index });
    });
  }

  public async closeTab(input: { tabId?: string; index?: number }): Promise<BrowserActionResult> {
    return this.measure('close_tab', async () => {
      await this.ensureStarted();
      const tab = this.resolveTab(input);
      await this.upstreamCall('close_page', { pageIdx: tab.index }, false);
      this.tabs.delete(tab.id);
      this.latestSnapshots.delete(tab.id);
      for (const candidate of this.tabs.values()) {
        if (candidate.index > tab.index) {
          candidate.index -= 1;
        }
      }
      if (this.selectedTabId === tab.id) {
        this.selectedTabId = undefined;
      }
      await this.refreshTabsBestEffort();
      return {
        ok: true,
        tabId: tab.id,
        navigationGeneration: tab.navigationGeneration,
        message: `Closed tab ${tab.id}.`,
      };
    });
  }

  public async navigate(url: string): Promise<BrowserActionResult> {
    return this.measure('navigate', async () => {
      const tab = await this.requireSelectedTab();
      if (tab.url === url) {
        throw new BrowserBridgeError(
          'INVALID_ARGUMENT',
          'The selected tab is already at this URL; refusing an upstream same-URL navigation that may time out.',
          {
            stage: 'navigation',
            recoverable: true,
            hint: 'Use browser_snapshot, or navigate to a distinct URL.',
          },
        );
      }
      let recoveredFromTimeout = false;
      try {
        await this.upstreamCall('navigate_page', { url }, false);
      } catch (error) {
        const bridgeError = asBridgeError(error);
        if (
          bridgeError.code !== 'TIMEOUT' ||
          (await this.currentUrlBestEffort()) !== normalizeNavigationUrl(url)
        ) {
          throw bridgeError;
        }
        recoveredFromTimeout = true;
      }
      this.invalidateNavigation(tab, url);
      await this.refreshTabsBestEffort();
      return this.action(
        recoveredFromTimeout
          ? `Navigated to ${url}; completion was verified after an upstream timeout.`
          : `Navigated to ${url}.`,
      );
    });
  }

  public async back(): Promise<BrowserActionResult> {
    return this.navigateHistory('back');
  }

  public async forward(): Promise<BrowserActionResult> {
    return this.navigateHistory('forward');
  }

  public async snapshot(options: SnapshotOptions): Promise<SnapshotResult> {
    return this.measure('snapshot', async () => {
      const tab = await this.requireSelectedTab();
      const upstreamArguments = (
        selector: string | undefined,
      ): Readonly<Record<string, unknown>> => ({
        maxLines: Math.min(Math.max((options.maxElements ?? 500) * 3, 100), 5_000),
        includeAttributes: options.includeAttributes ?? false,
        includeText: options.includeText ?? true,
        ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
        ...(selector ? { selector } : {}),
      });

      let source: UpstreamCallResult;
      try {
        source = await this.upstreamCall(
          'take_snapshot',
          upstreamArguments(options.selector),
          true,
        );
      } catch (error) {
        // The pinned upstream fails on every selector except `body`, so a scoped request that
        // errors is reported as the capability gap it is rather than as a page problem.
        if (options.selector !== undefined) {
          throw new BrowserBridgeError(
            'CAPABILITY_UNAVAILABLE',
            `Scoped snapshots are unavailable: @mozilla/firefox-devtools-mcp@0.9.15 fails for every selector except "body". Retake browser_snapshot without "selector" and narrow the result with interactive_only, max_elements, or max_depth.`,
            {
              stage: 'snapshot',
              recoverable: true,
              selector: options.selector,
              cause: asBridgeError(error).message,
            },
          );
        }
        throw error;
      }
      tab.domGeneration += 1;
      const normalizedSource = extractSnapshotBody(source.text);
      const parsed = parseMozillaCompactSnapshot({ text: normalizedSource.text });
      const fieldMetadata = await this.inspectSafeFieldMetadata(parsed.elements);
      const sensitiveUpstreamUids = new Set(
        parsed.elements
          .filter((element) =>
            isSensitiveFormField(element, fieldMetadata.get(element.upstreamUid)),
          )
          .map((element) => element.upstreamUid),
      );
      const redactedSourceText = String(
        redactSecrets(redactSnapshotValues(normalizedSource.text, sensitiveUpstreamUids)),
      );
      const redactedParsed = parseMozillaCompactSnapshot({ text: redactedSourceText });
      const selectorFingerprints = await this.resolveStrongSelectors(redactedParsed.elements);
      const metadata: readonly MozillaElementMetadata[] = redactedParsed.elements.map((element) => {
        const selectorFingerprint = selectorFingerprints.get(element.upstreamUid);
        const safeFieldMetadata = fieldMetadata.get(element.upstreamUid);
        return {
          upstreamUid: element.upstreamUid,
          frameId: 'top',
          ...(selectorFingerprint ? { selectorFingerprint } : {}),
          ...(safeFieldMetadata
            ? {
                attributes: {
                  ...(safeFieldMetadata.type ? { type: safeFieldMetadata.type } : {}),
                  ...(safeFieldMetadata.name ? { name: safeFieldMetadata.name } : {}),
                  ...(safeFieldMetadata.autocomplete
                    ? { autocomplete: safeFieldMetadata.autocomplete }
                    : {}),
                },
              }
            : {}),
          interactive:
            element.states['interactive'] === true || element.states['focusable'] === true,
          visible: element.states['hidden'] !== true && element.states['invisible'] !== true,
        };
      });
      const engineResult = await this.snapshotEngine.createSnapshot(
        {
          text: redactedSourceText,
          metadata,
          ...(options.selector ? { appliedSelector: options.selector } : {}),
        },
        {
          sessionId: this.sessionId,
          tabId: tab.id,
          frameId: 'top',
          navigationGeneration: tab.navigationGeneration,
          domGeneration: tab.domGeneration,
        },
        {
          ...(options.selector ? { selector: options.selector } : {}),
          ...(options.interactiveOnly !== undefined
            ? { interactiveOnly: options.interactiveOnly }
            : {}),
          ...(options.includeText !== undefined ? { includeText: options.includeText } : {}),
          ...(options.includeAttributes !== undefined
            ? { includeAttributes: options.includeAttributes }
            : {}),
          ...(options.includeBounds !== undefined ? { includeBounds: options.includeBounds } : {}),
          ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
          ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
          ...(options.maxElements !== undefined ? { maxElements: options.maxElements } : {}),
          ...(options.changedSinceSnapshot
            ? { changedSinceSnapshot: options.changedSinceSnapshot }
            : {}),
          ...(options.saveToFile ? { saveToFile: options.saveToFile } : {}),
        },
      );
      this.latestSnapshots.set(tab.id, engineResult);
      // Notices sit outside the untrusted boundary: they are bridge facts, not page content.
      // Without them a depth-truncated tree looks complete and the model reports missing
      // content as absent rather than unread.
      const content = normalizedSource.sourceTruncated
        ? `WARNING: the browser reached its snapshot size limit, so the end of this page is missing rather than absent. Treat it as unread, not empty. Narrow the request with interactive_only or max_elements, or scroll and retake.\n${engineResult.content}`
        : engineResult.content;
      return {
        snapshotId: engineResult.snapshotId,
        tabId: tab.id,
        navigationGeneration: tab.navigationGeneration,
        mutationGeneration: tab.domGeneration,
        text: content,
        elementCount: engineResult.elements.length,
        bytes: Buffer.byteLength(content, 'utf8'),
        truncated: engineResult.truncated || normalizedSource.sourceTruncated,
        ...(engineResult.savedFile ? { savedTo: engineResult.savedFile.path } : {}),
        ...(engineResult.delta
          ? {
              delta: {
                added: engineResult.delta.added.map((element) => element.uid),
                removed: engineResult.delta.removed.map((element) => element.uid),
                changed: engineResult.delta.changed.map((element) => element.uid),
              },
            }
          : {}),
      };
    });
  }

  public async find(input: {
    text: string;
    exact?: boolean;
    role?: string;
    limit?: number;
  }): Promise<unknown> {
    return this.measure('find', async () => {
      const { snapshot } = await this.currentSnapshot();
      const needle = input.text.toLocaleLowerCase('en-US');
      const matches = snapshot.elements.filter((element) => {
        if (
          input.role &&
          element.role.toLocaleLowerCase('en-US') !== input.role.toLocaleLowerCase('en-US')
        ) {
          return false;
        }
        const haystack = [element.name, element.text, element.value]
          .filter((value): value is string => value !== undefined)
          .join(' ')
          .toLocaleLowerCase('en-US');
        return input.exact ? haystack === needle : haystack.includes(needle);
      });
      return matches.slice(0, input.limit ?? 20).map((element) => this.publicElement(element));
    });
  }

  public async getText(input: {
    uid?: string;
    selector?: string;
    maxChars?: number;
  }): Promise<unknown> {
    return this.measure('get_text', async () => {
      if (input.selector) {
        const scoped = await this.snapshot({
          selector: input.selector,
          includeText: true,
          includeAttributes: false,
          maxChars: input.maxChars ?? 20_000,
          maxElements: 1_000,
        });
        return { text: scoped.text, snapshotId: scoped.snapshotId, truncated: scoped.truncated };
      }
      const uid = input.uid;
      if (!uid) {
        throw new BrowserBridgeError('INVALID_ARGUMENT', 'uid or selector is required.');
      }
      const { snapshot } = await this.currentSnapshot();
      const element = snapshot.elements.find((candidate) => candidate.uid === uid);
      if (!element) {
        await this.resolveUid(uid);
        throw new BrowserBridgeError(
          'STALE_REFERENCE',
          `UID ${uid} is not in the current snapshot.`,
          {
            recoverable: true,
            hint: 'Take a new browser_snapshot.',
          },
        );
      }
      const text = [element.name, element.text, element.value]
        .filter((value): value is string => value !== undefined)
        .join('\n')
        .slice(0, input.maxChars ?? 20_000);
      return { uid, text };
    });
  }

  public async click(input: { uid: string; doubleClick?: boolean }): Promise<BrowserActionResult> {
    return this.measure('click', async () => {
      const { sourceUid } = await this.resolveUid(input.uid);
      await this.upstreamCall(
        'click_by_uid',
        { uid: sourceUid, dblClick: input.doubleClick ?? false },
        false,
      );
      this.invalidateAfterPotentialNavigation();
      return this.action(`Clicked ${input.uid}.`);
    });
  }

  public async hover(uid: string): Promise<BrowserActionResult> {
    return this.measure('hover', async () => {
      const binding = await this.resolveUid(uid);
      await this.upstreamCall('hover_by_uid', { uid: binding.sourceUid }, false);
      return this.action(`Hovered ${uid}.`);
    });
  }

  public async fill(input: { uid: string; value: string }): Promise<BrowserActionResult> {
    return this.measure('fill', async () => {
      const binding = await this.resolveUid(input.uid);
      await this.upstreamCall('fill_by_uid', { uid: binding.sourceUid, value: input.value }, false);
      return this.action(`Filled ${input.uid}.`);
    });
  }

  public async fillForm(
    fields: readonly { uid: string; value: string }[],
  ): Promise<BrowserActionResult> {
    return this.measure('fill_form', async () => {
      const resolved = await Promise.all(
        fields.map(async (field) => ({
          uid: (await this.resolveUid(field.uid)).sourceUid,
          value: field.value,
        })),
      );
      await this.upstreamCall('fill_form_by_uid', { elements: resolved }, false);
      return this.action(`Filled ${fields.length} fields.`);
    });
  }

  public async selectOption(input: {
    uid: string;
    values: readonly string[];
  }): Promise<BrowserActionResult> {
    return this.measure('select_option', async () => {
      const binding = await this.resolveUid(input.uid);
      const values = JSON.stringify(input.values);
      const functionSource = `(element) => {
        if (!(element instanceof HTMLSelectElement)) throw new Error("Target is not a select element");
        const wanted = new Set(${values});
        let matched = 0;
        for (const option of element.options) {
          option.selected = wanted.has(option.value) || wanted.has(option.label);
          if (option.selected) matched += 1;
        }
        if (matched === 0) throw new Error("No requested option matched");
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return { matched };
      }`;
      const result = await this.upstreamCall(
        'evaluate_script',
        { function: functionSource, args: [{ uid: binding.sourceUid }] },
        false,
      );
      return this.action(`Selected option on ${input.uid}.`, parseJsonText(result));
    });
  }

  public async pressKey(input: { key: string; uid?: string }): Promise<BrowserActionResult> {
    return this.measure('press_key', async () => {
      const key = JSON.stringify(input.key);
      const binding = input.uid ? await this.resolveUid(input.uid) : undefined;
      const functionSource = `(${binding ? 'element' : ''}) => {
        const target = ${binding ? 'element' : 'document.activeElement || document.body'};
        if (!target) throw new Error("No key target");
        if (target.focus) target.focus();
        const init = { key: ${key}, bubbles: true, cancelable: true };
        const allowed = target.dispatchEvent(new KeyboardEvent("keydown", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));
        if (allowed && ${key} === "Enter" && target.form && target.form.requestSubmit) {
          target.form.requestSubmit();
        }
        return { key: ${key}, synthetic: true };
      }`;
      const result = await this.upstreamCall(
        'evaluate_script',
        {
          function: functionSource,
          ...(binding ? { args: [{ uid: binding.sourceUid }] } : {}),
        },
        false,
      );
      this.invalidateAfterPotentialNavigation();
      return this.action(`Pressed ${input.key}.`, parseJsonText(result));
    });
  }

  public async scroll(input: {
    uid?: string;
    deltaX?: number;
    deltaY?: number;
    direction?: string;
    amount?: number;
  }): Promise<BrowserActionResult> {
    return this.measure('scroll', async () => {
      const binding = input.uid ? await this.resolveUid(input.uid) : undefined;
      const amount = input.amount ?? 600;
      const x =
        input.deltaX ??
        (input.direction === 'left' ? -amount : input.direction === 'right' ? amount : 0);
      const y =
        input.deltaY ??
        (input.direction === 'up' ? -amount : input.direction === 'down' ? amount : 0);
      const functionSource = `(${binding ? 'element' : ''}) => {
        const target = ${binding ? 'element' : 'window'};
        target.scrollBy({ left: ${JSON.stringify(x)}, top: ${JSON.stringify(y)}, behavior: "auto" });
        return { x: target === window ? window.scrollX : target.scrollLeft, y: target === window ? window.scrollY : target.scrollTop };
      }`;
      const result = await this.upstreamCall(
        'evaluate_script',
        {
          function: functionSource,
          ...(binding ? { args: [{ uid: binding.sourceUid }] } : {}),
        },
        false,
      );
      return this.action('Scrolled.', parseJsonText(result));
    });
  }

  public async uploadFile(input: { uid: string; path: string }): Promise<BrowserActionResult> {
    return this.measure('upload_file', async () => {
      const absolute = resolve(input.path);
      const stats = await fs.stat(absolute).catch(() => undefined);
      if (!stats?.isFile()) {
        throw new BrowserBridgeError('INVALID_ARGUMENT', `Upload path is not a file: ${absolute}`, {
          stage: 'upload',
        });
      }
      const binding = await this.resolveUid(input.uid);
      await this.upstreamCall(
        'upload_file_by_uid',
        { uid: binding.sourceUid, filePath: absolute },
        false,
      );
      return this.action(`Uploaded ${absolute} to ${input.uid}.`);
    });
  }

  public async screenshot(input: { uid?: string; path?: string }): Promise<ScreenshotResult> {
    return this.measure('screenshot', async () => {
      const binding = input.uid ? await this.resolveUid(input.uid) : undefined;
      const result = await this.upstreamCall(
        binding ? 'screenshot_by_uid' : 'screenshot_page',
        binding ? { uid: binding.sourceUid } : {},
        true,
      );
      const image = result.images[0];
      if (!image || image.mimeType !== 'image/png') {
        throw new BrowserBridgeError('UPSTREAM_ERROR', 'Mozilla returned no PNG screenshot.', {
          stage: 'screenshot',
        });
      }
      const buffer = Buffer.from(image.data, 'base64');
      if (input.path) {
        const savedTo = await this.saveScreenshot(input.path, buffer);
        return { mimeType: 'image/png', bytes: buffer.byteLength, savedTo };
      }
      return {
        mimeType: 'image/png',
        bytes: buffer.byteLength,
        data: image.data,
      };
    });
  }

  public async getConsole(filters: ConsoleFilters): Promise<unknown> {
    return this.measure('get_console', async () => {
      const result = await this.upstreamCall(
        'list_console_messages',
        {
          ...(filters.errorsOnly
            ? { level: 'error' }
            : filters.severity
              ? { level: filters.severity }
              : {}),
          ...(filters.text ? { textContains: filters.text } : {}),
          ...(filters.source ? { source: filters.source } : {}),
          ...(filters.sinceMs !== undefined ? { sinceMs: filters.sinceMs } : {}),
          limit: filters.limit ?? 100,
          format: 'json',
        },
        true,
      );
      const output = redactParsed(parseJsonText(result));
      if (filters.clearAfterReading) {
        await this.upstreamCall('clear_console_messages', {}, false);
      }
      return output;
    });
  }

  public async getNetwork(filters: NetworkFilters): Promise<unknown> {
    return this.measure('get_network', async () => {
      const elapsedSinceClear =
        this.networkClearedAt === undefined ? undefined : Date.now() - this.networkClearedAt;
      const sinceMs =
        elapsedSinceClear === undefined
          ? filters.sinceMs
          : filters.sinceMs === undefined
            ? elapsedSinceClear
            : Math.min(filters.sinceMs, elapsedSinceClear);
      const result = await this.upstreamCall(
        'list_network_requests',
        {
          ...(filters.resourceType ? { resourceType: filters.resourceType } : {}),
          ...(filters.status !== undefined ? { status: filters.status } : {}),
          ...(filters.statusMin !== undefined ? { statusMin: filters.statusMin } : {}),
          ...(filters.statusMax !== undefined ? { statusMax: filters.statusMax } : {}),
          ...(filters.errorsOnly && filters.status === undefined && filters.statusMin === undefined
            ? { statusMin: 400 }
            : {}),
          ...(filters.url ? { urlContains: filters.url } : {}),
          ...(filters.method ? { method: filters.method } : {}),
          ...(sinceMs !== undefined ? { sinceMs } : {}),
          limit: filters.limit ?? 100,
          detail: 'summary',
          format: 'json',
        },
        true,
      );
      if (filters.clearAfterReading) {
        this.networkClearedAt = Date.now();
      }
      return redactParsed(parseJsonText(result));
    });
  }

  public async getRequest(input: { requestId: string }): Promise<unknown> {
    return this.measure('get_request', async () => {
      const result = await this.upstreamCall(
        'get_network_request',
        { id: input.requestId, format: 'json' },
        true,
      );
      return redactParsed(parseJsonText(result));
    });
  }

  public async getDownloads(input: {
    status?: string;
    url?: string;
    limit?: number;
    clearAfterReading?: boolean;
  }): Promise<unknown> {
    return this.measure('get_downloads', async () => {
      const result = await this.upstreamCall(
        'list_downloads',
        {
          ...(input.status ? { status: input.status } : {}),
          ...(input.url ? { urlContains: input.url } : {}),
          limit: input.limit ?? 100,
          format: 'json',
        },
        true,
      );
      if (input.clearAfterReading) {
        await this.upstreamCall('clear_downloads', {}, false);
      }
      return redactParsed(parseJsonText(result));
    });
  }

  public async batch(
    actions: readonly BrowserBatchAction[],
    continueOnError = false,
  ): Promise<BrowserBatchResult> {
    return this.measure('batch', () => executeBrowserBatch(this, actions, continueOnError));
  }

  public async close(): Promise<void> {
    if (this.closing || this.state === 'closed') {
      return;
    }
    this.closing = true;
    this.state = 'closed';
    try {
      const results = await Promise.allSettled([
        this.upstream?.close() ?? Promise.resolve(),
        this.profileLease?.release({
          removeProfile: this.options.removeProfileOnClose ?? false,
        }) ?? Promise.resolve(),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) =>
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        );
      if (failures.length > 0) {
        this.addDiagnostic('shutdown', false, 'Controlled session shutdown was incomplete.', {
          failures,
        });
        throw new BrowserBridgeError('SHUTDOWN', 'Controlled session shutdown was incomplete.', {
          stage: 'shutdown',
          recoverable: false,
          failures,
        });
      }
      this.addDiagnostic('shutdown', true, 'Controlled session shut down cleanly.');
    } finally {
      this.upstream = undefined;
      this.profileLease = undefined;
      this.closing = false;
    }
  }

  public telemetry(): LocalTelemetrySummary {
    return {
      totalOperations: [...this.metrics.values()].reduce((sum, value) => sum + value.count, 0),
      operations: Object.fromEntries(
        [...this.metrics.entries()].map(([name, value]) => [
          name,
          {
            count: value.count,
            meanMs: Number((value.totalMs / value.count).toFixed(2)),
            maxMs: Number(value.maxMs.toFixed(2)),
            errors: value.errors,
          },
        ]),
      ),
    };
  }

  private async ensureStarted(): Promise<void> {
    if (this.state === 'ready' && this.upstream?.getState() === 'ready') {
      return;
    }
    if (this.state === 'closed') {
      throw new BrowserBridgeError('SHUTDOWN', 'The browser session is closed.');
    }
    this.state = 'starting';
    // Attached mode joins a browser the user already started and owns, so the bridge must not
    // take a profile lease or manage a profile it did not create.
    if (!this.profileLease && !this.options.connectExisting) {
      this.addDiagnostic('profile', true, 'Acquiring dedicated profile ownership.');
      this.profileLease = await this.profileManager.acquire(this.options.profileName ?? 'default');
    }
    if (this.upstream?.getState() === 'failed') {
      await this.upstream.close();
      this.upstream = undefined;
    }
    if (!this.upstream) {
      const upstreamOptions: MozillaUpstreamOptions = {
        firefoxPath: this.options.browserPath,
        profileParent: this.profileLease?.upstreamProfilePath ?? this.options.outputDirectory,
        outputDirectory: this.options.outputDirectory,
        ...(this.options.connectExisting
          ? {
              connectExisting: true,
              ...(this.options.marionettePort !== undefined
                ? { marionettePort: this.options.marionettePort }
                : {}),
            }
          : {}),
        ...(this.options.nodePath ? { nodePath: this.options.nodePath } : {}),
        ...(this.options.headless !== undefined ? { headless: this.options.headless } : {}),
        ...(this.options.viewport ? { viewport: this.options.viewport } : {}),
        ...(this.options.startUrl ? { startUrl: this.options.startUrl } : {}),
        ...(this.options.preferences ? { preferences: this.options.preferences } : {}),
        ...(this.options.windowsJobSupervisorPath
          ? { windowsJobSupervisorPath: this.options.windowsJobSupervisorPath }
          : {}),
      };
      this.upstream =
        this.options.upstreamFactory?.(upstreamOptions) ??
        new MozillaUpstreamClient(upstreamOptions);
    }
    try {
      await this.upstream.ensureStarted();
      this.state = 'ready';
    } catch (error) {
      this.state = 'failed';
      throw error;
    }
  }

  private async upstreamCall(
    name: string,
    args: Readonly<Record<string, unknown>>,
    idempotent: boolean,
  ): Promise<UpstreamCallResult> {
    await this.ensureStarted();
    try {
      return await this.upstream!.call(name, args);
    } catch (error) {
      const bridgeError = asBridgeError(error);
      const disconnected =
        this.upstream?.getState() === 'failed' || bridgeError.code === 'BROWSER_CONNECTION_FAILED';
      if (!disconnected) {
        throw bridgeError;
      }
      this.state = 'failed';
      if (!idempotent) {
        throw new BrowserBridgeError(
          'OUTCOME_UNKNOWN',
          `${name} lost its browser connection; the action may or may not have completed.`,
          {
            stage: 'recovery',
            recoverable: true,
            hint: 'Refresh tabs and take a new snapshot before deciding whether to retry.',
          },
        );
      }
      await this.ensureStarted();
      return this.upstream!.call(name, args);
    }
  }

  private reconcileTabs(
    listed: readonly Omit<TabState, 'id' | 'url' | 'navigationGeneration' | 'domGeneration'>[],
  ): void {
    const existing = [...this.tabs.values()];
    const claimed = new Set<string>();
    const next = new Map<string, TabState>();
    for (const item of listed) {
      let match = existing.find(
        (tab) => !claimed.has(tab.id) && tab.index === item.index && tab.title === item.title,
      );
      match ??= existing.find((tab) => !claimed.has(tab.id) && tab.title === item.title);
      match ??= existing.find((tab) => !claimed.has(tab.id) && tab.index === item.index);
      const tab: TabState =
        match ??
        ({
          id: this.nextTabId(),
          index: item.index,
          title: item.title,
          selected: item.selected,
          navigationGeneration: 1,
          domGeneration: 0,
        } satisfies TabState);
      tab.index = item.index;
      tab.title = item.title;
      tab.selected = item.selected;
      claimed.add(tab.id);
      next.set(tab.id, tab);
      if (item.selected) {
        this.selectedTabId = tab.id;
      }
    }
    this.tabs.clear();
    for (const [id, tab] of next) {
      this.tabs.set(id, tab);
    }
    if (this.selectedTabId && !this.tabs.has(this.selectedTabId)) {
      this.selectedTabId = undefined;
    }
  }

  private tabList(): readonly BrowserTab[] {
    return [...this.tabs.values()]
      .sort((left, right) => left.index - right.index)
      .map((tab) => ({
        id: tab.id,
        index: tab.index,
        title: tab.title,
        ...(tab.url ? { url: tab.url } : {}),
        selected: tab.selected,
      }));
  }

  private resolveTab(input: {
    tabId?: string;
    index?: number;
    title?: string;
    url?: string;
  }): TabState {
    const tab =
      (input.tabId ? this.tabs.get(input.tabId) : undefined) ??
      (input.index !== undefined
        ? [...this.tabs.values()].find((candidate) => candidate.index === input.index)
        : undefined) ??
      (input.url
        ? [...this.tabs.values()].find((candidate) => candidate.url?.includes(input.url!))
        : undefined) ??
      (input.title
        ? [...this.tabs.values()].find((candidate) =>
            candidate.title
              .toLocaleLowerCase('en-US')
              .includes(input.title!.toLocaleLowerCase('en-US')),
          )
        : undefined);
    if (!tab) {
      throw new BrowserBridgeError('INVALID_TAB', 'No tab matched the requested target.', {
        stage: 'tabs',
        recoverable: true,
      });
    }
    return tab;
  }

  private async requireSelectedTab(): Promise<TabState> {
    await this.ensureStarted();
    if (!this.selectedTabId || !this.tabs.has(this.selectedTabId)) {
      await this.listTabs();
    }
    const tab = this.selectedTabId ? this.tabs.get(this.selectedTabId) : undefined;
    if (!tab) {
      throw new BrowserBridgeError('INVALID_TAB', 'No LibreWolf tab is selected.', {
        stage: 'tabs',
        recoverable: true,
      });
    }
    return tab;
  }

  private async currentSnapshot(): Promise<{
    tab: TabState;
    snapshot: EngineSnapshotResult;
  }> {
    const tab = await this.requireSelectedTab();
    const snapshot = this.latestSnapshots.get(tab.id);
    if (!snapshot) {
      throw new BrowserBridgeError('STALE_REFERENCE', 'No current snapshot is available.', {
        recoverable: true,
        hint: 'Call browser_snapshot first.',
      });
    }
    return { tab, snapshot };
  }

  private async resolveUid(uid: string): Promise<{ sourceUid: string }> {
    const tab = await this.requireSelectedTab();
    try {
      const binding = this.snapshotEngine.resolveUid(uid, {
        sessionId: this.sessionId,
        tabId: tab.id,
        frameId: 'top',
        navigationGeneration: tab.navigationGeneration,
        domGeneration: tab.domGeneration,
      });
      return { sourceUid: binding.sourceUid };
    } catch (error) {
      if (error instanceof StaleUidError) {
        throw new BrowserBridgeError('STALE_REFERENCE', error.message, {
          stage: 'uid',
          recoverable: true,
          uid,
          reason: error.code,
          hint: 'Take a new browser_snapshot and retry with its UID.',
        });
      }
      throw error;
    }
  }

  private async resolveStrongSelectors(
    elements: readonly ParsedSnapshotElement[],
  ): Promise<ReadonlyMap<string, ReturnType<typeof classifySelectorFingerprint>>> {
    const interactive = (element: ParsedSnapshotElement): boolean =>
      element.states['interactive'] === true || element.states['focusable'] === true;
    const candidates = [...elements]
      .sort((left, right) => Number(interactive(right)) - Number(interactive(left)))
      .slice(0, 500);
    const selectors = new Map<string, ReturnType<typeof classifySelectorFingerprint>>();
    const concurrency = 16;
    for (let offset = 0; offset < candidates.length; offset += concurrency) {
      const chunk = candidates.slice(offset, offset + concurrency);
      const resolved = await Promise.all(
        chunk.map(async (element) => {
          try {
            const result = await this.upstreamCall(
              'resolve_uid_to_selector',
              { uid: element.upstreamUid },
              true,
            );
            const selector = selectorFromResolution(element.upstreamUid, result.text);
            if (!selector) {
              return undefined;
            }
            const fingerprint = classifySelectorFingerprint(selector);
            return fingerprint.strength === 'strong'
              ? { uid: element.upstreamUid, fingerprint }
              : undefined;
          } catch {
            return undefined;
          }
        }),
      );
      for (const item of resolved) {
        if (item) {
          selectors.set(item.uid, item.fingerprint);
        }
      }
    }
    return selectors;
  }

  private async inspectSafeFieldMetadata(
    elements: readonly ParsedSnapshotElement[],
  ): Promise<ReadonlyMap<string, SafeFieldMetadata>> {
    const candidates = elements.filter((element) => element.value !== undefined).slice(0, 500);
    if (candidates.length === 0) {
      return new Map();
    }
    const functionSource = `(...elements) => elements.map((element) => {
      if (!(element instanceof HTMLInputElement) &&
          !(element instanceof HTMLTextAreaElement) &&
          !(element instanceof HTMLSelectElement)) {
        return null;
      }
      return {
        type: String(element.type || ""),
        name: String(element.name || ""),
        autocomplete: String(element.autocomplete || "")
      };
    })`;
    try {
      const result = await this.upstreamCall(
        'evaluate_script',
        {
          function: functionSource,
          args: candidates.map((element) => ({ uid: element.upstreamUid })),
        },
        true,
      );
      const decoded = parseJsonText(result);
      if (!Array.isArray(decoded) || decoded.length !== candidates.length) {
        return new Map();
      }
      const metadata = new Map<string, SafeFieldMetadata>();
      for (let index = 0; index < candidates.length; index += 1) {
        const item = decoded[index];
        const candidate = candidates[index];
        if (candidate && isSafeFieldMetadata(item)) {
          metadata.set(candidate.upstreamUid, item);
        }
      }
      return metadata;
    } catch {
      // The accessible name still catches common password/secret field names.
      // Failure of this optional metadata probe must not make snapshots unusable.
      return new Map();
    }
  }

  private async currentUrlBestEffort(): Promise<string | undefined> {
    try {
      const result = await this.upstreamCall(
        'evaluate_script',
        { function: '() => window.location.href' },
        true,
      );
      const decoded = parseJsonText(result);
      return typeof decoded === 'string' ? normalizeNavigationUrl(decoded.trim()) : undefined;
    } catch {
      return undefined;
    }
  }

  private invalidateNavigation(tab: TabState, url?: string): void {
    tab.navigationGeneration += 1;
    tab.domGeneration = 0;
    if (url) {
      tab.url = url;
    }
    this.snapshotEngine.invalidateNavigation(this.sessionId, tab.id, tab.navigationGeneration);
    this.latestSnapshots.delete(tab.id);
  }

  private invalidateAfterPotentialNavigation(): void {
    if (!this.selectedTabId) {
      return;
    }
    const tab = this.tabs.get(this.selectedTabId);
    if (tab) {
      this.invalidateNavigation(tab);
    }
  }

  private async navigateHistory(direction: 'back' | 'forward'): Promise<BrowserActionResult> {
    return this.measure(direction, async () => {
      const tab = await this.requireSelectedTab();
      await this.upstreamCall('navigate_history', { direction }, false);
      this.invalidateNavigation(tab);
      await this.refreshTabsBestEffort();
      return this.action(`Navigated ${direction}.`);
    });
  }

  private action(message: string, data?: unknown): BrowserActionResult {
    const tab = this.selectedTabId ? this.tabs.get(this.selectedTabId) : undefined;
    if (!tab) {
      throw new BrowserBridgeError('INVALID_TAB', 'No selected tab after action.');
    }
    return {
      ok: true,
      tabId: tab.id,
      navigationGeneration: tab.navigationGeneration,
      message,
      ...(data === undefined ? {} : { data: redactParsed(data) }),
    };
  }

  private async refreshTabsBestEffort(): Promise<void> {
    try {
      const result = await this.upstreamCall('list_pages', {}, true);
      this.reconcileTabs(parseTabs(result.text));
    } catch {
      // The state-changing operation already succeeded; callers can refresh explicitly.
    }
  }

  private nextTabId(): string {
    const id = `tab_${this.tabSequence.toString(36)}`;
    this.tabSequence += 1;
    return id;
  }

  private publicElement(element: CompactSnapshotElement): unknown {
    return {
      uid: element.uid,
      role: element.role,
      ...(element.name ? { name: element.name } : {}),
      ...(element.text ? { text: element.text } : {}),
      ...(element.value ? { value: element.value } : {}),
      ...(element.href ? { href: element.href } : {}),
      interactive: element.interactive,
    };
  }

  private async saveScreenshot(path: string, content: Buffer): Promise<string> {
    const destination = isAbsolute(path)
      ? resolve(path)
      : resolve(this.options.outputDirectory, path);
    const roots = [
      resolve(this.options.outputDirectory),
      resolve(process.cwd()),
      ...(this.options.allowedOutputRoots ?? []).map((root) => resolve(root)),
    ];
    if (!roots.some((root) => isInsideOrEqual(root, destination))) {
      throw new BrowserBridgeError(
        'PERMISSION_DENIED',
        `Screenshot path is outside allowed output roots: ${destination}`,
        { stage: 'screenshot', recoverable: true },
      );
    }
    const parent = dirname(destination);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const canonicalParent = await fs.realpath(parent);
    const canonicalRoots = await Promise.all(
      roots.map(async (root) => {
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        return fs.realpath(root);
      }),
    );
    if (!canonicalRoots.some((root) => isInsideOrEqual(root, canonicalParent))) {
      throw new BrowserBridgeError('PERMISSION_DENIED', 'Screenshot path escapes through a link.', {
        stage: 'screenshot',
      });
    }
    const existing = await fs.lstat(destination).catch((error: unknown) => {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : undefined;
      if (code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    if (existing) {
      throw new BrowserBridgeError(
        'ACTION_BLOCKED',
        `Refusing to overwrite existing screenshot: ${destination}`,
        { stage: 'screenshot', recoverable: true },
      );
    }
    await fs.writeFile(destination, content, {
      flag: 'wx',
      mode: fsConstants.S_IRUSR | fsConstants.S_IWUSR,
    });
    return destination;
  }

  private addDiagnostic(
    stage: StartupDiagnostic['stage'],
    ok: boolean,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ): void {
    this.diagnostics.push({
      stage,
      ok,
      at: new Date().toISOString(),
      message,
      ...(details ? { details } : {}),
    });
  }

  private async measure<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const started = performance.now();
    let error = false;
    try {
      return await operation();
    } catch (cause) {
      error = true;
      throw cause;
    } finally {
      const duration = performance.now() - started;
      const current = this.metrics.get(name) ?? {
        count: 0,
        totalMs: 0,
        maxMs: 0,
        errors: 0,
      };
      current.count += 1;
      current.totalMs += duration;
      current.maxMs = Math.max(current.maxMs, duration);
      if (error) {
        current.errors += 1;
      }
      this.metrics.set(name, current);
    }
  }
}
