import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryFileSystemAdapter, type FileSystemDirectoryAdapter } from './fs-adapter';
import { initializeProjectVault, openExistingVault } from './vault-service';
import { captureRevision } from './revision-service';
import { createDesignBranch } from './branch-service';
import { scanBranchChanges } from './scanner';
import { getBranchBaseline } from './branch-state';
import { createIdentityReview, possibleRenames, enableComponentTracking, componentChecksum } from './component-identity';
import { restoreRevisionToFolder } from './recovery-service';
import { fileHistory, historicalComponents } from '../history/file-history';
import { layoutRevisions } from '../history/layout';
import { createWorkspace, createProject, importProject, adoptProject, openWorkspace } from './workspace-service';
import { createHome, bringWorkspaceIntoHome } from './home-service';
import { copyVerifiedTree, inventorySignature, readVerifiedInventory } from './copy-service';
import { prepareApplyPreview, buildApplyPreview } from './apply-preview';
import { prepareApplication, applyPreparedApplication, applicationReview } from './application-service';
import type { CaptureRevisionInput, VaultState } from './types';
const notes = { problem: '', modification: '', observations: '' };
const mainId = 'branch-main';
const mapping = (state: VaultState, revisionId: string, path: string) => state.components?.revisions[revisionId]?.files.find(f => f.path === path)?.componentId;
const inventory = async (dir: FileSystemDirectoryAdapter) => inventorySignature(await readVerifiedInventory(dir));
async function fixture() {
  const working = new InMemoryFileSystemAdapter('Main'), vault = new InMemoryFileSystemAdapter('Vault');
  const folders: Record<string, FileSystemDirectoryAdapter> = { [mainId]: working };
  await initializeProjectVault(working, vault, 'Components');
  const save = (extra: Partial<CaptureRevisionInput> = {}, dir: FileSystemDirectoryAdapter = working, branchId = mainId) => captureRevision(dir, vault, { branchId, summary: 'Saved state', notes, workingFolders: folders, ...extra });
  const scan = async (dir = working, branchId = mainId) => {
    const state = await openExistingVault(vault);
    return { state, scan: await scanBranchChanges(dir, branchId, getBranchBaseline(state, branchId)) };
  };
  await working.writeFileText(['caliper.SLDPRT'], 'initial bytes');
  const first = await save();
  return { working, vault, folders, save, scan, first, componentId: mapping(first.vaultState, first.revision.manifest.revisionId, 'caliper.SLDPRT')! };
}
test('new registrations are distinct from identical Save As copies and stable through edits, scans and reopen without browser data', async () => {
  const f = await fixture();
  const before = await inventory(f.vault);
  await f.scan(); await f.scan();
  assert.equal(await inventory(f.vault), before, 'read-only scans do not allocate durable IDs');
  await f.working.writeFileText(['caliper.SLDPRT'], 'changed properties or geometry');
  await f.working.writeFileText(['Copy.SLDPRT'], 'changed properties or geometry');
  const second = await f.save();
  const state = await openExistingVault(f.vault);
  assert.equal(mapping(state, second.revision.manifest.revisionId, 'caliper.SLDPRT'), f.componentId);
  assert.notEqual(mapping(state, second.revision.manifest.revisionId, 'Copy.SLDPRT'), f.componentId);
  assert.equal(state.components?.status, 'available');
});
for (const changedBytes of [false, true]) test(`confirmed moved/renamed document follows identity and original recovery filenames (changed bytes: ${changedBytes})`, async () => {
  const f = await fixture();
  await f.working.removeEntry(['caliper.SLDPRT']);
  await f.working.writeFileText(['Parts', 'cliper.SLDPRT'], changedBytes ? 'changed bytes' : 'initial bytes');
  const { state, scan } = await f.scan();
  assert.deepEqual(possibleRenames(scan)[0].candidates, changedBytes ? [] : ['Parts/cliper.SLDPRT']);
  const review = createIdentityReview(state, scan, [{ from: 'caliper.SLDPRT', to: 'Parts/cliper.SLDPRT' }], []);
  const saved = await f.save({ identityReview: review, reviewedChangesSignature: scan.changesSignature, fileNotes: [{ path: 'Parts/cliper.SLDPRT', problem: 'Clearance', modification: 'Rename confirmed', observations: '' }] });
  assert.equal(mapping(saved.vaultState, saved.revision.manifest.revisionId, 'Parts/cliper.SLDPRT'), f.componentId);
  const history = fileHistory(saved.vaultState, layoutRevisions(saved.vaultState, mainId), '', null, null, f.componentId);
  assert.equal(history.records.get(saved.revision.manifest.revisionId)?.status, 'Renamed');
  assert.equal(history.records.get(f.first.revision.manifest.revisionId)?.file?.path, 'caliper.SLDPRT');
  for (const [revision, path] of [[f.first.revision, 'caliper.SLDPRT'], [saved.revision, 'Parts/cliper.SLDPRT']] as const) {
    const destination = new InMemoryFileSystemAdapter('Recovery');
    await restoreRevisionToFolder({ vaultDir: f.vault, destinationDir: destination, workingFolders: f.folders, revisionId: revision.manifest.revisionId });
    assert.ok(await destination.hasFile(path.split('/')));
    assert.equal((await destination.listEntries()).some(e => e.name === 'components'), false);
  }
});
test('ambiguous hash matches remain suggestions and unconfirmed delete/add receives a new identity', async () => {
  const f = await fixture();
  await f.working.removeEntry(['caliper.SLDPRT']);
  for (const name of ['one', 'two']) await f.working.writeFileText([name], 'initial bytes');
  const { scan } = await f.scan();
  assert.equal(possibleRenames(scan)[0].candidates.length, 2);
  const saved = await f.save();
  assert.ok(saved.vaultState.components!.revisions[saved.revision.manifest.revisionId].files.every(file => file.componentId !== f.componentId));
});
test('branch origins preserve identities without creating a revision and edits remain independent', async () => {
  const f = await fixture();
  const branch = await createDesignBranch({ vaultDir: f.vault, destinationParent: new InMemoryFileSystemAdapter('Cases'), workingFolders: f.folders, sourceRevisionId: f.first.revision.manifest.revisionId, name: 'Alternative', reason: 'Investigate' });
  assert.equal(branch.vaultState.revisions.length, 1);
  f.folders[branch.branch.branchId] = branch.workingDir;
  await branch.workingDir.writeFileText(['caliper.SLDPRT'], 'alternative');
  const saved = await f.save({}, branch.workingDir, branch.branch.branchId);
  assert.equal(mapping(saved.vaultState, saved.revision.manifest.revisionId, 'caliper.SLDPRT'), f.componentId);
  assert.equal(await f.working.readFileText(['caliper.SLDPRT']), 'initial bytes');
});
test('explicit same-path replacement can publish an identity-only revision and retains old history', async () => {
  const f = await fixture();
  const { state, scan } = await f.scan();
  assert.equal(scan.hasChanges, false);
  const saved = await f.save({ identityReview: createIdentityReview(state, scan, [], ['caliper.SLDPRT']) });
  assert.notEqual(mapping(saved.vaultState, saved.revision.manifest.revisionId, 'caliper.SLDPRT'), f.componentId);
  assert.equal(historicalComponents(saved.vaultState).length, 2);
  assert.equal(saved.revision.manifest.files[0].sha256, f.first.revision.manifest.files[0].sha256);
});
test('deletion followed by same-path same-byte reappearance establishes a different component', async () => {
  const f = await fixture();
  await f.working.removeEntry(['caliper.SLDPRT']);
  await f.save();
  await f.working.writeFileText(['caliper.SLDPRT'], 'initial bytes');
  const saved = await f.save();
  assert.notEqual(mapping(saved.vaultState, saved.revision.manifest.revisionId, 'caliper.SLDPRT'), f.componentId);
  assert.equal(historicalComponents(saved.vaultState).length, 2);
});
test('capture rejects stale bytes, baseline and branch decisions and one-to-many associations before publication', async () => {
  const f = await fixture();
  await f.working.removeEntry(['caliper.SLDPRT']);
  await f.working.writeFileText(['cliper.SLDPRT'], 'initial bytes');
  const { state, scan } = await f.scan();
  const review = createIdentityReview(state, scan, [{ from: 'caliper.SLDPRT', to: 'cliper.SLDPRT' }], []);
  await f.working.writeFileText(['cliper.SLDPRT'], 'changed after review');
  await assert.rejects(f.save({ identityReview: review }), /stale/);
  const latest = await f.scan();
  const valid = createIdentityReview(latest.state, latest.scan, review.renames, []);
  await assert.rejects(f.save({ identityReview: { ...valid, branchId: 'other' } }), /stale/);
  await assert.rejects(f.save({ identityReview: { ...valid, baselineManifestSha256: 'wrong' } }), /stale/);
  await assert.rejects(f.save({ identityReview: { ...valid, renames: [...valid.renames, ...valid.renames] } }), /one missing/);
  assert.equal((await openExistingVault(f.vault)).revisions.length, 1);
});
test('failed sidecar/manifest publication and retries do not commit provisional IDs or rename decisions', async () => {
  const f = await fixture();
  await f.working.removeEntry(['caliper.SLDPRT']);
  await f.working.writeFileText(['cliper.SLDPRT'], 'initial bytes');
  const { state, scan } = await f.scan();
  const review = createIdentityReview(state, scan, [{ from: 'caliper.SLDPRT', to: 'cliper.SLDPRT' }], []);
  const original = f.vault.writeFileText.bind(f.vault);
  let fail = true;
  f.vault.writeFileText = async (path, text, options) => {
    if (fail && path[0] === 'completed') { fail = false; throw new Error('Injected completion failure'); }
    return original(path, text, options);
  };
  await assert.rejects(f.save({ identityReview: review }), /Injected/);
  const failed = await openExistingVault(f.vault);
  assert.equal(failed.revisions.length, 1);
  assert.equal(Object.keys(failed.components!.revisions).length, 1);
  assert.equal(failed.components?.status, 'available');
  const saved = await f.save({ identityReview: review });
  assert.equal(mapping(saved.vaultState, saved.revision.manifest.revisionId, 'cliper.SLDPRT'), f.componentId);
  await assert.rejects(f.save({ identityReview: review }), /stale/);
  assert.equal((await openExistingVault(f.vault)).revisions.length, 2);
});
test('completion written before acknowledgement loss reopens the one published mapping', async () => {
  const f = await fixture();
  await f.working.writeFileText(['new'], 'new');
  const original = f.vault.readFileText.bind(f.vault);
  let lose = true;
  f.vault.readFileText = async path => {
    if (lose && path[0] === 'completed' && !path[1].startsWith(f.first.revision.manifest.revisionId)) { lose = false; throw new Error('Lost completion acknowledgement'); }
    return original(path);
  };
  await assert.rejects(f.save(), /Lost completion/);
  const state = await openExistingVault(f.vault);
  assert.equal(state.components?.status, 'available');
  assert.equal(state.revisions.length, 2);
  const newId = mapping(state, state.revisions[1].manifest.revisionId, 'new');
  await assert.rejects(f.save(), /No changes/);
  assert.equal(mapping(await openExistingVault(f.vault), state.revisions[1].manifest.revisionId, 'new'), newId);
});
test('cancellation during identity publication leaves the sidecar uncommitted and retry publishes one registration', async () => {
  const f = await fixture();
  await f.working.writeFileText(['new'], 'new');
  const abort = new AbortController();
  const original = f.vault.writeFileText.bind(f.vault);
  f.vault.writeFileText = async (path,text,options) => {
    await original(path,text,options);
    if(path[0] === 'components' && path[1] === 'revisions') abort.abort();
  };
  await assert.rejects(f.save({signal:abort.signal}), /cancelled/);
  assert.equal((await openExistingVault(f.vault)).revisions.length,1);
  f.vault.writeFileText = original;
  const saved = await f.save();
  assert.equal(saved.vaultState.revisions.length,2);
  assert.equal(saved.vaultState.components?.status,'available');
});
test('an existing project cannot silently share a newly registered ID or bind to a different manifest', async () => {
  for (const failure of ['reuse','binding']) {
    const f = await fixture();
    await f.working.writeFileText(['new'],'new');
    const saved = await f.save();
    const path = ['components','revisions',`${saved.revision.manifest.revisionId}.json`];
    const record = JSON.parse(await f.vault.readFileText(path));
    if(failure === 'reuse') {
      // End the old presence so uniqueness within a snapshot alone cannot catch it.
      await f.working.removeEntry(['caliper.SLDPRT']);
      const newer = await f.save();
      const newerPath = ['components','revisions',`${newer.revision.manifest.revisionId}.json`];
      const changed = JSON.parse(await f.vault.readFileText(newerPath));
      changed.files[0].componentId = f.componentId;
      changed.payloadSha256 = componentChecksum(changed);
      await f.vault.writeFileText(newerPath,JSON.stringify(changed));
    } else {
      record.manifestSha256 = '0'.repeat(64); record.payloadSha256 = componentChecksum(record);
      await f.vault.writeFileText(path,JSON.stringify(record));
    }
    assert.equal((await openExistingVault(f.vault)).components?.status,'unavailable');
  }
});
for (const damage of ['missing', 'duplicate', 'unsupported', 'checksum'] as const) test(`damaged component evidence (${damage}) blocks new identities without rewriting history`, async () => {
  const f = await fixture();
  const path = ['components', 'revisions', `${f.first.revision.manifest.revisionId}.json`];
  if (damage === 'missing') await f.vault.removeEntry(path);
  else {
    const record = JSON.parse(await f.vault.readFileText(path));
    if (damage === 'duplicate') record.files.push(record.files[0]);
    if (damage === 'unsupported') record.schemaVersion = 50;
    record.payloadSha256 = damage === 'checksum' ? 'broken' : componentChecksum(record);
    await f.vault.writeFileText(path, JSON.stringify(record));
  }
  const state = await openExistingVault(f.vault);
  assert.equal(state.components?.status, damage === 'unsupported' ? 'unsupported' : 'unavailable');
  assert.equal(state.revisions.length, 1);
  await f.working.writeFileText(['new'], 'new');
  await assert.rejects(f.save(), /unavailable/);
  await assert.rejects(enableComponentTracking(f.vault), /cannot be replaced/);
});
test('legacy upgrade is deliberate, prospective, retries preserve seeds and historical manifests stay byte-identical', async () => {
  const f = await fixture();
  await f.vault.removeEntry(['components'], { recursive: true }); // indistinguishable legacy fixture
  await f.working.writeFileText(['caliper.SLDPRT'], 'legacy second');
  const second = await f.save();
  const state = await openExistingVault(f.vault);
  assert.equal(state.components?.status, 'legacy');
  const before = await inventory(await f.vault.getDirectory(['revisions']));
  const original = f.vault.writeFileText.bind(f.vault);
  let fail = true;
  f.vault.writeFileText = async (path,text,opts) => {
    if (fail && path.join('/') === 'components/ready.json') { fail = false; throw new Error('Enrollment interrupted'); }
    return original(path,text,opts);
  };
  await assert.rejects(enableComponentTracking(f.vault), /Enrollment interrupted/);
  const seedText = await f.vault.readFileText(['components','boundary.json']);
  const upgraded = await enableComponentTracking(f.vault);
  assert.equal(upgraded.components?.status, 'available');
  assert.equal(await f.vault.readFileText(['components','boundary.json']), seedText);
  assert.equal(upgraded.components?.revisions[f.first.revision.manifest.revisionId], undefined);
  assert.ok(upgraded.components?.revisions[second.revision.manifest.revisionId]);
  assert.equal(await inventory(await f.vault.getDirectory(['revisions'])), before);
  assert.equal((await enableComponentTracking(f.vault)).components?.boundary?.payloadSha256, upgraded.components?.boundary?.payloadSha256);
});
test('complete project import/adoption, relocation and whole workspace import retain IDs and uncaptured edits; duplicate registration is rejected', async () => {
  const source = new InMemoryFileSystemAdapter('Source workspace');
  await createWorkspace(source);
  const project = await createProject(source,'Original');
  const main = project.workingFolders[mainId]!;
  await main.writeFileText(['part'], 'part');
  const saved = await captureRevision(main,project.vaultDir,{ branchId:mainId, summary:'Baseline',notes,workingFolders:project.workingFolders });
  const expected = saved.vaultState.components;
  await main.writeFileText(['part'],'unsaved edits');
  const container = await source.getDirectory(project.record.containerPath.split('/'));
  const target = new InMemoryFileSystemAdapter('Target workspace'); await createWorkspace(target);
  const imported = await importProject(target,container,container.name);
  assert.equal(imported.record.projectId,project.record.projectId);
  assert.deepEqual(imported.vaultState.components,expected);
  assert.equal(await imported.workingFolders[mainId]!.readFileText(['part']),'unsaved edits');
  await assert.rejects(importProject(target,container,container.name),/already has a managed location/);
  const adoptedRoot = new InMemoryFileSystemAdapter('Adopted'); await createWorkspace(adoptedRoot);
  assert.deepEqual((await adoptProject(adoptedRoot,project.vaultDir,project.workingFolders)).vaultState.components,expected);
  const home = new InMemoryFileSystemAdapter('Home'); await createHome(home);
  const migrated = await bringWorkspaceIntoHome(home,source);
  assert.deepEqual(migrated.workspace!.projects[0].project!.vaultState.components,expected);
  const relocated = new InMemoryFileSystemAdapter('Relocated'); await copyVerifiedTree(source,relocated);
  assert.deepEqual((await openWorkspace(relocated)).projects[0].project!.vaultState.components,expected);
  const otherRaw = new InMemoryFileSystemAdapter('Ordinary'); await otherRaw.writeFileText(['part'],'part');
  const ordinary = await importProject(target,otherRaw,'Ordinary');
  assert.notEqual(ordinary.record.projectId,project.record.projectId);
});
test('cross-branch rename and unrelated same-path replacement are blocked while safe additions carry source identity', async () => {
  const f = await fixture();
  const branch = await createDesignBranch({ vaultDir:f.vault,destinationParent:new InMemoryFileSystemAdapter('Cases'),workingFolders:f.folders,sourceRevisionId:f.first.revision.manifest.revisionId,name:'Case',reason:'Explore' });
  const branchId = branch.branch.branchId; f.folders[branchId] = branch.workingDir;
  await branch.workingDir.writeFileText(['caliper.SLDPRT'],'case edit');
  await branch.workingDir.writeFileText(['safe-new'],'source addition');
  const source = await f.save({},branch.workingDir,branchId);
  await f.working.removeEntry(['caliper.SLDPRT']); await f.working.writeFileText(['cliper.SLDPRT'],'initial bytes');
  const review = await f.scan();
  const dest = await f.save({identityReview:createIdentityReview(review.state,review.scan,[{from:'caliper.SLDPRT',to:'cliper.SLDPRT'}],[])});
  const prep = prepareApplyPreview(dest.vaultState,source.revision.manifest.revisionId,mainId);
  assert.equal(prep.status,'available'); if(prep.status !== 'available') return;
  assert.match(prep.context.rows.find(r=>r.path==='caliper.SLDPRT')!.identityBlock!,/different paths/);
  assert.equal(prep.context.rows.find(r=>r.path==='safe-new')!.identityBlock,undefined);
  const unsafe = buildApplyPreview(prep.context,{'caliper.SLDPRT':{selected:true,decision:'use-source'}},'Use change');
  assert.equal(unsafe.ready,false);
  const choices = {'safe-new':{selected:true,decision:'use-source' as const}};
  const plan = buildApplyPreview(prep.context,choices,'Use addition');
  assert.equal(plan.ready,true);
  const application = await prepareApplication(f.vault,applicationReview(plan,choices),{workingFolders:f.folders});
  await applyPreparedApplication(f.vault,application,{workingFolders:f.folders});
  const captured = await f.save();
  assert.equal(mapping(captured.vaultState,captured.revision.manifest.revisionId,'safe-new'),mapping(source.vaultState,source.revision.manifest.revisionId,'safe-new'));
  // A different component at an existing path never inherits the source identity.
  const current = await f.scan();
  const replaced = await f.save({identityReview:createIdentityReview(current.state,current.scan,[],['safe-new'])});
  await branch.workingDir.writeFileText(['safe-new'],'new source bytes');
  const source2 = await f.save({},branch.workingDir,branchId);
  const conflict = prepareApplyPreview(source2.vaultState,source2.revision.manifest.revisionId,mainId);
  assert.equal(conflict.status,'available');
  if(conflict.status === 'available') assert.match(conflict.context.rows.find(r=>r.path==='safe-new')!.identityBlock!,/Different components/);
  assert.ok(replaced.vaultState.components);
});
test('an applied addition cannot also be a confirmed rename target; rejection preserves evidence and corrected retry succeeds', async () => {
  const f = await fixture();
  const branch = await createDesignBranch({ vaultDir: f.vault, destinationParent: new InMemoryFileSystemAdapter('Cases'), workingFolders: f.folders, sourceRevisionId: f.first.revision.manifest.revisionId, name: 'Addition', reason: 'New component' });
  f.folders[branch.branch.branchId] = branch.workingDir;
  await branch.workingDir.writeFileText(['new.SLDPRT'], 'source addition');
  const source = await f.save({}, branch.workingDir, branch.branch.branchId);
  const prepared = prepareApplyPreview(source.vaultState, source.revision.manifest.revisionId, mainId);
  assert.equal(prepared.status, 'available');
  if (prepared.status !== 'available') throw new Error('Expected available preview');
  const choices = { 'new.SLDPRT': { selected: true, decision: 'use-source' as const } };
  const plan = buildApplyPreview(prepared.context, choices, 'Use addition');
  const application = await prepareApplication(f.vault, applicationReview(plan, choices), { workingFolders: f.folders });
  const applied = await applyPreparedApplication(f.vault, application, { workingFolders: f.folders });
  await f.working.removeEntry(['caliper.SLDPRT']);
  const { state, scan } = await f.scan();
  const review = createIdentityReview(state, scan, [{ from: 'caliper.SLDPRT', to: 'new.SLDPRT' }], []);
  const before = await inventory(f.vault);
  const writes: string[] = [];
  const original = f.vault.writeFileText.bind(f.vault);
  f.vault.writeFileText = async (path, text, options) => {
    writes.push(path.join('/'));
    return original(path, text, options);
  };
  await assert.rejects(f.save({ identityReview: review, reviewedChangesSignature: scan.changesSignature }), /Component identity conflict.*new\.SLDPRT.*confirmed rename/);
  assert.deepEqual(writes, [], 'reject before capture provenance, component sidecar or completion writes');
  assert.equal(await inventory(f.vault), before, 'rejection leaves all vault evidence unchanged');
  const rejected = await openExistingVault(f.vault);
  assert.equal(rejected.revisions.length, state.revisions.length);
  assert.equal(rejected.components?.status, 'available');
  assert.deepEqual(rejected.components, state.components);
  assert.equal(rejected.applicationOperations?.find(op => op.operationId === applied.operationId)?.status, 'applied');
  // Cancel the association: the deletion and applied addition retain separate identities.
  const corrected = createIdentityReview(rejected, scan, [], []);
  const saved = await f.save({ identityReview: corrected, reviewedChangesSignature: scan.changesSignature });
  const reopened = await openExistingVault(f.vault);
  assert.equal(reopened.revisions.length, state.revisions.length + 1);
  assert.equal(reopened.components?.status, 'available');
  assert.equal(mapping(reopened, saved.revision.manifest.revisionId, 'new.SLDPRT'), mapping(source.vaultState, source.revision.manifest.revisionId, 'new.SLDPRT'));
  assert.notEqual(mapping(reopened, saved.revision.manifest.revisionId, 'new.SLDPRT'), f.componentId);
  assert.equal(reopened.applicationOperations?.find(op => op.operationId === applied.operationId)?.status, 'captured');
});

