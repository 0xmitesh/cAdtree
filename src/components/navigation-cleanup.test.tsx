import "../../tests/dom";
import { indexedDB } from "fake-indexeddb";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import App from "../App";
import { ReferencesView } from "./ReferencesView";
import { compareApplyRecoverSample } from "../../tests/compare-apply-recover-sample";
import { nativeDirectory } from "../../tests/native-fs";
import { DEFAULT_TEST_USER } from "../../tests/test-auth";
import { appBusy, currentBranchId, openHomeWorkspace } from "../../tests/app-controls";
import { clearAllConvenienceMetadata, getWorkspacePath, saveWorkspacePath } from "../engine/idb-store";
import { InMemoryFileSystemAdapter } from "../engine/fs-adapter";
import { inventorySignature, readVerifiedInventory } from "../engine/copy-service";
import { importReferenceAttachment, retrieveReferenceAttachment, updateProjectReference } from "../engine/references";
import { openExistingVault } from "../engine/vault-service";

Object.assign(globalThis, { indexedDB });
afterEach(async () => { cleanup(); await clearAllConvenienceMetadata(); Reflect.deleteProperty(window, "showDirectoryPicker"); });
const signature = async (dir: InMemoryFileSystemAdapter) => inventorySignature(await readVerifiedInventory(dir));
async function openSample() {
  const sample = await compareApplyRecoverSample(), ui = render(<App />);
  await openHomeWorkspace(ui, sample.home);
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  return { sample, ui, nav: within(ui.getByRole("navigation", { name: "Primary navigation" })) };
}

test("Troubleshooting's reset explains its browser-wide scope, cancels without changes and resets connections without deleting CAD history", async () => {
  const { sample, ui, nav } = await openSample();
  const other = nativeDirectory(new InMemoryFileSystemAdapter("Other workspace"));
  const foreignPath = () => getWorkspacePath("foreign-workspace", other);
  await saveWorkspacePath("foreign-workspace", "D:\\Other", other);
  assert.equal(await foreignPath(), "D:\\Other");
  const before = await signature(sample.home);
  fireEvent.click(nav.getByRole("button", { name: "Settings" }));
  fireEvent.click(within(ui.container.querySelector<HTMLElement>(".settings-page")!).getByText("Troubleshooting", { selector: "summary" }));
  fireEvent.click(ui.getByText("Reset folder connections"));
  const reset = ui.getByRole("button", { name: "Reset all remembered folder connections in this browser" });
  assert.equal(reset.closest("details")!.querySelector("summary")!.textContent, "Reset folder connections");
  fireEvent.click(reset);
  let dialog = within(ui.getByRole("dialog", { name: "Reset all remembered folder connections?" }));
  assert.match(ui.getByRole("dialog").textContent!, /across all workspaces/);
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
  // Focus moves in a later effect than the one that removes the archived controls, so wait for it. Compare with `===` inside
  // `assert.ok`: a failed `assert.equal` on two jsdom elements spends ~15 s inspecting the DOM and reports only "test failed".
  await waitFor(() => assert.ok(document.activeElement === ui.getByRole("button", { name: "Archive case Lightweight bracket" }), "focus returns to the Archive case button"));
  assert.equal(inventorySignature(await readVerifiedInventory(sample.main)), beforeMain);
  assert.equal(inventorySignature(await readVerifiedInventory(sample.caseFolder)), beforeCase);
});

test("Reference browsing keeps every stored version downloadable without editing controls", async () => {
  const sample = await compareApplyRecoverSample();
  let state = await openExistingVault(sample.project.vaultDir), retrieved: Uint8Array | undefined;
  const metadata = { title: "Requirements", description: "Customer requirements", tags: [] };
  const props = () => ({ state, busy: false, progress: null, onCancel() {},
    onRetrieve: async (id: string, version: string) => { retrieved = (await retrieveReferenceAttachment(sample.project.vaultDir, state.project.projectId, id, version)).bytes; },
  });
  const ui = render(<ReferencesView {...props()} />);
  assert.equal(ui.queryByRole("button", { name: "Import reference" }), null);
  assert.ok(ui.getByRole("searchbox", { name: "Search references" }));
  assert.equal(ui.queryAllByRole("combobox").length, 0);
  assert.ok(ui.getByText(/No references yet/));
  state = await importReferenceAttachment(sample.project.vaultDir, state.project.projectId, new File(["One"], "Requirements.txt"), metadata);
  const reference = state.references!.library[0];
  state = await importReferenceAttachment(sample.project.vaultDir, state.project.projectId, new File(["Two"], "Updated.txt"), metadata, reference.referenceId);
  state = await updateProjectReference(sample.project.vaultDir, state.project.projectId, reference.referenceId, { removed: true });
  ui.rerender(<ReferencesView {...props()} />);
  const search = ui.getByRole("searchbox", { name: "Search references" });
  fireEvent.change(search, { target: { value: "Unmatched search" } });
  assert.ok(ui.getByText(/No matching references/));
  fireEvent.change(search, { target: { value: "" } });
  assert.equal(ui.container.querySelectorAll('.reference-card').length, 2);
  assert.equal(ui.queryByText("Technical details"), null);
  assert.equal(ui.queryByRole("button", { name: "Remove from current context" }), null);
  fireEvent.click(ui.getByRole("button", { name: "Download Requirements (Updated.txt)" }));
  await waitFor(() => assert.deepEqual(retrieved, new TextEncoder().encode("Two")));
  fireEvent.change(search, { target: { value: "Requirements.txt" } });
  fireEvent.click(ui.getByRole("button", { name: "Download Requirements (Requirements.txt)" }));
  await waitFor(() => assert.deepEqual(retrieved, new TextEncoder().encode("One")));
});

