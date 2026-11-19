import "../../tests/dom";
import {
  openHomeWorkspace,
  appBusy,
  currentBranchId,
  selectBranch, waitForScan,
} from "../../tests/app-controls";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  render,
  cleanup,
  fireEvent,
  waitFor,
  within,
  act,
} from "@testing-library/react";
import App from "../App";
import { createHome, createHomeWorkspace } from "../engine/home-service";
import { importProject, resolveManagedProject } from "../engine/workspace-service";
import { InMemoryFileSystemAdapter } from "../engine/fs-adapter";
import { openExistingVault } from "../engine/vault-service";
import { captureRevision } from "../engine/revision-service";
import { createDesignBranch } from "../engine/branch-service";
import { HistoryRecoveryView } from "./HistoryRecoveryView";

afterEach(cleanup);
const notes = { problem: "", modification: "", observations: "" };
async function setup() {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const { workspace: { root } } = await createHomeWorkspace(home, "Workbench");
  const source = new InMemoryFileSystemAdapter("Main CAD");
  await source.writeFileBytes(["Part.SLDPRT"], new Uint8Array([0, 255, 9]));
  const project = await importProject(root, source, "Actuator");
  const main = project.workingFolders["branch-main"] as InMemoryFileSystemAdapter;
  const vault = project.vaultDir;
  const parent = new InMemoryFileSystemAdapter("Cases");
  const first = (
    await captureRevision(main, vault, {
      branchId: "branch-main",
      summary: "Original housing",
      notes,
    })
  ).revision;
  const queue: FileSystemDirectoryHandle[] = [];
  Object.assign(window, {
    showDirectoryPicker: async () => {
      const next = queue.shift();
      if (!next) throw new Error("No queued folder");
      return next;
    },
  });
  const ui = render(<App />);
  await openHomeWorkspace(ui, home);
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await waitFor(() =>
    assert.ok(ui.getByRole("region", { name: "Project context" })),
  );
  await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
  await waitFor(() => assert.equal(appBusy(ui), false));
  return { home, root, project, main, vault, parent, first, queue, ui };
}
function visibleChanges(container: HTMLElement) {
  return within(
    [...container.querySelectorAll<HTMLElement>(".changes-page")].find(
      (page) => !page.parentElement!.hidden,
    )!,
  );
}
async function createFromUI(
  ctx: Awaited<ReturnType<typeof setup>>,
  name: string,
) {
  fireEvent.click(ctx.ui.getByRole("button", { name: "History" }));
  fireEvent.click(
    ctx.ui.getByRole("button", { name: /Rev 001: Original housing/ }),
  );
  fireEvent.click(
    ctx.ui.getByRole("button", { name: "Create design case from this revision" }),
  );
  await waitFor(() => assert.ok(ctx.ui.queryByRole("dialog")));
  const dialog = within(ctx.ui.getByRole("dialog"));
  assert.ok(dialog.getByText(/Rev 001 on Main/));
  fireEvent.change(dialog.getByRole("textbox", { name: "Case name" }), {
    target: { value: name },
  });
  fireEvent.change(
    dialog.getByRole("textbox", { name: "Engineering reason" }),
    { target: { value: `Explore ${name}` } },
  );
  fireEvent.click(dialog.getByRole("button", { name: "Create design case" }));
  await waitFor(() => assert.ok(!ctx.ui.queryByRole("dialog")));
  const state = await openExistingVault(ctx.vault);
  const branch = state.branches.find((b) => b.name === name)!;
  assert.ok(branch);
  assert.equal(currentBranchId(ctx.ui), branch.branchId);
  return branch;
}

