import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryFileSystemAdapter, type FileSystemDirectoryAdapter } from '../engine/fs-adapter';
import { initializeProjectVault, openExistingVault } from '../engine/vault-service';
import { captureRevision } from '../engine/revision-service';
import { scanBranchChanges } from '../engine/scanner';
import { getBranchBaseline } from '../engine/branch-state';
import { createDesignBranch } from '../engine/branch-service';
import { createIdentityReview } from '../engine/component-identity';
import { createReferenceReview, importReferenceAttachment, retrieveReferenceAttachment, updateProjectReference } from '../engine/references';
import { getObjectPathSegments } from '../engine/object-store';
import { inventorySignature, readVerifiedInventory } from '../engine/copy-service';
import { ancestryOf, layoutRevisions } from '../history/layout';
import type { CaptureRevisionInput, VaultState } from '../engine/types';
import { buildKnowledgeIndex, type KnowledgeIndex } from './index';

const main = 'branch-main';
const notes = { problem: ' Collar too thin\nunder load. ', modification: 'Increase thickness to 8 mm.', observations: '' };
const fileNotes = (path: string) => [{ path, problem: 'Local clearance', modification: 'Adjust fit', observations: 'Check assembly' }];
const attachment = (bytes = new Uint8Array([1, 2, 3])) => ({
  name: 'design.pdf', type: 'application/pdf', size: bytes.length, stream: () => new Blob([bytes as BlobPart]).stream(),
});
const inventory = async (dir: FileSystemDirectoryAdapter) => inventorySignature(await readVerifiedInventory(dir));
function freeze(value: object) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
}
async function fixture(notePath: string | null = 'collar.SLDPRT') {
  const working = new InMemoryFileSystemAdapter('Main'), vault = new InMemoryFileSystemAdapter('Vault');
  await initializeProjectVault(working, vault, 'Knowledge');
  const folders: Record<string, FileSystemDirectoryAdapter> = { [main]: working };
  const imported = await importReferenceAttachment(vault, (await openExistingVault(vault)).project.projectId,
    attachment(), { title: 'Design requirement', description: '', tags: [] });
  const ref = imported.references!.library[0], version = ref.versions[0];
  await updateProjectReference(vault, imported.project.projectId, ref.referenceId, { projectVersionId: version.versionId });
  await working.writeFileText(['collar.SLDPRT'], 'geometry one');
  if (notePath && notePath !== 'collar.SLDPRT') await working.writeFileText(notePath.split('/'), 'other component geometry');
  const scan = async () => {
    const state = await openExistingVault(vault);
    return { state, scan: await scanBranchChanges(working, main, getBranchBaseline(state, main)) };
  };
  const save = (extra: Partial<CaptureRevisionInput> = {}, dir: FileSystemDirectoryAdapter = working, branchId = main) =>
    captureRevision(dir, vault, { branchId, summary: 'Collar clearance', notes, workingFolders: folders, ...extra });
  const reviewed = await scan();
  const first = await save({ ...(notePath ? { fileNotes: fileNotes(notePath) } : {}), referenceReview: createReferenceReview(reviewed.state, reviewed.scan, [{
    referenceId: ref.referenceId, versionId: version.versionId, locator: 'page 4, table 2', explanation: 'Required fit',
    component: { kind: 'pending', path: 'collar.SLDPRT' },
  }]) });
  return { working, vault, folders, imported, ref, version, scan, save, first };
}

