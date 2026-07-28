import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- plain JS build script, intentionally untyped and shared with packaging.
import { UPSTREAM_PATCHES } from '../../scripts/patch-upstream-snapshot.mjs';

/**
 * The pinned Mozilla build discards page content through hard-coded limits that its own
 * `maxDepth` and `selector` parameters cannot reach, so the bridge patches those constants at
 * install and package time. Unpatched, a Hacker News snapshot renders 79 elements with no story
 * titles instead of 440 with all of them — a result that looks complete and contains nothing.
 *
 * This guards the patch: if upstream is bumped and the constants move, the failure surfaces here
 * rather than as silently empty snapshots at runtime.
 */

interface UpstreamPatch {
  readonly file: string;
  readonly what: string;
  readonly from: string;
  readonly to: string;
}

const require = createRequire(import.meta.url);
const upstreamRoot = dirname(require.resolve('@mozilla/firefox-devtools-mcp/package.json'));
const patches = UPSTREAM_PATCHES as readonly UpstreamPatch[];

describe('pinned upstream snapshot limits', () => {
  it('defines a patch for the depth budget and the attribute truncation', () => {
    expect(patches.map((patch) => patch.file)).toEqual([
      'dist/snapshot.injected.global.js',
      'dist/index.js',
    ]);
  });

  it.each(patches.map((patch) => [patch.what, patch] as const))(
    'has applied the patch for %s',
    async (_what, patch) => {
      const source = await readFile(resolve(upstreamRoot, patch.file), 'utf8');
      expect(
        source.includes(patch.to),
        `${patch.file} is not patched. Run "npm run patch:upstream".`,
      ).toBe(true);
      expect(source).not.toContain(patch.from);
    },
  );

  it('keeps the raised limits above this project’s own snapshot caps', () => {
    // The bridge bounds output itself (max_elements 500, max_chars 20000 by default), so the
    // upstream limits only need to stop being the binding constraint.
    const depth = patches.find((patch) => patch.what.includes('depth'));
    const attribute = patches.find((patch) => patch.what.includes('truncation'));
    expect(depth?.to).toContain('le=32');
    expect(attribute?.to).toContain('200');
  });
});
