import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryFileSystemAdapter, type FileSystemDirectoryAdapter } from './fs-adapter';
import { initializeProjectVault, openExistingVault } from './vault-service';
import { captureRevision } from './revision-service';
import { scanBranchChanges } from './scanner';
import { getBranchBaseline } from './branch-state';
import { createIdentityReview } from './component-identity';
import { createDesignBranch } from './branch-service';
import { getObjectPathSegments } from './object-store';
import { restoreRevisionToFolder } from './recovery-service';
import { createWorkspace, createProject, importProject, adoptProject, openWorkspace } from './workspace-service';
import { createHome, bringWorkspaceIntoHome } from './home-service';
import { copyVerifiedTree, readVerifiedInventory, inventorySignature } from './copy-service';
import { prepareReviewExport, exportRevisionForReview } from './review-export';
import { importReferenceAttachment, updateProjectReference, retrieveReferenceAttachment, createReferenceReview, referenceChecksum, referenceContextSignature, capturedReferenceLibrary } from './references';
import type { CaptureRevisionInput, VaultState } from './types';

const branchId = 'branch-main';
const notes = { problem: 'Requirement', modification: 'Clearance', observations: '' };
const metadata = { title: 'Clearance requirement', description: 'User supplied source', tags: ['fit', '客户'] };
const original = new Uint8Array([0, 255, 10, 13, 128, 42]);
const attachment = (name = '客户 requirement.pdf', bytes = original) => ({ name, type: 'application/pdf', size: bytes.length, stream: () => new Blob([bytes as BlobPart]).stream() });
const inventory = async (dir: FileSystemDirectoryAdapter) => inventorySignature(await readVerifiedInventory(dir));
const context = (state: VaultState, revisionId: string) => state.references!.contexts[revisionId].record!;

test('saved reference authors survive reopen and later uploads without rewriting earlier authors or guessing legacy attribution', async () => {
  const f = await fixture();
  assert.equal(f.version.savedBy, undefined);
  const author = { id: 'engineer-a', displayName: 'Asha' };
  let state = await importReferenceAttachment(f.vault, f.projectId, attachment('Review.pdf'), metadata, f.ref.referenceId, { savedBy: author });
  const savedVersion = state.references!.library[0].versions[1];
  author.displayName = 'Changed outside the store';
  await updateProjectReference(f.vault, f.projectId, f.ref.referenceId, { projectVersionId: savedVersion.versionId });
  await f.working.writeFileText(['Part.SLDPRT'], 'geometry');
  const saved = await f.save();
  const manifestPath = ['revisions', `${saved.revision.manifest.revisionId}.manifest.json`];
  const originalManifest = await f.vault.readFileText(manifestPath);
  state = await importReferenceAttachment(f.vault, f.projectId, attachment('Later.pdf'), metadata, f.ref.referenceId, { savedBy: { id: 'engineer-b', displayName: 'Ben' } });
  const latestVersion = state.references!.library[0].versions[2];
  await updateProjectReference(f.vault, f.projectId, f.ref.referenceId, { projectVersionId: latestVersion.versionId });
  const reopened = await openExistingVault(f.vault);
  const pinned = capturedReferenceLibrary(reopened, saved.revision.manifest.revisionId)[0].versions.find(v => v.versionId === savedVersion.versionId)!;
  assert.deepEqual(pinned.savedBy, { id: 'engineer-a', displayName: 'Asha' });
  assert.equal(pinned.importedAt, savedVersion.importedAt);
  assert.deepEqual(reopened.references!.library[0].versions[2].savedBy, { id: 'engineer-b', displayName: 'Ben' });
  assert.equal(reopened.references!.library[0].versions[0].savedBy, undefined);
  assert.equal(await f.vault.readFileText(manifestPath), originalManifest);
  const before = await inventory(f.vault);
  for (const invalid of [null, { id: '', displayName: 'Asha' }, { id: 'engineer-a', displayName: '' }, { id: 'engineer-a', displayName: 42 }]) {
    await assert.rejects(importReferenceAttachment(f.vault, f.projectId, attachment(), metadata, undefined, { savedBy: invalid as never }), /Invalid reference/);
  }
  assert.equal(await inventory(f.vault), before, 'Invalid authors cannot publish files or change existing reference history');
});
async function fixture() {
  const working = new InMemoryFileSystemAdapter('Main'), vault = new InMemoryFileSystemAdapter('Vault');
  await initializeProjectVault(working, vault, 'Actuator');
  const folders: Record<string, FileSystemDirectoryAdapter> = { [branchId]: working };
  const save = (extra: Partial<CaptureRevisionInput> = {}, folder: FileSystemDirectoryAdapter = working, id = branchId) => captureRevision(folder, vault, { branchId: id, summary: 'Saved design context', notes, workingFolders: folders, ...extra });
  const scan = async () => { const state = await openExistingVault(vault); return { state, scan: await scanBranchChanges(working, branchId, getBranchBaseline(state, branchId)) }; };
  const imported = await importReferenceAttachment(vault, (await openExistingVault(vault)).project.projectId, attachment(), metadata);
  const ref = imported.references!.library[0];
  return { working, vault, folders, save, scan, imported, ref, version: ref.versions[0], projectId: imported.project.projectId };
}