function assertCompleteReferenceContext(index: KnowledgeIndex, state: VaultState, revisionId: string) {
  const projected = index.revisions.find(r => r.revisionId === revisionId)!.referenceContext;
  const revision = state.revisions.find(r => r.manifest.revisionId === revisionId)!;
  const context = state.references!.contexts[revisionId].record!;
  const catalog = state.references!.catalogs[context.catalogId!];
  assert.equal(projected.availability.status, 'available');
  assert.equal(projected.attachments.length, context.links.length, 'Every committed association survives without requiring a note');
  for (const [i, link] of context.links.entries()) {
    const association = projected.attachments[i];
    const version = catalog.record.references.find(r => r.referenceId === link.referenceId)!.versions.find(v => v.versionId === link.versionId)!;
    assert.deepEqual({
      referenceId: association.referenceId, versionId: association.versionId, origin: association.origin,
      componentId: association.componentId, componentPath: association.componentPath,
      locator: association.locator, explanation: association.explanation,
    }, link);
    assert.equal(association.sha256, version.sha256); assert.equal(association.size, version.size);
    assert.equal(association.originalFilename, version.originalFilename); assert.equal(association.fileType, version.fileType);
    assert.deepEqual(association.source, {
      recordPath: `references/contexts/${revisionId}.json`, jsonPointer: `/links/${i}`,
      contextSha256: revision.completion.referenceContext!.contextSha256,
      contextPayloadSha256: context.payloadSha256, boundarySha256: context.boundarySha256,
      catalogId: context.catalogId, catalogSha256: catalog.sha256,
    });
    assert.equal(association.metadata.status, 'available'); assert.equal(association.content.status, 'unavailable');
  }
}

for (const notePath of [null, 'spacer.SLDPRT']) test(`F1: component associations survive independently of file notes (${notePath ?? 'no file notes'})`, async () => {
  const f = await fixture(notePath), state = f.first.vaultState, revisionId = f.first.revision.manifest.revisionId;
  const before = JSON.stringify(state), vaultBefore = await inventory(f.vault), workingBefore = await inventory(f.working);
  let writes = 0;
  f.vault.setHooks({ onBeforeWrite: () => { writes++; } });
  f.working.setHooks({ onBeforeWrite: () => { writes++; } });
  freeze(state);
  const index = buildKnowledgeIndex(state);
  assertCompleteReferenceContext(index, state, revisionId);
  assert.deepEqual(buildKnowledgeIndex(state), index);
  const componentLink = index.revisions[0].referenceContext.attachments.find(a => a.scope === 'component')!;
  assert.equal(componentLink.componentPath, 'collar.SLDPRT');
  assert.equal(componentLink.componentId, state.components!.revisions[revisionId].files.find(f => f.path === 'collar.SLDPRT')!.componentId);
  assert.equal(componentLink.locator, 'page 4, table 2'); assert.equal(componentLink.explanation, 'Required fit');
  const fileRecords = index.records.filter(r => r.scope === 'file');
  assert.equal(fileRecords.length, notePath ? 3 : 0, 'No fabricated file-note records');
  assert.ok(fileRecords.every(r => r.filePath === notePath && r.componentId !== componentLink.componentId));
  assert.ok(index.records.every(r => r.attachments.every(a => a.scope !== 'component')), 'Unrelated project/file notes do not inherit this association');
  for (const association of index.revisions[0].referenceContext.attachments) {
    const rawContext = JSON.parse(await f.vault.readFileText(association.source.recordPath.split('/')));
    const link = rawContext.links[Number(association.source.jsonPointer.split('/')[2])];
    assert.equal(link.referenceId, association.referenceId); assert.equal(link.locator, association.locator);
  }
  index.revisions[0].referenceContext.attachments[0].source.jsonPointer = '/consumer-edit';
  assert.notEqual(index.records[0].attachments[0].source.jsonPointer, '/consumer-edit', 'Revision and note views have detached attachment data');
  assert.equal(JSON.stringify(state), before); assert.equal(writes, 0);
  assert.equal(await inventory(f.vault), vaultBefore); assert.equal(await inventory(f.working), workingBefore);
});

