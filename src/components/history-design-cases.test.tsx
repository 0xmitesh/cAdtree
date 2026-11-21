import "../../tests/dom";
import { pickFile, filePicker } from "../../tests/file-picker";
import { indexedDB } from "fake-indexeddb";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import App from "../App";
import { compareApplyRecoverSample } from "../../tests/compare-apply-recover-sample";
import { appBusy, currentBranchId, openHomeWorkspace, selectBranch } from "../../tests/app-controls";
import { clearAllConvenienceMetadata } from "../engine/idb-store";
import { inventorySignature, readVerifiedInventory } from "../engine/copy-service";
import { resolveManagedProject } from "../engine/workspace-service";
import { caseLifecycle } from "../engine/case-lifecycle";

Object.assign(globalThis,{indexedDB});
afterEach(async()=>{cleanup();await clearAllConvenienceMetadata();Reflect.deleteProperty(window,'showDirectoryPicker');});

test('History owns the existing case activity/Compare panel without changing inspection, notes or files',async()=>{
  const s=await compareApplyRecoverSample();
  await s.main.writeFileText(['Bracket.SLDPRT'],'Uncaptured Main work');
  const ui=render(<App/>);
  await openHomeWorkspace(ui,s.home);
  fireEvent.click(ui.getByRole('button',{name:'Open project'}));
  await waitFor(()=>assert.equal(appBusy(ui),false));
  const nav=within(ui.getByRole('navigation',{name:'Primary navigation'}));
  fireEvent.click(nav.getByRole('button',{name:'Changes'}));
  const summary=ui.getByRole('textbox',{name:/What changed/});
  fireEvent.change(summary,{target:{value:'Keep this engineering draft'}});
  fireEvent.click(nav.getByRole('button',{name:'History'}));
  pickFile(ui, 'Bracket.SLDPRT');
  fireEvent.click(ui.getByRole('button',{name:/V3: Reviewed baseline/}));
  const details=ui.container.querySelector('.revision-detail')!;
  const inspection=details.textContent;
  const before=inventorySignature(await readVerifiedInventory(s.home));
  const calls={list:0,read:0,write:0};
  s.home.setHooks({onBeforeListEntries:()=>{calls.list++},onBeforeRead:()=>{calls.read++},onBeforeWrite:()=>{calls.write++}});
  assert.equal(ui.container.querySelectorAll('.design-cases').length,1);
  const disclosure=ui.container.querySelector<HTMLDetailsElement>('.history-design-cases')!;
  fireEvent.click(disclosure.querySelector('summary')!);
  assert.equal(disclosure.open,true);
  const cases=within(ui.getByRole('region',{name:'Design cases'}));
  assert.equal(cases.queryByLabelText('Saved activity and divergence for Lightweight bracket'),null);
  const compare=cases.getByRole('button',{name:'Compare Lightweight bracket with Main'});
  compare.focus();fireEvent.click(compare);
  const comparison=within(ui.getByRole('dialog',{name:'Compare saved versions'}));
  assert.equal((comparison.getByRole('combobox',{name:'From version'}) as HTMLSelectElement).value,s.destination.manifest.revisionId);
  assert.equal((comparison.getByRole('combobox',{name:'To version'}) as HTMLSelectElement).value,s.source.manifest.revisionId);
  assert.match(comparison.getByTestId('compare-with-main-note').textContent!,/Shows how Lightweight bracket differs from Main/);
  assert.match(ui.getByRole('dialog',{name:'Compare saved versions'}).textContent!,/All project files/);
  fireEvent.click(comparison.getByRole('button',{name:'Close comparison'}));
  assert.equal(document.activeElement,compare);
  assert.deepEqual(calls,{list:0,read:0,write:0});
  s.home.setHooks({onBeforeListEntries:undefined,onBeforeRead:undefined,onBeforeWrite:undefined});
  assert.equal(details.textContent,inspection);
  assert.equal(currentBranchId(ui),'branch-main');
  assert.equal(filePicker(ui).value,'Bracket.SLDPRT');
  assert.equal(inventorySignature(await readVerifiedInventory(s.home)),before);
  fireEvent.click(nav.getByRole('button',{name:'Settings'}));
  assert.equal(ui.queryByRole('region',{name:'Design cases'}),null);
  assert.equal(ui.container.querySelector('.settings-page .design-cases'),null);
  fireEvent.click(nav.getByRole('button',{name:'Changes'}));
  assert.equal((summary as HTMLInputElement).value,'Keep this engineering draft');
});