test('unchanged reference updates write nothing, while queued version changes publish once and preserve saved context', async () => {
  const f = await fixture();
  await updateProjectReference(f.vault, f.projectId, f.ref.referenceId, { projectVersionId: f.version.versionId });
  await f.working.writeFileText(['Part.SLDPRT'], 'Saved geometry');
  const saved = await f.save();
  const savedId = saved.revision.manifest.revisionId;
  const historical = structuredClone(context(saved.vaultState, savedId));
  const state = await importReferenceAttachment(f.vault, f.projectId, attachment('Updated.pdf', new Uint8Array([1, 2, 3])), metadata, f.ref.referenceId);
  const v2 = state.references!.library[0].versions[1];
  const before = await inventory(f.vault), workingBefore = await inventory(f.working);
  let writes = 0;
  f.vault.setHooks({ onBeforeWrite: () => { writes++; } });
  for (const changes of [
    {},
    { projectVersionId: f.version.versionId, removed: false },
    { removed: false },
    metadata,
    { title: ` ${metadata.title} `, tags: [...metadata.tags.map(t => ` ${t} `), ...metadata.tags, ''] },
  ]) {
    const next = await updateProjectReference(f.vault, f.projectId, f.ref.referenceId, changes);
    assert.equal(next.references!.catalogId, state.references!.catalogId);
    assert.deepEqual(context(next, savedId), historical);
  }
  assert.equal(writes, 0);
  assert.equal(await inventory(f.vault), before, 'No new files or publication directories for unchanged edits');
  const switched = await Promise.all([1, 2].map(() => updateProjectReference(f.vault, f.projectId, f.ref.referenceId, { projectVersionId: v2.versionId, removed: false })));
  assert.equal(switched[0].references!.catalogId, switched[1].references!.catalogId, 'Queued duplicate sees the newly selected version');
  const latest = await openExistingVault(f.vault);
  assert.equal(Object.keys(latest.references!.catalogs).length, Object.keys(state.references!.catalogs).length + 1);
  assert.equal(latest.references!.library[0].projectVersionId, v2.versionId);
  assert.deepEqual(context(latest, savedId), historical);
  assert.equal(latest.revisions.length, 1);
  assert.equal(await inventory(f.working), workingBefore);
});

test('reference no-op detection retains cancellation, project, identity and version validation', async () => {
  const f = await fixture(), before = await inventory(f.vault);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(updateProjectReference(f.vault, f.projectId, f.ref.referenceId, {}, { signal: controller.signal }));
  await assert.rejects(updateProjectReference(f.vault, 'another-project', f.ref.referenceId, {}), /Project changed/);
  await assert.rejects(updateProjectReference(f.vault, f.projectId, 'missing-reference', {}), /missing or unpublished/);
  await assert.rejects(updateProjectReference(f.vault, f.projectId, f.ref.referenceId, { projectVersionId: 'missing-version' }), /Invalid project reference version/);
  assert.equal(await inventory(f.vault), before);
});

