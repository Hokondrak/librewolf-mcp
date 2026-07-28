import { bench, describe } from 'vitest';

import {
  SnapshotEngine,
  parseMozillaCompactSnapshot,
  type MozillaCompactSnapshotInput,
  type SnapshotScope,
} from '../src/index.js';

/**
 * In-process snapshot cost. These benchmarks isolate the work the bridge itself does — parsing
 * upstream text, assigning stable UIDs, filtering, and rendering — from browser and IPC latency,
 * which `npm run profile:performance` measures end to end against real LibreWolf.
 *
 * The cached-snapshot target is 200 ms total, so this stage must stay a small fraction of it.
 */

const scope = (domGeneration: number, navigationGeneration = 1): SnapshotScope => ({
  sessionId: 'bench-session',
  tabId: 'bench-tab',
  frameId: 'top',
  navigationGeneration,
  domGeneration,
});

/** A page roughly the size of a busy application screen: nav, table, and a form. */
const buildPage = (rows: number): MozillaCompactSnapshotInput => {
  const lines = ['uid=root main "Dashboard"'];
  const metadata: { upstreamUid: string; selectorFingerprint: string }[] = [
    { upstreamUid: 'root', selectorFingerprint: '#root' },
  ];
  for (let index = 0; index < rows; index += 1) {
    lines.push(
      `  uid=row-${index} row`,
      `    uid=name-${index} input "Name ${index}" value="Item ${index}" interactive`,
      `    uid=qty-${index} input "Quantity ${index}" type="number" value="${index}" interactive`,
      `    uid=link-${index} link "Open ${index}" href="https://example.test/items/${index}"`,
      `    uid=del-${index} button "Delete ${index}" text="Delete" interactive`,
    );
    metadata.push(
      { upstreamUid: `name-${index}`, selectorFingerprint: `[name="name-${index}"]` },
      { upstreamUid: `qty-${index}`, selectorFingerprint: `[name="qty-${index}"]` },
      { upstreamUid: `link-${index}`, selectorFingerprint: `#link-${index}` },
      { upstreamUid: `del-${index}`, selectorFingerprint: `#delete-${index}` },
    );
  }
  return { text: lines.join('\n'), metadata };
};

const smallPage = buildPage(25);
const largePage = buildPage(250);

describe('snapshot parsing', () => {
  bench('parse a 100-element page', () => {
    parseMozillaCompactSnapshot(smallPage);
  });

  bench('parse a 1000-element page', () => {
    parseMozillaCompactSnapshot(largePage);
  });
});

describe('cold snapshot (first UID assignment)', () => {
  bench('100 elements', async () => {
    await new SnapshotEngine().createSnapshot(smallPage, scope(1));
  });

  bench('1000 elements', async () => {
    await new SnapshotEngine().createSnapshot(largePage, scope(1));
  });
});

describe('warm snapshot (UIDs reused across DOM generations)', () => {
  const smallEngine = new SnapshotEngine();
  const largeEngine = new SnapshotEngine();
  let smallGeneration = 1;
  let largeGeneration = 1;

  bench('100 elements', async () => {
    smallGeneration += 1;
    await smallEngine.createSnapshot(smallPage, scope(smallGeneration));
  });

  bench('1000 elements', async () => {
    largeGeneration += 1;
    await largeEngine.createSnapshot(largePage, scope(largeGeneration));
  });
});

describe('bounded and delta snapshots', () => {
  const engine = new SnapshotEngine();
  let generation = 1;

  bench('interactive-only with element cap', async () => {
    generation += 1;
    await engine.createSnapshot(largePage, scope(generation), {
      interactiveOnly: true,
      maxElements: 100,
      maxChars: 20_000,
    });
  });

  bench('delta against the previous snapshot', async () => {
    generation += 1;
    const previous = await engine.createSnapshot(largePage, scope(generation));
    generation += 1;
    await engine.createSnapshot(largePage, scope(generation), {
      changedSinceSnapshot: previous.snapshotId,
    });
  });
});