test('History Hide case/Unhide: Main protection, unsaved-changes warning, badge, Show hidden cases and saved history',async()=>{
  const s=await compareApplyRecoverSample();
  const ui=render(<App/>);await openHomeWorkspace(ui,s.home);
  fireEvent.click(ui.getByRole('button',{name:'Open project'}));
  await waitFor(()=>assert.equal(appBusy(ui),false));
  const disclosure=ui.container.querySelector<HTMLDetailsElement>('.history-design-cases')!;
  fireEvent.click(disclosure.querySelector('summary')!);
  assert.equal(ui.queryByRole('button',{name:'Hide case Main'}),null);
  const state=()=>resolveManagedProject(s.workspace.root,s.project.record.containerPath);
  const saved=(await state()).vaultState.revisions.map(r=>r.manifest.revisionId);
  const caseRevisions=(await state()).vaultState.revisions.filter(r=>r.manifest.branchId===s.caseId).map(r=>r.manifest.displayNumber);
  assert.ok(caseRevisions.length);
  const revisionButton=(n:number)=>ui.queryByRole('button',{name:new RegExp(`^V${n}:`)});
  assert.ok(revisionButton(caseRevisions[0]));
  const mainBefore=inventorySignature(await readVerifiedInventory(s.main));
  await s.caseFolder.writeFileText(['Bracket.SLDPRT'],'An unsaved case edit');
  const caseBefore=inventorySignature(await readVerifiedInventory(s.caseFolder));
  fireEvent.click(ui.getByRole('button',{name:'Hide case Lightweight bracket'}));
  let dialog=within(ui.getByRole('dialog',{name:'Hide design case'}));
  fireEvent.click(dialog.getByRole('button',{name:'Hide case'}));
  // First confirm: the fresh scan finds the unsaved change and warns; nothing is hidden yet.
  await waitFor(()=>assert.match(ui.getByRole('dialog').textContent!,/This case has 1 unsaved change\. They stay in its folder and show again when you unhide it\./));
  assert.equal(ui.getAllByText(/They stay in its folder/).length,1);
  assert.equal(ui.container.querySelector('.app-status-feedback'),null);
  assert.equal((await state()).vaultState.caseLifecycles?.[s.caseId]?.status??'active','active');
  // A further edit after the warning: the engine refuses and shows the fresh count.
  await s.caseFolder.writeFileText(['Extra.txt'],'Another unsaved file');
  fireEvent.click(dialog.getByRole('button',{name:'Hide case'}));
  await waitFor(()=>assert.match(ui.getByRole('dialog').textContent!,/differ from what you saw.*2 unsaved changes/));
  assert.equal((await state()).vaultState.caseLifecycles?.[s.caseId]?.status??'active','active');
  fireEvent.click(dialog.getByRole('button',{name:'Hide case'}));
  await waitFor(()=>assert.ok(ui.queryByRole('dialog')===null,'Hide confirmation closes after success'));
  assert.equal((await state()).vaultState.caseLifecycles?.[s.caseId].status,'archived');
  assert.equal((await state()).vaultState.caseLifecycles?.[s.caseId].unsavedAtHide,2);
  // Hidden: its row and its own revisions leave History until Show hidden cases is on.
  assert.equal(ui.queryByRole('button',{name:'Unhide case Lightweight bracket'}),null);
  assert.equal(revisionButton(caseRevisions[0]),null);
  const toggle=ui.container.querySelector<HTMLInputElement>('.history-hidden-toggle input')!;
  fireEvent.click(toggle);
  await waitFor(()=>assert.ok(revisionButton(caseRevisions[0])));
  assert.ok(revisionButton(caseRevisions[0])!.closest('.hidden-case'));
  const row=ui.getByRole('button',{name:'Unhide case Lightweight bracket'}).closest('.case-row')!;
  assert.match(row.textContent!,/Hidden/);
  assert.match(row.textContent!,/2 unsaved changes/);
  fireEvent.click(ui.getByRole('button',{name:'Unhide case Lightweight bracket'}));
  dialog=within(ui.getByRole('dialog',{name:'Unhide design case'}));
  fireEvent.click(dialog.getByRole('button',{name:'Cancel'}));
  assert.equal((await state()).vaultState.caseLifecycles?.[s.caseId].status,'archived');
  fireEvent.click(ui.getByRole('button',{name:'Unhide case Lightweight bracket'}));
  dialog=within(ui.getByRole('dialog',{name:'Unhide design case'}));
  fireEvent.click(dialog.getByRole('button',{name:'Unhide'}));
  await waitFor(()=>assert.ok(ui.queryByRole('dialog')===null,'Unhide confirmation closes after success'));
  assert.equal((await state()).vaultState.caseLifecycles?.[s.caseId].status,'active');
  assert.equal(currentBranchId(ui),'branch-main');
  assert.deepEqual((await state()).vaultState.revisions.map(r=>r.manifest.revisionId),saved);
  assert.equal(inventorySignature(await readVerifiedInventory(s.main)),mainBefore);
  assert.notEqual(inventorySignature(await readVerifiedInventory(s.caseFolder)),caseBefore);
  assert.equal(await s.caseFolder.readFileText(['Bracket.SLDPRT']),'An unsaved case edit');
  assert.equal(await s.caseFolder.readFileText(['Extra.txt']),'Another unsaved file');
});

