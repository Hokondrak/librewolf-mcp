import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSnapshotSavePolicy, SnapshotEngine, SnapshotPolicyError } from '../src/index.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'snapshot-policy-test-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('FileSnapshotSavePolicy', () => {
  it('saves within the configured root with restrictive policy', async () => {
    const root = await temporaryRoot();
    const engine = new SnapshotEngine({
      savePolicy: new FileSnapshotSavePolicy({ rootDirectory: root }),
    });
    const result = await engine.createSnapshot(
      {
        text: 'uid=save button "Save" interactive',
        metadata: [{ upstreamUid: 'save', selectorFingerprint: '#save' }],
      },
      {
        sessionId: 'session',
        tabId: 'tab',
        frameId: 'top',
        navigationGeneration: 1,
        domGeneration: 1,
      },
      { saveToFile: 'artifacts/snapshot.txt' },
    );

    expect(result.savedFile?.path).toBe(join(root, 'artifacts', 'snapshot.txt'));
    await expect(fs.readFile(result.savedFile!.path, 'utf8')).resolves.toContain(
      'BEGIN UNTRUSTED WEBPAGE CONTENT',
    );
  });

  it('denies traversal outside the configured root', async () => {
    const root = await temporaryRoot();
    const policy = new FileSnapshotSavePolicy({ rootDirectory: root });

    await expect(
      policy.save({
        destination: '..\\escape.txt',
        content: 'unsafe',
        snapshotId: 'snap_1',
      }),
    ).rejects.toBeInstanceOf(SnapshotPolicyError);
  });
});
