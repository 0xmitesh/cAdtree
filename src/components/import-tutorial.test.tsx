import "../../tests/dom";
import { indexedDB } from "fake-indexeddb";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { BRING_EXISTING_WORK_TUTORIAL as tutorial } from "../tutorials/bring-existing-work";
import { InMemoryFileSystemAdapter } from "../engine/fs-adapter";
import { bringWorkspaceIntoHome, createHome } from "../engine/home-service";
import { createWorkspace, importProject } from "../engine/workspace-service";
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

test("Tutorial 3 opens from Learn and its gated carousel cannot import or modify connected work", async () => {
  const root = new InMemoryFileSystemAdapter("Cadtree");
  const sourceWorkspace = new InMemoryFileSystemAdapter("Client A");
  const sourceProject = new InMemoryFileSystemAdapter("Bracket Assembly");
  await createWorkspace(sourceWorkspace, "Client A");
  await sourceProject.writeFileText(["Bracket.SLDPRT"], "Disposable opaque tutorial fixture");
  await createHome(root);
  const { workspace } = await bringWorkspaceIntoHome(root, sourceWorkspace);
  const project = await importProject(workspace.root, sourceProject, "Bracket Assembly");
  let pickerCalls = 0;
  Object.assign(window, { showDirectoryPicker: async () => { pickerCalls++; throw new Error("Tutorial must not pick a folder"); } });
  const ui = render(<App />);
  await openHomeWorkspace(ui, root);
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  fireEvent.click(ui.getByRole("button", { name: "cAdtree introduction" }));
  const inventories = () => Promise.all([root, sourceWorkspace, sourceProject].map(async dir => inventorySignature(await readVerifiedInventory(dir))));
  const before = await inventories();
  const card = within(ui.getByRole("article", { name: tutorial.title }));
  fireEvent.click(card.getByRole("button", { name: "Start tutorial" }));
  const dialog = within(ui.getByRole("dialog", { name: tutorial.title }));

  for (const [index, step] of tutorial.steps.entries()) {
    const stepLabel = `Step ${index + 1} of 6`;
    assert.ok(dialog.getByText(stepLabel));
    assert.ok(dialog.getByRole("heading", { name: step.title, level: 3 }));
    const visuals = step.visuals!;
    const forward = () => dialog.getByRole("button", { name: index === 5 ? "Finish" : "Next" }) as HTMLButtonElement;
    assert.equal(dialog.getAllByRole("img").length, 1);
    assert.equal(dialog.getByRole("img").getAttribute("src"), visuals[0].src);
    if (visuals.length > 1) {
      assert.equal(forward().disabled, true);
      fireEvent.click(forward());
      assert.ok(dialog.getByText(stepLabel), "footer cannot skip unseen visuals");
      assert.equal((dialog.getByRole("button", { name: "Previous visual" }) as HTMLButtonElement).disabled, true);
      if (index === 1) {
        fireEvent.click(dialog.getByRole("button", { name: "Next visual" }));
        fireEvent.click(dialog.getByRole("button", { name: "Previous visual" }));
        assert.equal(dialog.getByRole("img").getAttribute("src"), visuals[0].src);
        fireEvent.click(dialog.getByRole("button", { name: "Next visual" }));
        fireEvent.click(dialog.getByRole("button", { name: "Back" }));
        assert.ok(dialog.getByText("Step 1 of 6"));
        fireEvent.click(dialog.getByRole("button", { name: "Next" }));
        assert.ok(dialog.getByLabelText("Visual 1 of 3"), "step navigation resets the image");
        assert.equal(forward().disabled, true);
      }
    }
    for (const [v, visual] of visuals.entries()) {
      if (v) fireEvent.click(dialog.getByRole("button", { name: "Next visual" }));
      assert.ok(dialog.getByText(stepLabel), "image arrows never advance tutorial steps");
      assert.equal(dialog.getAllByRole("img").length, 1);
      assert.equal(dialog.getByRole("img").getAttribute("src"), visual.src);
      assert.equal(dialog.getByRole("img").getAttribute("alt"), visual.alt);
      assert.ok(dialog.getByText(visual.caption));
      assert.ok(dialog.getByText(visual.kind === "os" ? "Windows" : visual.kind === "concept" ? "Concept" : "cAdtree", { exact: true }));
    }
    if (visuals.length > 1) assert.equal((dialog.getByRole("button", { name: "Next visual" }) as HTMLButtonElement).disabled, true);
    assert.equal(forward().disabled, false);
    fireEvent.click(forward());
  }
  assert.equal(ui.queryByRole("dialog"), null, "Finish closes the viewer");
  assert.equal(pickerCalls, 0);
  assert.deepEqual(await inventories(), before, "managed records, CAD bytes and both source folders stay unchanged");
  assert.equal((await openExistingVault(project.vaultDir)).revisions.length, 0);
  assert.ok(within(ui.getByRole("article", { name: "Compare, apply & recover" })).getByRole("button", { name: "Start tutorial" }));
});

test("Tutorial 3 supports keyboard visual controls, Close and a fresh replay", async () => {
  const ui = render(<App />);
  const trigger = within(ui.getByRole("article", { name: tutorial.title })).getByRole("button", { name: "Start tutorial" });
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