test('opaque import/retrieve preserves exact bytes, metadata and separate identities even for identical hashes', async () => {
  const f = await fixture();
  assert.deepEqual((await retrieveReferenceAttachment(f.vault, f.projectId, f.ref.referenceId, f.version.versionId)).bytes, original);
  assert.equal(f.version.originalFilename, '客户 requirement.pdf'); assert.equal(f.version.fileType, 'application/pdf');
  assert.ok(Number.isFinite(Date.parse(f.version.importedAt))); assert.equal(f.version.size, original.length);
  assert.deepEqual(f.ref.tags, metadata.tags);
  const twice = await importReferenceAttachment(f.vault, f.projectId, attachment(), metadata);
  assert.equal(twice.references!.library.length, 2);
  assert.notEqual(twice.references!.library[1].referenceId, f.ref.referenceId);
  assert.notEqual(twice.references!.library[1].versions[0].versionId, f.version.versionId);
  assert.equal(twice.references!.library[1].versions[0].sha256, f.version.sha256);
  assert.equal(twice.revisions.length, 0);
  assert.deepEqual((await f.scan()).scan.added, []);
  assert.deepEqual(twice.components!.revisions, {});
});

test('capture pins inherited and explicit versions and resolves a new component to the committed ID', async () => {
  const f = await fixture();
  await updateProjectReference(f.vault, f.projectId, f.ref.referenceId, { projectVersionId: f.version.versionId });
  await f.working.writeFileText(['Parts', 'Pin.SLDPRT'], 'native geometry');
  const reviewed = await f.scan();
  const saved = await f.save({ referenceReview: createReferenceReview(reviewed.state, reviewed.scan, [{ referenceId: f.ref.referenceId, versionId: f.version.versionId, locator: 'page 4, section 2.1', explanation: 'Increased clearance', component: { kind: 'pending', path: 'Parts/Pin.SLDPRT' } }]) });
  const record = context(saved.vaultState, saved.revision.manifest.revisionId);
  assert.equal(record.links.length, 2); assert.deepEqual(record.links.map(l => l.origin), ['project', 'revision']);
  const id = saved.vaultState.components!.revisions[saved.revision.manifest.revisionId].files[0].componentId;
  assert.equal(record.links[1].componentId, id); assert.equal(record.links[1].componentPath, 'Parts/Pin.SLDPRT');
  assert.equal(record.links[1].locator, 'page 4, section 2.1'); assert.equal(record.links[1].explanation, 'Increased clearance');
  assert.equal(record.manifestSha256, saved.revision.completion.manifestSha256);
  assert.equal(saved.revision.manifest.files.length, 1);
  assert.ok(!JSON.stringify(saved.revision.manifest).includes('referenceId'), 'CAD manifest format is unchanged');
});

