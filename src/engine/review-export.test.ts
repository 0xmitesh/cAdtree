import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryFileSystemAdapter, type FileSystemDirectoryAdapter, type MemoryFaultHooks } from './fs-adapter';
import { initializeProjectVault, openExistingVault } from './vault-service';
import { captureRevision } from './revision-service';
import { createDesignBranch } from './branch-service';
import { createIdentityReview } from './component-identity';
import { scanBranchChanges } from './scanner';
import { inventorySignature, readVerifiedInventory } from './copy-service';
import { getObjectPathSegments } from './object-store';
import { prepareReviewExport, exportRevisionForReview, suggestReviewExportFolder, ReviewExportError } from './review-export';

const notes = { problem: 'Check fit', modification: 'Initial geometry', observations: 'For review' };
const complete = { kind: 'complete' as const, selectedPaths: [], labelFilenames: false };
const fingerprint = async (dir: FileSystemDirectoryAdapter) => inventorySignature(await readVerifiedInventory(dir));
async function fixture(hooks: MemoryFaultHooks = {}) {
  const disk = new InMemoryFileSystemAdapter('Disk', null, hooks);
  const working = await disk.getDirectory(['Working'], { create: true }), vault = await disk.getDirectory(['Vault'], { create: true }), parent = await disk.getDirectory(['Reviews'], { create: true });
  const folders = { 'branch-main': working };
  await initializeProjectVault(working, vault, 'Actuator');
  const bytes = new Uint8Array([0, 255, 10, 13, 80, 3]);
  await working.writeFileBytes(['Parts', 'Part1.SLDPRT'], bytes);
  await working.writeFileText(['Assembly.SLDASM'], 'native reference: Parts/Part1.SLDPRT');
  await working.getDirectory(['Empty', 'Nested'], { create: true });
  const saved = await captureRevision(working, vault, { branchId: 'branch-main', summary: 'Original fit', notes, fileNotes: [{ path: 'Parts/Part1.SLDPRT', ...notes }], workingFolders: folders });
  const plan = prepareReviewExport(saved.vaultState, saved.revision.manifest.revisionId, complete);
  const run = (selectedPlan = plan, extra: Partial<Parameters<typeof exportRevisionForReview>[0]> = {}) => exportRevisionForReview({ vaultDir: vault, parent, plan: selectedPlan, folderName: selectedPlan.folderName, workingFolders: folders, ...extra });
  return { disk, working, vault, parent, folders, saved, plan, run, bytes };
}