test('Hiding the working case switches the app to Main',async()=>{
  const s=await compareApplyRecoverSample();
  const ui=render(<App/>);await openHomeWorkspace(ui,s.home);
  fireEvent.click(ui.getByRole('button',{name:'Open project'}));
  await waitFor(()=>assert.equal(appBusy(ui),false));
  await selectBranch(ui,s.caseId);
  assert.equal(currentBranchId(ui),s.caseId);
  const nav=within(ui.getByRole('navigation',{name:'Primary navigation'}));
  fireEvent.click(nav.getByRole('button',{name:'History'}));
  const disclosure=ui.container.querySelector<HTMLDetailsElement>('.history-design-cases')!;
  fireEvent.click(disclosure.querySelector('summary')!);
  fireEvent.click(ui.getByRole('button',{name:'Hide case Lightweight bracket'}));
  const dialog=within(ui.getByRole('dialog',{name:'Hide design case'}));
  assert.match(ui.getByRole('dialog').textContent!,/You are working on this case\. cAdtree switches you to Main/);
  fireEvent.click(dialog.getByRole('button',{name:'Hide case'}));
  await waitFor(()=>assert.ok(ui.queryByRole('dialog')===null));
  await waitFor(()=>assert.equal(currentBranchId(ui),'branch-main'));
  await waitFor(()=>assert.equal(appBusy(ui),false));
  const state=await resolveManagedProject(s.workspace.root,s.project.record.containerPath);
  assert.equal(state.vaultState.caseLifecycles?.[s.caseId].status,'archived');
  assert.equal(state.vaultState.caseLifecycles?.[s.caseId].unsavedAtHide,0);
  await waitFor(()=>assert.match(ui.container.textContent!,/Hid Lightweight bracket\..*You are now working on Main\./));
  // The hidden case leaves the Explorer until Show hidden cases is on there; it is then read-only.
  assert.equal(ui.container.querySelector(`.desktop-workspace-tree [role="treeitem"][data-branch-id="${s.caseId}"]`),null);
  fireEvent.click(ui.container.querySelector<HTMLInputElement>('.desktop-workspace-tree .tree-hidden-toggle input, .tree-hidden-toggle input')!);
  const row=await waitFor(()=>{const r=ui.container.querySelector(`[role="treeitem"][data-branch-id="${s.caseId}"]`);assert.ok(r);return r;});
  // Shown hidden case rows can be opened (read-only); only busy or unreadable cases are disabled.
  assert.equal(row.getAttribute('aria-disabled'),null);
  assert.match(row.textContent!,/Lightweight bracket · Hidden/);
  assert.ok(row.classList.contains('hidden-case'));
});

