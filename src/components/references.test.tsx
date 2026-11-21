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
import { importReferenceAttachment, updateProjectReference, createReferenceReview, retrieveReferenceAttachment } from '../engine/references';
import { getObjectPathSegments } from '../engine/object-store';
import { ReferencesView } from './ReferencesView';
import { referenceBrowserFixture } from '../../tests/reference-browser-fixture';
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

test('reference browsing is one search box without mutation controls or project writes', async () => {
  const f = await referenceBrowserFixture();
  const before = inventorySignature(await readVerifiedInventory(f.vault));
  const copies: Uint8Array[] = [];
  const ui = render(<ReferencesView state={f.state} busy={false} progress={null} onCancel={() => {}} onRetrieve={async (id, version) => {
    copies.push((await retrieveReferenceAttachment(f.vault, f.state.project.projectId, id, version)).bytes);
  }} />);
  assert.equal(ui.queryAllByRole('combobox').length, 0, 'no Case or Part / file filters');
  assert.equal(ui.queryByRole('combobox', { name: 'Branch' }), null);
  assert.equal(ui.queryByRole('combobox', { name: 'Part / file' }), null);
  for (const name of ['Import reference', 'Edit details', 'Add new version', 'Use this version in project context', 'Remove from current context', 'Stop inheriting in future versions']) assert.equal(ui.queryByRole('button', { name }), null);
  const search = ui.getByRole('searchbox', { name: 'Search references' });
  assert.equal(ui.container.querySelectorAll('.reference-card').length, 5);
  // The file a reference applies to.
  fireEvent.change(search, { target: { value: 'A-renamed.SLDPRT' } });
  assert.equal(ui.container.querySelectorAll('.reference-card').length, 1);
  assert.ok(ui.getByRole('button', { name: 'Download Alpha requirement (Alpha.txt)' }));
  assert.ok(ui.getByText('File: A-renamed.SLDPRT'));
  // A note, then a file name, then no match.
  fireEvent.change(search, { target: { value: 'Beta requirement description' } });
  assert.ok(ui.getByRole('button', { name: 'Download Beta requirement (Beta.txt)' }));
  fireEvent.change(search, { target: { value: 'Alpha updated.txt' } });
  assert.equal(ui.container.querySelectorAll('.reference-card').length, 1);
  assert.ok(ui.getByText('Alternative · V4'));
  assert.ok(ui.getByText('File: B.SLDPRT'));
  fireEvent.click(ui.getByRole('button', { name: 'Download Alpha requirement (Alpha updated.txt)' }));
  await waitFor(() => assert.equal(copies.length, 1));
  assert.equal(new TextDecoder().decode(copies[0]), 'Alpha two');
  fireEvent.change(search, { target: { value: 'nothing like this' } });
  assert.ok(ui.getByText(/No matching references/));
  fireEvent.change(search, { target: { value: '' } });
  assert.equal(ui.container.querySelectorAll('.reference-card').length, 5);
  assert.equal(inventorySignature(await readVerifiedInventory(f.vault)), before);
});

