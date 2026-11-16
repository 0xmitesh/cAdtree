import '../../tests/dom';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { render, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react';
import App from '../App';
import { ReviewExportDialog } from './ReviewExportDialog';
import { InMemoryFileSystemAdapter, RealFileSystemAdapter } from '../engine/fs-adapter';
import { nativeDirectory } from '../../tests/native-fs';
import { openHomeWorkspace, appBusy, currentBranchId } from '../../tests/app-controls';
import { createHome, createHomeWorkspace } from '../engine/home-service';
import { createProject, createManagedBranch } from '../engine/workspace-service';
import { captureRevision } from '../engine/revision-service';
import { clearAllConvenienceMetadata } from '../engine/idb-store';
import { inventorySignature, readVerifiedInventory } from '../engine/copy-service';
import { exportRevisionForReview, ReviewExportError } from '../engine/review-export';
import { openExistingVault } from '../engine/vault-service';

Object.assign(globalThis, { indexedDB });
afterEach(async () => { cleanup(); await clearAllConvenienceMetadata(); Reflect.deleteProperty(window, 'showDirectoryPicker'); });
const notes = { problem: 'Fit', modification: 'Saved geometry', observations: 'Ready to inspect' };
const fingerprint = async (dir: InMemoryFileSystemAdapter) => inventorySignature(await readVerifiedInventory(dir));
async function fixture() {
  const home = new InMemoryFileSystemAdapter('Cadtree'); await createHome(home);
  const workspace = await createHomeWorkspace(home, 'Engineering');
  const project = await createProject(workspace.workspace.root, 'Actuator');
  const working = project.workingFolders['branch-main']!;
  await working.writeFileText(['Parts', 'Part1.SLDPRT'], 'saved original');
  await working.writeFileText(['Assembly.SLDASM'], 'Parts/Part1.SLDPRT');
  const baseline = await captureRevision(working, project.vaultDir, { branchId: 'branch-main', summary: 'Original', notes, workingFolders: project.workingFolders });
  const branch = await createManagedBranch(workspace.workspace.root, project.record.containerPath, { sourceRevisionId: baseline.revision.manifest.revisionId, name: 'Alternative', reason: 'Try fit' });
  await branch.workingFolders[branch.createdBranchId]!.writeFileText(['Parts', 'Part1.SLDPRT'], 'saved alternative');
  const saved = await captureRevision(branch.workingFolders[branch.createdBranchId]!, project.vaultDir, { branchId: branch.createdBranchId, summary: 'Alternative saved', notes, workingFolders: branch.workingFolders });
  await working.writeFileText(['Parts', 'Part1.SLDPRT'], 'newer unsaved Main edit');
  await working.writeFileText(['WorkingOnly.SLDPRT'], 'not in snapshot');
  const parent = new InMemoryFileSystemAdapter('Review destination');
  return { home, parent, project, branch, working, saved };
}

test('actual App exports the inspected older branch snapshot without switching Main or modifying project history/working files', async () => {
  const f = await fixture();
  Object.assign(window, { showDirectoryPicker: async () => nativeDirectory(f.parent) });
  const ui = render(<App />);
  await openHomeWorkspace(ui, f.home);
  fireEvent.click(ui.getByRole('button', { name: 'Open project' }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  assert.equal(currentBranchId(ui), 'branch-main');
  // Opening a writable home writes its offline guide (fire-and-forget); the export must change nothing beyond that.
  await waitFor(async () => assert.equal(await f.home.hasFile(['_INDEX cAdtree.txt']), true));
  const before = await fingerprint(f.home);
  fireEvent.click(within(ui.getByRole('navigation')).getByRole('button', { name: 'History' }));
  fireEvent.click(ui.getByRole('button', { name: /Rev 002:/ }));
  fireEvent.click(ui.getByRole('button', { name: 'Export for review' }));
  const dialog = within(ui.getByRole('dialog', { name: 'Export revision for review' }));
  assert.ok(dialog.getByText('Actuator · Alternative · R02'));
  assert.ok(dialog.getByText('Actuator - Alternative - R02/'));
  assert.equal((dialog.getByRole('radio', { name: 'Complete project' }) as HTMLInputElement).checked, true);
  fireEvent.click(dialog.getByRole('button', { name: 'Choose destination parent' }));
  await waitFor(() => assert.ok(dialog.getByText('Review destination')));
  fireEvent.click(dialog.getByRole('button', { name: 'Export for review' }));
  assert.equal(dialog.queryByText(/Verified review export ready/), null);
  await waitFor(() => assert.ok(dialog.getByText(/Verified review export ready/)));
  const output = await f.parent.getDirectory(['Actuator - Alternative - R02']);
  assert.equal(await output.readFileText(['Parts', 'Part1.SLDPRT']), 'saved alternative');
  assert.equal(await output.hasFile(['WorkingOnly.SLDPRT']), false);
  assert.match(await output.readFileText(['_CADTREE_REVIEW.txt']), /Branch: "Alternative".*\nRevision: R02/);
  assert.equal(currentBranchId(ui), 'branch-main');
  assert.equal(await fingerprint(f.home), before);
  assert.equal((await openExistingVault(f.project.vaultDir)).revisions.length, 2);
  fireEvent.click(dialog.getByRole('button', { name: /^Close$/ }));
  assert.ok(ui.getByRole('heading', { name: 'Alternative saved' }));
});

test('selected-file dialog previews preserved paths, makes filename labelling explicit, and filters to the snapshot', async () => {
  const f = await fixture();
  let calls = 0, finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  Object.assign(window, { showDirectoryPicker: async () => nativeDirectory(f.parent) });
  const ui = render(<ReviewExportDialog state={f.saved.vaultState} revisionId={f.saved.revision.manifest.revisionId} busy={false} progress={null} onClose={() => {}} onCancel={() => {}} onExport={async plan => {
    calls++; await gate;
    assert.equal(plan.request.kind, 'selected');
    assert.equal(plan.files.length, 1);
    assert.equal(plan.files[0].exportedPath, 'Parts/Part1_Alternative_R02.SLDPRT');
    return { folderName: plan.folderName, filesCount: 1, verifiedBytes: plan.files[0].size, summaryName: plan.summaryName };
  }} />);
  fireEvent.click(ui.getByRole('radio', { name: 'Selected files' }));
  assert.ok(ui.getByText(/partial review copy/));
  assert.equal(ui.queryByRole('checkbox', { name: 'Export WorkingOnly.SLDPRT' }), null);
  fireEvent.click(ui.getByRole('checkbox', { name: 'Export Parts/Part1.SLDPRT' }));
  const label = ui.getByRole('checkbox', { name: 'Add branch and revision to filenames' }) as HTMLInputElement;
  assert.equal(label.checked, false);
  assert.ok(ui.getByText(/Renamed files may require reference repair/));
  fireEvent.click(label);
  assert.ok(ui.getByText('Parts/Part1.SLDPRT → Parts/Part1_Alternative_R02.SLDPRT'));
  fireEvent.click(ui.getByRole('button', { name: 'Choose destination parent' }));
  await waitFor(() => assert.ok(ui.getByText('Review destination')));
  fireEvent.click(ui.getByRole('button', { name: 'Export for review' }));
  assert.equal(calls, 1);
  assert.equal(ui.queryByText(/Verified review export ready/), null);
  assert.equal((ui.getByRole('button', { name: 'Exporting…' }) as HTMLButtonElement).disabled, true);
  await act(async () => finish());
  await waitFor(() => assert.ok(ui.getByText(/Verified review export ready/)));
});

test('failed/cancelled UI export keeps the warning visible and shows a fresh numbered retry before success', async () => {
  const f = await fixture();
  Object.assign(window, { showDirectoryPicker: async () => nativeDirectory(f.parent) });
  let attempts = 0;
  const ui = render(<ReviewExportDialog state={f.saved.vaultState} revisionId={f.saved.revision.manifest.revisionId} busy={false} progress={null} onClose={() => {}} onCancel={() => {}} onExport={async (plan, parent, folderName) => {
    attempts++;
    if (attempts === 1) {
      await (await parent.getDirectory([folderName], { create: true, exclusiveCreate: true })).writeFileText([plan.markerName], 'INCOMPLETE');
      throw new ReviewExportError('Injected cancellation', folderName, true);
    }
    return exportRevisionForReview({ plan, parent, folderName, vaultDir: new RealFileSystemAdapter(nativeDirectory(f.project.vaultDir)), workingFolders: Object.fromEntries(Object.entries(f.branch.workingFolders).map(([id, dir]) => [id, new RealFileSystemAdapter(nativeDirectory(dir!))])) });
  }} />);
  fireEvent.click(ui.getByRole('button', { name: 'Choose destination parent' }));
  await waitFor(() => assert.ok(ui.getByText('Review destination')));
  fireEvent.click(ui.getByRole('button', { name: 'Export for review' }));
  await waitFor(() => assert.match(ui.getByRole('alert').textContent!, /Export cancelled.*Incomplete output/));
  await waitFor(() => assert.ok(ui.getByText('Actuator - Alternative - R02 (2)/')));
  assert.equal(ui.queryByText(/Verified review export ready/), null);
  fireEvent.click(ui.getByRole('button', { name: 'Export for review' }));
  await waitFor(() => assert.ok(ui.getByText(/Verified review export ready/)));
  assert.equal(attempts, 2);
  assert.ok(await f.parent.hasDirectory(['Actuator - Alternative - R02']));
  assert.ok(await f.parent.hasDirectory(['Actuator - Alternative - R02 (2)']));
});
