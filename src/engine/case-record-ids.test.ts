import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryFileSystemAdapter, type FileSystemDirectoryAdapter } from './fs-adapter';
import { openExistingVault, initializeProjectVault } from './vault-service';
import { captureRevision } from './revision-service';
import { createProject, createWorkspace, createManagedBranch, adoptProject, resolveManagedProject, type ManagedProject } from './workspace-service';
import { createDesignBranch, branchAttemptPath, MAX_BRANCH_ID_ATTEMPTS } from './branch-service';
import { prepareApplyPreview, buildApplyPreview, type PreviewChoice } from './apply-preview';
import { applicationReview, prepareApplication, applyPreparedApplication, recoverApplication } from './application-service';
import { branchApplications } from './application-records';
import { caseLifecycle } from './case-lifecycle';
import { changeCaseLifecycle } from './case-lifecycle-service';
import { isRecordId } from './ids';
import { matchInternalPath, internalReserve, CRSWAP_CHARS } from './path-budget';
import { MAIN_BRANCH_ID } from './types';

const notes = { problem: 'p', modification: 'm', observations: 'o' };
const part = ['Parts', 'Collar.SLDPRT'];
const bracket = ['Other', 'Bracket.SLDPRT'];
const OLD_ID = 'branch-0b1c2d3e-0000-4000-8000-00000000abcd';

async function project() {
  const root = new InMemoryFileSystemAdapter('Workspace');
  await createWorkspace(root);
  const created = await createProject(root, 'Gripper');
  const main = created.workingFolders[MAIN_BRANCH_ID]!;
  await main.writeFileText(part, 'base');
  await main.writeFileText(bracket, 'bracket');
  const first = await captureRevision(main, created.vaultDir, { branchId: MAIN_BRANCH_ID, summary: 'Base', notes, workingFolders: created.workingFolders });
  return { root, created, main, firstId: first.revision.manifest.revisionId, containerPath: created.record.containerPath };
}
const has = (dir: FileSystemDirectoryAdapter, path: string[]) => dir.hasFile(path);

async function applyOnto(vault: FileSystemDirectoryAdapter, workingFolders: ManagedProject['workingFolders'], sourceRevisionId: string, targetBranchId: string, failEvent?: (on: boolean) => void) {
  const state = await openExistingVault(vault);
  const prepared = prepareApplyPreview(state, sourceRevisionId, targetBranchId);
  if (prepared.status !== 'available') throw new Error(prepared.reason);
  const selection: Record<string, PreviewChoice> = Object.fromEntries(
    prepared.context.rows.filter((r) => r.kind === 'available' || r.kind === 'conflict')
      .map((r) => [r.path, { selected: true, decision: 'use-source' as const }]),
  );
  assert.ok(Object.keys(selection).length > 0);
  const review = applicationReview(buildApplyPreview(prepared.context, selection, 'Apply'), selection);
  const plan = await prepareApplication(vault, review, { workingFolders });
  failEvent?.(true);
  return { plan, run: () => applyPreparedApplication(vault, plan, { workingFolders }) };
}