test('Hiding the working case: if switching to Main fails, the banner says so and keeps the reason',async()=>{
  const s=await compareApplyRecoverSample();
  const ui=render(<App/>);await openHomeWorkspace(ui,s.home);
  fireEvent.click(ui.getByRole('button',{name:'Open project'}));
  await waitFor(()=>assert.equal(appBusy(ui),false));
  await selectBranch(ui,s.caseId);
  const nav=within(ui.getByRole('navigation',{name:'Primary navigation'}));
  fireEvent.click(nav.getByRole('button',{name:'History'}));
  fireEvent.click(ui.container.querySelector<HTMLDetailsElement>('.history-design-cases > summary')!);
  // Once the hide record is written, Main's working folder disappears, so the switch to Main fails.
  const working=await s.workspace.root.getDirectory([...s.project.record.containerPath.split('/'),'working']);
  let removed=false;
  s.home.setHooks({onAfterWrite:async(path:string)=>{
    if(!removed&&path.includes('case-lifecycle/')){removed=true;await working.removeEntry(['main'],{recursive:true});}
  }});
  fireEvent.click(ui.getByRole('button',{name:'Hide case Lightweight bracket'}));
  fireEvent.click(within(ui.getByRole('dialog',{name:'Hide design case'})).getByRole('button',{name:'Hide case'}));
  await waitFor(()=>assert.ok(ui.queryByRole('dialog')===null));
  await waitFor(()=>assert.equal(appBusy(ui),false));
  s.home.setHooks({onAfterWrite:undefined});
  assert.ok(removed);
  const state=await resolveManagedProject(s.workspace.root,s.project.record.containerPath).catch(()=>null);
  if(state) assert.equal(state.vaultState.caseLifecycles?.[s.caseId].status,'archived');
  const banner=await waitFor(()=>{const b=ui.container.querySelector('.app-status-feedback');assert.ok(b&&/Hid Lightweight bracket\./.test(b.textContent!));return b;});
  const text=banner.textContent!;
  // The case did change to Main, but checking Main failed: that failure stays in the banner
  // (before the fix, a plain success message replaced it).
  assert.equal(currentBranchId(ui),'branch-main');
  assert.match(text,/You are now working on Main\. This project is read-only\..*Directory "main" not found/);
});

async function openAndHideCase(){
  const s=await compareApplyRecoverSample();
  const ui=render(<App/>);await openHomeWorkspace(ui,s.home);
  fireEvent.click(ui.getByRole('button',{name:'Open project'}));
  await waitFor(()=>assert.equal(appBusy(ui),false));
  const nav=within(ui.getByRole('navigation',{name:'Primary navigation'}));
  fireEvent.click(nav.getByRole('button',{name:'History'}));
  fireEvent.click(ui.container.querySelector<HTMLDetailsElement>('.history-design-cases > summary')!);
  fireEvent.click(ui.getByRole('button',{name:'Hide case Lightweight bracket'}));
  fireEvent.click(within(ui.getByRole('dialog',{name:'Hide design case'})).getByRole('button',{name:'Hide case'}));
  await waitFor(()=>assert.ok(ui.queryByRole('dialog')===null));
  await waitFor(()=>assert.equal(appBusy(ui),false));
  return {s,ui,nav};
}
const switches=(ui:ReturnType<typeof render>)=>ui.getAllByRole('checkbox',{name:'Show hidden cases'}) as HTMLInputElement[];
const caseRow=(ui:ReturnType<typeof render>,id:string)=>ui.container.querySelector(`.desktop-workspace-tree [role="treeitem"][data-branch-id="${id}"]`);

test('One Show hidden cases switch: History and the Explorer always agree',async()=>{
  const {s,ui}=await openAndHideCase();
  assert.equal(switches(ui).length,2);
  assert.ok(switches(ui).every(box=>!box.checked));
  assert.equal(caseRow(ui,s.caseId),null);
  // History's switch also shows the case in the Explorer.
  fireEvent.click(ui.container.querySelector<HTMLInputElement>('.history-hidden-toggle input')!);
  await waitFor(()=>assert.ok(caseRow(ui,s.caseId)));
  assert.ok(switches(ui).every(box=>box.checked));
  // The Explorer's switch also hides it in History.
  fireEvent.click(ui.container.querySelector<HTMLInputElement>('.tree-hidden-toggle input')!);
  await waitFor(()=>assert.equal(caseRow(ui,s.caseId),null));
  assert.ok(switches(ui).every(box=>!box.checked));
  assert.equal(ui.queryByRole('button',{name:'Unhide case Lightweight bracket'}),null);
  fireEvent.click(ui.container.querySelector<HTMLInputElement>('.tree-hidden-toggle input')!);
  await waitFor(()=>assert.ok(ui.getByRole('button',{name:'Unhide case Lightweight bracket'})));
  assert.ok(switches(ui).every(box=>box.checked));
});

