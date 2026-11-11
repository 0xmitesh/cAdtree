import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryFileSystemAdapter, type FileSystemDirectoryAdapter } from './fs-adapter';
import { openExistingVault } from './vault-service';
import { captureRevision, MAX_REVISION_ID_ATTEMPTS, revisionCompletionPath, revisionManifestPath } from './revision-service';
import { createProject, createWorkspace, createManagedBranch, resolveManagedProject, type ManagedProject } from './workspace-service';
import { prepareApplyPreview, buildApplyPreview, type PreviewChoice } from './apply-preview';
import { applicationReview, prepareApplication, applyPreparedApplication } from './application-service';
import { compareSavedRevisions } from './snapshot-comparison';
import { restoreRevisionToFolder } from './recovery-service';
import { prepareReviewExport, exportRevisionForReview } from './review-export';
import { componentRecordPath } from './component-identity';
import { referenceContextPath } from './references';
import { isRecordId, newRecordId } from './ids';
import { matchInternalPath, internalReserve, CRSWAP_CHARS } from './path-budget';
import { layoutRevisions } from '../history/layout';
import { fileHistory } from '../history/file-history';
import { buildKnowledgeIndex } from '../knowledge';
import { createKnowledgeRecord, readKnowledgeRecord } from '../knowledge/records';
import { MAIN_BRANCH_ID } from './types';

const notes = { problem: 'p', modification: 'm', observations: 'o' };
const part = ['Parts', 'Collar.SLDPRT'];
/** Valid record IDs whose text order is the REVERSE of creation order, to prove order never comes from ID text. */
const DESC = (n: number) => `${String(20261231 - n)}-000000-aaaaa${n}`;

async function project() {
  const root = new InMemoryFileSystemAdapter('Workspace');
  await createWorkspace(root);
  const created = await createProject(root, 'Gripper');
  const main = created.workingFolders[MAIN_BRANCH_ID]!;
  return { root, created, main, vault: created.vaultDir, containerPath: created.record.containerPath };
}
type P = Awaited<ReturnType<typeof project>>;
const save = async (p: P, content: string, summary: string, newRevisionId?: () => string, extra: Partial<Parameters<typeof captureRevision>[2]> = {}) => {
  await p.main.writeFileText(part, content);
  return (await captureRevision(p.main, p.vault, { branchId: MAIN_BRANCH_ID, summary, notes, workingFolders: p.created.workingFolders, newRevisionId, ...extra })).revision.manifest.revisionId;
};
const has = (d: FileSystemDirectoryAdapter, path: string[]) => d.hasFile(path);

async function applyOnto(vault: FileSystemDirectoryAdapter, workingFolders: ManagedProject['workingFolders'], sourceRevisionId: string, targetBranchId: string) {
  const state = await openExistingVault(vault);
  const prepared = prepareApplyPreview(state, sourceRevisionId, targetBranchId);
  if (prepared.status !== 'available') throw new Error(prepared.reason);
  const selection: Record<string, PreviewChoice> = Object.fromEntries(
    prepared.context.rows.filter((r) => r.kind === 'available' || r.kind === 'conflict').map((r) => [r.path, { selected: true, decision: 'use-source' as const }]),
  );
  assert.ok(Object.keys(selection).length > 0);
  const review = applicationReview(buildApplyPreview(prepared.context, selection, 'Apply'), selection);
  const plan = await prepareApplication(vault, review, { workingFolders });
  return applyPreparedApplication(vault, plan, { workingFolders });
}

