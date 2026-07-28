import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Acceptance criteria 12 and 13: no service binds a non-loopback interface, and no browser data
 * leaves the machine. Both are properties of the shipped source rather than of any single run, so
 * they are enforced by scanning product source for the APIs that could violate them.
 *
 * Test fixtures are deliberately excluded: the e2e fixture server binds 127.0.0.1 on purpose.
 */

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

const scannedRoots = [
  'apps/mcp-server/src',
  'apps/native-host/src',
  'packages/browser-core/src',
  'packages/librewolf-locator/src',
  'packages/protocol/src',
  'packages/security/src',
  'packages/snapshot-engine/src',
  'extension/src',
];

/** Each pattern is an API that would open a listening socket or reach the network. */
const forbidden: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'TCP/HTTP listener', pattern: /\.listen\s*\(/u },
  { name: 'HTTP server', pattern: /\bcreateServer\s*\(/u },
  { name: 'outbound fetch', pattern: /(?<![.\w])fetch\s*\(/u },
  { name: 'outbound http(s) request', pattern: /\bhttps?\.(?:request|get)\s*\(/u },
  { name: 'WebSocket client', pattern: /\bnew\s+WebSocket\s*\(/u },
  { name: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/u },
  { name: 'raw datagram socket', pattern: /\bdgram\b/u },
];

const collectSourceFiles = async (root: string): Promise<string[]> => {
  const absolute = join(workspaceRoot, root);
  const entries = await readdir(absolute, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && ['.ts', '.js', '.mjs'].includes(extname(entry.name)))
    .filter((entry) => !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.bench.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
};

describe('local-only surface', () => {
  it('contains no listening socket or outbound network call in product source', async () => {
    const files = (await Promise.all(scannedRoots.map(collectSourceFiles))).flat();
    expect(files.length).toBeGreaterThan(20);

    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      source.split(/\r?\n/u).forEach((line, index) => {
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) {
          return;
        }
        for (const { name, pattern } of forbidden) {
          if (pattern.test(line)) {
            violations.push(
              `${relative(workspaceRoot, file)}:${index + 1} ${name} -> ${line.trim()}`,
            );
          }
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('never advertises a host or port in the shipped MCP configuration templates', async () => {
    const templates = [
      'packaging/claude-mcpb/manifest.json',
      'packaging/codex-plugin/librewolf-agent-bridge/.mcp.json',
    ];
    for (const template of templates) {
      const content = await readFile(join(workspaceRoot, template), 'utf8');
      // stdio transport only: no URL-based MCP endpoint may appear.
      expect(content).not.toMatch(/"(?:url|endpoint|host|port)"\s*:/u);
      expect(content).not.toMatch(/https?:\/\/(?!.*(?:github|modelcontextprotocol|mozilla))/u);
    }
  });
});