async function openReferences(f: Awaited<ReturnType<typeof fixture>>) {
  const ui = render(<App />);
  await openHomeWorkspace(ui, f.home); fireEvent.click(ui.getByRole('button', { name: 'Open project' }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  fireEvent.click(within(ui.getByRole('navigation')).getByRole('button', { name: 'References' }));
  return ui;
}

test('Add reference stores files without saving a version, applies them to the whole project and refreshes the list', async () => {
  const f = await fixture();
  const ui = await openReferences(f);
  assert.ok(ui.getByText(/No references yet/));
  fireEvent.click(ui.getByRole('button', { name: 'Add reference…' }));
  fireEvent.change(ui.getByLabelText('Reference files'), { target: { files: [source(), new File(['Customer brief'], 'Brief.txt')] } });
  fireEvent.change(ui.getByRole('textbox', { name: 'Note (optional)' }), { target: { value: 'From the customer' } });
  fireEvent.click(ui.getByRole('button', { name: 'Add' }));
  await waitFor(() => assert.ok(ui.getByRole('button', { name: 'Download Requirement.pdf (Requirement.pdf)' })));
  assert.ok(ui.getByRole('button', { name: 'Download Brief.txt (Brief.txt)' }));
  assert.equal(ui.container.querySelectorAll('.reference-card').length, 2);
  assert.equal(ui.getAllByText('From the customer').length, 2);
  assert.equal(ui.getAllByText(/Applies to the whole project/).length, 2, 'both cards say they apply to the whole project');
  assert.equal(ui.queryByRole('region', { name: 'Add reference' }), null, 'the panel closes after adding');
  await waitFor(() => assert.ok(document.activeElement === ui.getByRole('button', { name: 'Add reference…' }), 'focus returns to Add reference…'));
  await waitFor(() => assert.ok(ui.getByText(/Added 2 references to the project/)));
  const saved = await openExistingVault(f.project.vaultDir);
  assert.equal(saved.revisions.length, 1, 'no version was saved');
  const library = saved.references!.library;
  assert.deepEqual(library.map(ref => ref.title), ['Requirement.pdf', 'Brief.txt']);
  assert.ok(library.every(ref => ref.projectVersionId === ref.versions[0].versionId && ref.description === 'From the customer'));
  assert.deepEqual(await retrieveReferenceAttachment(f.project.vaultDir, saved.project.projectId, library[0].referenceId, library[0].versions[0].versionId).then(r => r.bytes), new Uint8Array(await source().arrayBuffer()));
  // Whole-project references are carried into the next saved revision.
  const next = await captureRevision(f.working, f.project.vaultDir, { branchId, summary: 'Second', notes, workingFolders: f.project.workingFolders });
  assert.equal(next.vaultState.references!.contexts[next.revision.manifest.revisionId].record!.links.filter(link => link.origin === 'project').length, 2);
  // The Map in the project folder is refreshed in the background.
  const guide = async () => { try { return await (await f.home.getDirectory(['Engineering', 'projects', 'Actuator'])).readFileText(['_MAP cAdtree.txt']); } catch { return ''; } };
  await waitFor(async () => assert.match(await guide(), /Requirement\.pdf/));
});

test('Add reference: cancelling writes nothing and choosing nothing keeps Add disabled', async () => {
  const f = await fixture();
  const ui = await openReferences(f);
  const before = inventorySignature(await readVerifiedInventory(f.home));
  fireEvent.click(ui.getByRole('button', { name: 'Add reference…' }));
  assert.equal((ui.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled, true);
  fireEvent.change(ui.getByLabelText('Reference files'), { target: { files: [source()] } });
  assert.equal((ui.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled, false);
  fireEvent.click(ui.getByRole('button', { name: 'Cancel' }));
  assert.equal(ui.queryByLabelText('Reference files'), null);
  assert.ok(document.activeElement === ui.getByRole('button', { name: 'Add reference…' }), 'focus returns to Add reference… on Cancel');
  assert.equal(inventorySignature(await readVerifiedInventory(f.home)), before);
  assert.equal((await openExistingVault(f.project.vaultDir)).references?.library.length ?? 0, 0);
});

test('Add reference is disabled with a reason when the project is read-only, and a failed add keeps the panel and the choice', async () => {
  const f = await fixture();
  const state = await openExistingVault(f.project.vaultDir);
  const calls: unknown[] = [];
  let ui = render(<ReferencesView state={state} busy={false} progress={null} onCancel={() => {}} onRetrieve={async () => {}} onAdd={async (...args) => { calls.push(args); }} addBlockReason="This project is read-only. Reconnect it." />);
  assert.equal((ui.getByRole('button', { name: 'Add reference…' }) as HTMLButtonElement).disabled, true);
  const reason = ui.getByText('This project is read-only. Reconnect it.');
  assert.equal((ui.getByRole('button', { name: 'Add reference…' }) as HTMLButtonElement).getAttribute('aria-describedby'), reason.id, 'the disabled button points at the reason');
  assert.equal(calls.length, 0);
  ui.unmount();
  ui = render(<ReferencesView state={state} busy={false} progress={null} onCancel={() => {}} onRetrieve={async () => {}} onAdd={async () => { throw new Error('Nothing was written.'); }} />);
  fireEvent.click(ui.getByRole('button', { name: 'Add reference…' }));
  fireEvent.change(ui.getByLabelText('Reference files'), { target: { files: [source()] } });
  fireEvent.click(ui.getByRole('button', { name: 'Add' }));
  await waitFor(() => assert.ok(ui.getByText('Nothing was written.')));
  assert.ok(ui.getByText(/Requirement\.pdf/), 'the chosen file stays listed for another try');
  ui.unmount();
  ui = render(<ReferencesView state={state} busy={false} progress={null} onCancel={() => {}} onRetrieve={async () => {}} />);
  assert.equal(ui.queryByRole('button', { name: 'Add reference…' }), null, 'no add control without an add action');
});

test('Add reference publishes each file in one write; a failing file names itself and the rest, keeps only them in the panel, and the guide is refreshed only for published files', async () => {
  const f = await fixture();
  const ui = await openReferences(f);
  const bad = new File(['xyz'], 'Bad.txt');
  Object.defineProperty(bad, 'size', { value: 999 });
  const writes = { count: 0 };
  f.home.setHooks({ onBeforeWrite: () => { writes.count++; } });
  // Nothing published: no guide refresh either.
  fireEvent.click(ui.getByRole('button', { name: 'Add reference…' }));
  fireEvent.change(ui.getByLabelText('Reference files'), { target: { files: [bad] } });
  fireEvent.click(ui.getByRole('button', { name: 'Add' }));
  await waitFor(() => assert.ok(ui.getByText(/Bad\.txt could not be added: Attachment changed while being imported\./)));
  assert.equal(ui.container.querySelectorAll('.reference-card').length, 0);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(writes.count, 0, 'nothing was published, so nothing (guide included) was written');
  // One file published, then a failure: the error shows once, in the panel.
  fireEvent.change(ui.getByLabelText('Reference files'), { target: { files: [new File(['Customer brief'], 'Brief.txt'), bad, new File(['Third'], 'Third.txt')] } });
  fireEvent.click(ui.getByRole('button', { name: 'Add' }));
  await waitFor(() => assert.ok(ui.getByText('1 of 3 files were added. Bad.txt could not be added: Attachment changed while being imported. Not added yet: Third.txt.')));
  assert.equal(ui.container.querySelectorAll('.app-status-feedback [role="alert"], .app-status-feedback .notice').length, 0, 'no second copy of the error in the status banner');
  assert.equal(ui.getAllByText(/could not be added/).length, 1);
  assert.ok(ui.getByRole('button', { name: 'Download Brief.txt (Brief.txt)' }), 'the published file is listed');
  const panel = ui.getByRole('region', { name: 'Add reference' });
  assert.deepEqual(Array.from(panel.querySelectorAll('li')).map(li => li.textContent!.split(' · ')[0]), ['Bad.txt', 'Third.txt'], 'a published file is not offered again');
  assert.equal((await openExistingVault(f.project.vaultDir)).references!.library.length, 1);
  await waitFor(() => assert.ok(writes.count > 0, 'the guide was refreshed after the published file'));
});

test('Stop applying removes a reference from the whole project after a confirm; it stays listed and earlier versions keep it', async () => {
  const f = await fixture();
  const ui = await openReferences(f);
  fireEvent.click(ui.getByRole('button', { name: 'Add reference…' }));
  fireEvent.change(ui.getByLabelText('Reference files'), { target: { files: [source()] } });
  fireEvent.click(ui.getByRole('button', { name: 'Add' }));
  const stopName = 'Stop applying Requirement.pdf to the whole project';
  await waitFor(() => assert.ok(ui.getByRole('button', { name: stopName })));
  await f.working.writeFileText(['part.SLDPRT'], 'geometry v2');
  const first = await captureRevision(f.working, f.project.vaultDir, { branchId, summary: 'Carries it', notes, workingFolders: f.project.workingFolders });
  const links = (state: Awaited<ReturnType<typeof openExistingVault>>, revisionId: string) => state.references!.contexts[revisionId].record!.links.filter(link => link.origin === 'project').length;
  assert.equal(links(first.vaultState, first.revision.manifest.revisionId), 1);
  // Asking, then keeping, changes nothing.
  const before = inventorySignature(await readVerifiedInventory(f.home));
  fireEvent.click(ui.getByRole('button', { name: stopName }));
  assert.ok(ui.getByText(/Versions you save from now on will not include it/));
  fireEvent.click(ui.getByRole('button', { name: 'Keep' }));
  assert.ok(ui.getByRole('button', { name: stopName }));
  assert.equal(inventorySignature(await readVerifiedInventory(f.home)), before);
  // Confirming stops it.
  fireEvent.click(ui.getByRole('button', { name: stopName }));
  fireEvent.click(ui.getByRole('button', { name: 'Stop applying' }));
  await waitFor(() => assert.equal(ui.queryByRole('button', { name: stopName }), null));
  assert.ok(ui.getByRole('button', { name: 'Download Requirement.pdf (Requirement.pdf)' }), 'the reference is never deleted');
  await waitFor(() => assert.ok(ui.getByText(/no longer applies to the whole project/)));
  const state = await openExistingVault(f.project.vaultDir);
  assert.equal(state.references!.library.length, 1);
  assert.equal(state.references!.library[0].projectVersionId, null);
  assert.equal(links(state, first.revision.manifest.revisionId), 1, 'the earlier version keeps it');
  await f.working.writeFileText(['part.SLDPRT'], 'geometry v3');
  const second = await captureRevision(f.working, f.project.vaultDir, { branchId, summary: 'Without it', notes, workingFolders: f.project.workingFolders });
  assert.equal(links(second.vaultState, second.revision.manifest.revisionId), 0, 'new versions no longer carry it');
});

test('Stop applying is hidden without an action and disabled in a read-only project', async () => {
  const f = await fixture();
  const state = await importReferenceAttachment(f.project.vaultDir, f.project.record.projectId, source(), { title: 'Requirement.pdf', description: '', tags: [] }, undefined, { applyToProject: true });
  let ui = render(<ReferencesView state={state} busy={false} progress={null} onCancel={() => {}} onRetrieve={async () => {}} />);
  assert.equal(ui.queryByRole('button', { name: /Stop applying/ }), null);
  ui.unmount();
  ui = render(<ReferencesView state={state} busy={false} progress={null} onCancel={() => {}} onRetrieve={async () => {}} onStopApplying={async () => {}} addBlockReason="Read-only." />);
  assert.equal((ui.getByRole('button', { name: /Stop applying/ }) as HTMLButtonElement).disabled, true);
});

test('actual App browses and downloads saved references and reopens entirely from disk', async () => {
  const f = await fixture();
  const imported = await importReferenceAttachment(f.project.vaultDir, f.project.record.projectId, source(), { title: 'Requirement.pdf', description: 'Customer discussion', tags: ['clearance', 'customer'] }, undefined, { savedBy: { id: 'test-engineer-1', displayName: 'Test Engineer' } });
  const ref = imported.references!.library[0];
  await updateProjectReference(f.project.vaultDir, f.project.record.projectId, ref.referenceId, { projectVersionId: ref.versions[0].versionId });
  await captureRevision(f.working, f.project.vaultDir, { branchId, summary: 'Record customer requirement', notes, workingFolders: f.project.workingFolders });
  let ui = render(<App />);
  await openHomeWorkspace(ui, f.home); fireEvent.click(ui.getByRole('button', { name: 'Open project' }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  fireEvent.click(within(ui.getByRole('navigation')).getByRole('button', { name: 'References' }));
  assert.equal(ui.queryByRole('button', { name: 'Import reference' }), null);
  const beforeDownload = inventorySignature(await readVerifiedInventory(f.home));
  const branchBefore = ui.container.querySelector('.project-context-header')!.getAttribute('data-branch-id');
  fireEvent.change(ui.getByRole('searchbox', { name: 'Search references' }), { target: { value: 'clearance' } });
  assert.ok(ui.getByText('Saved by Test Engineer'));
  let retrieved: Blob | undefined, downloaded = '';
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL, click = window.HTMLAnchorElement.prototype.click;
  URL.createObjectURL = blob => { retrieved = blob as Blob; return 'blob:test'; }; URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () { downloaded = this.download; };
  try {
    fireEvent.click(ui.getByRole('button', { name: 'Download Requirement.pdf (Requirement.pdf)' }));
    await waitFor(() => assert.equal(downloaded, 'Requirement.pdf'));
    assert.deepEqual(new Uint8Array(await retrieved!.arrayBuffer()), new Uint8Array(await source().arrayBuffer()));
    assert.equal(inventorySignature(await readVerifiedInventory(f.home)), beforeDownload);
    assert.equal(ui.container.querySelector('.project-context-header')!.getAttribute('data-branch-id'), branchBefore);
  } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke; window.HTMLAnchorElement.prototype.click = click; }
  cleanup(); await clearAllConvenienceMetadata();
  ui = render(<App />); await openHomeWorkspace(ui, f.home); fireEvent.click(ui.getByRole('button', { name: 'Open project' }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  fireEvent.click(within(ui.getByRole('navigation')).getByRole('button', { name: 'References' }));
  assert.ok(ui.getByRole('button', { name: 'Download Requirement.pdf (Requirement.pdf)' }));
  assert.equal((ui.getByRole('searchbox', { name: 'Search references' }) as HTMLInputElement).value, '');
});

test('clicking a saved reference downloads its pinned version and reports corrupted content without delivering a copy', async () => {
  const f = await fixture();
  const metadata = { title: 'Customer requirement', description: '', tags: [] };
  let state = await importReferenceAttachment(f.project.vaultDir, f.project.record.projectId, source(), metadata, undefined, { savedBy: { id: 'engineer-a', displayName: 'Asha' } });
  const original = state.references!.library[0], version = original.versions[0];
  state = await importReferenceAttachment(f.project.vaultDir, f.project.record.projectId, new File(['New requirement'], 'Updated.pdf'), metadata, original.referenceId, { savedBy: { id: 'engineer-b', displayName: 'Ben' } });
  const scan = await scanBranchChanges(f.working, branchId, f.first.revision.manifest);
  const saved = await captureRevision(f.working, f.project.vaultDir, {
    branchId, summary: 'Link original requirement', notes, workingFolders: f.project.workingFolders,
    referenceReview: createReferenceReview(state, scan, [{ referenceId: original.referenceId, versionId: version.versionId, locator: '', explanation: '' }]),
  });
  const copies: Uint8Array[] = [];
  const ui = render(<RevisionReferenceContext state={saved.vaultState} revisionId={saved.revision.manifest.revisionId} onRetrieve={async (referenceId, versionId) => {
    const result = await retrieveReferenceAttachment(f.project.vaultDir, f.project.record.projectId, referenceId, versionId);
    copies.push(result.bytes);
  }} />);
  assert.ok(ui.getByText('Requirement.pdf'));
  assert.equal(ui.queryByText('Updated.pdf'), null);
  assert.ok(ui.getByText('Saved by Asha'));
  assert.equal(ui.queryByText('Saved by Ben'), null);
  assert.equal(ui.container.textContent!.includes(version.sha256), false);
  assert.equal(ui.container.textContent!.includes(original.referenceId), false);
  assert.equal(ui.container.textContent!.includes(version.versionId), false);
  fireEvent.click(ui.getByRole('button', { name: 'Download Customer requirement' }));
  await waitFor(() => assert.equal(copies.length, 1));
  assert.deepEqual(copies[0], new Uint8Array(await source().arrayBuffer()));
  await f.project.vaultDir.writeFileText(getObjectPathSegments(version.sha256), 'corrupted attachment');
  fireEvent.click(ui.getByRole('button', { name: 'Download Customer requirement' }));
  await waitFor(() => assert.ok(ui.getByText(/Attachment content is corrupt/)));
  assert.equal(copies.length, 1, 'Corrupted bytes must never be offered as a download');
});

test('Changes attaches new reference files with notes to the whole version or a new part, preserving the draft on navigation', async () => {
  const f = await fixture();
  await f.working.writeFileText(['New.SLDPRT'], 'new component');
  const scan = await scanBranchChanges(f.working, branchId, f.first.revision.manifest);
  const before = inventorySignature(await readVerifiedInventory(f.project.vaultDir));
  let savedId = '';
  const cache = new Map<string, import('./ChangesCaptureView').CaptureDraft>();
  const props = { vaultState: f.first.vaultState, activeBranchId: branchId, workingFolderName: 'Main', vaultFolderName: 'Vault', scanResult: scan, draftCache: cache, draftKey: 'draft', isScanning: false, isCapturing: false, progress: null, statusBanner: null, onScan: async () => {}, onCancelOperation: () => {}, onReattachWorkingFolder: async () => {}, onCapture: async (params: Parameters<import('./ChangesCaptureView').ChangesCaptureViewProps['onCapture']>[0]) => {
    const saved = await captureRevision(f.working, f.project.vaultDir, { ...params, branchId, workingFolders: f.project.workingFolders, referenceAuthor: { id: 'engineer-a', displayName: 'Asha' } });
    savedId = saved.revision.manifest.revisionId;
  } };
  let ui = render(<ChangesCaptureView {...props} />);
  assert.equal(ui.queryByText('Version references'), null);
  fireEvent.click(ui.getByRole('button', { name: '+ Attach reference files' }));
  fireEvent.change(ui.getByLabelText('Reference files'), { target: { files: [source(), new File(['Customer brief'], 'Brief.txt')] } });
  fireEvent.change(ui.getByRole('textbox', { name: 'Reference note for Requirement.pdf' }), { target: { value: 'Increase clearance' } });
  fireEvent.change(ui.getByRole('combobox', { name: 'Applies to Requirement.pdf' }), { target: { value: 'path:New.SLDPRT' } });
  fireEvent.change(ui.getByRole('textbox', { name: 'Reference note for Brief.txt' }), { target: { value: 'Overall design intent' } });
  fireEvent.change(ui.getByRole('textbox', { name: /What changed/ }), { target: { value: 'Follow source' } });
  assert.equal(await inventorySignature(await readVerifiedInventory(f.project.vaultDir)), before, 'Choosing files must not write anything before Save');
  ui.unmount();
  ui = render(<ChangesCaptureView {...props} />);
  assert.equal((ui.getByRole('textbox', { name: 'Reference note for Requirement.pdf' }) as HTMLTextAreaElement).value, 'Increase clearance');
  fireEvent.click(ui.getByRole('button', { name: 'Save version' }));
  await waitFor(() => assert.ok(savedId));
  const saved = await openExistingVault(f.project.vaultDir), links = saved.references!.contexts[savedId].record!.links;
  assert.equal(links.length, 2);
  assert.equal(links[0].componentId, saved.components!.revisions[savedId].files.find(file => file.path === 'New.SLDPRT')!.componentId);
  assert.equal(links[0].explanation, 'Increase clearance');
  assert.equal(links[1].componentId, null);
  assert.equal(links[1].explanation, 'Overall design intent');
  const stored = await retrieveReferenceAttachment(f.project.vaultDir, saved.project.projectId, links[0].referenceId, links[0].versionId);
  assert.deepEqual(stored.bytes, new Uint8Array(await source().arrayBuffer()));
  assert.equal(stored.version.savedBy!.displayName, 'Asha');
  assert.equal(f.first.vaultState.references!.contexts[f.first.revision.manifest.revisionId].record!.links.length, 0);
  cleanup();
  const history = render(<RevisionReferenceContext state={saved} revisionId={savedId} />);
  assert.ok(history.getByText('Increase clearance'));
  assert.ok(history.getByText('Overall design intent'));
  cleanup();
  const browser = render(<ReferencesView state={saved} busy={false} progress={null} onCancel={() => {}} onRetrieve={async () => {}} />);
  assert.ok(browser.getByRole('button', { name: 'Download Requirement.pdf (Requirement.pdf)' }));
  assert.ok(browser.getByText('File: New.SLDPRT'));
});

test('already-saved references stay behind a collapsed Manage references disclosure; new attachments stay visible', async () => {
  const f = await fixture();
  const state = await importReferenceAttachment(f.project.vaultDir, f.project.record.projectId, source(), { title: 'Requirement', description: '', tags: [] });
  const ref = state.references!.library[0], scan = await scanBranchChanges(f.working, branchId, f.first.revision.manifest);
  const review = createReferenceReview(state, scan, [{ referenceId: ref.referenceId, versionId: ref.versions[0].versionId, locator: 'page 1', explanation: 'Kept note' }]);
  const cache = new Map([['draft', { summary: '', notes, fileNotes: {}, notePath: null, referenceReview: review, showAttachments: true }]]);
  const ui = render(<ChangesCaptureView vaultState={state} activeBranchId={branchId} workingFolderName="Main" vaultFolderName="Vault" scanResult={scan} draftCache={cache} draftKey="draft" isScanning={false} isCapturing={false} progress={null} statusBanner={null} onScan={async () => {}} onCapture={async () => {}} onCancelOperation={() => {}} onReattachWorkingFolder={async () => {}} />);
  assert.equal(ui.queryByText(/Reference selections are stale/), null);
  const toggle = ui.getByRole('button', { name: 'Manage references (1)' });
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(ui.queryByRole('textbox', { name: 'Reference note for Requirement.pdf 1' }), null);
  assert.equal(ui.queryByRole('button', { name: 'Remove from this version' }), null);
  assert.ok(ui.getByLabelText('Reference files'), 'the attach control stays visible');
  fireEvent.change(ui.getByLabelText('Reference files'), { target: { files: [new File(['Customer brief'], 'Brief.txt')] } });
  assert.ok(ui.getByRole('textbox', { name: 'Reference note for Brief.txt' }), 'new attachments are shown as before');
  fireEvent.click(toggle);
  assert.equal((ui.getByRole('textbox', { name: 'Reference note for Requirement.pdf 1' }) as HTMLTextAreaElement).value, 'Kept note');
  fireEvent.click(ui.getByRole('button', { name: 'Remove from this version' }));
  assert.equal(ui.queryByRole('button', { name: /Manage references/ }), null);
});

test('stale reference decisions remain visible until explicitly reviewed and legacy History never uses current defaults', async () => {
  const f = await fixture();
  let state = await importReferenceAttachment(f.project.vaultDir, f.project.record.projectId, source(), { title: 'Requirement', description: '', tags: [] });
  const ref = state.references!.library[0], scan = await scanBranchChanges(f.working, branchId, f.first.revision.manifest);
  const review = createReferenceReview(state, scan, [{ referenceId: ref.referenceId, versionId: ref.versions[0].versionId, locator: 'page 2', explanation: 'Decision' }]);
  state = await updateProjectReference(f.project.vaultDir, f.project.record.projectId, ref.referenceId, { projectVersionId: ref.versions[0].versionId });
  const cache = new Map([['draft', { summary: 'Reference update', notes, fileNotes: {}, notePath: null, referenceReview: review }]]);
  const ui = render(<ChangesCaptureView vaultState={state} activeBranchId={branchId} workingFolderName="Main" vaultFolderName="Vault" scanResult={scan} draftCache={cache} draftKey="draft" isScanning={false} isCapturing={false} progress={null} statusBanner={null} onScan={async () => {}} onCapture={async () => {}} onCancelOperation={() => {}} onReattachWorkingFolder={async () => {}} />);
  assert.ok(ui.getByText(/Reference selections are stale/));
  assert.ok(ui.getByText('Location: page 2'));
  assert.equal((ui.getByRole('textbox', { name: 'Reference note for Requirement.pdf 1' }) as HTMLTextAreaElement).value, 'Decision');
  fireEvent.click(ui.getByRole('button', { name: 'Review current references' }));
  assert.equal(ui.queryByText(/Reference selections are stale/), null);
  cleanup();
  const legacy = { ...state, references: { ...state.references!, contexts: { [f.first.revision.manifest.revisionId]: { status: 'legacy' as const } } } };
  const history = render(<RevisionReferenceContext state={legacy} revisionId={f.first.revision.manifest.revisionId} />);
  assert.ok(history.getByText('No references were saved with this version.'));
  assert.equal(history.queryByText('Requirement'), null);
});




test('Changes shows one muted line naming skipped system or temporary files, with at most three names', async () => {
  const f = await fixture();
  await f.working.writeFileText(['.DS_Store'], 'finder');
  const scan = await scanBranchChanges(f.working, branchId, f.first.revision.manifest);
  const props = { vaultState: f.first.vaultState, activeBranchId: branchId, workingFolderName: 'Main', vaultFolderName: 'Vault', scanResult: scan, draftCache: new Map(), draftKey: 'skipped', isScanning: false, isCapturing: false, progress: null, statusBanner: null, onScan: async () => {}, onCancelOperation: () => {}, onReattachWorkingFolder: async () => {}, onCapture: async () => {} };
  let ui = render(<ChangesCaptureView {...props} />);
  assert.equal(ui.getByTestId('skipped-system-files').textContent, 'Skipped 1 system or temporary file: .DS_Store');
  ui.unmount();
  const many = { ...scan, skippedSystemFiles: ['a/.DS_Store', '.DS_Store', 'Thumbs.db', 'desktop.ini', '._x'] };
  ui = render(<ChangesCaptureView {...props} scanResult={many} />);
  assert.equal(ui.getByTestId('skipped-system-files').textContent, 'Skipped 5 system or temporary files: a/.DS_Store, .DS_Store, Thumbs.db +2 more');
  ui.unmount();
  ui = render(<ChangesCaptureView {...props} scanResult={{ ...scan, skippedSystemFiles: [] }} />);
  assert.equal(ui.queryByTestId('skipped-system-files'), null);
});