test('a legacy shared ancestor does not block a safely unrelated source addition absent at that ancestor', async () => {
  const f = await fixture();
  await f.vault.removeEntry(['components'],{recursive:true});
  const branch = await createDesignBranch({vaultDir:f.vault,destinationParent:new InMemoryFileSystemAdapter('Cases'),workingFolders:f.folders,sourceRevisionId:f.first.revision.manifest.revisionId,name:'Legacy case',reason:'Explore'});
  f.folders[branch.branch.branchId] = branch.workingDir;
  await branch.workingDir.writeFileText(['caliper.SLDPRT'],'legacy case edit');
  await f.save({},branch.workingDir,branch.branch.branchId);
  await f.working.writeFileText(['caliper.SLDPRT'],'legacy main edit'); await f.save();
  await enableComponentTracking(f.vault);
  await branch.workingDir.writeFileText(['safe-addition'],'new');
  const source = await f.save({},branch.workingDir,branch.branch.branchId);
  const prepared = prepareApplyPreview(source.vaultState,source.revision.manifest.revisionId,mainId);
  assert.equal(prepared.status,'available');
  if(prepared.status !== 'available') return;
  assert.match(prepared.context.rows.find(r=>r.path==='caliper.SLDPRT')!.identityBlock!,/legacy endpoint/);
  assert.equal(prepared.context.rows.find(r=>r.path==='safe-addition')!.identityBlock,undefined);
  assert.equal(buildApplyPreview(prepared.context,{'safe-addition':{selected:true,decision:'use-source'}},'Unrelated addition').ready,true);
});
test('damaged identity metadata is refused by project and workspace imports without regenerating source identities', async () => {
  const root = new InMemoryFileSystemAdapter('Original'); await createWorkspace(root);
  const project = await createProject(root,'Damaged'); const main = project.workingFolders[mainId]!;
  await main.writeFileText(['part'],'part');
  const saved = await captureRevision(main,project.vaultDir,{branchId:mainId,summary:'First',notes,workingFolders:project.workingFolders});
  await project.vaultDir.removeEntry(['components','revisions',`${saved.revision.manifest.revisionId}.json`]);
  const before = await inventory(root);
  const target = new InMemoryFileSystemAdapter('Target'); await createWorkspace(target);
  const container = await root.getDirectory(project.record.containerPath.split('/'));
  await assert.rejects(importProject(target,container,'Damaged'),/Component identity unavailable/);
  await assert.rejects(adoptProject(target,project.vaultDir,project.workingFolders),/damaged or ambiguous/);
  const home = new InMemoryFileSystemAdapter('Home'); await createHome(home);
  await assert.rejects(bringWorkspaceIntoHome(home,root),/damaged|incomplete/);
  assert.equal(await inventory(root),before);
  assert.equal((await openWorkspace(target)).projects.length,0);
});
