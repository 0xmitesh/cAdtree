import '../../tests/dom';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { cleanup, render, fireEvent, within, waitFor } from '@testing-library/react';
import { ComponentIdentityControls } from './ComponentIdentityControls';
import { ChangesCaptureView } from './ChangesCaptureView';
import { InMemoryFileSystemAdapter } from '../engine/fs-adapter';
import { initializeProjectVault, openExistingVault } from '../engine/vault-service';
import { captureRevision } from '../engine/revision-service';
import { scanBranchChanges } from '../engine/scanner';
import { createDesignBranch } from '../engine/branch-service';
import { prepareApplyPreview, buildApplyPreview } from '../engine/apply-preview';
import { prepareApplication, applyPreparedApplication, applicationReview } from '../engine/application-service';
import { createIdentityReview, type IdentityReview } from '../engine/component-identity';
import type { ScanResult, VaultState } from '../engine/types';
afterEach(cleanup);
async function fixture() {
  const working = new InMemoryFileSystemAdapter('Main'), vault = new InMemoryFileSystemAdapter('Vault');
  await initializeProjectVault(working,vault,'UI test');
  await working.writeFileText(['old'],'same');
  const saved = await captureRevision(working,vault,{branchId:'branch-main',summary:'Original',notes:{problem:'',modification:'',observations:''},workingFolders:{'branch-main':working}});
  await working.removeEntry(['old']);
  await working.writeFileText(['first'],'same'); await working.writeFileText(['second'],'same');
  const scan = await scanBranchChanges(working,'branch-main',saved.revision.manifest);
  return {working,vault,scan,state:saved.vaultState};
}
function Controls({state,scan,initial,onChange = () => {}}:{state:VaultState;scan:ScanResult;initial?:IdentityReview;onChange?:(review?:IdentityReview)=>void}) {
  const [value,setValue] = useState(initial);
  return <ComponentIdentityControls state={state} scan={scan} value={value} onChange={next=>{setValue(next);onChange(next);}} busy={false}/>;
}
test('ambiguous suggestions require an explicit target and confirmation; cancellation restores ordinary delete/add', async()=>{
  const f = await fixture(); let review:IdentityReview|undefined;
  const ui = render(<Controls {...f} onChange={value=>review=value}/>);
  assert.ok(ui.getByText(/Ambiguous: 2 identical-content candidates/));
  assert.equal((ui.getByRole('button',{name:'Confirm rename'}) as HTMLButtonElement).disabled,true);
  assert.equal(review,undefined);
  fireEvent.change(ui.getByRole('combobox',{name:'New path for old'}),{target:{value:'second'}});
  assert.equal(review,undefined);
  fireEvent.click(ui.getByRole('button',{name:'Confirm rename'}));
  assert.deepEqual((review as IdentityReview | undefined)?.renames,[{from:'old',to:'second'}]);
  fireEvent.click(ui.getByRole('button',{name:'Cancel association'}));
  assert.deepEqual((review as IdentityReview | undefined)?.renames,[]);
});
test('changed scan does not silently renew old identity decisions', async()=>{
  const f = await fixture(); let cleared=false;
  const initial = createIdentityReview(f.state,f.scan,[{from:'old',to:'first'}],[]);
  const ui = render(<Controls {...f} scan={{...f.scan,changesSignature:'different'}} initial={initial} onChange={value=>cleared=value===undefined}/>);
  assert.ok(ui.getByRole('alert').textContent?.includes('stale'));
  assert.equal(cleared,false);
  fireEvent.click(ui.getByRole('button',{name:'Clear identity decisions'}));
  assert.equal(cleared,true);
});
test('the panel renders nothing when the scan offers no rename and no decision is pending', async()=>{
  const f = await fixture();
  await f.working.removeEntry(['first']); await f.working.removeEntry(['second']); await f.working.writeFileText(['old'],'same');
  const scan = await scanBranchChanges(f.working,'branch-main',f.state.revisions[0].manifest);
  const ui = render(<Controls state={f.state} scan={scan}/>);
  assert.equal(ui.container.querySelector('.component-identity'),null);
  assert.equal(ui.container.textContent,'');
  cleanup();
  // A deletion with nothing added is not a rename candidate either.
  await f.working.removeEntry(['old']);
  const deletedOnly = await scanBranchChanges(f.working,'branch-main',f.state.revisions[0].manifest);
  const other = render(<Controls state={f.state} scan={deletedOnly}/>);
  assert.equal(other.container.textContent,'');
});
test('a single identical-bytes candidate is pre-selected and confirms directly', async()=>{
  const f = await fixture(); await f.working.removeEntry(['second']);
  const scan = await scanBranchChanges(f.working,'branch-main',f.state.revisions[0].manifest);
  let review:IdentityReview|undefined;
  const ui = render(<Controls state={f.state} scan={scan} onChange={value=>review=value}/>);
  assert.ok(ui.getByText(/Possible rename: first \(identical bytes\)/));
  assert.equal((ui.getByRole('combobox',{name:'New path for old'}) as HTMLSelectElement).value,'first');
  fireEvent.click(ui.getByRole('button',{name:'Confirm rename'}));
  assert.deepEqual((review as IdentityReview|undefined)?.renames,[{from:'old',to:'first'}]);
});
test('files whose name and bytes both changed are not suggested in the panel; a deleted file\'s menu matches them explicitly', async()=>{
  const f = await fixture(); await f.working.removeEntry(['second']); await f.working.writeFileText(['first'],'different bytes');
  const scan = await scanBranchChanges(f.working,'branch-main',f.state.revisions[0].manifest);
  let captured:any;
  const ui = render(<ChangesCaptureView {...changesProps(f.state,scan,{onCapture:async(p:any)=>{captured=p;}})}/>);
  assert.equal(ui.queryByRole('region',{name:'Component identity'}),null,'no suggestion, so no panel');
  assert.equal(ui.queryByText(/Possible rename/),null);
  fireEvent.click(ui.getByRole('button',{name:'Match to a new file — old'}));
  const dialog = within(ui.getByRole('dialog',{name:'Match to a new file'}));
  assert.equal((dialog.getByRole('button',{name:'Confirm rename'}) as HTMLButtonElement).disabled,true);
  fireEvent.change(dialog.getByRole('combobox'),{target:{value:'first'}});
  fireEvent.click(dialog.getByRole('button',{name:'Confirm rename'}));
  const panel = within(ui.getByRole('region',{name:'Component identity'}));
  assert.ok(panel.getByText('Confirmed rename: old → first'));
  assert.equal(ui.queryByRole('button',{name:'Match to a new file — old'}),null);
  fireEvent.change(ui.getByRole('textbox',{name:/Revision summary/}),{target:{value:'Renamed and edited'}});
  fireEvent.click(ui.getByRole('button',{name:/^Save revision$/}));
  await waitFor(()=>assert.ok(captured));
  assert.deepEqual(captured.identityReview.renames,[{from:'old',to:'first'}]);
  fireEvent.click(panel.getByRole('button',{name:'Cancel association'}));
  assert.equal(ui.queryByRole('region',{name:'Component identity'}),null);
});
test('legacy projects show no identity controls and no enable-tracking button', async()=>{
  const f = await fixture(); await f.vault.removeEntry(['components'],{recursive:true});
  const state = await openExistingVault(f.vault);
  const ui = render(<Controls state={state} scan={f.scan}/>);
  assert.equal(ui.container.textContent,'');
  cleanup();
  const changes = render(<ChangesCaptureView {...changesProps(state,f.scan)}/>);
  assert.equal(changes.queryByRole('region',{name:'Component identity'}),null);
  assert.equal(changes.queryByText(/Enable component tracking/),null);
  assert.ok(changes.getByText("Renames aren't tracked for this project."));
});
function changesProps(state:VaultState,scan:ScanResult,extra:object={}) {
  return {vaultState:state,activeBranchId:'branch-main',workingFolderName:'Main',vaultFolderName:'Vault',scanResult:scan,isScanStale:false,isScanning:false,isCapturing:false,progress:null,statusBanner:null,onScan:async()=>{},onCancelOperation:()=>{},onReattachWorkingFolder:async()=>{},onCapture:async()=>{},...extra};
}
test('Treat as new component lives in each modified or unchanged file menu and needs confirmation', async()=>{
  const f = await fixture();
  await f.working.removeEntry(['first']); await f.working.removeEntry(['second']); await f.working.writeFileText(['old'],'edited');
  await f.working.writeFileText(['same.txt'],'kept');
  const saved = await captureRevision(f.working,f.vault,{branchId:'branch-main',summary:'Second',notes:{problem:'',modification:'',observations:''},workingFolders:{'branch-main':f.working}});
  await f.working.writeFileText(['old'],'edited again');
  const state = saved.vaultState;
  const scan = await scanBranchChanges(f.working,'branch-main',saved.revision.manifest);
  const ui = render(<ChangesCaptureView {...changesProps(state,scan)}/>);
  assert.equal(ui.queryByRole('region',{name:'Component identity'}),null,'no panel until a decision exists');
  assert.equal(ui.queryByText('Replace a component identity'),null);
  fireEvent.click(ui.getByRole('button',{name:/Show 1 unchanged files/}));
  assert.ok(ui.getByRole('button',{name:'Treat as new component — same.txt'}));
  fireEvent.click(ui.getByRole('button',{name:'Treat as new component — old'}));
  const dialog = within(ui.getByRole('dialog',{name:'Treat as new component'}));
  fireEvent.click(dialog.getByRole('button',{name:'Cancel'}));
  assert.equal(ui.queryByRole('dialog'),null);
  assert.equal(ui.queryByRole('region',{name:'Component identity'}),null);
  fireEvent.click(ui.getByRole('button',{name:'Treat as new component — old'}));
  fireEvent.click(within(ui.getByRole('dialog',{name:'Treat as new component'})).getByRole('button',{name:'Confirm new component'}));
  const panel = within(ui.getByRole('region',{name:'Component identity'}));
  assert.ok(panel.getByText('New component at old'));
  assert.equal(ui.queryByRole('button',{name:'Treat as new component — old'}),null);
  fireEvent.click(panel.getByRole('button',{name:'Cancel replacement'}));
  assert.equal(ui.queryByRole('region',{name:'Component identity'}),null);
  assert.ok(ui.getByRole('button',{name:'Treat as new component — old'}));
});
test('only an incomplete enrollment offers a retry, inside the error notice', async()=>{
  const f = await fixture(); await f.vault.removeEntry(['components','ready.json']);
  const state = await openExistingVault(f.vault);
  assert.equal(state.components?.enrollmentIncomplete,true);
  let calls=0;
  const ui = render(<ChangesCaptureView {...changesProps(state,f.scan,{onEnableComponentTracking:async()=>{calls++;}})}/>);
  assert.equal(ui.queryByRole('region',{name:'Component identity'}),null);
  const alert = within(ui.getByRole('alert'));
  assert.ok(alert.getByText(/Component enrollment is incomplete/));
  fireEvent.click(alert.getByRole('button',{name:'Retry component enrollment'}));
  await waitFor(()=>assert.equal(calls,1));
  cleanup();
  const without = render(<ChangesCaptureView {...changesProps(state,f.scan)}/>);
  assert.equal(without.queryByRole('button',{name:'Retry component enrollment'}),null);
});