test('F1: a reference-context-only revision preserves component associations and pinned historical provenance without notes or CAD changes', async () => {
  const f = await fixture(null), firstId = f.first.revision.manifest.revisionId;
  const earlier = buildKnowledgeIndex(f.first.vaultState).revisions[0];
  const reviewed = await f.scan();
  assert.equal(reviewed.scan.hasChanges, false);
  const componentId = reviewed.state.components!.revisions[firstId].files[0].componentId;
  const saved = await f.save({ referenceReview: createReferenceReview(reviewed.state, reviewed.scan, [{
    referenceId: f.ref.referenceId, versionId: f.version.versionId, locator: 'section 6.2', explanation: 'Updated context only',
    component: { kind: 'existing', componentId },
  }, { referenceId: f.ref.referenceId, versionId: f.version.versionId, locator: '', explanation: 'General revision context' }]) });
  const revisionId = saved.revision.manifest.revisionId;
  assert.equal(saved.vaultState.references!.contexts[revisionId].record!.contextOnly, true);
  assert.deepEqual(saved.revision.manifest.files, f.first.revision.manifest.files);
  assert.equal(saved.revision.manifest.fileNotes, undefined);
  // Moving the current library ahead must not alter either revision's captured provenance.
  await importReferenceAttachment(f.vault, saved.vaultState.project.projectId, attachment(new Uint8Array([8, 9])),
    { title: 'Later reference version', description: '', tags: [] }, f.ref.referenceId);
  const state = await openExistingVault(f.vault), before = JSON.stringify(state);
  const vaultBefore = await inventory(f.vault), workingBefore = await inventory(f.working);
  let writes = 0;
  f.vault.setHooks({ onBeforeWrite: () => { writes++; } });
  f.working.setHooks({ onBeforeWrite: () => { writes++; } });
  freeze(state);
  const index = buildKnowledgeIndex(state);
  assertCompleteReferenceContext(index, state, firstId); assertCompleteReferenceContext(index, state, revisionId);
  assert.deepEqual(index.revisions.find(r => r.revisionId === firstId), earlier);
  const association = index.revisions.find(r => r.revisionId === revisionId)!.referenceContext.attachments.find(a => a.scope === 'component')!;
  assert.equal(association.versionId, f.version.versionId); assert.equal(association.componentId, componentId);
  assert.equal(association.locator, 'section 6.2'); assert.equal(association.explanation, 'Updated context only');
  assert.deepEqual(index.revisions.find(r => r.revisionId === revisionId)!.referenceContext.attachments.map(a => a.scope), ['project', 'component', 'revision']);
  assert.equal(index.records.filter(r => r.scope === 'file').length, 0);
  assert.ok(index.records.every(r => r.attachments.every(a => a.scope !== 'component')));
  const reordered = structuredClone(state); reordered.revisions.reverse();
  assert.deepEqual(buildKnowledgeIndex(reordered), index);
  index.revisions.find(r => r.revisionId === revisionId)!.referenceContext.attachments[0].locator = 'consumer edit';
  assert.equal(JSON.stringify(state), before); assert.equal(writes, 0);
  assert.equal(await inventory(f.vault), vaultBefore); assert.equal(await inventory(f.working), workingBefore);
});

test('exact notes, distinct source identities and resolvable immutable manifest pointers; zero writes or mutation', async () => {
  const f = await fixture(), state = f.first.vaultState;
  const before = JSON.stringify(state), vaultBefore = await inventory(f.vault), workingBefore = await inventory(f.working);
  let writes = 0;
  f.vault.setHooks({ onBeforeWrite: () => { writes++; } });
  f.working.setHooks({ onBeforeWrite: () => { writes++; } });
  freeze(state);
  const index = buildKnowledgeIndex(state);
  assert.deepEqual(buildKnowledgeIndex(state), index);
  assert.equal(index.records.length, 7);
  assert.equal(new Set(index.records.map(r => r.id)).size, 7);
  assert.equal(index.records.find(r => r.kind === 'problem' && r.scope === 'project')!.text, f.first.revision.manifest.notes.problem);
  assert.equal(index.records.find(r => r.kind === 'observations' && r.scope === 'project')!.status, 'empty');
  for (const record of index.records) {
    const manifest = JSON.parse(await f.vault.readFileText(record.source.recordPath.split('/')));
    const text = record.source.jsonPointer.slice(1).split('/').reduce((value, key) => value[key], manifest);
    assert.equal(text, record.text);
    assert.equal(record.source.manifestSha256, f.first.revision.completion.manifestSha256);
    assert.equal(record.branchId, main); assert.equal(record.projectId, state.project.projectId);
  }
  index.records[0].attachments[0].locator = 'consumer edit';
  assert.equal(JSON.stringify(state), before);
  assert.equal(writes, 0);
  assert.equal(await inventory(f.vault), vaultBefore);
  assert.equal(await inventory(f.working), workingBefore);
  // The projection itself never normalizes text, even if a historical field
  // differs from today's capture-time trimming convention.
  const historical = structuredClone(state);
  historical.revisions[0].manifest.notes.problem = notes.problem;
  assert.equal(buildKnowledgeIndex(historical).records.find(r => r.source.jsonPointer === '/notes/problem')!.text, notes.problem);
});

