import "../../tests/dom";
import { indexedDB } from "fake-indexeddb";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { compareApplyRecoverSample } from "../../tests/compare-apply-recover-sample";
import { appBusy, currentBranchId, openHomeWorkspace, selectBranch } from "../../tests/app-controls";
import { clearAllConvenienceMetadata } from "../engine/idb-store";
import { inventorySignature, readVerifiedInventory } from "../engine/copy-service";

Object.assign(globalThis, { indexedDB });
afterEach(async () => {
  cleanup(); await clearAllConvenienceMetadata();
  Reflect.deleteProperty(window, "showDirectoryPicker");
});

test("Project Learn preserves the working case, inspected revision, scan and all pending note drafts without reopening folders", async () => {
  const sample = await compareApplyRecoverSample();
  await sample.caseFolder.writeFileText(["Bracket.SLDPRT"], "Uncaptured lighter bracket");
  const ui = render(<App />);
  await openHomeWorkspace(ui, sample.home);
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  await selectBranch(ui, sample.caseId);
  const nav = within(ui.getByRole("navigation", { name: "Primary navigation" }));
  fireEvent.click(nav.getByRole("button", { name: "Changes" }));
  fireEvent.click(ui.getByRole("button", { name: "Scan for changes" }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  const summary = ui.getByRole("textbox", { name: /Revision summary/ });
  fireEvent.change(summary, { target: { value: "Keep this pending summary" } });
  fireEvent.click(ui.getByRole("button", { name: /Add overall engineering notes/ }));
  const overall = ui.getByRole("textbox", { name: "Overall: problem" });
  fireEvent.change(overall, { target: { value: "Keep this engineering intent" } });
  fireEvent.click(ui.getByRole("button", { name: "Add note for Bracket.SLDPRT" }));
  const fileNote = ui.getByRole("textbox", { name: "Bracket.SLDPRT: modification" });
  fireEvent.change(fileNote, { target: { value: "Keep this file-specific draft" } });
  fireEvent.click(nav.getByRole("button", { name: "History" }));
  fireEvent.click(ui.getByRole("button", { name: /Rev 004: Reduced bracket thickness/ }));
  const details = ui.container.querySelector(".revision-detail")!;
  const inspected = details.textContent;
  const before = inventorySignature(await readVerifiedInventory(sample.home));
  let picks = 0;
  Object.assign(window, { showDirectoryPicker: async () => { picks++; throw Error("Learn must not reconnect folders"); } });
  const user = userEvent.setup({ document });
  const trigger = nav.getByRole("button", { name: "Learn cAdtree" });
  trigger.focus(); await user.keyboard("{Enter}");
  const chooser = within(ui.getByRole("dialog", { name: "Learn cAdtree" }));
  assert.equal(chooser.getAllByRole("article").length, 5);
  assert.equal(ui.container.querySelector(".revision-detail"), details);
  for (const title of ["Start with cAdtree", "Save your first revision", "Bring existing work into cAdtree", "Explore design alternatives", "Compare, apply & recover"]) {
    const start = within(chooser.getByRole("article", { name: title })).getByRole("button", { name: "Start tutorial" });
    start.focus(); await user.keyboard("{Enter}");
    const viewer = within(ui.getByRole("dialog", { name: title }));
    if (title === "Compare, apply & recover") {
      for (let step = 1; step <= 7; step++) {
        while (viewer.queryByRole("button", { name: "Next visual" }) && !(viewer.getByRole("button", { name: "Next visual" }) as HTMLButtonElement).disabled) {
          fireEvent.click(viewer.getByRole("button", { name: "Next visual" }));
        }
        fireEvent.click(viewer.getByRole("button", { name: step === 7 ? "Finish" : "Next" }));
      }
    } else fireEvent.click(viewer.getByRole("button", { name: "Close" }));
    assert.equal(ui.queryByRole("dialog", { name: title }), null);
    assert.equal(document.activeElement, start);
    assert.equal(details.textContent, inspected);
  }
  fireEvent.click(chooser.getByRole("button", { name: "Close" }));
  assert.equal(document.activeElement, trigger);
  assert.equal(ui.queryByRole("dialog"), null);
  assert.equal(currentBranchId(ui), sample.caseId);
  assert.equal(ui.container.querySelector(".revision-detail"), details, "History was not unmounted");
  assert.equal(details.textContent, inspected);
  fireEvent.click(nav.getByRole("button", { name: "Changes" }));
  assert.equal(ui.getByRole("textbox", { name: /Revision summary/ }), summary, "Changes was not unmounted");
  assert.equal((summary as HTMLInputElement).value, "Keep this pending summary");
  assert.equal((overall as HTMLTextAreaElement).value, "Keep this engineering intent");
  assert.equal((fileNote as HTMLTextAreaElement).value, "Keep this file-specific draft");
  assert.ok(ui.getByRole("button", { name: "Add note for Bracket.SLDPRT" }), "scan remains available");
  assert.equal(picks, 0);
  assert.equal(inventorySignature(await readVerifiedInventory(sample.home)), before);

  // The same overlay is reachable without changing each current project page.
  for (const page of ["Changes", "References", "Settings", "History"]) {
    fireEvent.click(nav.getByRole("button", { name: page }));
    assert.equal(nav.getByRole("button", { name: page }).getAttribute("aria-current"), "page");
    trigger.focus(); fireEvent.click(trigger);
    fireEvent.click(within(ui.getByRole("dialog", { name: "Learn cAdtree" })).getByRole("button", { name: "Close dialog" }));
    assert.equal(nav.getByRole("button", { name: page }).getAttribute("aria-current"), "page");
    assert.equal(document.activeElement, trigger);
  }
});