test('Changes exposes an applied-addition rename conflict and allows saving after cancelling the association', async () => {
  const f = await fixture();
  const notes = { problem: '', modification: '', observations: '' };
  const branchId = 'branch-main';
  const folders = { [branchId]: f.working };
  const source = await createDesignBranch({ vaultDir: f.vault, destinationParent: new InMemoryFileSystemAdapter('Cases'), workingFolders: folders, sourceRevisionId: f.scan.baselineRevisionId!, name: 'Addition', reason: 'New component' });
  const bindings = { ...folders, [source.branch.branchId]: source.workingDir };
  await source.workingDir.writeFileText(['first'], 'source addition');
  const saved = await captureRevision(source.workingDir, f.vault, { branchId: source.branch.branchId, summary: 'Add component', notes, workingFolders: bindings });
  // Restore the destination baseline so application starts from a clean folder.
  await f.working.removeEntry(['first']); await f.working.removeEntry(['second']);
  await f.working.writeFileText(['old'], 'same');
  const preview = prepareApplyPreview(saved.vaultState, saved.revision.manifest.revisionId, branchId);
  if (preview.status !== 'available') throw new Error(preview.reason);
  const choices = { first: { selected: true, decision: 'use-source' as const } };
  const plan = buildApplyPreview(preview.context, choices, 'Use new component');
  const prepared = await prepareApplication(f.vault, applicationReview(plan, choices), { workingFolders: bindings });
  await applyPreparedApplication(f.vault, prepared, { workingFolders: bindings });
  await f.working.removeEntry(['old']);
  const state = await openExistingVault(f.vault);
  const scan = await scanBranchChanges(f.working, branchId, f.state.revisions[0].manifest);
  let captures = 0;
  const ui = render(<ChangesCaptureView vaultState={state} activeBranchId={branchId} workingFolderName="Main" vaultFolderName="Vault" scanResult={scan} isScanStale={false} isScanning={false} isCapturing={false} progress={null} statusBanner={null} onScan={async () => {}} onCancelOperation={() => {}} onReattachWorkingFolder={async () => {}} onCapture={async input => {
    await captureRevision(f.working, f.vault, { ...input, branchId, workingFolders: bindings });
    captures++;
  }} />);
  fireEvent.change(ui.getByRole('textbox', { name: /Revision summary/ }), { target: { value: 'Capture applied component' } });
  fireEvent.click(ui.getByRole('button', { name: 'Match to a new file — old' }));
  const match = within(ui.getByRole('dialog', { name: 'Match to a new file' }));
  fireEvent.change(match.getByRole('combobox'), { target: { value: 'first' } });
  fireEvent.click(match.getByRole('button', { name: 'Confirm rename' }));
  assert.match(ui.getByRole('alert').textContent!, /Component identity conflict.*first.*confirmed rename/);
  const save = ui.getByRole('button', { name: /^Save revision$/ }) as HTMLButtonElement;
  assert.equal(save.disabled, true);
  fireEvent.submit(save.closest('form')!);
  assert.equal(captures, 0, 'submission cannot bypass the conflict block');
  assert.equal((await openExistingVault(f.vault)).revisions.length, state.revisions.length);
  fireEvent.click(ui.getByRole('button', { name: 'Cancel association' }));
  assert.equal(ui.queryByRole('alert'), null);
  assert.equal(save.disabled, false);
  fireEvent.click(save);
  await waitFor(() => assert.equal(captures, 1));
  const reopened = await openExistingVault(f.vault);
  assert.equal(reopened.revisions.length, state.revisions.length + 1);
  assert.equal(reopened.components?.status, 'available');
});

