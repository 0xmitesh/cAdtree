import "../../tests/dom";
import { indexedDB } from "fake-indexeddb";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import App from "../App";
import { ReferencesView } from "./ReferencesView";
import { compareApplyRecoverSample } from "../../tests/compare-apply-recover-sample";
import { nativeDirectory } from "../../tests/native-fs";
import { DEFAULT_TEST_USER } from "../../tests/test-auth";
import { appBusy, openHomeWorkspace } from "../../tests/app-controls";
import { clearAllConvenienceMetadata, getWorkspacePath, saveWorkspacePath, setConvenienceAccountScope } from "../engine/idb-store";
import { InMemoryFileSystemAdapter } from "../engine/fs-adapter";
import { inventorySignature, readVerifiedInventory } from "../engine/copy-service";
import { importReferenceAttachment, retrieveReferenceAttachment, updateProjectReference } from "../engine/references";
import { openExistingVault } from "../engine/vault-service";

Object.assign(globalThis, { indexedDB });
afterEach(async () => { cleanup(); await clearAllConvenienceMetadata(); setConvenienceAccountScope(DEFAULT_TEST_USER.uid); Reflect.deleteProperty(window, "showDirectoryPicker"); });
const signature = async (dir: InMemoryFileSystemAdapter) => inventorySignature(await readVerifiedInventory(dir));
async function openSample() {
  const sample = await compareApplyRecoverSample(), ui = render(<App />);
  await openHomeWorkspace(ui, sample.home);
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  return { sample, ui, nav: within(ui.getByRole("navigation", { name: "Primary navigation" })) };
}

