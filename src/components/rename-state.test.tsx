import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { act, render, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import App from "../App";
import { compareApplyRecoverSample } from "../../tests/compare-apply-recover-sample";
import { appBusy, currentBranchId, openHomeWorkspace, selectBranch } from "../../tests/app-controls";
import type { FileSystemDirectoryAdapter } from "../engine/fs-adapter";
import { copyVerifiedTree } from "../engine/copy-service";
import { createProject } from "../engine/workspace-service";
import { clearAllConvenienceMetadata } from "../engine/idb-store";

Object.assign(globalThis, { indexedDB });
afterEach(async () => {
  cleanup();
  await clearAllConvenienceMetadata();
});

const OLD = "projects/Bracket Assembly";
const NEW = "projects/Bracket Assembly (renamed in Explorer)";
const traverse = async (direction: "back" | "forward") =>
  act(async () => {
    window.history[direction]();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
const idle = (ui: ReturnType<typeof render>) => waitFor(() => assert.equal(appBusy(ui), false));
const projectOpen = (ui: ReturnType<typeof render>) =>
  Boolean(ui.container.querySelector(".project-context-header"));

/** A rename in Explorer or Finder, as the in-memory adapter sees it: same bytes at a new location. */
async function renameFolder(root: FileSystemDirectoryAdapter, from: string, to: string) {
  await copyVerifiedTree(
    await root.getDirectory(from.split("/")),
    await root.getDirectory(to.split("/"), { create: true }),
  );
  await root.removeEntry(from.split("/"), { recursive: true });
}
async function copyFolder(root: FileSystemDirectoryAdapter, from: string, to: string) {
  await copyVerifiedTree(
    await root.getDirectory(from.split("/")),
    await root.getDirectory(to.split("/"), { create: true }),
  );
}
async function openBracket(ui: ReturnType<typeof render>) {
  fireEvent.click(
    within(ui.getByRole("heading", { name: "Bracket Assembly", level: 3 }).closest(".workspace-project") as HTMLElement)
      .getByRole("button", { name: "Open project" }),
  );
  await idle(ui);
}
async function reopenWorkspace(ui: ReturnType<typeof render>) {
  fireEvent.click(within(ui.getByRole("navigation", { name: "Primary navigation" })).getByRole("button", { name: "My workspaces" }));
  fireEvent.click(ui.getByRole("button", { name: "Open workspace" }));
  await idle(ui);
}
async function setup() {
  const sample = await compareApplyRecoverSample();
  await createProject(sample.workspace.root, "Z alternate");
  const ui = render(<App />);
  await openHomeWorkspace(ui, sample.home);
  await openBracket(ui);
  return { sample, ui, nav: within(ui.getByRole("navigation", { name: "Primary navigation" })) };
}
async function openOther(ui: ReturnType<typeof render>) {
  await reopenWorkspace(ui);
  fireEvent.click(
    within(ui.getByRole("heading", { name: "Z alternate", level: 3 }).closest(".workspace-project") as HTMLElement)
      .getByRole("button", { name: "Open project" }),
  );
  await idle(ui);
}

test("Capture draft and last-used case survive renaming the project folder", async () => {
  const { sample, ui, nav } = await setup();
  await sample.caseFolder.writeFileText(["Bracket.SLDPRT"], "Pending experiment");
  await selectBranch(ui, sample.caseId);
  await idle(ui);
  fireEvent.click(nav.getByRole("button", { name: "Changes" }));
  fireEvent.click(ui.getByRole("button", { name: "Scan for changes" }));
  await idle(ui);
  fireEvent.change(ui.getByRole("textbox", { name: /Revision summary/ }), { target: { value: "Draft kept across rename" } });
  // Leave for another project, then rename the first one on disk.
  await openOther(ui);
  await renameFolder(sample.workspace.root, OLD, NEW);
  await reopenWorkspace(ui);
  await openBracket(ui);
  assert.equal(currentBranchId(ui), sample.caseId, "reopens on the case last used, not Main");
  fireEvent.click(within(ui.getByRole("navigation", { name: "Primary navigation" })).getByRole("button", { name: "Changes" }));
  await waitFor(() =>
    assert.equal((ui.getByRole("textbox", { name: /Revision summary/ }) as HTMLInputElement).value, "Draft kept across rename"),
  );
});

test("Back reopens a renamed project by ID, at its new folder", async () => {
  const { sample, ui, nav } = await setup();
  fireEvent.click(nav.getByRole("button", { name: "References" }));
  await openOther(ui);
  await renameFolder(sample.workspace.root, OLD, NEW);
  await reopenWorkspace(ui);
  assert.equal(ui.queryByRole("heading", { name: "References." }), null);
  // The entry still recorded for Bracket Assembly (References) predates the rename.
  for (let i = 0; i < 8 && !ui.queryByRole("heading", { name: "References." }); i++) {
    await traverse("back");
    await idle(ui);
  }
  await waitFor(() => assert.ok(ui.getByRole("heading", { name: "References." })));
  assert.equal(projectOpen(ui), true);
  assert.match(ui.container.querySelector(".project-context-header")!.textContent!, /Bracket Assembly/);
  // The renamed folder is the one in use: a change made there shows up in a scan.
  const moved = await sample.workspace.root.getDirectory([...NEW.split("/"), "working", "main"]);
  await moved.writeFileText(["After-rename.txt"], "new file");
  fireEvent.click(within(ui.getByRole("navigation", { name: "Primary navigation" })).getByRole("button", { name: "Changes" }));
  fireEvent.click(ui.getByRole("button", { name: "Scan for changes" }));
  await idle(ui);
  assert.ok(ui.getByText("After-rename.txt"));
});

test("Back refuses a project that has become a duplicate", async () => {
  const { sample, ui, nav } = await setup();
  fireEvent.click(nav.getByRole("button", { name: "References" }));
  await openOther(ui);
  await copyFolder(sample.workspace.root, OLD, NEW);
  await reopenWorkspace(ui);
  for (let i = 0; i < 8; i++) {
    await traverse("back");
    await idle(ui);
  }
  assert.equal(ui.queryByRole("heading", { name: "References." }), null);
  assert.equal(
    ui.container.querySelector(".project-context-header")?.textContent?.includes("Bracket Assembly") ?? false,
    false,
  );
});

test("Explorer expanded state follows the project's ID through a folder rename", async () => {
  const { sample, ui } = await setup();
  await openOther(ui);
  const tree = () => within(ui.getByRole("tree", { name: "Workspace explorer" }));
  const bracketBranches = () => tree().queryAllByRole("treeitem", { name: /^(Main|Lightweight bracket), Bracket Assembly, Tutorial Workspace$/ });
  assert.ok(bracketBranches().length > 0, "Bracket Assembly stays expanded after another project is opened");
  await renameFolder(sample.workspace.root, OLD, NEW);
  await reopenWorkspace(ui);
  assert.ok(tree().getByRole("treeitem", { name: "Bracket Assembly, Tutorial Workspace" }));
  assert.ok(bracketBranches().length > 0, "the renamed project is still expanded");
});

test("Duplicate copies keep separate, non-openable Explorer rows and never share a React key", async (t) => {
  const sample = await compareApplyRecoverSample();
  await copyFolder(sample.workspace.root, OLD, "projects/Bracket copy");
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
  const ui = render(<App />);
  await openHomeWorkspace(ui, sample.home);
  const tree = within(ui.getByRole("tree", { name: "Workspace explorer" }));
  const rows = tree.getAllByRole("treeitem", { name: "Bracket Assembly, Tutorial Workspace" });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.getAttribute("aria-disabled") === "true"));
  // Expanding one copy must not expand the other.
  const branchRows = () => tree.queryAllByRole("treeitem", { name: /, Bracket Assembly, Tutorial Workspace$/ });
  assert.equal(branchRows().length, 0);
  fireEvent.click(tree.getAllByRole("button", { name: "Expand Bracket Assembly" })[0]);
  const expanded = branchRows().length;
  assert.ok(expanded > 0);
  assert.equal(tree.getAllByRole("button", { name: /^(Expand|Collapse) Bracket Assembly$/ }).filter((b) => b.getAttribute("aria-expanded") === "true").length, 1);
  for (const row of rows) fireEvent.click(row);
  await waitFor(() => assert.equal(appBusy(ui), false));
  assert.equal(projectOpen(ui), false);
  assert.deepEqual(errors.filter((message) => /same key|unique "key"/.test(message)), []);
});