test('multiple revisions, rename continuity, independent branch and pinned historical reference versions', async () => {
  const f = await fixture(), firstId = f.first.revision.manifest.revisionId;
  const original = buildKnowledgeIndex(f.first.vaultState);
  await f.working.removeEntry(['collar.SLDPRT']);
  await f.working.writeFileText(['renamed.SLDPRT'], 'geometry two');
  const reviewed = await f.scan();
  const second = await f.save({ fileNotes: fileNotes('renamed.SLDPRT'), identityReview: createIdentityReview(reviewed.state, reviewed.scan,
    [{ from: 'collar.SLDPRT', to: 'renamed.SLDPRT' }], []) });
  const branch = await createDesignBranch({ vaultDir: f.vault, destinationParent: new InMemoryFileSystemAdapter('Cases'),
    workingFolders: f.folders, sourceRevisionId: firstId, name: 'Alternative', reason: 'Investigate fit' });
  f.folders[branch.branch.branchId] = branch.workingDir;
  await branch.workingDir.writeFileText(['collar.SLDPRT'], 'alternative geometry');
  const imported = await importReferenceAttachment(f.vault, f.imported.project.projectId, attachment(new Uint8Array([4, 5])),
    { title: 'Updated requirement', description: '', tags: [] }, f.ref.referenceId);
  const latest = imported.references!.library[0].versions[1];
  await updateProjectReference(f.vault, f.imported.project.projectId, f.ref.referenceId, { projectVersionId: latest.versionId });
  const third = await f.save({ fileNotes: fileNotes('collar.SLDPRT') }, branch.workingDir, branch.branch.branchId);
  const state = third.vaultState, index = buildKnowledgeIndex(state), graph = layoutRevisions(state, main);
  assert.deepEqual(index.records.filter(r => r.revisionId === firstId), original.records);
  const parts = index.records.filter(r => r.scope === 'file');
  assert.equal(new Set(parts.map(r => r.componentId)).size, 1);
  assert.ok(parts.every(r => r.componentId));
  assert.equal(parts.find(r => r.revisionId === second.revision.manifest.revisionId)!.filePath, 'renamed.SLDPRT');
  assert.equal(index.branches.find(b => b.branchId === branch.branch.branchId)!.startingRevisionId, firstId);
  for (const revision of index.revisions) assert.deepEqual(revision.history.ancestry, [...ancestryOf(graph, revision.revisionId)]);
  const scoped = parts.find(r => r.revisionId === firstId)!.attachments.find(a => a.scope === 'component')!;
  assert.equal(scoped.locator, 'page 4, table 2'); assert.equal(scoped.sha256, f.version.sha256);
  assert.equal(scoped.referenceId, f.ref.referenceId); assert.equal(scoped.versionId, f.version.versionId);
  assert.equal(scoped.metadata.status, 'available'); assert.equal(scoped.content.status, 'unavailable');
  const context = JSON.parse(await f.vault.readFileText(scoped.source.recordPath.split('/')));
  assert.deepEqual(context.links[Number(scoped.source.jsonPointer.split('/')[2])], {
    referenceId: scoped.referenceId, versionId: scoped.versionId, origin: scoped.origin,
    locator: scoped.locator, explanation: scoped.explanation, componentId: scoped.componentId, componentPath: scoped.componentPath,
  });
  assert.ok(index.records.filter(r => r.scope === 'project').flatMap(r => r.attachments)
    .filter(a => a.origin === 'project').every(a => a.locator === ''), 'No inferred page locator');
  assert.equal(index.records.find(r => r.revisionId === third.revision.manifest.revisionId)!.attachments[0].versionId, latest.versionId);
  assert.ok(index.records.filter(r => r.scope === 'project').every(r => r.attachments.every(a => a.scope !== 'component')));
  const reordered = structuredClone(state); reordered.revisions.reverse(); reordered.branches.reverse();
  assert.deepEqual(buildKnowledgeIndex(reordered), index);
});

