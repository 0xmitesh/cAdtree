import '../../tests/dom';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { cleanup, render, fireEvent, within, waitFor } from '@testing-library/react';
import { ComponentIdentityControls } from './ComponentIdentityControls';
import { InMemoryFileSystemAdapter } from '../engine/fs-adapter';
import { initializeProjectVault, openExistingVault } from '../engine/vault-service';
import { captureRevision } from '../engine/revision-service';
import { scanBranchChanges } from '../engine/scanner';
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
