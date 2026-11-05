import "../../tests/dom";
import { indexedDB } from "fake-indexeddb";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { COMPARE_APPLY_RECOVER_TUTORIAL as tutorial } from "../tutorials/compare-apply-recover";
import { compareApplyRecoverSample } from "../../tests/compare-apply-recover-sample";
import { resolveManagedProject } from "../engine/workspace-service";
import { inventorySignature, readVerifiedInventory } from "../engine/copy-service";
import { clearAllConvenienceMetadata } from "../engine/idb-store";
import { prepareApplyPreview, buildApplyPreview } from "../engine/apply-preview";
import { applicationReview, prepareApplication, applyPreparedApplication } from "../engine/application-service";
import { appBusy, currentBranchId, openHomeWorkspace, selectBranch } from "../../tests/app-controls";

Object.assign(globalThis, { indexedDB });
afterEach(async () => {
  cleanup(); await clearAllConvenienceMetadata();
  Reflect.deleteProperty(window, "showDirectoryPicker");
});

test("The final tutorial never compares, applies, recovers, switches or archives connected work", async () => {
  const s = await compareApplyRecoverSample();
  const project = await resolveManagedProject(s.workspace.root, s.project.record.containerPath);
  const context = prepareApplyPreview(project.vaultState, s.source.manifest.revisionId, "branch-main");
  assert.equal(context.status, "available");
  if (context.status !== "available") throw Error("Sample review unavailable");
  const choices = { "Bracket.SLDPRT": { selected: true, decision: "use-source" as const } };
  const review = applicationReview(buildApplyPreview(context.context, choices, "Retain this pending application during tutorial use"), choices);
  const options = { workingFolders: project.workingFolders };
  await applyPreparedApplication(project.vaultDir, await prepareApplication(project.vaultDir, review, options), options);
  await s.main.writeFileText(["Uncaptured.txt"], "Keep the engineer's later work");
  await s.caseFolder.writeFileText(["Bracket.SLDPRT"], "Keep this uncaptured alternative edit");
  let picks = 0;
  Object.assign(window, { showDirectoryPicker: async () => { picks++; throw Error("Tutorial must not choose folders"); } });
  const ui = render(<App />);
  await openHomeWorkspace(ui, s.home);
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  await selectBranch(ui, s.caseId);
  assert.equal(currentBranchId(ui), s.caseId);
  fireEvent.click(ui.getByRole("link", { name: "cAdtree introduction" }));
  const before = inventorySignature(await readVerifiedInventory(s.home));
  const beforeState = (await resolveManagedProject(s.workspace.root, s.project.record.containerPath)).vaultState;
  const trigger = within(ui.getByRole("article", { name: tutorial.title })).getByRole("button", { name: "Start tutorial" });
  trigger.focus(); fireEvent.click(trigger);
  const dialog = within(ui.getByRole("dialog", { name: tutorial.title }));
  for (const [index, step] of tutorial.steps.entries()) {
    const label = `Step ${index + 1} of 7`;
    assert.ok(dialog.getByText(label));
    assert.ok(dialog.getByRole("heading", { name: step.title, level: 3 }));
    assert.equal(ui.getAllByRole("dialog").length, 1, "only educational viewer opens");
    const visuals = step.visuals!;
    const forward = () => dialog.getByRole("button", { name: index === 6 ? "Finish" : "Next" }) as HTMLButtonElement;
    if (visuals.length > 1) {
      assert.equal(forward().disabled, true);
      fireEvent.click(forward()); assert.ok(dialog.getByText(label));
      assert.equal((dialog.getByRole("button", { name: "Previous visual" }) as HTMLButtonElement).disabled, true);
      if (index === 1) {
        fireEvent.click(dialog.getByRole("button", { name: "Next visual" }));
        fireEvent.click(dialog.getByRole("button", { name: "Previous visual" }));
        assert.equal(dialog.getByRole("img").getAttribute("src"), visuals[0].src);
        fireEvent.click(dialog.getByRole("button", { name: "Back" }));
        fireEvent.click(dialog.getByRole("button", { name: "Next" }));
        assert.ok(dialog.getByLabelText("Visual 1 of 4"));
        assert.equal(forward().disabled, true, "partially reviewed step stays gated");
      }
    }
    for (const [v, visual] of visuals.entries()) {
      if (v) fireEvent.click(dialog.getByRole("button", { name: "Next visual" }));
      assert.ok(dialog.getByText(label));
      assert.equal(dialog.getAllByRole("img").length, 1);
      assert.equal(dialog.getByRole("img").getAttribute("src"), visual.src);
      assert.equal(dialog.getByRole("img").getAttribute("alt"), visual.alt);
      assert.ok(dialog.getByText(visual.caption));
      assert.ok(dialog.getByText(visual.kind === "concept" ? "Concept" : "cAdtree", { exact: true }));
    }
    if (visuals.length > 1) assert.equal((dialog.getByRole("button", { name: "Next visual" }) as HTMLButtonElement).disabled, true);
    if (index === 1) {
      fireEvent.click(dialog.getByRole("button", { name: "Back" }));
      fireEvent.click(dialog.getByRole("button", { name: "Next" }));
      assert.ok(dialog.getByLabelText("Visual 1 of 4"));
      assert.equal(forward().disabled, false, "completed visual review lasts until Close");
    }
    assert.equal(forward().disabled, false); fireEvent.click(forward());
  }
  assert.equal(ui.queryByRole("dialog"), null); assert.equal(document.activeElement, trigger);
  assert.equal(picks, 0);
  assert.equal(inventorySignature(await readVerifiedInventory(s.home)), before, "all working files, directories, records and pending evidence are identical");
  const after = (await resolveManagedProject(s.workspace.root, s.project.record.containerPath)).vaultState;
  assert.equal(after.revisions.length, 6); assert.equal(after.branches.length, 2);
  assert.deepEqual(after.caseLifecycles, beforeState.caseLifecycles);
  assert.deepEqual(after.applicationOperations, beforeState.applicationOperations, "pending application is neither applied, recovered nor abandoned");
  assert.equal(ui.queryAllByText("Coming soon").length, 0);
  assert.equal(ui.getAllByRole("button", { name: "Start tutorial" }).length, 5);
  fireEvent.click(ui.getByRole("button", { name: "My workspaces" }));
  fireEvent.click(ui.getByRole("button", { name: "Open workspace" }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  assert.equal(currentBranchId(ui), s.caseId);
});

test("The final tutorial supports keyboard controls, Close and fresh replay; Tutorials 1–4 still open", async () => {
  const ui = render(<App />);
  for (const title of ["Start with cAdtree", "Save your first revision", "Bring existing work into cAdtree", "Explore design alternatives"]) {
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
  assert.ok(dialog.getByLabelText("Visual 2 of 4"));
  fireEvent.click(dialog.getByRole("button", { name: "Close" }));
  assert.equal(ui.queryByRole("dialog"), null); assert.equal(document.activeElement, trigger);
  await user.keyboard("{Enter}");
  dialog = within(ui.getByRole("dialog", { name: tutorial.title }));
  assert.ok(dialog.getByText("Step 1 of 7"));
  fireEvent.click(dialog.getByRole("button", { name: "Next" }));
  assert.ok(dialog.getByLabelText("Visual 1 of 4"));
  assert.equal((dialog.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled, true);
});