test("reopening an established branch with a damaged marker keeps its selector, graph, history, and diagnostics inspectable", async () => {
  for (const mode of ["missing", "malformed"]) {
    const ctx = await setup();
    const branch = await createFromUI(ctx, "Case A");
    const folder = (await resolveManagedProject(ctx.root, ctx.project.record.containerPath)).workingFolders[branch.branchId]!;
    await folder.writeFileBytes(["Part.SLDPRT"], new Uint8Array([4, 0, 255]));
    await captureRevision(folder, ctx.vault, {
      branchId: branch.branchId,
      summary: "Established damaged case",
      notes,
      workingFolders: { "branch-main": ctx.main, [branch.branchId]: folder },
    });
    const marker = ["branches", `${branch.branchId}.ready.json`];
    if (mode === "missing") await ctx.vault.removeEntry(marker);
    else await ctx.vault.writeFileText(marker, "{");
    cleanup();
    const ui = render(<App />);
    await openHomeWorkspace(ui, ctx.home);
    fireEvent.click(ui.getByRole("button", { name: "Inspect project" }));
    await waitFor(() => assert.equal(appBusy(ui), false));
    await waitFor(() =>
      assert.ok(
        ui.container.querySelector(
          `.desktop-workspace-tree [role="treeitem"][data-branch-id="${branch.branchId}"]`,
        ),
      ),
    );
    assert.ok(ui.getByText("History needs attention."));
    await selectBranch(ui, branch.branchId);
    await waitFor(() => assert.equal(appBusy(ui), false));
    fireEvent.click(
      ui.getByRole("button", { name: /Rev 002: Established damaged case/ }),
    );
    assert.ok(ui.getByRole("heading", { name: "Established damaged case" }));
    assert.equal(
      (
        ui.getByRole("button", {
          name: "Create design case from this revision",
        }) as HTMLButtonElement
      ).disabled,
      true,
    );
    fireEvent.click(ui.getByRole("button", { name: "List" }));
    assert.ok(ui.getByRole("heading", { name: "Established damaged case" }));
    fireEvent.click(ui.getByRole("button", { name: "Settings" }));
    assert.match(
      ui.container.querySelector(".settings-page")!.textContent!,
      /Established branch "Case A" has a damaged ready marker/,
    );
    assert.equal(
      (await openExistingVault(ctx.vault)).branches.find(
        (candidate) => candidate.branchId === branch.branchId,
      )?.name,
      "Case A",
    );
    if (mode === "missing")
      assert.equal(await ctx.vault.hasFile(marker), false);
    else assert.equal(await ctx.vault.readFileText(marker), "{");
    cleanup();
  }
});