test('a new case gets a record ID used by every record; save, interrupted apply, recovery and archive work', async () => {
  const { root, created, main, firstId, containerPath } = await project();
  const vault = created.vaultDir;
  const writes: string[] = [];
  let failEvent = false;
  root.setHooks({
    onBeforeWrite: (full) => {
      writes.push(full);
      if (failEvent && full.includes('/events/') && full.endsWith('000004.json')) throw new Error('lost final');
    },
  });
  const withCase = await createManagedBranch(root, containerPath, { sourceRevisionId: firstId, name: 'Lighter collar', reason: 'Mass' });
  const id = withCase.createdBranchId;
  assert.ok(isRecordId(id), id);
  assert.equal(id.length, 22);
  // Folder is the readable name; every record uses the ID.
  assert.equal(withCase.workingPaths[id], `${containerPath}/working/Lighter collar`);
  const projectDir = await root.getDirectory(containerPath.split('/'));
  assert.ok(await has(projectDir, ['.cadtree', 'branches', `${id}.json`]));
  assert.ok(await has(vault, ['branches', `${id}.branch.json`]));
  assert.ok(await has(vault, ['branches', `${id}.ready.json`]));
  assert.ok(writes.some((w) => w.endsWith(`/staging/${id}.branch-attempt.json`)), 'staging attempt used the ID');
  assert.equal(await has(vault, branchAttemptPath(id)), false, 'attempt removed after publication');
  const reopened = await resolveManagedProject(root, containerPath);
  assert.ok(reopened.workingFolders[id]);

  // Save on the case.
  const caseDir = withCase.workingFolders[id]!;
  await caseDir.writeFileText(part, 'lighter');
  const save = await captureRevision(caseDir, vault, { branchId: id, summary: 'Lighter', notes, workingFolders: withCase.workingFolders });
  assert.equal(save.revision.manifest.branchId, id);

  // Main moves on; apply it onto the case, losing the last event (interrupted apply).
  await main.writeFileText(bracket, 'bracket v2');
  const mainSave = await captureRevision(main, vault, { branchId: MAIN_BRANCH_ID, summary: 'v2', notes, workingFolders: withCase.workingFolders });
  const { run } = await applyOnto(vault, withCase.workingFolders, mainSave.revision.manifest.revisionId, id, (on) => { failEvent = on; });
  await assert.rejects(run(), /lost final/);
  failEvent = false;
  // Recovery meets an unexpected edit, keeps a copy, then completes.
  await caseDir.writeFileText(bracket, 'unexpected edit');
  const op = branchApplications(await openExistingVault(vault), id).at(-1)!;
  const recovered = await recoverApplication(vault, withCase.record.projectId, id, op.operationId, { workingFolders: withCase.workingFolders });
  assert.deepEqual(recovered.manualPaths, [bracket.join('/')]);
  await caseDir.writeFileText(bracket, 'bracket');
  await recoverApplication(vault, withCase.record.projectId, id, op.operationId, { workingFolders: withCase.workingFolders });

  // Archive.
  const state = await openExistingVault(vault);
  await changeCaseLifecycle(vault, { projectId: withCase.record.projectId, branchId: id, activeBranchId: MAIN_BRANCH_ID, status: 'archived', expectedVersion: caseLifecycle(state, id).version }, { workingFolders: withCase.workingFolders });
  const final = await openExistingVault(vault);
  assert.equal(caseLifecycle(final, id).status, 'archived');
  assert.ok((await vault.listEntries()).some((e) => e.name === 'case-lifecycle'));

  // Every internal path written under the project fits the new-record reserve and no legacy shape.
  const prefix = `Workspace/${containerPath}/`;
  for (const full of writes.filter((w) => w.startsWith(prefix))) {
    const rel = full.slice(prefix.length);
    if (/^working\/|^recoveries\//.test(rel)) continue;
    const label = matchInternalPath(rel, 'file');
    assert.ok(label, `unlisted path ${rel}`);
    assert.ok(!label!.includes('(legacy'), `${rel} hit ${label}`);
    assert.ok(rel.length + CRSWAP_CHARS <= internalReserve(), rel);
  }
});

test('a record-ID clash draws a new ID and never touches the first case', async () => {
  const { root, containerPath, firstId } = await project();
  const fixed = '20260101-000000-aaaaaa';
  const alt = '20260101-000000-bbbbbb';
  const first = await createManagedBranch(root, containerPath, { sourceRevisionId: firstId, name: 'First', reason: 'r', newBranchId: () => fixed });
  assert.equal(first.createdBranchId, fixed);
  const vault = first.vaultDir;
  const snap = async () => JSON.stringify([
    await vault.readFileText(['branches', `${fixed}.branch.json`]),
    await vault.readFileText(['branches', `${fixed}.ready.json`]),
  ]);
  const before = await snap();
  const queue = [fixed, fixed, alt];
  const second = await createManagedBranch(root, containerPath, { sourceRevisionId: firstId, name: 'Second', reason: 'r', newBranchId: () => queue.shift()! });
  assert.equal(second.createdBranchId, alt);
  assert.equal(await snap(), before);
  const state = await openExistingVault(vault);
  assert.deepEqual(state.branches.map((b) => b.branchId).sort(), [MAIN_BRANCH_ID, fixed, alt].sort());
});

test('a leftover staging attempt with the drawn ID counts as a clash (exclusive write), and retries are bounded', async () => {
  const { created, main, firstId } = await project();
  const vault = created.vaultDir;
  const taken = '20260101-000000-cccccc';
  await vault.writeFileText(branchAttemptPath(taken), 'leftover from a failed attempt');
  const parent = new InMemoryFileSystemAdapter('Cases');
  const base = { vaultDir: vault, destinationParent: parent, workingFolders: { [MAIN_BRANCH_ID]: main }, sourceRevisionId: firstId, reason: 'r' };
  const ok = await createDesignBranch({ ...base, name: 'A', newBranchId: (() => { const q = [taken, '20260101-000000-dddddd']; return () => q.shift()!; })() });
  assert.equal(ok.branch.branchId, '20260101-000000-dddddd');
  assert.equal(await vault.readFileText(branchAttemptPath(taken)), 'leftover from a failed attempt');
  let draws = 0;
  await assert.rejects(createDesignBranch({ ...base, workingFolders: { [MAIN_BRANCH_ID]: main, [ok.branch.branchId]: ok.workingDir }, name: 'B', newBranchId: () => { draws++; return taken; } }), /No free design case ID/);
  assert.equal(draws, MAX_BRANCH_ID_ATTEMPTS);
  assert.equal((await parent.listEntries()).length, 1, 'no working folder was created for the rejected case');
});

test('a project with an OLD branch-<uuid> case and a NEW case loads, lists in name order, and applies between them', async () => {
  const { root, created, main, firstId, containerPath } = await project();
  const oldCase = await createManagedBranch(root, containerPath, { sourceRevisionId: firstId, name: 'Zeta old', reason: 'r', newBranchId: () => OLD_ID });
  const newCase = await createManagedBranch(root, containerPath, { sourceRevisionId: firstId, name: 'Alpha new', reason: 'r' });
  assert.equal(oldCase.createdBranchId, OLD_ID);
  assert.ok(isRecordId(newCase.createdBranchId));
  const reopened = await resolveManagedProject(root, containerPath);
  assert.equal(reopened.vaultState.branches[0].isMain, true);
  assert.deepEqual(reopened.vaultState.branches.slice(1).map((b) => b.name), ['Alpha new', 'Zeta old']);
  assert.ok(reopened.workingFolders[OLD_ID] && reopened.workingFolders[newCase.createdBranchId]);

  // Save on the old case, apply onto the new case.
  const oldDir = reopened.workingFolders[OLD_ID]!;
  await oldDir.writeFileText(part, 'old case edit');
  const oldSave = await captureRevision(oldDir, created.vaultDir, { branchId: OLD_ID, summary: 'Old edit', notes, workingFolders: reopened.workingFolders });
  const { plan, run } = await applyOnto(created.vaultDir, reopened.workingFolders, oldSave.revision.manifest.revisionId, newCase.createdBranchId);
  assert.ok(plan);
  await run();
  const applied = branchApplications(await openExistingVault(created.vaultDir), newCase.createdBranchId).at(-1)!;
  assert.ok(applied.operationId);
  assert.equal(await reopened.workingFolders[newCase.createdBranchId]!.readFileText(part), 'old case edit');
  // Archiving the old case still works.
  const state = await openExistingVault(created.vaultDir);
  await changeCaseLifecycle(created.vaultDir, { projectId: created.record.projectId, branchId: OLD_ID, activeBranchId: MAIN_BRANCH_ID, status: 'archived', expectedVersion: caseLifecycle(state, OLD_ID).version }, { workingFolders: reopened.workingFolders });
  assert.equal(caseLifecycle(await openExistingVault(created.vaultDir), OLD_ID).status, 'archived');
});

test('adopting a vault that holds old-format and new-format cases binds both to their working folders', async () => {
  const main = new InMemoryFileSystemAdapter('Main');
  await main.writeFileText(part, 'base');
  const vault = new InMemoryFileSystemAdapter('Old vault');
  await initializeProjectVault(main, vault, 'Legacy');
  const first = await captureRevision(main, vault, { branchId: MAIN_BRANCH_ID, summary: 'Base', notes });
  const sourceRevisionId = first.revision.manifest.revisionId;
  const mk = async (name: string, id?: string, folders: Record<string, FileSystemDirectoryAdapter> = {}) =>
    createDesignBranch({ vaultDir: vault, destinationParent: new InMemoryFileSystemAdapter('Cases'), workingFolders: { [MAIN_BRANCH_ID]: main, ...folders }, sourceRevisionId, name, reason: 'r', ...(id ? { newBranchId: () => id } : {}) });
  const oldCase = await mk('Old case', OLD_ID);
  const newCase = await mk('New case', undefined, { [OLD_ID]: oldCase.workingDir });
  assert.ok(isRecordId(newCase.branch.branchId));
  const root = new InMemoryFileSystemAdapter('Workspace');
  await createWorkspace(root);
  const adopted = await adoptProject(root, vault, { [MAIN_BRANCH_ID]: main, [OLD_ID]: oldCase.workingDir, [newCase.branch.branchId]: newCase.workingDir });
  assert.equal(adopted.workingPaths[OLD_ID], 'projects/Legacy/working/Old case');
  assert.equal(adopted.workingPaths[newCase.branch.branchId], 'projects/Legacy/working/New case');
  const reopened = await resolveManagedProject(root, adopted.record.containerPath);
  assert.ok(reopened.workingFolders[OLD_ID] && reopened.workingFolders[newCase.branch.branchId]);
});

test('an injected case ID must be a safe segment and not branch-main; nothing is written otherwise', async () => {
  const { created, main, firstId } = await project();
  const vault = created.vaultDir;
  for (const bad of ['', 'branch-main', 'a/b', '..', 'x'.repeat(65), 'sp ace', 'a.b']) {
    const parent = new InMemoryFileSystemAdapter('Cases');
    const before = (await vault.listEntries()).map((e) => e.name).join();
    await assert.rejects(
      createDesignBranch({ vaultDir: vault, destinationParent: parent, workingFolders: { [MAIN_BRANCH_ID]: main }, sourceRevisionId: firstId, name: 'Bad', reason: 'r', newBranchId: () => bad }),
      /Invalid design case ID/,
    );
    assert.equal((await parent.listEntries()).length, 0);
    assert.equal(await vault.hasDirectory(['staging']) ? (await (await vault.getDirectory(['staging'])).listEntries()).some((e) => e.name.endsWith('.branch-attempt.json')) : false, false);
    assert.equal((await vault.listEntries()).map((e) => e.name).join(), before);
  }
});
