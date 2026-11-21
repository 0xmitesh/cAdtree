import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryFileSystemAdapter, type FileSystemDirectoryAdapter } from './fs-adapter';
import { withProjectWriterLock, type ProjectWriterLock } from './locks';
import { openExistingVault } from './vault-service';
import { captureRevision, captureUnderLock, WorkingFilesChangedError } from './revision-service';
import { enumerateWorkingFolder, partitionSystemFiles } from './scanner';
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

/** The tracked content of a folder: untracked OS clutter is left out unless listed in `tracked`. */
async function snapshotOf(dir: FileSystemDirectoryAdapter, tracked: string[] = []): Promise<ExpectedWorkingSnapshot> {
  const listed = await enumerateWorkingFolder(dir);
  const files = partitionSystemFiles(listed.files, new Set(tracked)).files;
  return { files: files.map(({ path, sha256, size }) => ({ path, sha256, size })), directories: listed.directories };
}
/** Every file (with bytes' hash) and folder in the vault, to prove nothing was written. */
const vaultTree = async (p: P) => {
  const listed = await enumerateWorkingFolder(p.vault);
  return JSON.stringify({ files: listed.files.map(({ path, sha256, size }) => ({ path, sha256, size })), directories: listed.directories });
};

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
    withProjectWriterLock(projectId, (lock) => captureUnderLock(b.main, b.vault, input(b, 'First'), projectId, lock)),
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

test('captureUnderLock refuses a lock token for another project or one already released, before writing anything', async () => {
  const p = await project();
  const other = await project();
  await p.main.writeFileText(part, 'one');
  const projectId = p.created.record.projectId;
  const before = await vaultTree(p);
  await withProjectWriterLock(other.created.record.projectId, (lock) =>
    assert.rejects(captureUnderLock(p.main, p.vault, input(p, 'First'), projectId, lock), /writer lock for this project is not held/));
  let released!: ProjectWriterLock;
  await withProjectWriterLock(projectId, async (lock) => { released = lock; });
  await assert.rejects(captureUnderLock(p.main, p.vault, input(p, 'First'), projectId, released), /writer lock for this project is not held/);
  assert.equal(await vaultTree(p), before);
});

test('expectedSnapshot: OS clutter listed in the snapshot counts as tracked and is saved, even if the parent version does not track it', async () => {
  const p = await project();
  await p.main.writeFileText(part, 'one');
  await captureRevision(p.main, p.vault, input(p, 'First'));
  await p.main.writeFileText(['Parts', '.DS_Store'], 'finder');
  await p.main.writeFileText(part, 'two');
  const expected = await snapshotOf(p.main, ['Parts/.DS_Store']);
  assert.ok(expected.files.some((f) => f.path === 'Parts/.DS_Store'));
  const saved = await captureRevision(p.main, p.vault, input(p, 'Second', { expectedSnapshot: expected }));
  assert.deepEqual(saved.revision.manifest.files.map((f) => f.path), ['Parts/.DS_Store', 'Parts/Collar.SLDPRT']);
});

test('expectedSnapshot: untracked OS clutter that appears but is not listed is ignored, and the save goes ahead', async () => {
  const p = await project();
  await p.main.writeFileText(part, 'one');
  const expected = await snapshotOf(p.main);
  await p.main.writeFileText(['Parts', 'Thumbs.db'], 'thumbs');
  const saved = await captureRevision(p.main, p.vault, input(p, 'First', { expectedSnapshot: expected }));
  assert.deepEqual(saved.revision.manifest.files.map((f) => f.path), ['Parts/Collar.SLDPRT']);
});

test('expectedSnapshot: a lock file that appears after the scan does not trip the "files changed while saving" check', async () => {
  const p = await project();
  await p.main.writeFileText(part, 'one');
  const expected = await snapshotOf(p.main);
  await p.main.writeFileText(['Parts', '~$Collar.SLDPRT'], 'owner');
  await p.main.writeFileText(['Parts', 'Collar.SLDPRT.bak'], 'backup');
  const saved = await captureRevision(p.main, p.vault, input(p, 'First', { expectedSnapshot: expected }));
  assert.deepEqual(saved.revision.manifest.files.map((f) => f.path), ['Parts/Collar.SLDPRT']);
});

test('expectedSnapshot listing a path or folder twice is a programming error, not a working-folder change; nothing is written', async () => {
  const p = await project();
  await p.main.writeFileText(part, 'one');
  await p.main.getDirectory(['Drawings'], { create: true });
  const good = await snapshotOf(p.main);
  const before = await vaultTree(p);
  for (const bad of [{ ...good, files: [...good.files, good.files[0]] }, { ...good, directories: [...good.directories, good.directories[0]] }]) {
    await assert.rejects(
      captureRevision(p.main, p.vault, input(p, 'First', { expectedSnapshot: bad })),
      (error: unknown) => error instanceof Error && !(error instanceof WorkingFilesChangedError) && /Invalid expected snapshot/.test(error.message),
    );
  }
  assert.equal(await vaultTree(p), before);
});

const mismatches: { name: string; change: (p: P) => Promise<void> }[] = [
  { name: 'file added', change: (p) => p.main.writeFileText(['Parts', 'New.SLDPRT'], 'new') },
  { name: 'file removed', change: (p) => p.main.removeEntry(['Parts', 'Keep.SLDPRT']) },
  { name: 'file bytes changed (same size)', change: (p) => p.main.writeFileText(part, 'TWO') },
  { name: 'folder added', change: async (p) => { await p.main.getDirectory(['Extra'], { create: true }); } },
  { name: 'file renamed by letter case only', change: async (p) => { await p.main.removeEntry(part); await p.main.writeFileText(['Parts', 'collar.SLDPRT'], 'two'); } },
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