test('new versions, editable details and removal preserve historical snapshots; context-only captures reject repeats', async () => {
  const f = await fixture();
  await updateProjectReference(f.vault, f.projectId, f.ref.referenceId, { projectVersionId: f.version.versionId });
  await f.working.writeFileText(['part'], 'geometry');
  const first = await f.save(), firstId = first.revision.manifest.revisionId;
  const manifestBytes = await f.vault.readFileText(['revisions', `${firstId}.manifest.json`]);
  const v2 = await importReferenceAttachment(f.vault, f.projectId, attachment('requirement-v2.pdf', new Uint8Array([1, 2, 3])), { ...metadata, title: 'Revised requirement' }, f.ref.referenceId);
  const next = v2.references!.library[0].versions[1];
  assert.equal(v2.references!.library[0].projectVersionId, f.version.versionId, 'adding a version never silently advances project defaults');
  await assert.rejects(f.save(), /No changes/);
  await updateProjectReference(f.vault, f.projectId, f.ref.referenceId, { projectVersionId: next.versionId });
  const second = await f.save();
  assert.equal(context(second.vaultState, second.revision.manifest.revisionId).contextOnly, true);
  assert.deepEqual(second.revision.manifest.files, first.revision.manifest.files);
  assert.equal(context(second.vaultState, firstId).links[0].versionId, f.version.versionId);
  assert.equal(context(second.vaultState, second.revision.manifest.revisionId).links[0].versionId, next.versionId);
  assert.equal(second.vaultState.references!.catalogs[context(second.vaultState, firstId).catalogId!].record.references[0].title, metadata.title);
  await assert.rejects(f.save(), /No changes/);
  await updateProjectReference(f.vault, f.projectId, f.ref.referenceId, { removed: true });
  const removed = await f.save();
  assert.deepEqual(context(removed.vaultState, removed.revision.manifest.revisionId).links, []);
  assert.equal(removed.vaultState.references!.library[0].versions.length, 2);
  assert.deepEqual((await retrieveReferenceAttachment(f.vault, f.projectId, f.ref.referenceId, f.version.versionId)).bytes, original);
  assert.equal(await f.vault.readFileText(['revisions', `${firstId}.manifest.json`]), manifestBytes);
  await assert.rejects(f.save(), /No changes/);
});

test('explicit component associations follow permanent identity through confirmed rename and branch origin', async () => {
  const f = await fixture(); await f.working.writeFileText(['old.SLDPRT'], 'geometry');
  let reviewed = await f.scan();
  const first = await f.save({ referenceReview: createReferenceReview(reviewed.state, reviewed.scan, [{ referenceId: f.ref.referenceId, versionId: f.version.versionId, locator: '00:12:30–00:13:10', explanation: 'Meeting decision', component: { kind: 'pending', path: 'old.SLDPRT' } }]) });
  const firstLink = context(first.vaultState, first.revision.manifest.revisionId).links[0];
  await f.working.removeEntry(['old.SLDPRT']); await f.working.writeFileText(['Parts', 'new.SLDPRT'], 'changed geometry');
  reviewed = await f.scan();
  const renamed = await f.save({ identityReview: createIdentityReview(reviewed.state, reviewed.scan, [{ from: 'old.SLDPRT', to: 'Parts/new.SLDPRT' }], []) });
  const renamedLink = context(renamed.vaultState, renamed.revision.manifest.revisionId).links[0];
  assert.equal(renamedLink.componentId, firstLink.componentId); assert.equal(renamedLink.componentPath, 'Parts/new.SLDPRT');
  assert.equal(context(renamed.vaultState, first.revision.manifest.revisionId).links[0].componentPath, 'old.SLDPRT');
  const branch = await createDesignBranch({ vaultDir: f.vault, destinationParent: new InMemoryFileSystemAdapter('Cases'), workingFolders: f.folders, sourceRevisionId: renamed.revision.manifest.revisionId, name: 'Alternative', reason: 'Try fit' });
  f.folders[branch.branch.branchId] = branch.workingDir;
  await branch.workingDir.writeFileText(['Parts', 'new.SLDPRT'], 'alternative');
  const alternative = await f.save({}, branch.workingDir, branch.branch.branchId);
  assert.equal(context(alternative.vaultState, alternative.revision.manifest.revisionId).links[0].componentId, firstLink.componentId);
  await assert.rejects(f.save({}, branch.workingDir, branch.branch.branchId), /No changes/);
});