test('an older complete snapshot exports exact saved bytes and empty directories without reading working files or changing history', async () => {
  let prohibitWorkingReads = false, workingReads = 0;
  const f = await fixture({ onBeforeRead: path => { if (prohibitWorkingReads && path.includes('/Working/')) { workingReads++; throw new Error('Working bytes must not be read'); } } });
  await f.working.writeFileText(['Parts', 'Part1.SLDPRT'], 'newer unsaved geometry');
  const beforeVault = await fingerprint(f.vault), beforeWorking = await fingerprint(f.working);
  prohibitWorkingReads = true;
  const result = await f.run();
  prohibitWorkingReads = false;
  assert.equal(workingReads, 0);
  assert.equal(result.folderName, 'Actuator_Main_R01');
  const output = await f.parent.getDirectory([result.folderName]);
  assert.deepEqual(await output.readFileBytes(['Parts', 'Part1.SLDPRT']), f.bytes);
  assert.equal(await output.readFileText(['Assembly.SLDASM']), 'native reference: Parts/Part1.SLDPRT');
  assert.ok(await output.hasDirectory(['Empty', 'Nested']));
  assert.equal(await output.hasFile([f.plan.markerName]), false);
  const summary = await output.readFileText([result.summaryName]);
  for (const text of ['COMPLETE', 'Original fit', 'Check fit', 'Initial geometry', 'For review', f.saved.revision.manifest.captureCompletedAt, f.plan.files[0].sha256, f.plan.files[0].componentId!]) assert.ok(summary.includes(text), text);
  assert.doesNotMatch(summary, /[A-Z]:\\|\/home\/|\/Users\//);
  assert.equal(await fingerprint(f.vault), beforeVault);
  assert.equal(await fingerprint(f.working), beforeWorking);
  assert.equal((await openExistingVault(f.vault)).revisions.length, 1);
});

test('selected exports preserve relative paths by default, are partial, and do not discover dependencies', async () => {
  const f = await fixture();
  const plan = prepareReviewExport(f.saved.vaultState, f.plan.revisionId, { kind: 'selected', selectedPaths: ['Parts/Part1.SLDPRT'], labelFilenames: false });
  const result = await f.run(plan);
  const output = await f.parent.getDirectory([result.folderName]);
  assert.deepEqual(await output.readFileBytes(['Parts', 'Part1.SLDPRT']), f.bytes);
  assert.equal(await output.hasFile(['Assembly.SLDASM']), false);
  assert.equal(await output.hasDirectory(['Empty']), false);
  assert.match(await output.readFileText([plan.summaryName]), /PARTIAL.*dependencies are not discovered/);
  assert.equal(result.filesCount, 1);
});

test('labels use the selected revision’s recorded branch and project-wide number, retaining extension and saved content', async () => {
  const f = await fixture();
  await f.working.writeFileText(['Assembly.SLDASM'], 'Main revision two');
  await captureRevision(f.working, f.vault, { branchId: 'branch-main', summary: 'Main R2', notes, workingFolders: f.folders });
  const branch = await createDesignBranch({ vaultDir: f.vault, destinationParent: await f.disk.getDirectory(['Cases'], { create: true }), workingFolders: f.folders, sourceRevisionId: f.plan.revisionId, name: 'Alternative', reason: 'Different fit' });
  const bindings = { ...f.folders, [branch.branch.branchId]: branch.workingDir };
  await branch.workingDir.writeFileText(['Parts', 'Part1.SLDPRT'], 'alternative saved bytes');
  const saved = await captureRevision(branch.workingDir, f.vault, { branchId: branch.branch.branchId, summary: 'Alternative R3', notes, workingFolders: bindings });
  const plan = prepareReviewExport(saved.vaultState, saved.revision.manifest.revisionId, { kind: 'selected', selectedPaths: ['Parts/Part1.SLDPRT'], labelFilenames: true });
  assert.equal(plan.folderName, 'Actuator_Alternative_R03');
  assert.equal(plan.files[0].exportedPath, 'Parts/Part1_Alternative_R03.SLDPRT');
  const result = await f.run(plan, { workingFolders: bindings });
  const output = await f.parent.getDirectory([result.folderName]);
  assert.equal(await output.readFileText(['Parts', 'Part1_Alternative_R03.SLDPRT']), 'alternative saved bytes');
  assert.match(await output.readFileText([plan.summaryName]), /reference repair.*references were not rewritten/);
});

test('exports before and after a confirmed rename keep each historical filename and the available shared component ID', async () => {
  const f = await fixture();
  await f.working.removeEntry(['Parts', 'Part1.SLDPRT']);
  await f.working.writeFileText(['Parts', 'Pin.SLDPRT'], 'changed saved bytes');
  const state = await openExistingVault(f.vault);
  const scan = await scanBranchChanges(f.working, 'branch-main', f.saved.revision.manifest);
  const identityReview = createIdentityReview(state, scan, [{ from: 'Parts/Part1.SLDPRT', to: 'Parts/Pin.SLDPRT' }], []);
  const saved = await captureRevision(f.working, f.vault, { branchId: 'branch-main', summary: 'Confirmed rename', notes, identityReview, workingFolders: f.folders });
  const before = prepareReviewExport(saved.vaultState, f.plan.revisionId, complete);
  const after = prepareReviewExport(saved.vaultState, saved.revision.manifest.revisionId, complete);
  await f.run(before); await f.run(after);
  const oldOutput = await f.parent.getDirectory([before.folderName]), newOutput = await f.parent.getDirectory([after.folderName]);
  assert.deepEqual(await oldOutput.readFileBytes(['Parts', 'Part1.SLDPRT']), f.bytes);
  assert.equal(await oldOutput.hasFile(['Parts', 'Pin.SLDPRT']), false);
  assert.equal(await newOutput.readFileText(['Parts', 'Pin.SLDPRT']), 'changed saved bytes');
  assert.equal(await newOutput.hasFile(['Parts', 'Part1.SLDPRT']), false);
  assert.equal(before.files.find(x => x.path.includes('Part1'))!.componentId, after.files.find(x => x.path.includes('Pin'))!.componentId);
});

test('sanitized or case-folded filename collisions block the preview rather than overwrite or omit files', async () => {
  const f = await fixture();
  for (const path of ['Pin?.SLDPRT', 'Pin*.SLDPRT']) await f.working.writeFileText([path], path);
  const saved = await captureRevision(f.working, f.vault, { branchId: 'branch-main', summary: 'Distinct POSIX names', notes, workingFolders: f.folders });
  const request = { kind: 'selected' as const, selectedPaths: ['Pin?.SLDPRT', 'Pin*.SLDPRT'], labelFilenames: true };
  assert.throws(() => prepareReviewExport(saved.vaultState, saved.revision.manifest.revisionId, request), /naming collision.*Change the selection/);
  assert.deepEqual(await f.parent.listEntries(), []);
  const corrected = prepareReviewExport(saved.vaultState, saved.revision.manifest.revisionId, { ...request, selectedPaths: ['Pin?.SLDPRT'] });
  await f.run(corrected);
  assert.equal(corrected.files[0].exportedPath, 'Pin-_Main_R02.SLDPRT');
  assert.equal(await (await f.parent.getDirectory([corrected.folderName])).readFileText(['Pin-_Main_R02.SLDPRT']), 'Pin?.SLDPRT');
});

test('summary/marker name collisions preserve snapshot files and the preview explicitly names the alternative metadata file', async () => {
  const f = await fixture();
  await f.working.writeFileText(['_CADTREE_REVIEW.txt'], 'original review-named file');
  await f.working.writeFileText(['_CADTREE_EXPORT_INCOMPLETE.txt'], 'original marker-named file');
  const saved = await captureRevision(f.working, f.vault, { branchId: 'branch-main', summary: 'Metadata names', notes, workingFolders: f.folders });
  const plan = prepareReviewExport(saved.vaultState, saved.revision.manifest.revisionId, complete);
  assert.equal(plan.summaryName, '_CADTREE_REVIEW-2.txt');
  assert.equal(plan.markerName, '_CADTREE_EXPORT_INCOMPLETE-2.txt');
  const result = await f.run(plan), output = await f.parent.getDirectory([result.folderName]);
  assert.equal(await output.readFileText(['_CADTREE_REVIEW.txt']), 'original review-named file');
  assert.equal(await output.readFileText(['_CADTREE_EXPORT_INCOMPLETE.txt']), 'original marker-named file');
  assert.equal(await output.hasFile([plan.markerName]), false);
});

test('existing destinations are untouched, numbered retries are proposed, and protected descendants cannot be destinations', async () => {
  const f = await fixture();
  const occupied = await f.parent.getDirectory([f.plan.folderName.toUpperCase()], { create: true });
  await occupied.writeFileText(['Keep.txt'], 'do not overwrite');
  await assert.rejects(f.run(), /already exists/);
  assert.equal(await occupied.readFileText(['Keep.txt']), 'do not overwrite');
  assert.equal(await suggestReviewExportFolder(f.parent, f.plan.folderName), f.plan.folderName + '-2');
  for (const parent of [f.vault, f.working, await f.working.getDirectory(['Nested'], { create: true })]) {
    const before = await fingerprint(parent);
    await assert.rejects(f.run(f.plan, { parent }), /outside the vault and every working folder/);
    assert.equal(await fingerprint(parent), before);
  }
  // Selecting a common ancestor is safe when the labelled child is a sibling.
  await f.run(f.plan, { parent: f.disk });
  assert.ok(await f.disk.hasDirectory([f.plan.folderName]));
});

test('invalid selections, unsafe paths and a forged or stale preview fail before creating output', async () => {
  const f = await fixture();
  assert.throws(() => prepareReviewExport(f.saved.vaultState, f.plan.revisionId, { kind: 'selected', selectedPaths: [], labelFilenames: false }), /Select at least/);
  assert.throws(() => prepareReviewExport(f.saved.vaultState, f.plan.revisionId, { kind: 'selected', selectedPaths: ['absent'], labelFilenames: false }), /absent/);
  await assert.rejects(f.run({ ...f.plan, files: [] }), /preview changed/);
  await assert.rejects(f.run(f.plan, { folderName: '../escape' }), /destination name/);
  assert.deepEqual(await f.parent.listEntries(), []);
});

test('a missing or corrupted required saved object is refused before creating the export folder', async () => {
  for (const damage of ['missing', 'changed']) {
    const f = await fixture();
    const object = getObjectPathSegments(f.plan.files[0].sha256);
    if (damage === 'missing') await f.vault.removeEntry(object); else await f.vault.writeFileText(object, 'corrupted');
    await assert.rejects(f.run(), /Saved content failed verification/);
    assert.deepEqual(await f.parent.listEntries(), []);
    assert.equal((await openExistingVault(f.vault)).revisions.length, 1);
  }
});

for (const failure of ['write', 'cancel', 'verification'] as const) test(`${failure} failure retains identifiable incomplete output and a fresh retry succeeds without altering sources`, async () => {
  let armed = false, f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ onBeforeWrite: path => { if (armed && failure === 'write' && path.includes('/Reviews/') && path.endsWith('.SLDPRT')) throw new Error('Injected export write failure'); }, onAfterWrite: async path => {
    if (armed && failure === 'verification' && path.includes('/Reviews/') && path.endsWith('.SLDPRT')) { armed = false; await (await f.parent.getDirectory([f.plan.folderName])).writeFileBytes(['Parts', 'Part1.SLDPRT'], new Uint8Array(f.bytes.length)); }
  } });
  const before = await fingerprint(f.vault), beforeWorking = await fingerprint(f.working);
  const abort = new AbortController();
  armed = true;
  await assert.rejects(f.run(f.plan, { signal: abort.signal, onProgress: p => { if (failure === 'cancel' && p.phase === 'restoring_files' && p.processedFiles === 1) abort.abort(); } }), error => {
    assert.ok(error instanceof ReviewExportError);
    assert.equal(error.incompleteFolder, f.plan.folderName);
    assert.match(error.message, /Incomplete output.*fresh folder/);
    if (failure === 'cancel') assert.equal(error.cancelled, true);
    return true;
  });
  armed = false;
  assert.ok(await (await f.parent.getDirectory([f.plan.folderName])).hasFile([f.plan.markerName]));
  const name = await suggestReviewExportFolder(f.parent, f.plan.folderName);
  assert.equal(name, f.plan.folderName + '-2');
  const result = await f.run(f.plan, { folderName: name });
  assert.equal(result.filesCount, f.plan.files.length);
  assert.equal(await fingerprint(f.vault), before);
  assert.equal(await fingerprint(f.working), beforeWorking);
});

test('cancelling before verification creates nothing and legacy snapshots export without inventing component IDs', async () => {
  const f = await fixture();
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.run(f.plan, { signal: abort.signal }), /No export folder was created/);
  assert.deepEqual(await f.parent.listEntries(), []);
  await f.vault.removeEntry(['components'], { recursive: true });
  const state = await openExistingVault(f.vault);
  const plan = prepareReviewExport(state, f.plan.revisionId, complete);
  assert.ok(plan.files.every(file => file.componentId === null));
  const before = await fingerprint(f.vault);
  await f.run(plan);
  assert.equal(await fingerprint(f.vault), before);
  assert.match(plan.summaryText, /component ID: unavailable for this snapshot/);
});
