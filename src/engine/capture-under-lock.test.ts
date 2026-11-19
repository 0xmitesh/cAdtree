import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryFileSystemAdapter, type FileSystemDirectoryAdapter } from './fs-adapter';
import { withProjectWriterLock } from './locks';
import { openExistingVault } from './vault-service';
import { captureRevision, captureUnderLock, WorkingFilesChangedError } from './revision-service';
import { enumerateWorkingFolder } from './scanner';
import { createProject, createWorkspace } from './workspace-service';
import { MAIN_BRANCH_ID, type ExpectedWorkingSnapshot } from './types';

const notes = { problem: 'p', modification: 'm', observations: 'o' };
const part = ['Parts', 'Collar.SLDPRT'];

async function project() {
  const root = new InMemoryFileSystemAdapter('Workspace');
  await createWorkspace(root);
  const created = await createProject(root, 'Gripper');
  const main = created.workingFolders[MAIN_BRANCH_ID]!;
  return { root, created, main, vault: created.vaultDir };
}
type P = Awaited<ReturnType<typeof project>>;
const input = (p: P, summary: string, extra = {}) => ({ branchId: MAIN_BRANCH_ID, summary, notes, workingFolders: p.created.workingFolders, ...extra });

async function snapshotOf(dir: FileSystemDirectoryAdapter): Promise<ExpectedWorkingSnapshot> {
  const listed = await enumerateWorkingFolder(dir);
  return { files: listed.files.map(({ path, sha256, size }) => ({ path, sha256, size })), directories: listed.directories };
}
/** Every file (with bytes' hash) and folder in the vault, to prove nothing was written. */
const vaultTree = async (p: P) => JSON.stringify(await snapshotOf(p.vault));

const timeout = (ms: number) => new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms));

test('captureUnderLock runs inside a held project lock without deadlock and gives the same result as captureRevision', async () => {
  const a = await project();
  const b = await project();
  for (const p of [a, b]) {
    await p.main.writeFileText(part, 'one');
    await p.main.getDirectory(['Drawings', 'Empty'], { create: true });
  }
  const viaWrapper = await captureRevision(a.main, a.vault, input(a, 'First'));
  const projectId = b.created.record.projectId;
  const viaLock = await Promise.race([
    withProjectWriterLock(projectId, () => captureUnderLock(b.main, b.vault, input(b, 'First'), projectId)),
    timeout(5000),
  ]);
  assert.notEqual(viaLock, 'timeout', 'captureUnderLock under the held lock must finish');
  if (viaLock === 'timeout') return;
  const strip = (m: typeof viaWrapper.revision.manifest) => ({ files: m.files.map(({ path, sha256, size }) => ({ path, sha256, size })), directories: m.directories, summary: m.summary, notes: m.notes, displayNumber: m.displayNumber, parentRevisionId: m.parentRevisionId, branchId: m.branchId });
  assert.deepEqual(strip(viaLock.revision.manifest), strip(viaWrapper.revision.manifest));
  assert.equal(viaLock.revision.integrityStatus, viaWrapper.revision.integrityStatus);
  assert.equal(viaLock.cacheWarning, viaWrapper.cacheWarning);
  const state = await openExistingVault(b.vault);
  assert.deepEqual(state.revisions.map((r) => r.manifest.revisionId), [viaLock.revision.manifest.revisionId]);
  assert.equal(state.branchHeads[MAIN_BRANCH_ID], viaLock.revision.manifest.revisionId);
  assert.deepEqual(state.incompleteAttempts, []);
});

test('why captureUnderLock exists: captureRevision called while the same project lock is held waits for that lock', async () => {
  const p = await project();
  await p.main.writeFileText(part, 'one');
  const projectId = p.created.record.projectId;
  let nested!: Promise<unknown>;
  await withProjectWriterLock(projectId, async () => {
    nested = captureRevision(p.main, p.vault, input(p, 'Nested'));
    assert.equal(await Promise.race([nested.then(() => 'done'), timeout(200)]), 'timeout');
  });
  // It only proceeds once the outer holder released the lock: awaiting it inside would never return.
  await nested;
  assert.equal((await openExistingVault(p.vault)).revisions.length, 1);
});

test('expectedSnapshot: a capture whose fresh scan matches exactly is saved normally', async () => {
  const p = await project();
  await p.main.writeFileText(part, 'one');
  await p.main.getDirectory(['Drawings', 'Empty'], { create: true });
  const expected = await snapshotOf(p.main);
  const saved = await captureRevision(p.main, p.vault, input(p, 'First', { expectedSnapshot: expected }));
  assert.deepEqual(saved.revision.manifest.files.map((f) => f.path), ['Parts/Collar.SLDPRT']);
  // Also on top of an earlier revision (unchanged + modified files both count).
  await p.main.writeFileText(['Parts', 'Other.SLDPRT'], 'x');
  await p.main.writeFileText(part, 'two');
  const second = await captureRevision(p.main, p.vault, input(p, 'Second', { expectedSnapshot: await snapshotOf(p.main) }));
  assert.equal(second.revision.manifest.parentRevisionId, saved.revision.manifest.revisionId);
});

const mismatches: { name: string; change: (p: P) => Promise<void> }[] = [
  { name: 'file added', change: (p) => p.main.writeFileText(['Parts', 'New.SLDPRT'], 'new') },
  { name: 'file removed', change: (p) => p.main.removeEntry(['Parts', 'Keep.SLDPRT']) },
  { name: 'file bytes changed (same size)', change: (p) => p.main.writeFileText(part, 'TWO') },
  { name: 'folder added', change: async (p) => { await p.main.getDirectory(['Extra'], { create: true }); } },
  { name: 'folder removed', change: (p) => p.main.removeEntry(['Drawings', 'Empty'], { recursive: true }) },
];

for (const { name, change } of mismatches) {
  test(`expectedSnapshot mismatch (${name}): capture refuses and writes nothing to the vault`, async () => {
    const p = await project();
    await p.main.writeFileText(part, 'one');
    await p.main.writeFileText(['Parts', 'Keep.SLDPRT'], 'keep');
    await p.main.getDirectory(['Drawings', 'Empty'], { create: true });
    const first = await captureRevision(p.main, p.vault, input(p, 'First'));
    // The caller expects one more edit (the "plan's result"), then the folder drifts.
    await p.main.writeFileText(part, 'two');
    const expected = await snapshotOf(p.main);
    await change(p);
    const before = await vaultTree(p);
    let writes = 0; // capture writes only to the vault, so any write would count
    p.root.setHooks({ onBeforeWrite: () => { writes++; } });
    await assert.rejects(
      captureRevision(p.main, p.vault, input(p, 'Second', { expectedSnapshot: expected })),
      (error: unknown) => error instanceof WorkingFilesChangedError && error.message === 'The working files changed while saving; nothing was saved. Review the changes and save again.',
    );
    p.root.setHooks({});
    assert.equal(writes, 0);
    // Not even a staging session: the refusal comes before the first vault write.
    assert.equal(await vaultTree(p), before);
    const state = await openExistingVault(p.vault);
    assert.deepEqual(state.revisions.map((r) => r.manifest.revisionId), [first.revision.manifest.revisionId]);
    assert.deepEqual(state.incompleteAttempts, []);
  });
}