test('stale catalog and invalid component/version associations reject before any capture writes; corrected retry succeeds', async () => {
  const f = await fixture(); await f.working.writeFileText(['part'], 'geometry');
  const reviewed = await f.scan();
  const explicit = [{ referenceId: f.ref.referenceId, versionId: f.version.versionId, locator: '', explanation: '', component: { kind: 'pending' as const, path: 'missing' } }];
  const before = await inventory(f.vault);
  await assert.rejects(f.save({ referenceReview: createReferenceReview(reviewed.state, reviewed.scan, explicit) }), /component is absent/);
  assert.equal(await inventory(f.vault), before); assert.equal((await openExistingVault(f.vault)).revisions.length, 0);
  await assert.rejects(f.save({ referenceReview: createReferenceReview(reviewed.state, reviewed.scan, [{ ...explicit[0], component: undefined, versionId: 'wrong-version' }]) }), /version is missing/);
  const stale = createReferenceReview(reviewed.state, reviewed.scan, []);
  await updateProjectReference(f.vault, f.projectId, f.ref.referenceId, { title: 'Edited title' });
  await assert.rejects(f.save({ referenceReview: stale }), /stale/);
  const current = await f.scan();
  const saved = await f.save({ referenceReview: createReferenceReview(current.state, current.scan, [{ ...explicit[0], component: { kind: 'pending', path: 'part' } }]) });
  assert.equal(saved.vaultState.revisions.length, 1); assert.equal(saved.vaultState.references!.status, 'available');
});

for (const damage of ['missing', 'corrupt'] as const) test(`${damage} attachment blocks retrieval, linked capture and managed copying while CAD inspection/recovery remains usable`, async () => {
  const f = await fixture(); await updateProjectReference(f.vault, f.projectId, f.ref.referenceId, { projectVersionId: f.version.versionId });
  await f.working.writeFileText(['part'], 'saved geometry'); const first = await f.save();
  if (damage === 'missing') await f.vault.removeEntry(getObjectPathSegments(f.version.sha256));
  else await f.vault.writeFileBytes(getObjectPathSegments(f.version.sha256), new Uint8Array(original.length).fill(9));
  await assert.rejects(retrieveReferenceAttachment(f.vault, f.projectId, f.ref.referenceId, f.version.versionId), /missing|corrupt/i);
  await f.working.writeFileText(['part'], 'newer geometry');
  await assert.rejects(f.save(), /missing|unavailable/i);
  const reopened = await openExistingVault(f.vault); assert.equal(reopened.revisions.length, 1); assert.equal(reopened.components?.status, 'available');
  const recovery = new InMemoryFileSystemAdapter('Recovery');
  await restoreRevisionToFolder({ vaultDir: f.vault, destinationDir: recovery, revisionId: first.revision.manifest.revisionId, workingFolders: f.folders });
  assert.equal(await recovery.readFileText(['part']), 'saved geometry'); assert.equal(await recovery.hasDirectory(['references']), false);
  const destination = new InMemoryFileSystemAdapter('Managed'); await createWorkspace(destination);
  await assert.rejects(adoptProject(destination, f.vault, f.folders), /damaged|missing|verification failed/i);
});

test('required content and catalog are checked again immediately before completion publication', async () => {
  for (const change of ['content', 'catalog']) {
    const f = await fixture(); await updateProjectReference(f.vault, f.projectId, f.ref.referenceId, { projectVersionId: f.version.versionId });
    await f.working.writeFileText(['part'], 'geometry');
    const originalRead = f.vault.readFileText.bind(f.vault);
    let invalidate = false;
    f.vault.readFileText = async path => {
      if (invalidate && change === 'catalog' && path[0] === 'references' && path[1] === 'catalogs') return '{}';
      return originalRead(path);
    };
    await assert.rejects(f.save({ onProgress: async p => {
      if (p.phase === 'publishing_completion') {
        invalidate = true;
        if (change === 'content') await f.vault.writeFileBytes(getObjectPathSegments(f.version.sha256), new Uint8Array(original.length));
      }
    } }), /Reference|reference/);
    invalidate = false;
    assert.equal((await openExistingVault(f.vault)).revisions.length, 0);
  }
});

