#!/usr/bin/env node

import { validateLaunchArguments } from './launch-arguments.js';
import { NativeHostRuntime } from './runtime.js';

async function main(): Promise<void> {
  const launch = validateLaunchArguments(process.argv.slice(2));
  const runtime = new NativeHostRuntime({
    input: process.stdin,
    output: process.stdout,
    identity: {
      extensionId: launch.extensionId,
      extensionVersion: '0.1.0',
      manifestVersion: 3,
      hostVersion: '0.1.0',
      browserName: 'LibreWolf',
      browserVersion: 'unknown',
    },
  });
  await runtime.run();
}

void main().catch((error: unknown) => {
  // Native messaging reserves stdout exclusively for length-prefixed protocol frames.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[librewolf-agent-host] ${message.slice(0, 500)}\n`);
  process.exitCode = 1;
});
