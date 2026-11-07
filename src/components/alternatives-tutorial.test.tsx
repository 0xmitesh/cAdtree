import "../../tests/dom";
import { indexedDB } from "fake-indexeddb";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { EXPLORE_DESIGN_ALTERNATIVES_TUTORIAL as tutorial } from "../tutorials/explore-design-alternatives";
import { designAlternativesSample } from "../../tests/design-alternatives-sample";
import { createManagedBranch, resolveManagedProject } from "../engine/workspace-service";
import { inventorySignature, readVerifiedInventory } from "../engine/copy-service";
import { clearAllConvenienceMetadata } from "../engine/idb-store";
import { appBusy, currentBranchId, openHomeWorkspace, selectBranch } from "../../tests/app-controls";

Object.assign(globalThis, { indexedDB });
afterEach(async () => {
  cleanup();
  await clearAllConvenienceMetadata();
  Reflect.deleteProperty(window, "showDirectoryPicker");
});

test("Tutorial 4's full gated walkthrough leaves an active case, uncaptured edits and complete home unchanged", async () => {
  const sample = await designAlternativesSample();
  const caseProject = await createManagedBranch(sample.workspace.root, sample.project.record.containerPath, {
    sourceRevisionId: sample.baseline.manifest.revisionId,
    name: "Existing alternative", reason: "Retain real connected context during tutorial browsing",
  });
  const branchId = caseProject.createdBranchId;
  await caseProject.workingFolders[branchId]!.writeFileText(["Bracket.SLDPRT"], "Uncaptured case edit must survive");
  let pickerCalls = 0;
  Object.assign(window, { showDirectoryPicker: async () => { pickerCalls++; throw Error("Tutorial must not choose folders"); } });
  const ui = render(<App />);
  await openHomeWorkspace(ui, sample.home);
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  await selectBranch(ui, branchId);
  assert.equal(currentBranchId(ui), branchId);
  fireEvent.click(ui.getByRole("button", { name: "cAdtree introduction" }));
  const before = inventorySignature(await readVerifiedInventory(sample.home));
  const trigger = within(ui.getByRole("article", { name: tutorial.title })).getByRole("button", { name: "Start tutorial" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = within(ui.getByRole("dialog", { name: tutorial.title }));
  for (const [index, step] of tutorial.steps.entries()) {
    const stepLabel = `Step ${index + 1} of 6`;
    assert.ok(dialog.getByText(stepLabel));
    assert.ok(dialog.getByRole("heading", { name: step.title, level: 3 }));
    const visuals = step.visuals!;
    const forward = () => dialog.getByRole("button", { name: index === 5 ? "Finish" : "Next" }) as HTMLButtonElement;
    if (visuals.length > 1) {
      assert.equal(forward().disabled, true);
      fireEvent.click(forward());
      assert.ok(dialog.getByText(stepLabel));
      assert.equal((dialog.getByRole("button", { name: "Previous visual" }) as HTMLButtonElement).disabled, true);
      if (index === 1) {
        fireEvent.click(dialog.getByRole("button", { name: "Next visual" }));
        fireEvent.click(dialog.getByRole("button", { name: "Previous visual" }));
        assert.equal(dialog.getByRole("img").getAttribute("src"), visuals[0].src);
        fireEvent.click(dialog.getByRole("button", { name: "Back" }));
        fireEvent.click(dialog.getByRole("button", { name: "Next" }));
        assert.ok(dialog.getByLabelText("Visual 1 of 2"), "changing steps resets the image");
        assert.equal(forward().disabled, false, "reviewed images stay reviewed until Close");
      }
    }
    for (const [v, visual] of visuals.entries()) {
      if (v) fireEvent.click(dialog.getByRole("button", { name: "Next visual" }));
      assert.ok(dialog.getByText(stepLabel), "image arrows do not advance tutorial steps");
      assert.equal(dialog.getAllByRole("img").length, 1);
      assert.equal(dialog.getByRole("img").getAttribute("src"), visual.src);
      assert.equal(dialog.getByRole("img").getAttribute("alt"), visual.alt);
      assert.ok(dialog.getByText(visual.caption));
      assert.ok(dialog.getByText(visual.kind === "concept" ? "Concept" : "cAdtree", { exact: true }));
    }
    if (visuals.length > 1) assert.equal((dialog.getByRole("button", { name: "Next visual" }) as HTMLButtonElement).disabled, true);
    assert.equal(forward().disabled, false);
    fireEvent.click(forward());
  }
  assert.equal(ui.queryByRole("dialog"), null);
  assert.equal(document.activeElement, trigger, "Finish restores opener focus");
  assert.equal(pickerCalls, 0);
  assert.equal(inventorySignature(await readVerifiedInventory(sample.home)), before, "all records, folders and CAD bytes stay identical");
  const after = await resolveManagedProject(sample.workspace.root, sample.project.record.containerPath);
  assert.equal(after.vaultState.branches.length, 2);
  assert.equal(after.vaultState.revisions.length, 3);
  assert.equal(after.vaultState.caseLifecycles?.[branchId]?.status ?? "active", "active");
  assert.ok(within(ui.getByRole("article", { name: "Compare, apply & recover" })).getByRole("button", { name: "Start tutorial" }));
  fireEvent.click(ui.getByRole("button", { name: "My workspaces" }));
  fireEvent.click(ui.getByRole("button", { name: "Open workspace" }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  assert.equal(currentBranchId(ui), branchId, "active case survives tutorial and returning to the project");
});

test("Tutorial 4 supports keyboard carousel controls, Close and a fresh replay; Tutorials 1–3 still open", async () => {
  const ui = render(<App />);
  for (const title of ["Start with cAdtree", "Save your first revision", "Bring existing work into cAdtree"]) {
    fireEvent.click(within(ui.getByRole("article", { name: title })).getByRole("button", { name: "Start tutorial" }));
    const previous = within(ui.getByRole("dialog", { name: title }));
    assert.ok(previous.getByText("Step 1 of 6"));
    fireEvent.click(previous.getByRole("button", { name: "Close" }));
  }
  const trigger = within(ui.getByRole("article", { name: tutorial.title })).getByRole("button", { name: "Start tutorial" });
  const user = userEvent.setup({ document });
  trigger.focus(); await user.keyboard("{Enter}");
  let dialog = within(ui.getByRole("dialog", { name: tutorial.title }));
  fireEvent.click(dialog.getByRole("button", { name: "Next" }));
  dialog.getByRole("button", { name: "Next visual" }).focus(); await user.keyboard("{Enter}");
  assert.ok(dialog.getByLabelText("Visual 2 of 2"));
  fireEvent.click(dialog.getByRole("button", { name: "Close" }));
  assert.equal(ui.queryByRole("dialog"), null);
  assert.equal(document.activeElement, trigger);
  await user.keyboard("{Enter}");
  dialog = within(ui.getByRole("dialog", { name: tutorial.title }));
  assert.ok(dialog.getByText("Step 1 of 6"));
  fireEvent.click(dialog.getByRole("button", { name: "Next" }));
  assert.ok(dialog.getByLabelText("Visual 1 of 2"));
  assert.equal((dialog.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled, true);
});
