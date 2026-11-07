import '../../tests/dom';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { act, cleanup, render, fireEvent, within, waitFor } from '@testing-library/react';
import App from '../App';
import { ChangesCaptureView } from './ChangesCaptureView';
import { RevisionReferenceContext } from './RevisionReferenceContext';
import { InMemoryFileSystemAdapter } from '../engine/fs-adapter';
import { createHome, createHomeWorkspace } from '../engine/home-service';
import { createProject } from '../engine/workspace-service';
import { captureRevision } from '../engine/revision-service';
import { openExistingVault } from '../engine/vault-service';
import { scanBranchChanges } from '../engine/scanner';
import { clearAllConvenienceMetadata } from '../engine/idb-store';
import { inventorySignature, readVerifiedInventory } from '../engine/copy-service';
import { importReferenceAttachment, updateProjectReference, createReferenceReview } from '../engine/references';
import { openHomeWorkspace, appBusy } from '../../tests/app-controls';

Object.assign(globalThis, { indexedDB });
afterEach(async () => { cleanup(); await clearAllConvenienceMetadata(); Reflect.deleteProperty(window, 'showDirectoryPicker'); });
const branchId = 'branch-main', notes = { problem: '', modification: '', observations: '' };
async function fixture() {
  const home = new InMemoryFileSystemAdapter('Cadtree'); await createHome(home);
  const workspace = await createHomeWorkspace(home, 'Engineering');
  const project = await createProject(workspace.workspace.root, 'Actuator'), working = project.workingFolders[branchId]!;
  await working.writeFileText(['part.SLDPRT'], 'geometry');
  const first = await captureRevision(working, project.vaultDir, { branchId, summary: 'Initial geometry', notes, workingFolders: project.workingFolders });
  return { home, project, working, first };
}
const source = () => new File([new Uint8Array([0, 255, 13, 10, 128])], 'Requirement.pdf', { type: 'application/pdf' });