test('a new revision gets a record ID used by manifest, completion, component and reference files; every consumer works on it', async () => {
  const p = await project();
  const writes: string[] = [];
  p.root.setHooks({ onBeforeWrite: (full) => { writes.push(full); } });
  const id1 = await save(p, 'one', 'First');
  const id2 = await save(p, 'two', 'Second');
  assert.ok(isRecordId(id1) && id1.length === 22, id1);
  for (const id of [id1, id2]) {
    assert.ok(await has(p.vault, revisionManifestPath(id)));
    assert.ok(await has(p.vault, revisionCompletionPath(id)));
    assert.ok(await has(p.vault, componentRecordPath(id)));
    assert.ok(await has(p.vault, referenceContextPath(id)));
  }
  const state = await openExistingVault(p.vault);
  assert.deepEqual(state.revisions.map((r) => r.manifest.revisionId), [id1, id2]);
  assert.equal(state.revisions[1].manifest.parentRevisionId, id1);
  assert.ok(state.revisions.every((r) => r.integrityStatus !== 'corrupted'));
  assert.deepEqual(state.incompleteAttempts, []);

  const graph = layoutRevisions(state, MAIN_BRANCH_ID);
  assert.deepEqual(graph.nodes.map((n) => n.id).sort(), [id1, id2].sort());
  assert.deepEqual(graph.edges.map((e) => [e.child, e.parent]), [[id2, id1]]);
  const compared = compareSavedRevisions(state, id1, id2);
  assert.equal(compared.status, 'compared');
  const history = fileHistory(state, graph, part.join('/'));
  assert.ok(history.records.has(id1) && history.records.has(id2));

  const exportParent = new InMemoryFileSystemAdapter('Reviews');
  const plan = prepareReviewExport(state, id1, { kind: 'complete', selectedPaths: [], labelFilenames: false });
  await exportRevisionForReview({ vaultDir: p.vault, parent: exportParent, plan, folderName: plan.folderName, workingFolders: p.created.workingFolders });
  assert.equal(await (await exportParent.getDirectory([plan.folderName])).readFileText(part), 'one');

  const dest = await p.root.getDirectory(['Recovered'], { create: true });
  await restoreRevisionToFolder({ vaultDir: p.vault, destinationDir: dest, revisionId: id1 });
  assert.equal(await dest.readFileText(part), 'one');

  // Apply into a design case created from the new revision.
  const withCase = await createManagedBranch(p.root, p.containerPath, { sourceRevisionId: id1, name: 'Alt', reason: 'r' });
  await applyOnto(p.vault, withCase.workingFolders, id2, withCase.createdBranchId);
  assert.equal(await withCase.workingFolders[withCase.createdBranchId]!.readFileText(part), 'two');
  const reopened = await resolveManagedProject(p.root, p.containerPath);
  assert.ok(reopened.workingFolders[withCase.createdBranchId]);

  const prefix = `Workspace/${p.containerPath}/`;
  for (const full of writes.filter((w) => w.startsWith(prefix))) {
    const rel = full.slice(prefix.length);
    if (/^working\/|^recoveries\//.test(rel)) continue;
    const label = matchInternalPath(rel, 'file');
    assert.ok(label, `unlisted path ${rel}`);
    assert.ok(!label!.includes('(legacy'), `${rel} hit ${label}`);
    assert.ok(rel.length + CRSWAP_CHARS <= internalReserve(), rel);
  }
});

test('a revision-ID clash draws a new ID before anything else is written and never touches the first revision', async () => {
  const p = await project();
  const fixed = '20260101-000000-aaaaaa', alt = '20260101-000000-bbbbbb';
  assert.equal(await save(p, 'one', 'First', () => fixed), fixed);
  const files = [revisionManifestPath(fixed), revisionCompletionPath(fixed), componentRecordPath(fixed), referenceContextPath(fixed)];
  const snap = async () => JSON.stringify(await Promise.all(files.map((f) => p.vault.readFileText(f))));
  const before = await snap();
  const queue = [fixed, fixed, alt];
  assert.equal(await save(p, 'two', 'Second', () => queue.shift()!), alt);
  assert.equal(await snap(), before);
  const state = await openExistingVault(p.vault);
  assert.deepEqual(state.revisions.map((r) => r.manifest.revisionId), [fixed, alt]);
  assert.deepEqual(state.incompleteAttempts, []);
});

test('a leftover attempt (staging session) with the drawn ID is a clash; retries are bounded and write nothing', async () => {
  const p = await project();
  await save(p, 'one', 'First');
  const taken = '20260101-000000-cccccc';
  await save(p, 'two', 'Second', () => taken);
  // Leftover from a failed capture: same session folder name, no manifest.
  const { getStagingSessionPathSegments } = await import('./object-store');
  const leftover = '20260101-000000-dddddd';
  await p.vault.getDirectory(getStagingSessionPathSegments(`session-${leftover}`), { create: true });
  await p.main.writeFileText(part, 'three');
  const stagingBefore = (await (await p.vault.getDirectory(['staging'])).listEntries()).map((e) => e.name).sort();
  let calls = 0;
  await assert.rejects(
    captureRevision(p.main, p.vault, { branchId: MAIN_BRANCH_ID, summary: 'Third', notes, workingFolders: p.created.workingFolders, newRevisionId: () => { calls++; return calls % 2 ? leftover : taken; } }),
    /No free revision ID after 5 attempts\. Nothing was written/,
  );
  assert.equal(calls, MAX_REVISION_ID_ATTEMPTS);
  assert.deepEqual((await (await p.vault.getDirectory(['staging'])).listEntries()).map((e) => e.name).sort(), stagingBefore);
  assert.equal((await openExistingVault(p.vault)).revisions.length, 2);
  // A fresh draw still works afterwards.
  assert.ok(isRecordId(await save(p, 'three', 'Third')));
});

test('history whose record IDs sort against creation order loads, verifies, keeps order, compares and applies', async () => {
  const p = await project();
  const o1 = await save(p, 'v1', 'One', () => DESC(1));
  const o2 = await save(p, 'v2', 'Two', () => DESC(2));
  const n3 = await save(p, 'v3', 'New three');
  const n4 = await save(p, 'v4', 'New four');
  assert.equal(o1, DESC(1));
  assert.ok(isRecordId(o1) && isRecordId(n3) && isRecordId(n4));
  const state = await openExistingVault(p.vault);
  assert.deepEqual(state.revisions.map((r) => r.manifest.revisionId), [o1, o2, n3, n4]);
  assert.deepEqual(state.revisions.map((r) => r.manifest.parentRevisionId), [null, o1, o2, n3]);
  assert.ok(state.revisions.every((r) => r.integrityStatus !== 'corrupted'));
  assert.equal(state.references?.status, 'available');
  assert.equal(state.components?.status, 'available');
  assert.deepEqual(state.incompleteAttempts, []);
  assert.deepEqual(state.branchHeads[MAIN_BRANCH_ID], n4);

  const graph = layoutRevisions(state, MAIN_BRANCH_ID);
  // Order comes from parents and display numbers (newest first), never from the ID text.
  assert.deepEqual(graph.nodes.map((n) => n.id), [n4, n3, o2, o1]);
  assert.deepEqual(graph.edges.map((e) => [e.child, e.parent]).sort(), [[o2, o1], [n3, o2], [n4, n3]].sort());
  assert.equal(graph.warnings.length, 0);
  assert.equal(compareSavedRevisions(state, o1, n4).status, 'compared');
  assert.equal(compareSavedRevisions(state, n3, o2).status, 'compared');

  // Case from an old revision, applying a new one; and the reverse.
  const fromOld = await createManagedBranch(p.root, p.containerPath, { sourceRevisionId: o1, name: 'From old', reason: 'r' });
  await applyOnto(p.vault, fromOld.workingFolders, n4, fromOld.createdBranchId);
  assert.equal(await fromOld.workingFolders[fromOld.createdBranchId]!.readFileText(part), 'v4');
  const fromNew = await createManagedBranch(p.root, p.containerPath, { sourceRevisionId: n3, name: 'From new', reason: 'r' });
  const caseDir = fromNew.workingFolders[fromNew.createdBranchId]!;
  await caseDir.writeFileText(['Other', 'Extra.SLDPRT'], 'extra');
  const caseRev = (await captureRevision(caseDir, p.vault, { branchId: fromNew.createdBranchId, summary: 'Case', notes, workingFolders: fromNew.workingFolders, newRevisionId: () => DESC(9) })).revision;
  assert.equal(caseRev.manifest.parentRevisionId, n3);
  assert.equal(compareSavedRevisions(await openExistingVault(p.vault), o1, DESC(9)).status, 'compared');
});

test('Knowledge Lab records can cite record-ID revisions', async () => {
  const p = await project();
  const oldId = await save(p, 'v1', 'First');
  const newId = await save(p, 'v2', 'Second');
  const state = await openExistingVault(p.vault);
  const projectId = state.project.projectId;
  assert.equal(buildKnowledgeIndex(state).revisions.length, 2);
  for (const [n, revisionId] of [[1, oldId], [2, newId]] as const) {
    const componentId = state.components!.revisions[revisionId].files[0].componentId;
    const recordId = `20260101-000000-${String(n).padStart(6, '0')}`;
    const created = await createKnowledgeRecord(p.vault, {
      projectId, recordId, recordType: 'generic.observation', schemaVersion: 1,
      payload: { description: 'note', attributes: {} }, provenance: { kind: 'user-entered' },
      relationships: [
        { relation: 'context', target: { kind: 'revision', projectId, revisionId } },
        { relation: 'related', target: { kind: 'component', projectId, revisionId, componentId } },
      ],
    });
    assert.deepEqual(created.record.relationships.map((r) => r.binding.kind), ['revision', 'component']);
    assert.deepEqual(await readKnowledgeRecord(p.vault, projectId, recordId), created);
  }
  assert.equal((await openExistingVault(p.vault)).knowledge!.records.length, 2);
});


test('a leftover staging folder from an interrupted capture is reported as staging_artifact and stays harmless', async () => {
  const p = await project();
  const { getStagingSessionPathSegments } = await import('./object-store');
  const leftover = getStagingSessionPathSegments(`session-${newRecordId()}`);
  await p.vault.getDirectory(leftover, { create: true });
  await p.vault.writeFileText([...leftover, 'orphan.tmp'], 'partial');
  const state = await openExistingVault(p.vault);
  assert.ok(state.incompleteAttempts.some((a) => a.kind === 'staging_artifact' && a.path === leftover.join('/')));
  assert.equal(await p.vault.readFileText([...leftover, 'orphan.tmp']), 'partial');
  assert.ok(isRecordId(await save(p, 'after-leftover', 'After leftover')));
  assert.equal(await p.vault.readFileText([...leftover, 'orphan.tmp']), 'partial');
});
