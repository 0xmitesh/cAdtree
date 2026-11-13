import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { render, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import App from "../App";
import { compareApplyRecoverSample } from "../../tests/compare-apply-recover-sample";
import { appBusy, currentBranchId, openHomeWorkspace } from "../../tests/app-controls";
import type { FileSystemDirectoryAdapter } from "../engine/fs-adapter";
import { copyVerifiedTree } from "../engine/copy-service";
import { openWorkspace } from "../engine/workspace-service";
import { clearAllConvenienceMetadata } from "../engine/idb-store";

Object.assign(globalThis, { indexedDB });
afterEach(async () => {
  cleanup();
  await clearAllConvenienceMetadata();
});

const OLD = "projects/Bracket Assembly";
const NEW = "projects/Bracket Assembly (renamed in Explorer)";
const NEW_LEAF = "Bracket Assembly (renamed in Explorer)";
const RENAMED = `This project's folder was renamed to '${NEW_LEAF}'. cAdtree found it by its project ID.`;
const idle = (ui: ReturnType<typeof render>) => waitFor(() => assert.equal(appBusy(ui), false));

async function renameFolder(root: FileSystemDirectoryAdapter, from: string, to: string) {
  await copyVerifiedTree(await root.getDirectory(from.split("/")), await root.getDirectory(to.split("/"), { create: true }));
  await root.removeEntry(from.split("/"), { recursive: true });
}
async function copyFolder(root: FileSystemDirectoryAdapter, from: string, to: string) {
  await copyVerifiedTree(await root.getDirectory(from.split("/")), await root.getDirectory(to.split("/"), { create: true }));
}
async function setup() {
  const sample = await compareApplyRecoverSample();
  const ui = render(<App />);
  await openHomeWorkspace(ui, sample.home);
  fireEvent.click(
    within(ui.getByRole("heading", { name: "Bracket Assembly", level: 3 }).closest(".workspace-project") as HTMLElement)
      .getByRole("button", { name: "Open project" }),
  );
  await idle(ui);
  return { sample, ui };
}
const nav = (ui: ReturnType<typeof render>, name: string) =>
  fireEvent.click(within(ui.getByRole("navigation", { name: "Primary navigation" })).getByRole("button", { name }));
/** The workspace page with the project still open (Explorer workspace row). */
const toWorkspacePage = (ui: ReturnType<typeof render>) =>
  fireEvent.click(within(ui.getByRole("tree", { name: "Workspace explorer" })).getByRole("treeitem", { name: /^Tutorial Workspace/ }));
const refresh = async (ui: ReturnType<typeof render>) => {
  fireEvent.click(ui.getByRole("button", { name: "Refresh workspace" }));
  await idle(ui);
};
const revisionCount = async (root: FileSystemDirectoryAdapter, path: string) =>
  (await openWorkspace(root)).projects.find((p) => p.containerPath === path)!.project!.vaultState.revisions.length;
const exists = async (root: FileSystemDirectoryAdapter, path: string) =>
  root.getDirectory(path.split("/")).then(() => true, () => false);
async function scanAndDraft(ui: ReturnType<typeof render>, summary: string) {
  nav(ui, "Changes");
  fireEvent.click(ui.getByRole("button", { name: "Scan for changes" }));
  await idle(ui);
  fireEvent.change(ui.getByRole("textbox", { name: /Revision summary/ }), { target: { value: summary } });
}

test("Refresh after the open project's folder is renamed: notice, still open, new location in use, case kept", async () => {
  const { sample, ui } = await setup();
  const before = await revisionCount(sample.workspace.root, OLD);
  await renameFolder(sample.workspace.root, OLD, NEW);
  toWorkspacePage(ui);
  await refresh(ui);
  assert.ok(ui.getByText(RENAMED));
  assert.ok(ui.container.querySelector(".project-context-header"));
  assert.match(ui.container.querySelector(".project-context-header")!.textContent!, /Bracket Assembly/);
  assert.equal(currentBranchId(ui), "branch-main");
  const moved = await sample.workspace.root.getDirectory([...NEW.split("/"), "working", "main"]);
  await moved.writeFileText(["After-rename.txt"], "new file");
  nav(ui, "Changes");
  fireEvent.click(ui.getByRole("button", { name: "Scan for changes" }));
  await idle(ui);
  assert.ok(ui.getByText("After-rename.txt"));
  assert.equal(await revisionCount(sample.workspace.root, NEW), before);
});

test("Scan after a rename re-finds the project by ID, reports it and scans the new location", async () => {
  const { sample, ui } = await setup();
  await renameFolder(sample.workspace.root, OLD, NEW);
  const moved = await sample.workspace.root.getDirectory([...NEW.split("/"), "working", "main"]);
  await moved.writeFileText(["After-rename.txt"], "new file");
  nav(ui, "Changes");
  fireEvent.click(ui.getByRole("button", { name: "Scan for changes" }));
  await idle(ui);
  assert.ok(ui.getByText(new RegExp(RENAMED.replace(/[()']/g, "\\$&"))));
  assert.ok(ui.getByText("After-rename.txt"));
});

test("Saving after a rename writes nothing to the old path, shows the notice, and a retry succeeds at the new path", async () => {
  const { sample, ui } = await setup();
  const root = sample.workspace.root;
  const before = await revisionCount(root, OLD);
  await sample.main.writeFileText(["Pending.txt"], "work in progress");
  await scanAndDraft(ui, "Saved after rename");
  await renameFolder(root, OLD, NEW);
  fireEvent.click(ui.getByRole("button", { name: "Save revision" }));
  await idle(ui);
  assert.ok(ui.getAllByText(new RegExp(RENAMED.replace(/[()']/g, "\\$&"))).length >= 1);
  assert.equal(await exists(root, OLD), false, "nothing was recreated at the old path");
  assert.equal(await revisionCount(root, NEW), before, "nothing was saved");
  // Retry: the draft is kept, rescan, then save at the new location.
  fireEvent.click(ui.getByRole("button", { name: "Scan for changes" }));
  await idle(ui);
  assert.equal((ui.getByRole("textbox", { name: /Revision summary/ }) as HTMLInputElement).value, "Saved after rename");
  fireEvent.click(ui.getByRole("button", { name: "Save revision" }));
  await idle(ui);
  assert.equal(await revisionCount(root, NEW), before + 1);
  assert.equal(await exists(root, OLD), false);
});

test("A copy made while the project is open: saving is refused with the duplicate wording, nothing is written, Refresh shows read-only", async () => {
  const { sample, ui } = await setup();
  const root = sample.workspace.root;
  const before = await revisionCount(root, OLD);
  await sample.main.writeFileText(["Pending.txt"], "work in progress");
  await scanAndDraft(ui, "Should not be saved");
  await copyFolder(root, OLD, NEW);
  fireEvent.click(ui.getByRole("button", { name: "Save revision" }));
  await idle(ui);
  assert.ok(ui.getAllByText(/every copy stays read-only/).length >= 1);
  const projects = (await openWorkspace(root)).projects.filter((p) => p.name === "Bracket Assembly");
  assert.equal(projects.length, 2);
  for (const project of projects) assert.equal(project.project!.vaultState.revisions.length, before, "no copy was written");
  toWorkspacePage(ui);
  await refresh(ui);
  nav(ui, "Changes");
  assert.match(ui.container.textContent!, /Managed project is read-only\. This project's ID exists at more than one location/);
  assert.ok(ui.container.querySelector(".project-context-header"));
});

test("The open project's folder is removed from the workspace: Refresh reports it can't be found, read-only", async () => {
  const { sample, ui } = await setup();
  const root = sample.workspace.root;
  await root.removeEntry(OLD.split("/"), { recursive: true });
  toWorkspacePage(ui);
  await refresh(ui);
  nav(ui, "Changes");
  assert.match(ui.container.textContent!, /Managed project is read-only\. This project's folder can't be found in the workspace any more\./);
  await sample.main.writeFileText(["Late.txt"], "x").catch(() => {});
  fireEvent.click(ui.getByRole("button", { name: "Scan for changes" }));
  await idle(ui);
  assert.equal(await exists(root, OLD), false, "nothing was recreated");
});

test("Unchanged path: Refresh and a scan show no rename notice", async () => {
  const { sample, ui } = await setup();
  toWorkspacePage(ui);
  await refresh(ui);
  assert.equal(ui.queryByText(/was renamed to/), null);
  await sample.main.writeFileText(["Plain.txt"], "x");
  nav(ui, "Changes");
  fireEvent.click(ui.getByRole("button", { name: "Scan for changes" }));
  await idle(ui);
  assert.ok(ui.getByText("Plain.txt"));
  assert.equal(ui.queryByText(/was renamed to/), null);
  assert.equal(ui.container.textContent!.includes("read-only. This project"), false);
});
