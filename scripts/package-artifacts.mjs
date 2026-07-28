#!/usr/bin/env node

/**
 * Build and assemble local release inputs. This script never invokes an
 * installer, edits the registry, publishes packages, or downloads dependencies.
 * ZIP members have stable ordering, timestamps, and modes.
 */
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { patchUpstreamSnapshot } from './patch-upstream-snapshot.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, process.env.PACKAGE_OUTPUT_DIR ?? 'artifacts');
const staging = resolve(output, '.staging');
const sourceDate = sourceDateEpoch(process.env.SOURCE_DATE_EPOCH);

function fail(message) {
  throw new Error(`package-artifacts: ${message}`);
}

function sourceDateEpoch(value) {
  if (value === undefined) return new Date('1980-01-01T00:00:00.000Z');
  if (!/^\d+$/.test(value)) fail('SOURCE_DATE_EPOCH must be a whole number of seconds.');
  const date = new Date(Number(value) * 1_000);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1980) {
    fail('SOURCE_DATE_EPOCH must be a valid instant on or after 1980-01-01.');
  }
  return date;
}

function insideRoot(path, label) {
  const fromRoot = relative(root, path);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    fail(`${label} must be a child of the repository root.`);
  }
}

function insideDirectory(path, directory, label) {
  const fromDirectory = relative(directory, path);
  if (fromDirectory === '' || fromDirectory === '..' || fromDirectory.startsWith(`..${sep}`)) {
    fail(`${label} escapes its staging directory.`);
  }
}

async function requireFile(path, label) {
  try {
    if (!(await stat(path)).isFile()) fail(`${label} is not a regular file: ${path}`);
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`${label} is missing: ${path}`);
    throw error;
  }
}

async function requireDirectory(path, label) {
  try {
    if (!(await stat(path)).isDirectory()) fail(`${label} is not a directory: ${path}`);
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`${label} is missing: ${path}`);
    throw error;
  }
}

async function run(command, args, cwd) {
  const npmCli =
    process.platform === 'win32' && command === 'npm' ? process.env.npm_execpath : undefined;
  if (
    process.platform === 'win32' &&
    command === 'npm' &&
    (!npmCli || !resolve(npmCli).toLowerCase().endsWith('npm-cli.js'))
  ) {
    fail('npm_execpath must identify npm-cli.js when packaging on Windows.');
  }
  const executable = npmCli ? process.execPath : command;
  const commandArguments = npmCli ? [resolve(npmCli), ...args] : args;
  const result = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, commandArguments, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.once('error', rejectRun);
    child.once('close', (code) => resolveRun({ code, stdout, stderr }));
  });
  if (result.code !== 0) {
    fail(
      `${command} ${args.join(' ')} failed in ${cwd}.\n${result.stderr || result.stdout}`.trim(),
    );
  }
  return result.stdout;
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolute)));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = (value >>> 8) ^ CRC32_TABLE[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  return {
    time: (date.getUTCSeconds() >> 1) | (date.getUTCMinutes() << 5) | (date.getUTCHours() << 11),
    date:
      date.getUTCDate() | ((date.getUTCMonth() + 1) << 5) | ((date.getUTCFullYear() - 1980) << 9),
  };
}

function uint16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

async function createDeterministicZip(directory, destination) {
  const files = await walk(directory);
  const { time, date } = dosDateTime(sourceDate);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = relative(directory, file).split(sep).join('/');
    const nameBytes = Buffer.from(name, 'utf8');
    const content = await readFile(file);
    const checksum = crc32(content);
    const local = Buffer.concat([
      uint32(0x04034b50),
      uint16(20),
      uint16(0x0800),
      uint16(0),
      uint16(time),
      uint16(date),
      uint32(checksum),
      uint32(content.length),
      uint32(content.length),
      uint16(nameBytes.length),
      uint16(0),
      nameBytes,
      content,
    ]);
    localParts.push(local);
    const mode = name.endsWith('.sh') ? 0o100755 : 0o100644;
    centralParts.push(
      Buffer.concat([
        uint32(0x02014b50),
        uint16(0x0314),
        uint16(20),
        uint16(0x0800),
        uint16(0),
        uint16(time),
        uint16(date),
        uint32(checksum),
        uint32(content.length),
        uint32(content.length),
        uint16(nameBytes.length),
        uint16(0),
        uint16(0),
        uint16(0),
        uint16(0),
        uint32(mode << 16),
        uint32(offset),
        nameBytes,
      ]),
    );
    offset += local.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.concat([
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(files.length),
    uint16(files.length),
    uint32(centralDirectory.length),
    uint32(offset),
    uint16(0),
  ]);
  await writeFile(destination, Buffer.concat([...localParts, centralDirectory, end]));
}

