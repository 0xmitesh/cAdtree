import "../../tests/dom";
import { indexedDB } from "fake-indexeddb";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { compareApplyRecoverSample } from "../../tests/compare-apply-recover-sample";
import { appBusy, currentBranchId, openHomeWorkspace, selectBranch, waitForScan, holdOperation } from "../../tests/app-controls";
import { createTestAuthController, SECOND_TEST_USER } from "../../tests/test-auth";
import { clearAllConvenienceMetadata } from "../engine/idb-store";
import { inventorySignature, readVerifiedInventory } from "../engine/copy-service";
import { createProject } from "../engine/workspace-service";
import { autoRefreshTiming } from "../app/useAutoRefresh";

Object.assign(globalThis, { indexedDB });
afterEach(async () => { cleanup(); await clearAllConvenienceMetadata(); Reflect.deleteProperty(window, "showDirectoryPicker"); });
// jsdom performs same-document history traversal asynchronously, as browsers do.
async function traverse(direction: "back" | "forward") {
  await act(async () => { window.history[direction](); await new Promise(resolve => setTimeout(resolve, 30)); });
}
async function openSample(auth = createTestAuthController(), secondProject = false) {
  const sample = await compareApplyRecoverSample();
  if (secondProject) await createProject(sample.workspace.root, 'Z alternate fixture');
  const ui = render(<App auth={auth.adapter} />);
  await openHomeWorkspace(ui, sample.home);
  fireEvent.click(within(ui.getByRole('heading',{name:'Bracket Assembly',level:3}).closest('.workspace-project') as HTMLElement).getByRole('button',{name:'Open project'}));
  await waitFor(() => assert.equal(appBusy(ui), false));
  return {sample, ui, nav: within(ui.getByRole("navigation", {name: "Primary navigation"})), auth};
}

test("Logo is an intro button; main-view Back/Forward preserves current project, inspection, case and drafts", async () => {
  const {sample,ui,nav}=await openSample();
  await sample.caseFolder.writeFileText(['Bracket.SLDPRT'],'Pending experiment');
  await selectBranch(ui,sample.caseId);
  fireEvent.click(nav.getByRole("button",{name:"Changes"}));
  await waitForScan(ui);
  await waitFor(()=>assert.equal(appBusy(ui),false));
  const summary=ui.getByRole("textbox",{name:/Version summary/});
  fireEvent.change(summary,{target:{value:"Keep this pending decision"}});
  fireEvent.click(ui.getByRole("button",{name:/Add a description/}));
  const note=ui.getByRole("textbox",{name:"Overall: Why"});
  fireEvent.change(note,{target:{value:"Keep the engineering intent"}});
  fireEvent.click(nav.getByRole("button",{name:"History"}));
  fireEvent.click(ui.getByRole("button",{name:/V4: Reduced bracket thickness/}));
  const details=ui.container.querySelector('.revision-detail');
  const text=details?.textContent;
  const signature=inventorySignature(await readVerifiedInventory(sample.home));
  let picks=0;
  Object.assign(window,{showDirectoryPicker:async()=>{picks++;throw Error('Navigation must not pick folders')}});
  const logo=ui.getByRole("button",{name:"cAdtree introduction"});
  assert.equal(logo.hasAttribute('href'),false);
  assert.equal(ui.queryByRole('link',{name:'cAdtree introduction'}),null);
  logo.focus();await userEvent.setup({document}).keyboard('{Enter}');
  assert.ok(ui.getByRole('heading',{name:'Welcome to cAdtree'}));
  const introIndex=window.history.state.cadtreeView.index;
  fireEvent.click(within(ui.getByRole('article',{name:'Explore design alternatives'})).getByRole('button',{name:'Start tutorial'}));
  fireEvent.click(within(ui.getByRole('dialog',{name:'Explore design alternatives'})).getByRole('button',{name:'Close'}));
  assert.equal(window.history.state.cadtreeView.index,introIndex,'tutorials add no view-history entries');
  await traverse('back');
  assert.ok(ui.getByRole('heading',{name:'History.'}));
  assert.equal(ui.container.querySelector('.revision-detail'),details);
  assert.equal(details?.textContent,text);
  assert.equal(currentBranchId(ui),sample.caseId);
  await traverse('forward');assert.ok(ui.getByRole('heading',{name:'Welcome to cAdtree'}));
  fireEvent.click(nav.getByRole('button',{name:'My workspaces'}));
  assert.ok(ui.getByRole('heading',{name:'My workspaces.'}));
  await traverse('back');assert.ok(ui.getByRole('heading',{name:'Welcome to cAdtree'}));
  await traverse('back');assert.ok(ui.getByRole('heading',{name:'History.'}));
  fireEvent.click(nav.getByRole('button',{name:'Changes'}));
  assert.equal(ui.getByRole('textbox',{name:/Version summary/}),summary);
  assert.equal((summary as HTMLInputElement).value,'Keep this pending decision');
  assert.equal((note as HTMLTextAreaElement).value,'Keep the engineering intent');
  // A new visit after Back replaces the forward path, rather than replaying intro.
  await traverse('back');assert.ok(ui.getByRole('heading',{name:'History.'}));
  await traverse('forward');assert.ok(ui.getByRole('heading',{name:'Changes.'}));
  assert.equal(inventorySignature(await readVerifiedInventory(sample.home)),signature);assert.equal(picks,0);
});