test('missing/unsupported component evidence never infers identity from path; deleted-file notes remain unresolved', async () => {
  const f = await fixture();
  for (const status of ['legacy', 'unavailable', 'unsupported'] as const) {
    const state = structuredClone(f.first.vaultState);
    state.components = { status, reason: 'Unavailable mapping', revisions: {} };
    const files = buildKnowledgeIndex(state).records.filter(r => r.scope === 'file');
    assert.ok(files.every(r => r.componentId === undefined && r.component?.status !== 'available'));
    assert.ok(files.every(r => r.attachments.every(a => a.scope !== 'component')));
  }
  await f.working.removeEntry(['collar.SLDPRT']);
  // Explicit component references cannot follow a deleted file; clear those selections.
  const reviewed = await f.scan();
  const saved = await f.save({ fileNotes: fileNotes('collar.SLDPRT'), referenceReview: createReferenceReview(reviewed.state, reviewed.scan, []) });
  assert.ok(buildKnowledgeIndex(saved.vaultState).records.filter(r => r.revisionId === saved.revision.manifest.revisionId && r.scope === 'file')
    .every(r => r.componentId === undefined && r.component?.status === 'unavailable'));
});

test('legacy, verified empty context and missing context have different meanings', async () => {
  const f = await fixture();
  const legacy = structuredClone(f.first.vaultState), id = f.first.revision.manifest.revisionId;
  delete legacy.revisions[0].completion.referenceContext;
  delete legacy.revisions[0].manifest.fileNotes;
  legacy.references = { status: 'legacy', library: [], catalogs: {}, contexts: { [id]: { status: 'legacy' } }, catalogId: null, catalogSha256: null };
  const old = buildKnowledgeIndex(legacy);
  assert.equal(old.revisions[0].fileNotes.status, 'not_recorded');
  assert.equal(old.revisions[0].referenceContext.availability.status, 'not_recorded');
  assert.deepEqual(old.revisions[0].referenceContext.attachments, []);
  assert.ok(old.records.every(r => r.references.status === 'not_recorded'));
  const missing = structuredClone(f.first.vaultState); delete missing.references;
  assert.ok(buildKnowledgeIndex(missing).records.every(r => r.references.status === 'unavailable'));
  assert.equal(buildKnowledgeIndex(missing).revisions[0].referenceContext.availability.status, 'unavailable');
  const brokenCatalog = structuredClone(f.first.vaultState); brokenCatalog.references!.catalogs = {};
  assert.ok(buildKnowledgeIndex(brokenCatalog).records.every(r => r.references.status === 'unavailable' && !r.attachments.length));
  assert.equal(buildKnowledgeIndex(brokenCatalog).revisions[0].referenceContext.availability.status, 'unavailable');
  await updateProjectReference(f.vault, f.imported.project.projectId, f.ref.referenceId, { projectVersionId: null });
  const reviewed = await f.scan();
  const saved = await f.save({ referenceReview: createReferenceReview(reviewed.state, reviewed.scan, []) });
  const empty = buildKnowledgeIndex(saved.vaultState).records.filter(r => r.revisionId === saved.revision.manifest.revisionId);
  assert.ok(empty.every(r => r.references.status === 'available' && r.attachments.length === 0));
  assert.deepEqual(buildKnowledgeIndex(saved.vaultState).revisions.find(r => r.revisionId === saved.revision.manifest.revisionId)!.referenceContext,
    { availability: { status: 'available' }, attachments: [] });
});

