import "../../tests/dom";
import { indexedDB } from "fake-indexeddb";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import App from "../App";
import { compareApplyRecoverSample } from "../../tests/compare-apply-recover-sample";
import { appBusy, currentBranchId, openHomeWorkspace, selectBranch } from "../../tests/app-controls";
import { clearAllConvenienceMetadata } from "../engine/idb-store";
import { inventorySignature, readVerifiedInventory } from "../engine/copy-service";

Object.assign(globalThis, { indexedDB });
afterEach(async () => {
  cleanup();
  await clearAllConvenienceMetadata();
  Reflect.deleteProperty(window, "showDirectoryPicker");
});

async function openSample() {
  const sample = await compareApplyRecoverSample();
  await sample.main.writeFileText(["Bracket.SLDPRT"], "Uncaptured Main engineering work");
  const ui = render(<App />);
  await openHomeWorkspace(ui, sample.home);
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  return { sample, ui, nav: within(ui.getByRole("navigation", { name: "Primary navigation" })) };
}

test("References uses its branch filter while the other project views show the current case as text, without changing inspection, drafts or files", async () => {
  const { sample, ui, nav } = await openSample();
  const header = ui.getByRole("region", { name: "Project context" });
  const before = inventorySignature(await readVerifiedInventory(sample.home));
  fireEvent.click(nav.getByRole("button", { name: "Changes" }));
  fireEvent.click(ui.getByRole("button", { name: "Scan for changes" }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  fireEvent.change(ui.getByRole("textbox", { name: /Revision summary/ }), { target: { value: "Keep the Main engineering draft" } });
  fireEvent.click(nav.getByRole("button", { name: "History" }));
  fireEvent.click(ui.getByRole("button", { name: /Rev 004: Reduced bracket thickness/ }));
  const inspection = ui.container.querySelector(".revision-detail")!.textContent;
  assert.match(inspection!, /Lightweight bracket/);
  for (const view of ["Changes", "References", "Settings", "History"]) {
    fireEvent.click(nav.getByRole("button", { name: view }));
    assert.equal(ui.getByRole("region", { name: "Project context" }), header);
    if (view === "References") {
      assert.equal(header.querySelector(".project-context-case"), null);
      fireEvent.change(ui.getByRole("combobox", { name: "Branch" }), { target: { value: sample.caseId } });
      assert.equal(currentBranchId(ui), "branch-main");
    } else {
      assert.equal(header.querySelector(".project-context-case")!.textContent, "Case: Main");
    }
    assert.equal(ui.container.querySelector('.current-branch-indicator'), null);
  }
  assert.equal(ui.container.querySelector(".revision-detail")!.textContent, inspection);
  fireEvent.click(nav.getByRole("button", { name: "Changes" }));
  assert.equal((ui.getByRole("textbox", { name: /Revision summary/ }) as HTMLInputElement).value, "Keep the Main engineering draft");
  assert.equal(inventorySignature(await readVerifiedInventory(sample.home)), before);
});

test("The Explorer switches the case from History, Changes and Settings, the header shows it as text, and the Explorer is locked during a scan", async () => {
  const { sample, ui, nav } = await openSample();
  const caseRows = () => Array.from(ui.container.querySelectorAll<HTMLElement>('.desktop-workspace-tree [data-branch-id]'));
  assert.equal(ui.queryByRole("combobox", { name: "Working case" }), null);
  const before = inventorySignature(await readVerifiedInventory(sample.home));
  for (const view of ["History", "Changes", "Settings"]) {
    fireEvent.click(nav.getByRole("button", { name: view }));
    for (const id of [sample.caseId, "branch-main"]) {
      await selectBranch(ui, id);
      assert.equal(currentBranchId(ui), id);
      assert.match(ui.getByRole("region", { name: "Project context" }).querySelector(".project-context-case")!.textContent!, id === "branch-main" ? /^Case: Main$/ : /^Case: Lightweight bracket$/);
      assert.ok(ui.getByRole("heading", { name: `${view}.` }));
    }
  }
  assert.equal(inventorySignature(await readVerifiedInventory(sample.home)), before);
  fireEvent.click(nav.getByRole("button", { name: "Changes" }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  sample.home.setHooks({ onBeforeListEntries: async () => { await gate; } });
  fireEvent.click(ui.getByRole("button", { name: "Scan for changes" }));
  await waitFor(() => assert.equal(appBusy(ui), true));
  assert.ok(caseRows().length >= 2);
  for (const row of caseRows()) assert.equal(row.getAttribute("aria-disabled"), "true");
  fireEvent.click(caseRows().find(row => row.dataset.branchId === sample.caseId)!);
  await act(async () => release());
  await waitFor(() => assert.equal(appBusy(ui), false));
  for (const row of caseRows()) assert.equal(row.getAttribute("aria-disabled"), null);
  assert.equal(currentBranchId(ui), "branch-main");
});