test("App creates branches, preserves Main and branch notes, and keeps graph highlighting separate from working context", async () => {
  const ctx = await setup();
  await ctx.main.writeFileBytes(["Part.SLDPRT"], new Uint8Array([3, 2]));
  fireEvent.click(
    within(ctx.ui.getByRole("navigation")).getByRole("button", {
      name: "Changes",
    }),
  );
  await waitForScan(ctx.ui);
  await waitFor(() =>
    assert.ok(ctx.ui.getByRole("heading", { name: "1 changed file" })),
  );
  let changes = visibleChanges(ctx.ui.container);
  fireEvent.change(changes.getByRole("textbox", { name: /Revision summary/ }), {
    target: { value: "Main draft" },
  });
  fireEvent.click(
    changes.getByRole("button", { name: /Add a description/ }),
  );
  fireEvent.change(changes.getByRole("textbox", { name: "Overall: Why" }), {
    target: { value: "Main intent" },
  });
  fireEvent.click(
    changes.getByRole("button", { name: "Add note for Part.SLDPRT" }),
  );
  fireEvent.change(
    changes.getByRole("textbox", { name: "Part.SLDPRT: Why" }),
    { target: { value: "Main file note" } },
  );
  const branch = await createFromUI(ctx, "Case A");
  assert.equal((await openExistingVault(ctx.vault)).revisions.length, 1);
  assert.ok(
    ctx.ui.getByRole("button", { name: "Started from Rev 001 on Main" }),
  );
  const branchFolder = (await resolveManagedProject(ctx.root, ctx.project.record.containerPath)).workingFolders[branch.branchId]!;
  await branchFolder.writeFileBytes(["Part.SLDPRT"], new Uint8Array([7, 8]));
  fireEvent.click(
    within(ctx.ui.getByRole("navigation")).getByRole("button", {
      name: "Changes",
    }),
  );
  await waitForScan(ctx.ui);
  await waitFor(() =>
    assert.ok(ctx.ui.getByRole("heading", { name: "1 changed file" })),
  );
  changes = visibleChanges(ctx.ui.container);
  assert.equal(
    (
      changes.getByRole("textbox", {
        name: /Revision summary/,
      }) as HTMLInputElement
    ).value,
    "",
  );
  assert.equal(changes.queryByText("Main file note"), null);
  fireEvent.change(changes.getByRole("textbox", { name: /Revision summary/ }), {
    target: { value: "Case A draft" },
  });
  fireEvent.click(
    changes.getByRole("button", { name: /Add a description/ }),
  );
  fireEvent.change(changes.getByRole("textbox", { name: "Overall: Why" }), {
    target: { value: "Alternative intent" },
  });
  await selectBranch(ctx.ui, "branch-main");
  await waitFor(() => assert.equal(appBusy(ctx.ui), false));
  changes = visibleChanges(ctx.ui.container);
  assert.equal(
    (
      changes.getByRole("textbox", {
        name: /Revision summary/,
      }) as HTMLInputElement
    ).value,
    "Main draft",
  );
  assert.equal(
    (
      changes.getByRole("textbox", {
        name: "Overall: Why",
      }) as HTMLTextAreaElement
    ).value,
    "Main intent",
  );
  assert.equal(
    (
      changes.getByRole("textbox", {
        name: "Part.SLDPRT: Why",
      }) as HTMLTextAreaElement
    ).value,
    "Main file note",
  );
  await selectBranch(ctx.ui, branch.branchId);
  await waitFor(() => assert.equal(appBusy(ctx.ui), false));
  changes = visibleChanges(ctx.ui.container);
  assert.equal(
    (
      changes.getByRole("textbox", {
        name: /Revision summary/,
      }) as HTMLInputElement
    ).value,
    "Case A draft",
  );
  fireEvent.click(changes.getByRole("button", { name: "Save revision" }));
  await waitFor(async () =>
    assert.equal((await openExistingVault(ctx.vault)).revisions.length, 2),
  );
  await waitFor(() => assert.equal(appBusy(ctx.ui), false));
  const saved = (await openExistingVault(ctx.vault)).revisions[1].manifest;
  assert.equal(saved.branchId, branch.branchId);
  assert.equal(saved.parentRevisionId, ctx.first.manifest.revisionId);
  assert.equal(saved.notes.problem, "Alternative intent");
  assert.equal(saved.fileNotes, undefined);
  fireEvent.click(ctx.ui.getByRole("button", { name: "History" }));
  fireEvent.click(ctx.ui.getByRole("button", { name: "Main" }));
  assert.equal(currentBranchId(ctx.ui), branch.branchId);
  fireEvent.click(
    ctx.ui.getByRole("button", { name: "Started from Rev 001 on Main" }),
  );
  fireEvent.click(ctx.ui.getByRole("button", { name: "List" }));
  assert.ok(ctx.ui.getByRole("heading", { name: "Original housing" }));
  fireEvent.click(within(ctx.ui.container.querySelector<HTMLElement>(".revision-detail")!).getByText("Troubleshooting"));
  fireEvent.click(ctx.ui.getByRole("button", { name: "Verify file contents" }));
  await waitFor(() =>
    assert.ok(ctx.ui.getByText("Metadata and file contents verified")),
  );
  await selectBranch(ctx.ui, "branch-main");
  await waitFor(() => assert.equal(appBusy(ctx.ui), false));
  assert.ok(ctx.ui.getByText("Metadata and file contents verified"));
});