test('actual missing and corrupted attachment bytes cannot become trusted content', async () => {
  const f = await fixture(), objectPath = getObjectPathSegments(f.version.sha256);
  await f.vault.writeFileBytes(objectPath, new Uint8Array([9, 9, 9]));
  const corrupt = await openExistingVault(f.vault);
  assert.ok(buildKnowledgeIndex(corrupt).records.flatMap(r => r.attachments).every(a => a.content.status === 'unavailable'));
  await assert.rejects(retrieveReferenceAttachment(f.vault, corrupt.project.projectId, f.ref.referenceId, f.version.versionId), /corrupt/);
  await f.vault.removeEntry(objectPath);
  const missing = await openExistingVault(f.vault);
  assert.equal(missing.references!.status, 'unavailable');
  assert.ok(buildKnowledgeIndex(missing).records.every(r => r.references.status === 'unavailable' && r.attachments.length === 0));
  assert.equal(buildKnowledgeIndex(missing).revisions[0].referenceContext.availability.status, 'unavailable');
  assert.deepEqual(buildKnowledgeIndex(missing).revisions[0].referenceContext.attachments, []);
});

test('corrupted manifests and partial/unsupported reference contexts expose no trusted facts', async () => {
  const f = await fixture(), id = f.first.revision.manifest.revisionId;
  for (const status of ['unavailable', 'unsupported'] as const) {
    const partial = structuredClone(f.first.vaultState);
    partial.references!.status = status;
    assert.equal(partial.references!.contexts[id].status, 'available');
    assert.ok(buildKnowledgeIndex(partial).records.every(r => r.references.status === status && !r.attachments.length));
    assert.equal(buildKnowledgeIndex(partial).revisions[0].referenceContext.availability.status, status);
    assert.deepEqual(buildKnowledgeIndex(partial).revisions[0].referenceContext.attachments, []);
  }
  const contextPath = ['references', 'contexts', `${id}.json`];
  await f.vault.writeFileText(contextPath, '{}');
  const contextDamaged = await openExistingVault(f.vault);
  assert.ok(buildKnowledgeIndex(contextDamaged).records.every(r => r.references.status === 'unavailable'));
  const manifestPath = ['revisions', `${id}.manifest.json`];
  const manifest = JSON.parse(await f.vault.readFileText(manifestPath)); manifest.notes.problem = 'tampered claim';
  await f.vault.writeFileText(manifestPath, JSON.stringify(manifest));
  const damaged = buildKnowledgeIndex(await openExistingVault(f.vault));
  assert.equal(damaged.records.length, 0); assert.equal(damaged.revisions[0].notes.status, 'unavailable');
  assert.equal(damaged.revisions[0].referenceContext.availability.status, 'unavailable');
  assert.deepEqual(damaged.revisions[0].referenceContext.attachments, []);
  assert.ok(damaged.diagnostics.length);
});

test('broken/duplicate/cyclic ancestry uses history utilities and preserves unavailable branch origins', async () => {
  const f = await fixture();
  const missing = structuredClone(f.first.vaultState), id = missing.revisions[0].manifest.revisionId;
  missing.revisions[0].manifest.parentRevisionId = 'missing-parent';
  missing.branches[0].startingRevisionId = 'missing-origin';
  let index = buildKnowledgeIndex(missing);
  assert.equal(index.revisions[0].history.validatedParentRevisionId, null);
  assert.ok(index.revisions[0].history.warnings.some(w => /missing/.test(w)));
  assert.equal(index.branches[0].origin.status, 'unavailable');
  assert.ok(index.records.length, 'Readable endpoint notes survive missing ancestry');
  missing.revisions[0].manifest.parentRevisionId = id;
  index = buildKnowledgeIndex(missing);
  assert.deepEqual(index.revisions[0].history.ancestry, [id]);
  assert.ok(index.revisions[0].history.warnings.some(w => /Cyclic/.test(w)));
  missing.revisions.push(structuredClone(missing.revisions[0]));
  assert.equal(buildKnowledgeIndex(missing).records.length, 0);
  const unsupported = structuredClone(f.first.vaultState); unsupported.revisions[0].manifest.schemaVersion = 2;
  assert.equal(buildKnowledgeIndex(unsupported).revisions[0].notes.status, 'unsupported');
  assert.equal(buildKnowledgeIndex(unsupported).revisions[0].referenceContext.availability.status, 'unsupported');
  assert.equal(buildKnowledgeIndex(unsupported).records.length, 0);
});