test("Browser troubleshooting explains its cross-account scope, cancels without changes and resets connections without deleting CAD history", async () => {
  const { sample, ui, nav } = await openSample();
  const other = nativeDirectory(new InMemoryFileSystemAdapter("Other workspace"));
  async function foreignPath() {
    setConvenienceAccountScope("another-account");
    try { return await getWorkspacePath("foreign-workspace", other); }
    finally { setConvenienceAccountScope(DEFAULT_TEST_USER.uid); }
  }
  setConvenienceAccountScope("another-account");
  await saveWorkspacePath("foreign-workspace", "D:\\Other", other);
  setConvenienceAccountScope(DEFAULT_TEST_USER.uid);
  assert.equal(await foreignPath(), "D:\\Other");
  const before = await signature(sample.home);
  fireEvent.click(nav.getByRole("button", { name: "Settings" }));
  fireEvent.click(ui.getByText("Browser troubleshooting"));
  const reset = ui.getByRole("button", { name: "Reset all remembered folder connections in this browser" });
  assert.equal(reset.closest("details")!.querySelector("summary")!.textContent, "Browser troubleshooting");
  fireEvent.click(reset);
  let dialog = within(ui.getByRole("dialog", { name: "Reset all remembered folder connections?" }));
  assert.match(ui.getByRole("dialog").textContent!, /across all accounts and workspaces/);
  assert.match(ui.getByRole("dialog").textContent!, /does not delete CAD files/);
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  assert.equal(await foreignPath(), "D:\\Other");
  assert.equal(await signature(sample.home), before);
  fireEvent.click(reset);
  dialog = within(ui.getByRole("dialog", { name: "Reset all remembered folder connections?" }));
  fireEvent.click(dialog.getByRole("button", { name: "Reset all remembered folder connections" }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  await waitFor(() => assert.ok(ui.getByRole("heading", { name: "History." })));
  assert.equal(await foreignPath(), "");
  assert.equal(await signature(sample.home), before);
  assert.ok(ui.getByText(DEFAULT_TEST_USER.displayName!));
});

test("Archive controls appear only when needed and disappear after reopening the last archived case", async () => {
  const { sample, ui } = await openSample();
  const beforeMain = inventorySignature(await readVerifiedInventory(sample.main));
  const beforeCase = inventorySignature(await readVerifiedInventory(sample.caseFolder));
  assert.equal(ui.queryByRole("checkbox", { name: "Show archived cases" }), null);
  fireEvent.click(ui.container.querySelector(".history-design-cases > summary")!);
  assert.ok(ui.getByText("No archived cases."));
  assert.equal(ui.queryByText("Archived cases (0)"), null);
  fireEvent.click(ui.getByRole("button", { name: "Archive case Lightweight bracket" }));
  fireEvent.click(within(ui.getByRole("dialog", { name: "Archive design case" })).getByRole("button", { name: "Archive case" }));
  await waitFor(() => assert.ok(ui.getByRole("checkbox", { name: "Show archived cases" })));
  fireEvent.click(ui.getByText("Archived cases (1)"));
  fireEvent.click(ui.getByRole("button", { name: "Reopen case Lightweight bracket" }));
  fireEvent.click(within(ui.getByRole("dialog", { name: "Reopen design case" })).getByRole("button", { name: "Reopen case" }));
  await waitFor(() => assert.ok(ui.queryByRole("checkbox", { name: "Show archived cases" }) === null));
  assert.ok(ui.getByText("No archived cases."));
  assert.equal(document.activeElement, ui.getByRole("button", { name: "Archive case Lightweight bracket" }));
  assert.equal(inventorySignature(await readVerifiedInventory(sample.main)), beforeMain);
  assert.equal(inventorySignature(await readVerifiedInventory(sample.caseFolder)), beforeCase);
});

test("Reference filters follow available records and technical details preserve exact selected-version retrieval", async () => {
  const sample = await compareApplyRecoverSample();
  let state = await openExistingVault(sample.project.vaultDir), retrieved: Uint8Array | undefined;
  const metadata = { title: "Requirements", description: "Customer requirements", tags: [] };
  const props = () => ({ state, busy: false, progress: null, onCancel() {}, onImport: async () => {},
    onUpdate: async (id: string, changes: { removed?: boolean; projectVersionId?: string | null }) => {
      state = await updateProjectReference(sample.project.vaultDir, state.project.projectId, id, changes);
      ui.rerender(<ReferencesView {...props()} />);
    },
    onRetrieve: async (id: string, version: string) => { retrieved = (await retrieveReferenceAttachment(sample.project.vaultDir, state.project.projectId, id, version)).bytes; },
  });
  const ui = render(<ReferencesView {...props()} />);
  assert.ok(ui.getByRole("button", { name: "Import reference" }));
  assert.equal(ui.queryByRole("textbox", { name: "Search references" }), null);
  assert.equal(ui.queryByRole("checkbox", { name: "Show removed references" }), null);
  assert.ok(ui.getByText(/No references yet/));
  state = await importReferenceAttachment(sample.project.vaultDir, state.project.projectId, new File(["One"], "Requirements.txt"), metadata);
  const reference = state.references!.library[0];
  state = await importReferenceAttachment(sample.project.vaultDir, state.project.projectId, new File(["Two"], "Updated.txt"), metadata, reference.referenceId);
  ui.rerender(<ReferencesView {...props()} />);
  const search = ui.getByRole("textbox", { name: "Search references" });
  assert.equal(ui.queryByRole("checkbox", { name: "Show removed references" }), null);
  fireEvent.change(search, { target: { value: "Unmatched search" } });
  assert.ok(ui.getByText(/No matching references/));
  assert.equal(ui.getByRole("textbox", { name: "Search references" }), search);
  fireEvent.change(search, { target: { value: "" } });
  const technical = ui.container.querySelector<HTMLDetailsElement>(".reference-technical-details")!;
  assert.equal(technical.open, false);
  fireEvent.click(within(technical).getByText("Technical details"));
  assert.equal(technical.open, true);
  assert.ok(technical.textContent!.includes(reference.referenceId));
  assert.ok(technical.textContent!.includes(state.references!.library[0].versions[1].sha256));
  fireEvent.click(ui.getByRole("button", { name: "Retrieve exact attachment" }));
  await waitFor(() => assert.deepEqual(retrieved, new TextEncoder().encode("Two")));
  fireEvent.click(ui.getByRole("button", { name: "Remove from current context" }));
  await waitFor(() => assert.ok(ui.getByRole("checkbox", { name: "Show removed references" })));
  assert.equal(ui.getByRole("textbox", { name: "Search references" }), search);
  fireEvent.click(ui.getByRole("checkbox", { name: "Show removed references" }));
  fireEvent.click(ui.getByRole("button", { name: "Restore to library" }));
  await waitFor(() => assert.ok(ui.queryByRole("checkbox", { name: "Show removed references" }) === null));
  assert.equal(state.references!.library[0].versions.length, 2);
});