test("Cadtree home is a hierarchy toggle, not a second workspace-list command", async()=>{
  const {ui,nav}=await openSample();
  const workspace=ui.getByRole('treeitem',{name:'Tutorial Workspace'});
  fireEvent.click(workspace);
  await waitFor(()=>assert.ok(ui.getByRole('heading',{name:'Tutorial Workspace.'})));
  const index=window.history.state.cadtreeView.index;
  const root=ui.getByRole('treeitem',{name:'Cadtree home'});
  assert.equal(root.getAttribute('aria-expanded'),'true');
  fireEvent.click(root);assert.equal(root.getAttribute('aria-expanded'),'false');
  fireEvent.keyDown(root,{key:'Enter'});assert.equal(root.getAttribute('aria-expanded'),'true');
  assert.ok(ui.getByRole('heading',{name:'Tutorial Workspace.'}));
  assert.equal(window.history.state.cadtreeView.index,index);
  fireEvent.click(nav.getByRole('button',{name:'My workspaces'}));
  assert.ok(ui.getByRole('heading',{name:'My workspaces.'}));
  await traverse('back');assert.ok(ui.getByRole('heading',{name:'Tutorial Workspace.'}));
});

test("Signing in as another account keeps the open project and the browser-history entries", async()=>{
  const {ui,nav,auth,sample}=await openSample();
  fireEvent.click(nav.getByRole('button',{name:'Changes'}));
  const before=inventorySignature(await readVerifiedInventory(sample.home));
  await act(async()=>auth.setUser(SECOND_TEST_USER));
  assert.ok(ui.getByText('Second Engineer'));
  assert.ok(ui.getByRole('heading',{name:'Changes.'}));
  await traverse('back');
  assert.ok(ui.getByRole('heading',{name:'History.'}));
  assert.equal(ui.queryByRole('heading',{name:'Welcome to cAdtree'}),null);
  assert.equal(inventorySignature(await readVerifiedInventory(sample.home)),before);
});

test("Back waits for a running operation and then restores the requested main view", async()=>{
  const {ui,nav,sample}=await openSample();
  fireEvent.click(nav.getByRole('button',{name:'Changes'}));
  const held=await holdOperation(ui,sample.home);
  assert.ok(ui.getByRole('heading',{name:'Settings.'}));
  await traverse('back');assert.ok(ui.getByRole('heading',{name:'Settings.'}));
  await held.release();
  await waitFor(()=>assert.ok(ui.getByRole('heading',{name:'Changes.'})));
});