const banner = (ui: ReturnType<typeof render>) => ui.container.querySelector(".app-status-feedback");
// The open project page: the primary navigation button marked as current.
const page = (nav: ReturnType<typeof within>) => nav.getAllByRole("button").find((b: HTMLElement) => b.getAttribute("aria-current") === "page")?.getAttribute("aria-label");
async function scanBanner(ui: ReturnType<typeof render>, nav: ReturnType<typeof within>) {
  fireEvent.click(nav.getByRole("button", { name: "Changes" }));
  fireEvent.click(ui.getByRole("button", { name: "Scan for changes" }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  await waitFor(() => assert.ok(banner(ui), "the scan outcome is shown on the page that raised it"));
}
async function traverse(direction: "back" | "forward") {
  await act(async () => { window.history[direction](); await new Promise((resolve) => setTimeout(resolve, 30)); });
}

test("A status banner stays on the page that raised it: another tab, Back/Forward and leaving the project clear it", async () => {
  const { ui, nav } = await openSample();
  await scanBanner(ui, nav);
  fireEvent.click(nav.getByRole("button", { name: "References" }));
  assert.equal(banner(ui), null, "the Changes notice does not follow the user to References");
  fireEvent.click(nav.getByRole("button", { name: "Changes" }));
  assert.equal(banner(ui), null, "and does not come back when the user returns");
  // Same tab again: the notice stays until the user leaves.
  fireEvent.click(ui.getByRole("button", { name: "Scan for changes" }));
  await waitFor(() => assert.ok(banner(ui)));
  fireEvent.click(nav.getByRole("button", { name: "Changes" }));
  assert.ok(banner(ui), "re-selecting the current page keeps its notice");
  // Back and Forward leave the page as well.
  await traverse("back");
  assert.equal(banner(ui), null);
  await traverse("forward");
  assert.equal(banner(ui), null);
  // Leaving the project clears it too.
  fireEvent.click(ui.getByRole("button", { name: "Scan for changes" }));
  await waitFor(() => assert.ok(banner(ui)));
  fireEvent.click(nav.getByRole("button", { name: "My workspaces" }));
  assert.equal(banner(ui), null);
});

test("Switching case in the Explorer keeps the current page; Back and Forward still work across the switch", async () => {
  const { sample, ui, nav } = await openSample();
  const tree = within(ui.getByRole("tree", { name: "Workspace explorer" }));
  const caseItem = () => tree.getByRole("treeitem", { name: /^Lightweight bracket, Bracket Assembly/ });
  fireEvent.click(nav.getByRole("button", { name: "References" }));
  assert.equal(page(nav), "References");
  fireEvent.click(caseItem());
  await waitFor(() => assert.equal(appBusy(ui), false));
  assert.equal(currentBranchId(ui), sample.caseId);
  assert.equal(page(nav), "References", "References stays open");
  fireEvent.click(nav.getByRole("button", { name: "Changes" }));
  fireEvent.click(tree.getByRole("treeitem", { name: /^Main, Bracket Assembly/ }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  assert.equal(currentBranchId(ui), "branch-main");
  assert.equal(page(nav), "Changes", "Changes stays open");
  fireEvent.click(caseItem());
  await waitFor(() => assert.equal(appBusy(ui), false));
  assert.equal(page(nav), "Changes");
  fireEvent.click(nav.getByRole("button", { name: "Settings" }));
  fireEvent.click(tree.getByRole("treeitem", { name: /^Main, Bracket Assembly/ }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  assert.equal(page(nav), "Settings");
  // Back and Forward walk the pages visited, whichever case is current.
  await traverse("back");
  assert.equal(page(nav), "Changes");
  await traverse("back");
  assert.equal(page(nav), "References");
  await traverse("forward");
  assert.equal(page(nav), "Changes");
  assert.equal(currentBranchId(ui), "branch-main");
});