test('interrupted and cancelled imports publish no reference identity and allow fresh import', async () => {
  for (const cancelled of [false, true]) {
    const f = await fixture(), originalWrite = f.vault.writeFileText.bind(f.vault), abort = new AbortController();
    const originalDirectory = f.vault.getDirectory.bind(f.vault);
    let fail = true;
    f.vault.getDirectory = async (path, options) => {
      if (!cancelled && fail && options?.exclusiveCreate && path[0] === 'references' && path[1] === 'completed') { fail = false; throw new Error('Interrupted reference publication'); }
      return originalDirectory(path, options);
    };
    f.vault.writeFileText = async (path, text, options) => {
      if (fail && path[0] === 'references' && path[1] === (cancelled ? 'catalogs' : 'completed')) {
        fail = false;
        if (cancelled) { await originalWrite(path, text, options); abort.abort(); return; }
        throw new Error('Interrupted reference publication');
      }
      return originalWrite(path, text, options);
    };
    await assert.rejects(importReferenceAttachment(f.vault, f.projectId, attachment('new.txt'), metadata, undefined, { signal: abort.signal }), /Interrupted|cancel/i);
    const failed = await openExistingVault(f.vault);
    assert.equal(failed.references!.status, 'available'); assert.equal(failed.references!.library.length, 1);
    assert.ok(failed.incompleteAttempts.some(a => a.kind === 'uncompleted_reference'));
    const retry = await importReferenceAttachment(f.vault, f.projectId, attachment('new.txt'), metadata);
    assert.equal(retry.references!.library.length, 2);
  }
});

test('interrupted revision publication does not commit context; retry uses a fresh revision and keeps exact links', async () => {
  const f = await fixture(); await updateProjectReference(f.vault, f.projectId, f.ref.referenceId, { projectVersionId: f.version.versionId });
  await f.working.writeFileText(['part'], 'geometry');
  const write = f.vault.writeFileText.bind(f.vault); let fail = true;
  f.vault.writeFileText = async (path, text, options) => { if (fail && path[0] === 'completed') { fail = false; throw new Error('Interrupted completion'); } return write(path, text, options); };
  await assert.rejects(f.save(), /Interrupted completion/);
  const failed = await openExistingVault(f.vault); assert.equal(failed.revisions.length, 0); assert.deepEqual(failed.references!.contexts, {});
  assert.ok(failed.incompleteAttempts.some(a => a.kind === 'uncompleted_reference'));
  const saved = await f.save(); assert.equal(saved.vaultState.revisions.length, 1); assert.equal(context(saved.vaultState, saved.revision.manifest.revisionId).links[0].versionId, f.version.versionId);
});

test('complete project copy, adoption, workspace import and disk-only relocation preserve identities, context and bytes', async () => {
  const source = new InMemoryFileSystemAdapter('Source'); await createWorkspace(source);
  const project = await createProject(source, 'Actuator'), working = project.workingFolders[branchId]!;
  const state = await importReferenceAttachment(project.vaultDir, project.record.projectId, attachment(), metadata), ref = state.references!.library[0];
  await updateProjectReference(project.vaultDir, project.record.projectId, ref.referenceId, { projectVersionId: ref.versions[0].versionId });
  await working.writeFileText(['part'], 'geometry');
  const saved = await captureRevision(working, project.vaultDir, { branchId, summary: 'Context', notes, workingFolders: project.workingFolders });
  await working.writeFileText(['part'], 'unsaved edit');
  const target = new InMemoryFileSystemAdapter('Target'); await createWorkspace(target);
  const imported = await importProject(target, await source.getDirectory(project.record.containerPath.split('/')), 'Copy');
  const adoptedRoot = new InMemoryFileSystemAdapter('Adopted'); await createWorkspace(adoptedRoot);
  const adopted = await adoptProject(adoptedRoot, project.vaultDir, project.workingFolders);
  const home = new InMemoryFileSystemAdapter('Home'); await createHome(home);
  const brought = await bringWorkspaceIntoHome(home, source);
  const moved = new InMemoryFileSystemAdapter('Moved'); await copyVerifiedTree(source, moved);
  const relocated = (await openWorkspace(moved)).projects[0].project!;
  for (const p of [imported, adopted, brought.workspace!.projects[0].project!, relocated]) {
    assert.equal(p.record.projectId, project.record.projectId); assert.deepEqual(p.vaultState.references, saved.vaultState.references);
    assert.deepEqual((await retrieveReferenceAttachment(p.vaultDir, p.record.projectId, ref.referenceId, ref.versions[0].versionId)).bytes, original);
    assert.equal(await p.workingFolders[branchId]!.readFileText(['part']), 'unsaved edit');
  }
});

