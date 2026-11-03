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
test('legacy viewing never enables identity tracking without the explicit upgrade confirmation', async()=>{
  const f = await fixture(); await f.vault.removeEntry(['components'],{recursive:true});
  const state = await openExistingVault(f.vault); let calls=0;
  const ui = render(<ComponentIdentityControls state={state} scan={f.scan} busy={false} onChange={()=>{}} onEnable={async()=>{calls++;}}/>);
  assert.equal(calls,0);
  fireEvent.click(ui.getByRole('button',{name:'Enable component tracking'}));
  assert.equal(calls,0);
  let dialog=within(ui.getByRole('dialog',{name:'Enable component tracking'}));
  fireEvent.click(dialog.getByRole('button',{name:'Cancel'}));
  assert.equal(calls,0);
  fireEvent.click(ui.getByRole('button',{name:'Enable component tracking'}));
  dialog=within(ui.getByRole('dialog',{name:'Enable component tracking'}));
  fireEvent.click(dialog.getByRole('button',{name:'Enable tracking'}));
  await waitFor(()=>assert.equal(calls,1));
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
  fireEvent.change(ui.getByRole('combobox', { name: 'New path for old' }), { target: { value: 'first' } });
  fireEvent.click(ui.getByRole('button', { name: 'Confirm rename' }));
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