test('Changes saves the single Description and per-file Note into modification, leaving Why and What you noticed empty', async () => {
  const f = await fixture();
  let params: Parameters<import('./ChangesCaptureView').ChangesCaptureViewProps['onCapture']>[0] | undefined;
  const ui = render(<ChangesCaptureView {...changesProps(f.state, f.scan, { onCapture: async (p: typeof params) => { params = p; } })} />);
  fireEvent.change(ui.getByRole('textbox', { name: /Revision summary/ }), { target: { value: 'Notes check' } });
  fireEvent.click(ui.getByRole('button', { name: /Add a description/ }));
  fireEvent.change(ui.getByRole('textbox', { name: 'Overall: Description' }), { target: { value: 'Overall words' } });
  fireEvent.click(ui.getByRole('button', { name: 'Add note for first' }));
  fireEvent.change(ui.getByRole('textbox', { name: 'first: Note' }), { target: { value: 'File words' } });
  fireEvent.click(ui.getByRole('button', { name: /^Save revision$/ }));
  await waitFor(() => assert.ok(params));
  assert.deepEqual(params!.notes, { problem: '', modification: 'Overall words', observations: '' });
  assert.deepEqual(params!.fileNotes, [{ path: 'first', problem: '', modification: 'File words', observations: '' }]);
});