test("Returning from a different project revalidates its location and retains the earlier project's note draft", async()=>{
  const {sample,ui,nav}=await openSample(undefined,true);
  await sample.main.writeFileText(['Bracket.SLDPRT'],'An unsaved Main experiment');
  fireEvent.click(nav.getByRole('button',{name:'Changes'}));
  await waitForScan(ui);
  await waitFor(()=>assert.equal(appBusy(ui),false));
  fireEvent.change(ui.getByRole('textbox',{name:/Version summary/}),{target:{value:'Earlier project draft'}});
  fireEvent.click(nav.getByRole('button',{name:'My workspaces'}));
  fireEvent.click(ui.getByRole('button',{name:'Open workspace'}));
  await waitFor(()=>assert.equal(appBusy(ui),false));
  const other=within(ui.getByRole('heading',{name:'Z alternate fixture',level:3}).closest('.workspace-project') as HTMLElement);
  fireEvent.click(other.getByRole('button',{name:'Open project'}));
  await waitFor(()=>assert.equal(appBusy(ui),false));
  const before=inventorySignature(await readVerifiedInventory(sample.home));
  await traverse('back');assert.ok(ui.getByRole('heading',{name:'Tutorial Workspace.'}));
  await traverse('back');assert.ok(ui.getByRole('heading',{name:'My workspaces.'}));
  await traverse('back');
  await waitFor(()=>assert.equal(appBusy(ui),false));
  await waitFor(()=>assert.equal((ui.getByRole('textbox',{name:/Version summary/}) as HTMLInputElement).value,'Earlier project draft'));
  assert.equal(inventorySignature(await readVerifiedInventory(sample.home)),before);
});

test("Back stays put when the workspace is no longer in the home: no project opens outside a workspace", async()=>{
  const {sample,ui,nav}=await openSample(undefined,true);
  fireEvent.click(nav.getByRole('button',{name:'My workspaces'}));
  fireEvent.click(ui.getByRole('button',{name:'Open workspace'}));
  await waitFor(()=>assert.equal(appBusy(ui),false));
  fireEvent.click(within(ui.getByRole('heading',{name:'Z alternate fixture',level:3}).closest('.workspace-project') as HTMLElement).getByRole('button',{name:'Open project'}));
  await waitFor(()=>assert.equal(appBusy(ui),false));
  fireEvent.click(nav.getByRole('button',{name:'My workspaces'}));
  assert.ok(ui.getByRole('heading',{name:'My workspaces.'}));
  // The registration vanishes; the quiet re-read of the home list no longer shows the workspace.
  const saved=autoRefreshTiming.debounceMs;autoRefreshTiming.debounceMs=10;
  try{
    const records=await sample.home.getDirectory(['.cadtree-home','workspaces']);
    for(const entry of await records.listEntries())await records.removeEntry([entry.name]);
    await act(async()=>{window.dispatchEvent(new window.Event('focus'));await new Promise(resolve=>setTimeout(resolve,200));});
    await waitFor(()=>assert.equal(ui.queryByRole('button',{name:'Open workspace'}),null));
  }finally{autoRefreshTiming.debounceMs=saved;}
  // Back through the second project and the workspace page to the earlier My workspaces page.
  await traverse('back');assert.ok(ui.container.querySelector('.project-context-header')?.textContent?.includes('Z alternate fixture'));
  await traverse('back');assert.ok(ui.getByRole('heading',{name:'Tutorial Workspace.'}));
  await traverse('back');assert.ok(ui.getByRole('heading',{name:'My workspaces.'}));
  // The entry before it is the first project, whose workspace is gone from the home: Back cannot move.
  await traverse('back');
  assert.ok(ui.getByRole('heading',{name:'My workspaces.'}),'the page does not change');
  assert.equal(ui.queryByRole('treeitem',{name:/External/})===null,true,'no External root in the Explorer');
  // The project that was open stays open: the earlier one (Bracket Assembly) was not opened outside a workspace.
  assert.equal(ui.container.querySelector('.project-context-header')?.textContent?.includes('Bracket Assembly')??false,false);
  // Back once more reaches the entry before the refused one (the workspace page).
  await traverse('back');assert.ok(ui.getByRole('heading',{name:'Tutorial Workspace.'}));
});
