import { copyFile, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const appRoot = resolve(import.meta.dirname, '..');
const source = resolve(appRoot, '..', 'native-host', 'dist', 'native', 'secure-pipe-helper.exe');
const destination = resolve(appRoot, 'dist', 'native', 'secure-pipe-helper.exe');

const sourceStats = await stat(source).catch(() => undefined);
if (!sourceStats?.isFile()) {
  if (process.platform === 'win32') {
    throw new Error(
      `The secure native helper is missing: ${source}. Build the native-host workspace first.`,
    );
  }
  process.stdout.write(
    '[mcp-server] Windows secure-pipe helper is not produced on this platform.\n',
  );
  process.exit(0);
}

await mkdir(resolve(appRoot, 'dist', 'native'), { recursive: true });
await copyFile(source, destination);
process.stdout.write(`[mcp-server] copied ${destination}\n`);