test('legacy revisions remain unannotated without rewriting manifests and missing or unsupported evidence is never regenerated', async () => {
  const f = await fixture(); await f.working.writeFileText(['part'], 'legacy bytes'); const first = await f.save();
  if (await f.vault.hasFile(['reference-context.json'])) await f.vault.removeEntry(['reference-context.json']);
  await f.vault.removeEntry(['references'], { recursive: true });
  // Model an actual pre-feature completion rather than erasing evidence from a new capture.
  const completionPath = ['completed', `${first.revision.manifest.revisionId}.done.json`];
  const legacyCompletion = JSON.parse(await f.vault.readFileText(completionPath)); delete legacyCompletion.referenceContext;
  await f.vault.writeFileText(completionPath, JSON.stringify(legacyCompletion, null, 2));
  const legacy = await openExistingVault(f.vault); assert.equal(legacy.references!.status, 'legacy');
  const id = first.revision.manifest.revisionId, manifest = await f.vault.readFileText(['revisions', `${id}.manifest.json`]);
  const imported = await importReferenceAttachment(f.vault, f.projectId, attachment(), metadata), ref = imported.references!.library[0];
  await updateProjectReference(f.vault, f.projectId, ref.referenceId, { projectVersionId: ref.versions[0].versionId });
  const next = await f.save(); assert.equal(next.vaultState.references!.contexts[id].status, 'legacy');
  assert.equal(await f.vault.readFileText(['revisions', `${id}.manifest.json`]), manifest);
  // The old single-file boundary remains readable and strict for compatibility.
  const root = structuredClone(next.vaultState.references!.boundary!); root.schemaVersion = 99; root.payloadSha256 = referenceChecksum(root);
  await f.vault.removeEntry(['references', 'enrollment'], { recursive: true });
  await f.vault.writeFileText(['reference-context.json'], JSON.stringify(root));
  assert.equal((await openExistingVault(f.vault)).references!.status, 'unsupported');
  await assert.rejects(importReferenceAttachment(f.vault, f.projectId, attachment(), metadata), /Unsupported/);
  await f.vault.removeEntry(['reference-context.json']);
  await assert.rejects(importReferenceAttachment(f.vault, f.projectId, attachment(), metadata), /missing|regenerated/);
  assert.equal(await f.vault.hasFile(['reference-context.json']), false);
});

test('review exports exclude reference attachments and explicitly describe that limit', async () => {
  const f = await fixture(); await updateProjectReference(f.vault, f.projectId, f.ref.referenceId, { projectVersionId: f.version.versionId });
  await f.working.writeFileText(['part'], 'geometry'); const saved = await f.save();
  const plan = prepareReviewExport(saved.vaultState, saved.revision.manifest.revisionId, { kind: 'complete', selectedPaths: [], labelFilenames: false });
  const parent = new InMemoryFileSystemAdapter('Reviews');
  const output = await exportRevisionForReview({ vaultDir: f.vault, parent, plan, folderName: plan.folderName, workingFolders: f.folders });
  const folder = await parent.getDirectory([output.folderName]);
  assert.deepEqual((await folder.listEntries()).map(e => e.name).sort(), ['_CADTREE_REVIEW.txt', 'part']);
  assert.match(await folder.readFileText([output.summaryName]), /reference attachments are not included/);
});

test('context equality ignores display path but preserves exact version, origin, locator and permanent identity', () => {
  const link = { referenceId: 'reference', versionId: 'version', origin: 'revision' as const, locator: 'page 4', explanation: 'Fit', componentId: 'component', componentPath: 'old' };
  assert.equal(referenceContextSignature([link]), referenceContextSignature([{ ...link, componentPath: 'new' }]));
  for (const change of [{ versionId: 'other' }, { componentId: 'other' }, { locator: 'page 5' }, { origin: 'project' as const }]) assert.notEqual(referenceContextSignature([link]), referenceContextSignature([{ ...link, ...change }]));
});