test('A shown hidden case opens read-only: you can look and export, but nothing can be saved or changed in it',async()=>{
  const {s,ui,nav}=await openAndHideCase();
  await s.caseFolder.writeFileText(['Bracket.SLDPRT'],'An edit made while hidden');
  // Every byte of the test home (workspaces, projects, vaults, working folders) before the hidden case is opened.
  const homeBefore=inventorySignature(await readVerifiedInventory(s.home));
  fireEvent.click(ui.container.querySelector<HTMLInputElement>('.history-hidden-toggle input')!);
  await selectBranch(ui,s.caseId);
  assert.equal(currentBranchId(ui),s.caseId);
  const notice='This case is hidden, so you can look but not change it. Unhide it in History → Design cases to work on it again.';
  assert.ok(ui.getByText(notice));
  // Changes: the change is seen, but Save version and Discard are refused with the reason.
  fireEvent.click(nav.getByRole('button',{name:'Changes'}));
  await waitFor(()=>assert.ok(ui.getByRole('button',{name:'Discard all…'})));
  assert.equal((ui.getByRole('button',{name:'Save version'}) as HTMLButtonElement).disabled,true);
  assert.equal((ui.getByRole('button',{name:'Discard all…'}) as HTMLButtonElement).disabled,true);
  // Try them anyway: nothing may happen.
  fireEvent.click(ui.getByRole('button',{name:'Discard all…'}));
  fireEvent.click(ui.getByRole('button',{name:'Save version'}));
  assert.equal(ui.queryByRole('dialog'),null);
  assert.ok(ui.getAllByText('This case is hidden. Unhide it in History → Design cases before saving or changing its files.').length>=1);
  // History: Get this version, Bring back and Copy are refused; Export a copy and Compare still work.
  fireEvent.click(nav.getByRole('button',{name:'History'}));
  fireEvent.click(ui.getByRole('button',{name:/^V3:/}));
  assert.equal(ui.container.querySelector('.revision-detail')!.textContent!.includes('Export a copy'),true);
  assert.equal((ui.getByRole('button',{name:'Export a copy'}) as HTMLButtonElement).disabled,false);
  const getButtons=ui.queryAllByRole('button',{name:'Get this version'}) as HTMLButtonElement[];
  assert.ok(getButtons.length>0&&getButtons.every(b=>b.disabled),'Get this version is refused for a hidden case');
  const mainCopy=ui.getByRole('button',{name:/^Copy files from Main…|^Bring back onto/});
  fireEvent.click(mainCopy);
  await waitFor(()=>assert.match(ui.getByRole('dialog').textContent!,/This case is hidden\. Unhide it in History/));
  // The case has unsaved changes, so the dialog offers Discard them; it is refused too.
  const discardThem=within(ui.getByRole('dialog')).getByRole('button',{name:'Discard them'}) as HTMLButtonElement;
  assert.equal(discardThem.disabled,true);
  fireEvent.click(discardThem);
  // Nothing was written anywhere: the whole home is byte for byte what it was before.
  assert.equal(await s.caseFolder.readFileText(['Bracket.SLDPRT']),'An edit made while hidden');
  assert.equal(inventorySignature(await readVerifiedInventory(s.home)),homeBefore);
  assert.equal(caseLifecycle((await resolveManagedProject(s.workspace.root,s.project.record.containerPath)).vaultState,s.caseId).status,'archived');
});

test('Turning Show hidden cases off while a hidden case is open keeps it open',async()=>{
  const {s,ui}=await openAndHideCase();
  fireEvent.click(ui.container.querySelector<HTMLInputElement>('.tree-hidden-toggle input')!);
  await selectBranch(ui,s.caseId);
  assert.equal(currentBranchId(ui),s.caseId);
  fireEvent.click(ui.container.querySelector<HTMLInputElement>('.tree-hidden-toggle input')!);
  await waitFor(()=>assert.ok(switches(ui).every(box=>!box.checked)));
  assert.equal(currentBranchId(ui),s.caseId);
  assert.ok(caseRow(ui,s.caseId),'the open case keeps its Explorer row');
  assert.ok(ui.getByText(/This case is hidden, so you can look but not change it/));
});