test("App rejects branch switching during an asynchronous scan", async () => {
  const ctx = await setup();
  const branch = await createFromUI(ctx, "Case A");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let scanning = false;
  fireEvent.click(ctx.ui.getByRole("button", { name: "Settings" }));
  ctx.main.setHooks({
    onBeforeRead: async () => {
      scanning = true;
      await gate;
    },
  });
  const row = (id: string) =>
    ctx.ui.container.querySelector<HTMLElement>(`.desktop-workspace-tree [data-branch-id="${id}"]`)!;
  assert.equal(currentBranchId(ctx.ui), branch.branchId);
  fireEvent.click(row("branch-main"));
  await waitFor(() => assert.equal(scanning, true));
  assert.equal(row("branch-main").getAttribute("aria-disabled"), "true");
  assert.equal(row(branch.branchId).getAttribute("aria-disabled"), "true");
  // A click on the other case during the operation is ignored.
  fireEvent.click(row(branch.branchId));
  await act(async () => {
    release();
  });
  await waitFor(() => assert.equal(row("branch-main").getAttribute("aria-disabled"), null));
  await waitFor(() => assert.equal(appBusy(ctx.ui), false));
  assert.equal(currentBranchId(ctx.ui), "branch-main");
  ctx.main.setHooks({ onBeforeRead: undefined });
});

test("multiple unmodified branch labels share their actual baseline node without creating revisions", async () => {
  const ctx = await setup();
  cleanup();
  const folders = { "branch-main": ctx.main };
  for (const name of ["Case A", "Case B", "Case C"]) {
    const result = await createDesignBranch({
      vaultDir: ctx.vault,
      destinationParent: ctx.parent,
      workingFolders: folders,
      sourceRevisionId: ctx.first.manifest.revisionId,
      name,
      reason: "Compare alternatives",
    });
    Object.assign(folders, { [result.branch.branchId]: result.workingDir });
  }
  const state = await openExistingVault(ctx.vault);
  const ui = render(
    <HistoryRecoveryView
      vaultState={state}
      activeBranchId="branch-main"
      progress={null}
      statusBanner={null}
      onVerifySingleRevisionObjects={async () => {}}
      onCancelOperation={() => {}}
    />,
  );
  for (const name of ["Main", "Case A", "Case B", "Case C"])
    assert.ok(ui.getByRole("button", { name: `${name} head at Rev 001` }));
  assert.equal(ui.container.querySelectorAll(".graph-dot").length, 1);
  assert.equal(
    ui.container.querySelectorAll(".graph-lines path[data-child]").length,
    0,
  );
});

test("branch creation shows cancellable progress and reports the incomplete folder without publishing it", async () => {
  const ctx = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused = false;
  (ctx.root as InMemoryFileSystemAdapter).setHooks({
    onBeforeWrite: async () => {
      paused = true;
      await gate;
    },
  });
  fireEvent.click(
    ctx.ui.getByRole("button", { name: "Create design case from this revision" }),
  );
  await waitFor(() => assert.ok(ctx.ui.queryByRole("dialog")));
  const dialog = within(ctx.ui.getByRole("dialog"));
  fireEvent.change(dialog.getByRole("textbox", { name: "Case name" }), {
    target: { value: "Cancelled Case" },
  });
  fireEvent.change(
    dialog.getByRole("textbox", { name: "Engineering reason" }),
    { target: { value: "Test interrupted copy" } },
  );
  fireEvent.click(dialog.getByRole("button", { name: "Create design case" }));
  try {
    await waitFor(() => assert.equal(paused, true));
    assert.equal(appBusy(ctx.ui), true);
    fireEvent.click(dialog.getByRole("button", { name: "Cancel operation" }));
  } finally {
    await act(async () => {
      release();
    });
  }
  await waitFor(() =>
    assert.match(
      dialog.getByRole("alert").textContent!,
      /Incomplete destination/,
    ),
  );
  assert.equal((await openExistingVault(ctx.vault)).branches.length, 1);
  (ctx.root as InMemoryFileSystemAdapter).setHooks({ onBeforeWrite: undefined });
});
