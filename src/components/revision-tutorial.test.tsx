import "../../tests/dom";
import { indexedDB } from "fake-indexeddb";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { SAVE_FIRST_REVISION_TUTORIAL as tutorial } from "../tutorials/save-first-revision";
import { InMemoryFileSystemAdapter } from "../engine/fs-adapter";
import { createHome, createHomeWorkspace } from "../engine/home-service";
import { createProject } from "../engine/workspace-service";
import { openExistingVault } from "../engine/vault-service";
import { inventorySignature, readVerifiedInventory } from "../engine/copy-service";
import { clearAllConvenienceMetadata } from "../engine/idb-store";
import { appBusy, openHomeWorkspace } from "../../tests/app-controls";

Object.assign(globalThis, { indexedDB });
afterEach(async () => {
  cleanup();
  await clearAllConvenienceMetadata();
  Reflect.deleteProperty(window, "showDirectoryPicker");
});

test("Tutorial 2 uses the shared gated carousel without changing the connected project", async () => {
  const root = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(root);
  const { workspace } = await createHomeWorkspace(root, "Tutorial Workspace");
  const project = await createProject(workspace.root, "Bracket Assembly");
  const main = project.workingFolders["branch-main"]!;
  await main.writeFileText(["Bracket.SLDPRT"], "Disposable tutorial test fixture");
  let pickerCalls = 0;
  Object.assign(window, { showDirectoryPicker: async () => { pickerCalls++; throw new Error("Tutorial must not pick a folder"); } });
  const ui = render(<App />);
  await openHomeWorkspace(ui, root);
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  fireEvent.click(ui.getByRole("link", { name: "cAdtree introduction" }));
  const before = inventorySignature(await readVerifiedInventory(root));
  const card = within(ui.getByRole("article", { name: "Save your first revision" }));
  fireEvent.click(card.getByRole("button", { name: "Start tutorial" }));
  const dialog = within(ui.getByRole("dialog", { name: tutorial.title }));
  const next = () => fireEvent.click(dialog.getByRole("button", { name: "Next" }));

  for (const [index, step] of tutorial.steps.entries()) {
    assert.ok(dialog.getByText(`Step ${index + 1} of 6`));
    assert.ok(dialog.getByRole("heading", { name: step.title, level: 3 }));
    assert.equal(dialog.getAllByRole("img").length, 1);
    assert.equal(dialog.getByRole("img").getAttribute("src"), step.visuals![0].src);
    const last = index === tutorial.steps.length - 1;
    const forward = dialog.getByRole("button", { name: last ? "Finish" : "Next" }) as HTMLButtonElement;
    if (step.visuals!.length > 1) {
      assert.equal(forward.disabled, true);
      fireEvent.click(forward);
      assert.ok(dialog.getByText(`Step ${index + 1} of 6`), "footer cannot skip unseen images");
      assert.equal((dialog.getByRole("button", { name: "Previous visual" }) as HTMLButtonElement).disabled, true);
      // Go back before completing the three-image step; re-entry must reset the image.
      if (index === 1) {
        fireEvent.click(dialog.getByRole("button", { name: "Next visual" }));
        fireEvent.click(dialog.getByRole("button", { name: "Back" }));
        next();
        assert.ok(dialog.getByLabelText("Visual 1 of 3"));
        assert.equal(forward.disabled, true);
      }
      for (let v = 1; v < step.visuals!.length; v++) {
        fireEvent.click(dialog.getByRole("button", { name: "Next visual" }));
        assert.ok(dialog.getByText(`Step ${index + 1} of 6`), "image navigation stays in the step");
        assert.equal(dialog.getAllByRole("img").length, 1);
        assert.equal(dialog.getByRole("img").getAttribute("src"), step.visuals![v].src);
        assert.ok(dialog.getByText(step.visuals![v].caption));
        assert.ok(dialog.getByText(step.visuals![v].kind === "os" ? "Windows" : "cAdtree", { exact: true }));
      }
      assert.equal((dialog.getByRole("button", { name: "Next visual" }) as HTMLButtonElement).disabled, true);
    } else assert.ok(dialog.getByText("Concept", { exact: true }));
    assert.equal(forward.disabled, false);
    fireEvent.click(forward);
  }
  assert.equal(ui.queryByRole("dialog"), null, "Finish closes the viewer");
  assert.equal(pickerCalls, 0);
  assert.equal(inventorySignature(await readVerifiedInventory(root)), before, "all project and working bytes remain unchanged");
  assert.equal((await openExistingVault(project.vaultDir)).revisions.length, 0, "the tutorial creates no revision");
  assert.equal(ui.queryAllByText("Coming soon").length, 0);
});

test("Tutorial 2 closes and reopens at its first step using keyboard controls", async () => {
  const ui = render(<App />);
  const card = within(ui.getByRole("article", { name: "Save your first revision" }));
  const trigger = card.getByRole("button", { name: "Start tutorial" });
  const user = userEvent.setup({ document });
  trigger.focus();
  await user.keyboard("{Enter}");
  let dialog = within(ui.getByRole("dialog", { name: tutorial.title }));
  fireEvent.click(dialog.getByRole("button", { name: "Next" }));
  dialog.getByRole("button", { name: "Next visual" }).focus();
  await user.keyboard("{Enter}");
  assert.ok(dialog.getByLabelText("Visual 2 of 3"));
  fireEvent.click(dialog.getByRole("button", { name: "Close" }));
  assert.equal(ui.queryByRole("dialog"), null);
  assert.equal(document.activeElement, trigger);
  await user.keyboard("{Enter}");
  dialog = within(ui.getByRole("dialog", { name: tutorial.title }));
  assert.ok(dialog.getByText("Step 1 of 6"));
  fireEvent.click(dialog.getByRole("button", { name: "Next" }));
  assert.ok(dialog.getByLabelText("Visual 1 of 3"));
  assert.equal((dialog.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled, true);
});
