import "../../tests/dom";
import {
  appBusy,
  currentBranchId,
  selectBranch,
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
import { nativeDirectory } from "../../tests/native-fs";
import { InMemoryFileSystemAdapter } from "../engine/fs-adapter";
import {
  initializeProjectVault,
  openExistingVault,
} from "../engine/vault-service";
import { captureRevision } from "../engine/revision-service";
import { createDesignBranch } from "../engine/branch-service";
import { HistoryRecoveryView } from "./HistoryRecoveryView";

afterEach(cleanup);
const notes = { problem: "", modification: "", observations: "" };
async function setup() {
  const main = new InMemoryFileSystemAdapter("Main CAD");
  const vault = new InMemoryFileSystemAdapter("Vault");
  const parent = new InMemoryFileSystemAdapter("Cases");
  await main.writeFileBytes(["Part.SLDPRT"], new Uint8Array([0, 255, 9]));
  await initializeProjectVault(main, vault, "Actuator");
  const first = (
    await captureRevision(main, vault, {
      branchId: "branch-main",
      summary: "Original housing",
      notes,
    })
  ).revision;
  const queue = [nativeDirectory(vault), nativeDirectory(main)];
  Object.assign(window, {
    showDirectoryPicker: async () => {
      const next = queue.shift();
      if (!next) throw new Error("No queued folder");
      return next;
    },
  });
  const ui = render(<App />);
  fireEvent.click(ui.getByText("Other locations"));
  fireEvent.click(
    ui.getByRole("button", { name: "Inspect external workspaces" }),
  );
  fireEvent.click(ui.getByText("Advanced: external projects"));
  fireEvent.click(ui.getByRole("button", { name: "Open external projects" }));
  fireEvent.click(ui.getByRole("button", { name: /Open existing vault/ }));
  const dialog = within(ui.getByRole("dialog"));
  fireEvent.click(dialog.getByRole("button", { name: "Choose vault" }));
  await waitFor(() => assert.ok(dialog.getByText("Vault", { exact: true })));
  fireEvent.click(dialog.getByRole("button", { name: "Connect" }));
  await waitFor(() => assert.ok(dialog.getByText("Main CAD", { exact: true })));
  fireEvent.click(dialog.getByRole("button", { name: "Open project" }));
  await waitFor(() =>
    assert.ok(ui.getByRole("status", { name: "Current branch" })),
  );
  await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
  return { main, vault, parent, first, queue, ui };
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
    ctx.ui.getByRole("button", { name: "Create branch from here" }),
  );
  const dialog = within(ctx.ui.getByRole("dialog"));
  assert.ok(dialog.getByText(/Rev 001 on Main/));
  fireEvent.change(dialog.getByRole("textbox", { name: "Branch name" }), {
    target: { value: name },
  });
  fireEvent.change(
    dialog.getByRole("textbox", { name: "Engineering reason" }),
    { target: { value: `Explore ${name}` } },
  );
  ctx.queue.push(nativeDirectory(ctx.parent));
  fireEvent.click(dialog.getByRole("button", { name: "Choose parent folder" }));
  await waitFor(() => assert.ok(dialog.getByText("Cases", { exact: true })));
  fireEvent.click(dialog.getByRole("button", { name: "Create branch" }));
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
    const folder = await ctx.parent.getDirectory([
      (await ctx.parent.listEntries())[0].name,
    ]);
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
    fireEvent.click(ui.getByText("Other locations"));
    fireEvent.click(
      ui.getByRole("button", { name: "Inspect external workspaces" }),
    );
    fireEvent.click(ui.getByText("Advanced: external projects"));
    fireEvent.click(ui.getByRole("button", { name: "Open external projects" }));
    ctx.queue.push(nativeDirectory(ctx.vault));
    fireEvent.click(ui.getByRole("button", { name: /Open existing vault/ }));
    const dialog = within(ui.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Choose vault" }));
    await waitFor(() => assert.ok(dialog.getByText("Vault", { exact: true })));
    fireEvent.click(dialog.getByRole("button", { name: "Open project" }));
    await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
    assert.ok(
      within(
        ui.container.querySelector<HTMLElement>(".settings-page")!,
      ).getByRole("option", { name: "Case A", hidden: true }),
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
          name: "Create branch from here",
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
  fireEvent.click(ctx.ui.getByRole("button", { name: "Scan for changes" }));
  await waitFor(() =>
    assert.ok(ctx.ui.getByRole("heading", { name: "1 changed file" })),
  );
  let changes = visibleChanges(ctx.ui.container);
  fireEvent.change(changes.getByRole("textbox", { name: /Revision summary/ }), {
    target: { value: "Main draft" },
  });
  fireEvent.click(
    changes.getByRole("button", { name: /Add.*overall engineering notes/ }),
  );
  fireEvent.change(changes.getByRole("textbox", { name: "Overall: problem" }), {
    target: { value: "Main intent" },
  });
  fireEvent.click(
    changes.getByRole("button", { name: "Add note for Part.SLDPRT" }),
  );
  fireEvent.change(
    changes.getByRole("textbox", { name: "Part.SLDPRT: problem" }),
    { target: { value: "Main file note" } },
  );
  const branch = await createFromUI(ctx, "Case A");
  assert.equal((await openExistingVault(ctx.vault)).revisions.length, 1);
  assert.ok(
    ctx.ui.getByRole("button", { name: "Started from Rev 001 on Main" }),
  );
  assert.match(
    ctx.ui.container.textContent!,
    /Browser convenience data could not be saved/,
  );
  const branchFolderEntry = (await ctx.parent.listEntries())[0];
  const branchFolder = await ctx.parent.getDirectory([branchFolderEntry.name]);
  await branchFolder.writeFileBytes(["Part.SLDPRT"], new Uint8Array([7, 8]));
  fireEvent.click(
    within(ctx.ui.getByRole("navigation")).getByRole("button", {
      name: "Changes",
    }),
  );
  fireEvent.click(ctx.ui.getByRole("button", { name: "Scan for changes" }));
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
    changes.getByRole("button", { name: /Add.*overall engineering notes/ }),
  );
  fireEvent.change(changes.getByRole("textbox", { name: "Overall: problem" }), {
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
        name: "Overall: problem",
      }) as HTMLTextAreaElement
    ).value,
    "Main intent",
  );
  assert.equal(
    (
      changes.getByRole("textbox", {
        name: "Part.SLDPRT: problem",
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
  fireEvent.click(ctx.ui.getByRole("button", { name: "Technical details" }));
  fireEvent.click(ctx.ui.getByRole("button", { name: "Verify file contents" }));
  await waitFor(() =>
    assert.ok(ctx.ui.getByText("Metadata and file contents verified")),
  );
  await selectBranch(ctx.ui, "branch-main");
  await waitFor(() => assert.equal(appBusy(ctx.ui), false));
  assert.ok(ctx.ui.getByText("Metadata and file contents verified"));
});

test("App clears stale scan context for unavailable handles and rejects switching during an asynchronous scan", async () => {
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
  fireEvent.change(ctx.ui.getByRole("combobox", { name: "Active branch" }), {
    target: { value: "branch-main" },
  });
  await waitFor(() => assert.equal(scanning, true));
  assert.equal(
    (
      ctx.ui.getByRole("combobox", {
        name: "Active branch",
      }) as HTMLSelectElement
    ).disabled,
    true,
  );
  // Programmatic event also tests the synchronous operation guard.
  fireEvent.change(ctx.ui.getByRole("combobox", { name: "Active branch" }), {
    target: { value: branch.branchId },
  });
  await act(async () => {
    release();
  });
  await waitFor(() =>
    assert.equal(
      (
        ctx.ui.getByRole("combobox", {
          name: "Active branch",
        }) as HTMLSelectElement
      ).disabled,
      false,
    ),
  );
  assert.equal(
    (
      ctx.ui.getByRole("combobox", {
        name: "Active branch",
      }) as HTMLSelectElement
    ).value,
    "branch-main",
  );
  ctx.main.setHooks({ onBeforeRead: undefined, readPermission: "denied" });
  fireEvent.change(ctx.ui.getByRole("combobox", { name: "Active branch" }), {
    target: { value: branch.branchId },
  });
  await waitFor(() =>
    assert.equal(
      (
        ctx.ui.getByRole("combobox", {
          name: "Active branch",
        }) as HTMLSelectElement
      ).disabled,
      false,
    ),
  );
  fireEvent.change(ctx.ui.getByRole("combobox", { name: "Active branch" }), {
    target: { value: "branch-main" },
  });
  await waitFor(() =>
    assert.ok(ctx.ui.getByRole("button", { name: "Connect folder" })),
  );
  assert.match(
    ctx.ui.container.querySelector(".settings-page .settings-row")!
      .textContent!,
    /Not connected/,
  );
  fireEvent.click(
    within(ctx.ui.getByRole("navigation")).getByRole("button", {
      name: "Changes",
    }),
  );
  assert.ok(visibleChanges(ctx.ui.container).getByText("Scan needed"));
  assert.equal(
    visibleChanges(ctx.ui.container).queryByRole("button", {
      name: "Save revision",
    }),
    null,
  );
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
      isRestoring={false}
      progress={null}
      lastRestoreReport={null}
      statusBanner={null}
      onRestoreFullProject={async () => {}}
      onRestoreSelectedFiles={async () => {}}
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

test("clearing browser bindings reconstructs all branches and requires explicit isolated reconnection one folder at a time", async () => {
  const ctx = await setup();
  const branch = await createFromUI(ctx, "Case A");
  const caseDir = await ctx.parent.getDirectory([
    (await ctx.parent.listEntries())[0].name,
  ]);
  fireEvent.click(ctx.ui.getByRole("button", { name: "Settings" }));
  fireEvent.click(ctx.ui.getByText("Advanced record information"));
  fireEvent.click(
    ctx.ui.getByRole("button", {
      name: "Clear remembered connections and reopen vault",
    }),
  );
  const dialog = within(ctx.ui.getByRole("dialog"));
  fireEvent.click(
    dialog.getByRole("button", { name: "Clear connections and reopen" }),
  );
  await waitFor(() => assert.ok(!ctx.ui.queryByRole("dialog")));
  await waitFor(() => assert.equal(appBusy(ctx.ui), false));
  assert.equal(
    ctx.ui.container.querySelectorAll(".settings-page option").length,
    2,
  );
  assert.match(
    ctx.ui.container.querySelector(".settings-page .settings-row")!
      .textContent!,
    /Not connected/,
  );
  await selectBranch(ctx.ui, "branch-main");
  await waitFor(() => assert.equal(appBusy(ctx.ui), false));
  ctx.queue.push(nativeDirectory(ctx.main));
  fireEvent.click(ctx.ui.getByRole("button", { name: "Connect folder" }));
  await waitFor(() => assert.equal(appBusy(ctx.ui), false));
  assert.match(
    ctx.ui.container.querySelector(".settings-page .settings-row")!
      .textContent!,
    /Main CAD/,
  );
  assert.match(
    ctx.ui.container.querySelector(".global-integrity")!.textContent!,
    /Case A/,
  );
  await selectBranch(ctx.ui, branch.branchId);
  await waitFor(() => assert.equal(appBusy(ctx.ui), false));
  ctx.queue.push(nativeDirectory(caseDir));
  fireEvent.click(ctx.ui.getByRole("button", { name: "Connect folder" }));
  await waitFor(() => assert.equal(appBusy(ctx.ui), false));
  assert.ok(
    !ctx.ui.container
      .querySelector(".global-integrity")!
      .textContent!.includes("Connect the working folders"),
  );
  assert.equal((await openExistingVault(ctx.vault)).revisions.length, 1);
});

test("branch creation shows cancellable progress and reports the incomplete folder without publishing it", async () => {
  const ctx = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused = false;
  ctx.parent.setHooks({
    onBeforeWrite: async () => {
      paused = true;
      await gate;
    },
  });
  fireEvent.click(
    ctx.ui.getByRole("button", { name: "Create branch from here" }),
  );
  const dialog = within(ctx.ui.getByRole("dialog"));
  fireEvent.change(dialog.getByRole("textbox", { name: "Branch name" }), {
    target: { value: "Cancelled Case" },
  });
  fireEvent.change(
    dialog.getByRole("textbox", { name: "Engineering reason" }),
    { target: { value: "Test interrupted copy" } },
  );
  ctx.queue.push(nativeDirectory(ctx.parent));
  fireEvent.click(dialog.getByRole("button", { name: "Choose parent folder" }));
  await waitFor(() => assert.ok(dialog.getByText("Cases")));
  fireEvent.click(dialog.getByRole("button", { name: "Create branch" }));
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
  assert.equal((await ctx.parent.listEntries()).length, 1);
});
