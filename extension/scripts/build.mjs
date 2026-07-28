import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(root, 'dist');
const variants = [
  ['mv3', 'manifest.json'],
  ['mv2', 'manifest.mv2.json'],
];

await rm(outputRoot, { recursive: true, force: true });

for (const [variant, manifestFile] of variants) {
  const outdir = resolve(outputRoot, variant);
  await mkdir(outdir, { recursive: true });
  await build({
    absWorkingDir: root,
    entryPoints: {
      'background/index': 'src/background/index.ts',
      'content/index': 'src/content/index.ts',
      'popup/index': 'src/popup/index.ts',
      'options/index': 'src/options/index.ts',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'firefox102',
    outdir,
    sourcemap: true,
    logLevel: 'warning',
  });

  const manifest = await readFile(resolve(root, manifestFile), 'utf8');
  await writeFile(resolve(outdir, 'manifest.json'), manifest, 'utf8');
  await cp(resolve(root, 'src/popup/index.html'), resolve(outdir, 'popup/index.html'));
  await cp(resolve(root, 'src/options/index.html'), resolve(outdir, 'options/index.html'));
}

console.error(`Built development extensions in ${outputRoot}`);