test('already-pinned reference versions are disabled; another version still updates project context', async () => {
  const f = await fixture();
  const metadata = { title: 'Requirements', description: '', tags: ['demo'] };
  let state = await importReferenceAttachment(f.project.vaultDir, f.project.record.projectId, source(), metadata);
  const ref = state.references!.library[0], v1 = ref.versions[0].versionId;
  state = await importReferenceAttachment(f.project.vaultDir, f.project.record.projectId, new File(['Updated requirement'], 'Updated.pdf'), metadata, ref.referenceId);
  const v2 = state.references!.library[0].versions[1].versionId;
  await updateProjectReference(f.project.vaultDir, f.project.record.projectId, ref.referenceId, { projectVersionId: v1 });
  const ui = render(<App />);
  await openHomeWorkspace(ui, f.home);
  fireEvent.click(ui.getByRole('button', { name: 'Open project' }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  fireEvent.click(within(ui.getByRole('navigation')).getByRole('button', { name: 'References' }));
  const versions = ui.getByRole('combobox', { name: /Attachment version/ });
  assert.equal((versions as HTMLSelectElement).value, v2);
  fireEvent.change(versions, { target: { value: v1 } });
  const selected = ui.getByRole('button', { name: 'Project context: this version' }) as HTMLButtonElement;
  assert.equal(selected.disabled, true);
  const beforeState = await openExistingVault(f.project.vaultDir);
  const beforeFiles = inventorySignature(await readVerifiedInventory(f.home));
  const calls = { reads: 0, writes: 0 };
  f.home.setHooks({ onBeforeRead: () => { calls.reads++; }, onBeforeWrite: () => { calls.writes++; } });
  await act(async () => { selected.click(); });
  assert.deepEqual(calls, { reads: 0, writes: 0 }, 'The disabled status does not invoke a reference operation');
  assert.equal(inventorySignature(await readVerifiedInventory(f.home)), beforeFiles);
  f.home.setHooks({ onBeforeRead: undefined, onBeforeWrite: undefined });
  fireEvent.change(versions, { target: { value: v2 } });
  const choose = ui.getByRole('button', { name: 'Use this version in project context' }) as HTMLButtonElement;
  assert.equal(choose.disabled, false);
  fireEvent.click(choose);
  await waitFor(() => assert.equal((ui.getByRole('button', { name: 'Project context: this version' }) as HTMLButtonElement).disabled, true));
  await waitFor(() => assert.equal(appBusy(ui), false));
  const updated = await openExistingVault(f.project.vaultDir);
  assert.equal(updated.references!.library[0].projectVersionId, v2);
  assert.equal(updated.references!.library[0].versions.length, 2);
  assert.equal(Object.keys(updated.references!.catalogs).length, Object.keys(beforeState.references!.catalogs).length + 1);
  assert.equal(updated.revisions.length, 1);
  fireEvent.change(versions, { target: { value: v1 } });
  assert.equal((ui.getByRole('button', { name: 'Use this version in project context' }) as HTMLButtonElement).disabled, false);
});

test('actual App imports, pins project context, saves a reference-only revision, retrieves and reopens entirely from disk', async () => {
  const f = await fixture(); let ui = render(<App />); 
  await openHomeWorkspace(ui, f.home); fireEvent.click(ui.getByRole('button', { name: 'Open project' }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  fireEvent.click(within(ui.getByRole('navigation')).getByRole('button', { name: 'References' }));
  fireEvent.click(ui.getByRole('button', { name: 'Import reference' }));
  const dialog = within(ui.getByRole('dialog', { name: 'Import reference' }));
  fireEvent.change(dialog.getByLabelText('Original attachment'), { target: { files: [source()] } });
  fireEvent.change(dialog.getByLabelText('Description'), { target: { value: 'Customer discussion' } });
  fireEvent.change(dialog.getByLabelText('Tags (comma separated)'), { target: { value: 'clearance, customer' } });
  fireEvent.submit(dialog.getByRole('button', { name: 'Copy and verify attachment' }).closest('form')!);
  await waitFor(() => assert.ok(!ui.queryByRole('dialog')));
  assert.ok(ui.getByText(/import time, not document creation date/));
  fireEvent.change(ui.getByRole('textbox', { name: 'Search references' }), { target: { value: 'clearance' } });
  assert.ok(ui.getByRole('heading', { name: 'Requirement.pdf' }));
  fireEvent.change(ui.getByRole('textbox', { name: 'Search references' }), { target: { value: 'unmatched' } });
  assert.equal(ui.queryByRole('heading', { name: 'Requirement.pdf' }), null);
  fireEvent.change(ui.getByRole('textbox', { name: 'Search references' }), { target: { value: '' } });
  fireEvent.click(ui.getByRole('button', { name: 'Use this version in project context' }));
  await waitFor(() => assert.ok(ui.getByRole('button', { name: 'Project context: this version' })));
  assert.equal((await openExistingVault(f.project.vaultDir)).revisions.length, 1);
  fireEvent.click(within(ui.getByRole('navigation')).getByRole('button', { name: 'Changes' }));
  await waitFor(() => assert.ok(ui.getByText(/Reference-context-only revision/)));
  fireEvent.change(ui.getByRole('textbox', { name: /Revision summary/ }), { target: { value: 'Record customer requirement' } });
  fireEvent.click(ui.getByRole('button', { name: 'Save revision' }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  await waitFor(async () => assert.equal((await openExistingVault(f.project.vaultDir)).revisions.length, 2));
  assert.equal(ui.queryByRole('button', { name: 'Save revision' }), null, 'identical context cannot create repeated empty revisions');
  fireEvent.click(within(ui.getByRole('navigation')).getByRole('button', { name: 'History' }));
  fireEvent.click(ui.getByRole('button', { name: /Rev 002:/ }));
  fireEvent.click(ui.getByRole('button', { name: "Saved references", pressed: false }));
  assert.ok(ui.getByText('Inherited project reference'));
  let retrieved: Blob | undefined, downloaded = '';
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL, click = window.HTMLAnchorElement.prototype.click;
  URL.createObjectURL = blob => { retrieved = blob as Blob; return 'blob:test'; }; URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () { downloaded = this.download; };
  try {
    fireEvent.click(ui.getByRole('button', { name: 'Retrieve exact attachment' }));
    await waitFor(() => assert.equal(downloaded, 'Requirement.pdf'));
    assert.deepEqual(new Uint8Array(await retrieved!.arrayBuffer()), new Uint8Array(await source().arrayBuffer()));
  } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke; window.HTMLAnchorElement.prototype.click = click; }
  cleanup(); await clearAllConvenienceMetadata();
  ui = render(<App />); await openHomeWorkspace(ui, f.home); fireEvent.click(ui.getByRole('button', { name: 'Open project' }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  fireEvent.click(within(ui.getByRole('navigation')).getByRole('button', { name: 'References' }));
  assert.ok(ui.getByRole('heading', { name: 'Requirement.pdf' }));
  assert.ok(ui.getByRole('button', { name: 'Project context: this version' }));
});

test('Changes selects an exact version, locator, explanation and pending component then passes the committed identity review to capture', async () => {
  const f = await fixture();
  let state = await importReferenceAttachment(f.project.vaultDir, f.project.record.projectId, source(), { title: 'Requirements', description: '', tags: [] });
  const ref = state.references!.library[0];
  state = await importReferenceAttachment(f.project.vaultDir, f.project.record.projectId, new File(['version two'], 'Updated.pdf'), { title: 'Requirements', description: '', tags: [] }, ref.referenceId);
  await f.working.writeFileText(['New.SLDPRT'], 'new component');
  const scan = await scanBranchChanges(f.working, branchId, f.first.revision.manifest);
  let savedId = '';
  const ui = render(<ChangesCaptureView vaultState={state} activeBranchId={branchId} workingFolderName="Main" vaultFolderName="Vault" scanResult={scan} isScanStale={false} isScanning={false} isCapturing={false} progress={null} statusBanner={null} onScan={async () => {}} onCancelOperation={() => {}} onReattachWorkingFolder={async () => {}} onCapture={async params => {
    assert.equal(params.referenceReview!.explicit[0].versionId, ref.versions[0].versionId);
    const saved = await captureRevision(f.working, f.project.vaultDir, { ...params, branchId, workingFolders: f.project.workingFolders });
    savedId = saved.revision.manifest.revisionId;
  }} />);
  fireEvent.click(ui.getByRole('button', { name: 'Add revision reference' }));
  fireEvent.change(ui.getByRole('combobox', { name: 'Exact version' }), { target: { value: ref.versions[0].versionId } });
  fireEvent.change(ui.getByRole('textbox', { name: 'Locator (optional)' }), { target: { value: 'page 4' } });
  fireEvent.change(ui.getByRole('textbox', { name: 'Explanation (optional)' }), { target: { value: 'Increase clearance' } });
  fireEvent.change(ui.getByRole('combobox', { name: 'Component (optional)' }), { target: { value: 'path:New.SLDPRT' } });
  fireEvent.change(ui.getByRole('textbox', { name: /Revision summary/ }), { target: { value: 'Follow source' } });
  fireEvent.click(ui.getByRole('button', { name: 'Save revision' }));
  await waitFor(() => assert.ok(savedId));
  const saved = await openExistingVault(f.project.vaultDir), link = saved.references!.contexts[savedId].record!.links[0];
  assert.equal(link.componentId, saved.components!.revisions[savedId].files.find(f => f.path === 'New.SLDPRT')!.componentId);
  assert.equal(link.locator, 'page 4'); assert.equal(link.explanation, 'Increase clearance');
});

test('stale reference decisions remain visible until explicitly reviewed and legacy History never uses current defaults', async () => {
  const f = await fixture();
  let state = await importReferenceAttachment(f.project.vaultDir, f.project.record.projectId, source(), { title: 'Requirement', description: '', tags: [] });
  const ref = state.references!.library[0], scan = await scanBranchChanges(f.working, branchId, f.first.revision.manifest);
  const review = createReferenceReview(state, scan, [{ referenceId: ref.referenceId, versionId: ref.versions[0].versionId, locator: 'page 2', explanation: 'Decision' }]);
  state = await updateProjectReference(f.project.vaultDir, f.project.record.projectId, ref.referenceId, { projectVersionId: ref.versions[0].versionId });
  const cache = new Map([['draft', { summary: 'Reference update', notes, fileNotes: {}, notePath: null, showOverall: false, referenceReview: review }]]);
  const ui = render(<ChangesCaptureView vaultState={state} activeBranchId={branchId} workingFolderName="Main" vaultFolderName="Vault" scanResult={scan} draftCache={cache} draftKey="draft" isScanStale={false} isScanning={false} isCapturing={false} progress={null} statusBanner={null} onScan={async () => {}} onCapture={async () => {}} onCancelOperation={() => {}} onReattachWorkingFolder={async () => {}} />);
  assert.ok(ui.getByText(/Reference selections are stale/));
  assert.equal((ui.getByRole('textbox', { name: 'Locator (optional)' }) as HTMLInputElement).value, 'page 2');
  fireEvent.click(ui.getByRole('button', { name: 'Review current references' }));
  assert.equal(ui.queryByText(/Reference selections are stale/), null);
  cleanup();
  const legacy = { ...state, references: { ...state.references!, contexts: { [f.first.revision.manifest.revisionId]: { status: 'legacy' as const } } } };
  const history = render(<RevisionReferenceContext state={legacy} revisionId={f.first.revision.manifest.revisionId} />);
  assert.ok(history.getByText('No reference context recorded.'));
  assert.equal(history.queryByText('Requirement'), null);
});



