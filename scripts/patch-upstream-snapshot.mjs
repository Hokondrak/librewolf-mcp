/**
 * Raises hard-coded output limits inside the pinned Mozilla snapshot implementation.
 *
 * `@mozilla/firefox-devtools-mcp@0.9.15` discards page content before a consumer can ask for it,
 * and the parameters it advertises for controlling that do not work:
 *
 *   - `take_snapshot` advertises `maxDepth`, but the string never appears in the injected DOM
 *     walker. It is silently ignored and the hard-coded depth of 10 always applies.
 *   - `take_snapshot` advertises `selector` for scoping, which would restart the depth budget,
 *     but every selector except `body` fails with "Failed to generate snapshot: Unknown error".
 *
 * The effect is severe on ordinary pages. Hacker News nests every story link at depth 11 behind
 * `center > table#hnmain > tbody`, so all thirty stories vanish while their empty parent spans
 * remain — a snapshot that looks complete and contains no content. Separately,
 * `MAX_ATTR_LENGTH = 30` truncates every accessible name, href, value, and text run to 30
 * characters, which clips most real headlines and URLs.
 *
 * These patches change numeric constants only. Mozilla's logic, license, and notices are
 * unmodified, and the raised limits are still bounded well below this project's own snapshot
 * caps, so the compact-output guarantees are unaffected. Reported upstream as defects rather
 * than maintained as a fork.
 *
 * Every patch is idempotent and fails loudly: if neither the original nor the patched text is
 * present, the pinned upstream has changed and its limits must be re-verified rather than
 * silently left at their defaults.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/** Relative file, the exact text to replace, and its replacement. */
export const UPSTREAM_PATCHES = [
  {
    file: 'dist/snapshot.injected.global.js',
    what: 'DOM walk depth and node budget',
    from: 'var le=10,j=1e3',
    to: 'var le=32,j=5e3',
  },
  {
    file: 'dist/index.js',
    what: 'attribute, name, href and text truncation',
    from: 'MAX_ATTR_LENGTH = 30',
    to: 'MAX_ATTR_LENGTH = 200',
  },
];

const upstreamRoot = () => dirname(require.resolve('@mozilla/firefox-devtools-mcp/package.json'));

/** Applies every patch under `root`, which defaults to the resolved upstream package. */
export const patchUpstreamSnapshot = async (root = upstreamRoot()) => {
  const results = [];
  for (const patch of UPSTREAM_PATCHES) {
    const path = resolve(root, patch.file);
    const source = await readFile(path, 'utf8');

    if (source.includes(patch.to)) {
      results.push({ ...patch, path, changed: false, reason: 'already-patched' });
      continue;
    }
    if (!source.includes(patch.from)) {
      throw new Error(
        `patch-upstream-snapshot: expected "${patch.from}" (${patch.what}) in ${path}. The ` +
          'pinned @mozilla/firefox-devtools-mcp build has changed; re-verify its snapshot limits ' +
          'before shipping and update this patch.',
      );
    }
    await writeFile(path, source.replace(patch.from, patch.to), 'utf8');
    results.push({ ...patch, path, changed: true, reason: 'patched' });
  }
  return results;
};

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  for (const result of await patchUpstreamSnapshot()) {
    console.log(`patch-upstream-snapshot: ${result.what} — ${result.reason}`);
  }
}