test('a missing committed context or a rechecksummed wrong revision binding is unavailable without losing CAD recovery', async () => {
  for (const missing of [true, false]) {
    const f = await fixture(); await updateProjectReference(f.vault, f.projectId, f.ref.referenceId, { projectVersionId: f.version.versionId });
    await f.working.writeFileText(['part'], 'geometry'); const first = await f.save(), id = first.revision.manifest.revisionId;
    const path = ['references', 'contexts', `${id}.json`];
    if (missing) await f.vault.removeEntry(path);
    else { const record = JSON.parse(await f.vault.readFileText(path)); record.branchId = 'wrong-branch'; record.payloadSha256 = referenceChecksum(record); await f.vault.writeFileText(path, JSON.stringify(record)); }
    const reopened = await openExistingVault(f.vault);
    assert.equal(reopened.references!.status, 'unavailable'); assert.equal(reopened.references!.contexts[id].status, 'unavailable');
    await f.working.writeFileText(['part'], 'newer edit'); await assert.rejects(f.save(), /Reference evidence unavailable/);
    assert.equal((await openExistingVault(f.vault)).revisions.length, 1);
    const recovery = new InMemoryFileSystemAdapter('Recovery');
    await restoreRevisionToFolder({ vaultDir: f.vault, destinationDir: recovery, revisionId: id, workingFolders: f.folders });
    assert.equal(await recovery.readFileText(['part']), 'geometry');
  }
});

test('lost import and capture acknowledgements reconstruct one completed publication instead of duplicating it', async () => {
  const f = await fixture(), write = f.vault.writeFileText.bind(f.vault);
  const directory = f.vault.getDirectory.bind(f.vault);
  let importAck = true;
  f.vault.getDirectory = async (path, options) => {
    const result = await directory(path, options);
    if (importAck && options?.exclusiveCreate && path[0] === 'references' && path[1] === 'completed') { importAck = false; throw new Error('Lost import acknowledgement'); }
    return result;
  };
  await assert.rejects(importReferenceAttachment(f.vault, f.projectId, attachment('transcript.md'), metadata), /Lost import/);
  const imported = await openExistingVault(f.vault); assert.equal(imported.references!.library.length, 2); assert.equal(imported.references!.status, 'available');
  await updateProjectReference(f.vault, f.projectId, f.ref.referenceId, { projectVersionId: f.version.versionId });
  await f.working.writeFileText(['part'], 'geometry'); let captureAck = true;
  f.vault.writeFileText = async (path, text, options) => { await write(path, text, options); if (captureAck && path[0] === 'completed') { captureAck = false; throw new Error('Lost capture acknowledgement'); } };
  await assert.rejects(f.save(), /Lost capture/);
  const committed = await openExistingVault(f.vault); assert.equal(committed.revisions.length, 1); assert.equal(committed.references!.status, 'available');
  assert.equal(context(committed, committed.revisions[0].manifest.revisionId).links[0].versionId, f.version.versionId);
  await assert.rejects(f.save(), /No changes/);
});

test('new completion binding detects loss of all reference sidecars and refuses legacy re-enrollment', async () => {
  const f = await fixture(); await updateProjectReference(f.vault, f.projectId, f.ref.referenceId, { projectVersionId: f.version.versionId });
  await f.working.writeFileText(['part'], 'geometry'); const first = await f.save();
  assert.ok(first.revision.completion.referenceContext);
  if (await f.vault.hasFile(['reference-context.json'])) await f.vault.removeEntry(['reference-context.json']);
  await f.vault.removeEntry(['references'], { recursive: true });
  const state = await openExistingVault(f.vault);
  assert.equal(state.references!.status, 'unavailable'); assert.equal(state.references!.contexts[first.revision.manifest.revisionId].status, 'unavailable');
  await assert.rejects(importReferenceAttachment(f.vault, f.projectId, attachment(), metadata), /cannot be regenerated/);
  assert.equal(await f.vault.hasFile(['reference-context.json']), false);
  assert.equal(state.revisions.length, 1);
});