async function checksum(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/** PE COFF timestamps/checksums are linker metadata, not executable behavior. */
async function normalizePortableExecutableTimestamp(path) {
  const executable = await readFile(path);
  if (executable.length < 0x40 || executable.toString('ascii', 0, 2) !== 'MZ') {
    fail(`Secure helper is not a PE executable: ${path}`);
  }
  const peOffset = executable.readUInt32LE(0x3c);
  if (
    peOffset + 12 > executable.length ||
    executable.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0'
  ) {
    fail(`Secure helper has an invalid PE header: ${path}`);
  }
  executable.writeUInt32LE(0, peOffset + 8);
  // The optional-header checksum incorporates the COFF timestamp. A zero
  // checksum is valid for an ordinary user-mode executable and makes repeated
  // MinGW links byte-identical after timestamp normalization.
  const optionalHeaderOffset = peOffset + 4 + 20;
  executable.writeUInt32LE(0, optionalHeaderOffset + 64);
  await writeFile(path, executable);
}

function tarText(buffer, start, length) {
  return buffer
    .subarray(start, start + length)
    .toString('utf8')
    .replace(/\0.*$/su, '')
    .trim();
}

/** Extract only ordinary files/directories from an npm tarball, rejecting traversal. */
async function extractTarGz(archive, destination) {
  const contents = gunzipSync(await readFile(archive));
  let offset = 0;
  while (offset + 512 <= contents.length) {
    const header = contents.subarray(offset, offset + 512);
    const name = tarText(header, 0, 100);
    if (!name) break;
    const prefix = tarText(header, 345, 155);
    const entry = prefix ? `${prefix}/${name}` : name;
    const sizeText = tarText(header, 124, 12);
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0) fail(`Invalid TAR size for ${entry}.`);
    const type = String.fromCharCode(header[156] || 0);
    const target = resolve(destination, entry);
    insideDirectory(target, destination, `TAR entry ${entry}`);
    if (type === '0' || type === '\0') {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents.subarray(offset + 512, offset + 512 + size));
    } else if (type === '5') {
      await mkdir(target, { recursive: true });
    } else {
      fail(`Unsupported TAR entry type ${JSON.stringify(type)} for ${entry}.`);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

function writeTarText(header, offset, length, value) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) fail(`TAR field is too long: ${value}`);
  bytes.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`;
  writeTarText(header, offset, length, encoded);
}

/** Normalize npm-pack output: same packed files, fixed TAR metadata and gzip timestamp. */
async function createDeterministicNpmTarball(packageRoot, destination) {
  const blocks = [];
  for (const file of await walk(packageRoot)) {
    const entry = `package/${relative(packageRoot, file).split(sep).join('/')}`;
    if (Buffer.byteLength(entry, 'utf8') > 100) fail(`Packed path exceeds TAR limit: ${entry}`);
    const content = await readFile(file);
    const header = Buffer.alloc(512);
    writeTarText(header, 0, 100, entry);
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, content.length);
    writeTarOctal(header, 136, 12, Math.floor(sourceDate.getTime() / 1_000));
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    writeTarText(header, 257, 6, 'ustar\0');
    writeTarText(header, 263, 2, '00');
    writeTarText(header, 265, 32, 'root');
    writeTarText(header, 297, 32, 'root');
    let checksumValue = 0;
    for (const byte of header) checksumValue += byte;
    writeTarOctal(header, 148, 8, checksumValue);
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, gzipSync(Buffer.concat(blocks), { mtime: 0 }));
}

async function populateServerPayload(extractedPackage, destination, packageJson) {
  const dist = resolve(extractedPackage, 'dist');
  await requireFile(resolve(dist, 'cli.js'), 'packed MCP server CLI');
  await cp(dist, destination, { recursive: true });
  await rm(resolve(destination, '.tsbuildinfo'), { force: true });
  await writeFile(
    resolve(destination, 'package.json'),
    `${JSON.stringify(
      {
        name: packageJson.name,
        version: packageJson.version,
        private: true,
        type: 'module',
        engines: packageJson.engines,
        dependencies: packageJson.dependencies,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  // Reconstruct the exact npm dependency graph, including nested versions and
  // peer placement. --offline guarantees release assembly never fetches.
  await run(
    'npm',
    ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--offline'],
    destination,
  );
  // The staged install is a fresh dependency tree, so the workspace patch does not carry over.
  // Without this, a shipped bundle silently reverts to the upstream depth-10 walker.
  await patchStagedSnapshotScript(destination);
}

/**
 * Applies the pinned-upstream snapshot limit patches to a staged payload, reusing the same
 * definitions as the workspace patch so a shipped bundle cannot drift from a local build.
 */
async function patchStagedSnapshotScript(destination) {
  await patchUpstreamSnapshot(resolve(destination, 'node_modules/@mozilla/firefox-devtools-mcp'));
}

async function populateNativePayload(destination, nativePackageJson) {
  const nativeDist = resolve(root, 'apps/native-host/dist');
  await requireFile(resolve(nativeDist, 'cli.js'), 'built native-host CLI');
  await requireFile(
    resolve(nativeDist, 'native/secure-pipe-helper.exe'),
    'built secure pipe helper',
  );
  await cp(nativeDist, resolve(destination, 'dist'), { recursive: true });
  await rm(resolve(destination, 'dist/.tsbuildinfo'), { force: true });
  await normalizePortableExecutableTimestamp(
    resolve(destination, 'dist/native/secure-pipe-helper.exe'),
  );
  if (
    Object.keys(nativePackageJson.dependencies ?? {}).length > 0 ||
    Object.keys(nativePackageJson.optionalDependencies ?? {}).length > 0
  ) {
    fail('Native host release payload must bundle all non-Node dependencies.');
  }
  await copyFile(
    resolve(root, 'apps/native-host/package.json'),
    resolve(destination, 'package.json'),
  );
  await copyFile(
    resolve(root, 'THIRD_PARTY_NOTICES.md'),
    resolve(destination, 'THIRD_PARTY_NOTICES.md'),
  );
}

async function addReleaseNotices(destination) {
  await copyFile(resolve(root, 'LICENSE'), resolve(destination, 'LICENSE'));
  await copyFile(
    resolve(root, 'THIRD_PARTY_NOTICES.md'),
    resolve(destination, 'THIRD_PARTY_NOTICES.md'),
  );
  const licenses = resolve(destination, 'licenses');
  await mkdir(licenses, { recursive: true });
  await copyFile(resolve(root, 'packaging/licenses/ZOD-MIT.txt'), resolve(licenses, 'ZOD-MIT.txt'));
}

async function main() {
  insideRoot(output, 'PACKAGE_OUTPUT_DIR');
  const mcpRoot = resolve(root, 'apps/mcp-server');
  const nativeRoot = resolve(root, 'apps/native-host');
  const pluginTemplate = resolve(root, 'packaging/codex-plugin/librewolf-agent-bridge');
  const mcpbTemplate = resolve(root, 'packaging/claude-mcpb');

  await requireFile(resolve(mcpRoot, 'src/cli.ts'), 'MCP server CLI source entry point');
  await requireFile(resolve(root, 'extension/manifest.json'), 'MV3 extension manifest');
  await requireFile(resolve(root, 'extension/manifest.mv2.json'), 'MV2 extension manifest');
  await requireDirectory(pluginTemplate, 'Codex plugin template');
  await requireDirectory(mcpbTemplate, 'Claude MCPB template');
  await requireFile(resolve(root, 'LICENSE'), 'root license');
  await requireFile(resolve(root, 'THIRD_PARTY_NOTICES.md'), 'root third-party notices');
  await requireFile(resolve(root, 'packaging/licenses/ZOD-MIT.txt'), 'Zod MIT notice');
  for (const platform of ['windows', 'linux', 'macos']) {
    await requireDirectory(resolve(root, 'packaging', platform), `${platform} packaging template`);
  }

  // Build before creating or replacing the artifact directory.
  await run('npm', ['run', 'build'], root);
  await run('npm', ['run', 'build'], resolve(root, 'extension'));
  await requireFile(resolve(mcpRoot, 'dist/cli.js'), 'built MCP server CLI');
  await requireFile(resolve(nativeRoot, 'dist/cli.js'), 'built native-host CLI');
  await requireFile(
    resolve(nativeRoot, 'dist/native/secure-pipe-helper.exe'),
    'built secure pipe helper',
  );
  await requireFile(resolve(root, 'extension/dist/mv2/manifest.json'), 'built MV2 extension');
  await requireFile(resolve(root, 'extension/dist/mv3/manifest.json'), 'built MV3 extension');

  await rm(output, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const packOutput = await run(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', staging],
    mcpRoot,
  );
  let npmPack;
  try {
    npmPack = JSON.parse(packOutput);
  } catch {
    fail(`npm pack returned invalid JSON: ${packOutput}`);
  }
  if (!Array.isArray(npmPack) || typeof npmPack[0]?.filename !== 'string') {
    fail('npm pack did not report an output filename.');
  }
  const packedTarball = resolve(staging, npmPack[0].filename);
  await requireFile(packedTarball, 'npm tarball');
  const mcpPackageJson = JSON.parse(await readFile(resolve(mcpRoot, 'package.json'), 'utf8'));
  const nativePackageJson = JSON.parse(await readFile(resolve(nativeRoot, 'package.json'), 'utf8'));
  const version = mcpPackageJson.version;

  const extractedPackage = resolve(staging, 'mcp-package');
  await mkdir(extractedPackage, { recursive: true });
  await extractTarGz(packedTarball, extractedPackage);
  const packedRoot = resolve(extractedPackage, 'package');
  await requireFile(resolve(packedRoot, 'dist/cli.js'), 'packed MCP server CLI');
  await normalizePortableExecutableTimestamp(
    resolve(packedRoot, 'dist/native/secure-pipe-helper.exe'),
  );
  const npmTarball = resolve(staging, 'canonical', npmPack[0].filename);
  await createDeterministicNpmTarball(packedRoot, npmTarball);

  const pluginStage = resolve(staging, 'codex-plugin', 'librewolf-agent-bridge');
  await cp(pluginTemplate, pluginStage, { recursive: true });
  await populateServerPayload(packedRoot, resolve(pluginStage, 'server'), mcpPackageJson);
  await addReleaseNotices(pluginStage);

  const mcpbStage = resolve(staging, 'claude-mcpb');
  await cp(mcpbTemplate, mcpbStage, { recursive: true });
  await populateServerPayload(packedRoot, resolve(mcpbStage, 'server'), mcpPackageJson);
  await addReleaseNotices(mcpbStage);

  const platformStages = [];
  for (const platform of ['windows', 'linux', 'macos']) {
    const platformStage = resolve(staging, 'platforms', platform);
    await cp(resolve(root, 'packaging', platform), platformStage, { recursive: true });
    await populateNativePayload(resolve(platformStage, 'native-host-payload'), nativePackageJson);
    await addReleaseNotices(platformStage);
    platformStages.push([platform, platformStage]);
  }

  const outputs = [
    { source: npmTarball, name: npmPack[0].filename, kind: 'npm-tarball' },
    {
      source: resolve(output, `librewolf-agent-bridge-extension-mv2-${version}.xpi`),
      name: `librewolf-agent-bridge-extension-mv2-${version}.xpi`,
      kind: 'xpi-mv2',
      directory: resolve(root, 'extension/dist/mv2'),
    },
    {
      source: resolve(output, `librewolf-agent-bridge-extension-mv3-${version}.xpi`),
      name: `librewolf-agent-bridge-extension-mv3-${version}.xpi`,
      kind: 'xpi-mv3',
      directory: resolve(root, 'extension/dist/mv3'),
    },
    {
      source: resolve(output, `librewolf-agent-bridge-codex-plugin-${version}.zip`),
      name: `librewolf-agent-bridge-codex-plugin-${version}.zip`,
      kind: 'codex-plugin',
      directory: pluginStage,
    },
    {
      source: resolve(output, `librewolf-agent-bridge-${version}.mcpb`),
      name: `librewolf-agent-bridge-${version}.mcpb`,
      kind: 'claude-mcpb',
      directory: mcpbStage,
    },
    ...platformStages.map(([platform, directory]) => ({
      source: resolve(output, `librewolf-agent-bridge-${platform}-companion-${version}.zip`),
      name: `librewolf-agent-bridge-${platform}-companion-${version}.zip`,
      kind: `${platform}-companion`,
      directory,
    })),
  ];

  await copyFile(npmTarball, resolve(output, outputs[0].name));
  for (const artifact of outputs.slice(1))
    await createDeterministicZip(artifact.directory, artifact.source);

  const manifest = {
    schemaVersion: 1,
    generatedAt: sourceDate.toISOString(),
    sourceDateEpoch: Math.floor(sourceDate.getTime() / 1_000),
    version,
    artifacts: await Promise.all(
      outputs.map(async ({ source, name, kind }) => ({
        name,
        kind,
        bytes: (await stat(source)).size,
        sha256: await checksum(source),
      })),
    ),
  };
  await writeFile(
    resolve(output, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    resolve(output, 'SHA256SUMS'),
    `${manifest.artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join('\n')}\n`,
    'utf8',
  );
  await rm(staging, { recursive: true, force: true });
  process.stdout.write(`Created ${manifest.artifacts.length} artifacts in ${output}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
