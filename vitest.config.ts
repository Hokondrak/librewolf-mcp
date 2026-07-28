import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@librewolf-agent-bridge/protocol': fromRoot('./packages/protocol/src/index.ts'),
      '@librewolf-agent-bridge/security': fromRoot('./packages/security/src/index.ts'),
      '@librewolf-agent-bridge/librewolf-locator': fromRoot(
        './packages/librewolf-locator/src/index.ts',
      ),
      '@librewolf-agent-bridge/snapshot-engine': fromRoot(
        './packages/snapshot-engine/src/index.ts',
      ),
      '@librewolf-agent-bridge/browser-core': fromRoot('./packages/browser-core/src/index.ts'),
      'librewolf-agent-bridge': fromRoot('./apps/mcp-server/src/index.ts'),
    },
  },
  test: {
    include: [
      'packages/**/*.test.ts',
      'apps/**/*.test.ts',
      'extension/tests/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    // The live e2e suite gates itself on LIBREWOLF_AGENT_BRIDGE_E2E and a built CLI, so it is
    // collected here and skips rather than failing on machines without LibreWolf.
    benchmark: {
      include: ['packages/**/*.bench.ts', 'tests/**/*.bench.ts'],
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts', 'extension/src/**/*.ts'],
    },
    testTimeout: 20_000,
  },
});
