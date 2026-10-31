import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  render,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import App from "../App";
import { InMemoryFileSystemAdapter } from "../engine/fs-adapter";
import { nativeDirectory } from "../../tests/native-fs";
import {
  createWorkspace,
  openWorkspace,
  importProject,
} from "../engine/workspace-service";
import {
  openExistingVault,
  initializeProjectVault,
} from "../engine/vault-service";
import { captureRevision } from "../engine/revision-service";
import { createDesignBranch } from "../engine/branch-service";
import {
  readVerifiedInventory,
  inventorySignature,
} from "../engine/copy-service";

afterEach(cleanup);
const notes = { problem: "", modification: "", observations: "" };
const snap = async (dir: InMemoryFileSystemAdapter) =>
  inventorySignature(await readVerifiedInventory(dir));
function pickerQueue() {
  const queue: FileSystemDirectoryHandle[] = [];
  let calls = 0;
  Object.assign(window, {
    showDirectoryPicker: async () => {
      calls++;
      const next = queue.shift();
      if (!next) throw new Error("No queued native folder");
      return next;
    },
  });
  return { queue, calls: () => calls };
}
function changes(container: HTMLElement) {
  return within(
    [...container.querySelectorAll<HTMLElement>(".changes-page")].find(
      (page) => !page.parentElement!.hidden,
    )!,
  );
}
const nav = (ui: ReturnType<typeof render>, name: string) =>
  fireEvent.click(
    within(ui.getByRole("navigation")).getByRole("button", { name }),
  );
const idle = (ui: ReturnType<typeof render>) =>
  waitFor(() =>
    assert.equal(
      (ui.getByRole("combobox", { name: "Active branch" }) as HTMLSelectElement)
        .disabled,
      false,
    ),
  );
test("UI imports into a workspace, creates cases without parent pickers, recovers copies, and reconnects all cases with one root", async () => {
  const root = new InMemoryFileSystemAdapter("Workbench");
  const source = new InMemoryFileSystemAdapter("Original CAD");
  await source.writeFileBytes(
    ["Parts", "Part.SLDPRT"],
    new Uint8Array([0, 255, 42]),
  );
  await source.getDirectory(["Empty"], { create: true });
  const before = await snap(source);
  const picker = pickerQueue();
  picker.queue.push(nativeDirectory(root));
  let ui = render(<App />);
  fireEvent.click(ui.getByText("Other locations"));
  fireEvent.click(
    ui.getByRole("button", { name: "Inspect external workspaces" }),
  );
  fireEvent.click(ui.getByRole("button", { name: /Create workspace/ }));
  let dialog = within(ui.getByRole("dialog"));
  fireEvent.change(dialog.getByRole("textbox", { name: "Workspace name" }), {
    target: { value: "Workbench" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Choose folder" }));
  await waitFor(() =>
    assert.ok(dialog.getByText("Workbench", { exact: true })),
  );
  fireEvent.click(dialog.getByRole("button", { name: "Create workspace" }));
  await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
  fireEvent.click(ui.getByRole("button", { name: "Add project" }));
  dialog = within(ui.getByRole("dialog"));
  picker.queue.push(nativeDirectory(source));
  fireEvent.change(dialog.getByRole("textbox", { name: "Project name" }), {
    target: { value: "Actuator" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Choose folder" }));
  await waitFor(() =>
    assert.ok(dialog.getByText("Original CAD", { exact: true })),
  );
  fireEvent.click(dialog.getByRole("button", { name: "Import project" }));
  await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
  await idle(ui);
  assert.match(ui.container.textContent!, /Continue working in this copy/);
  let project = (await openWorkspace(root)).projects[0].project!;
  assert.equal(project.vaultState.revisions.length, 0);
  assert.equal(await snap(source), before);
  fireEvent.change(
    changes(ui.container).getByRole("textbox", { name: /Revision summary/ }),
    { target: { value: "Managed baseline" } },
  );
  fireEvent.click(
    changes(ui.container).getByRole("button", { name: "Save revision" }),
  );
  await idle(ui);
  assert.equal((await openExistingVault(project.vaultDir)).revisions.length, 1);
  nav(ui, "History");
  const pickerCount = picker.calls();
  for (const name of ["Case A", "Case B", "Case C"]) {
    fireEvent.click(
      ui.getByRole("button", { name: "Create branch from here" }),
    );
    await waitFor(() => assert.ok(ui.queryByRole("dialog")));
    dialog = within(ui.getByRole("dialog"));
    assert.ok(!dialog.queryByRole("button", { name: "Choose parent folder" }));
    fireEvent.change(dialog.getByRole("textbox", { name: "Branch name" }), {
      target: { value: name },
    });
    fireEvent.change(
      dialog.getByRole("textbox", { name: "Engineering reason" }),
      { target: { value: `Explore ${name}` } },
    );
    fireEvent.click(dialog.getByRole("button", { name: "Create branch" }));
    await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
    await idle(ui);
  }
  assert.equal(picker.calls(), pickerCount);
  project = (await openWorkspace(root)).projects[0].project!;
  assert.equal(project.vaultState.revisions.length, 1);
  assert.equal(project.vaultState.branches.length, 4);
  fireEvent.click(ui.getByRole("button", { name: "Restore project copy" }));
  await waitFor(() => assert.ok(ui.queryByRole("dialog")));
  dialog = within(ui.getByRole("dialog"));
  assert.ok(
    dialog.getByRole("checkbox", {
      name: "Choose an external destination instead",
    }),
  );
  fireEvent.click(dialog.getByRole("button", { name: "Restore copy" }));
  await idle(ui);
  assert.equal(picker.calls(), pickerCount);
  assert.match(ui.container.textContent!, /recoveries\/copy-/);
  // An explicit external override still uses a user-chosen destination.
  const external = new InMemoryFileSystemAdapter("External recovery");
  picker.queue.push(nativeDirectory(external));
  fireEvent.click(ui.getByRole("button", { name: "Restore project copy" }));
  await waitFor(() => assert.ok(ui.queryByRole("dialog")));
  dialog = within(ui.getByRole("dialog"));
  fireEvent.click(
    dialog.getByRole("checkbox", {
      name: "Choose an external destination instead",
    }),
  );
  fireEvent.click(dialog.getByRole("button", { name: "Choose destination" }));
  await idle(ui);
  assert.equal(picker.calls(), pickerCount + 1);
  assert.equal(await snap(external), before);
  assert.equal((await openExistingVault(project.vaultDir)).branches.length, 4);
  // Reopening from a clean app has no per-branch handle cache.
  cleanup();
  picker.queue.push(nativeDirectory(root));
  const reopenCount = picker.calls();
  ui = render(<App />);
  fireEvent.click(ui.getByText("Other locations"));
  fireEvent.click(
    ui.getByRole("button", { name: "Inspect external workspaces" }),
  );
  fireEvent.click(ui.getByRole("button", { name: /Open workspace/ }));
  await waitFor(() =>
    assert.ok(ui.getByRole("button", { name: "Open project" })),
  );
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await idle(ui);
  assert.equal(ui.getAllByRole("option").length, 4);
  assert.equal(picker.calls(), reopenCount + 1);
  const caseA = project.vaultState.branches.find(
    (branch) => branch.name === "Case A",
  )!;
  fireEvent.change(ui.getByRole("combobox", { name: "Active branch" }), {
    target: { value: caseA.branchId },
  });
  await idle(ui);
  assert.equal(picker.calls(), reopenCount + 1);
  assert.ok(
    !ui.container
      .querySelector(".settings-page .settings-row")!
      .textContent!.includes("Not connected"),
  );
  assert.equal(await snap(source), before);
});

test("UI surfaces missing managed leaves before branch actions and preserves read-only history", async () => {
  const root = new InMemoryFileSystemAdapter("Workbench");
  await createWorkspace(root);
  const source = new InMemoryFileSystemAdapter("Source");
  await source.writeFileBytes(["Part"], new Uint8Array([1, 2, 3]));
  const project = await importProject(root, source, "Actuator");
  await captureRevision(
    project.workingFolders["branch-main"]!,
    project.vaultDir,
    {
      branchId: "branch-main",
      summary: "History survives",
      notes,
      workingFolders: project.workingFolders,
    },
  );
  await root.removeEntry(project.workingPaths["branch-main"].split("/"), {
    recursive: true,
  });
  const picker = pickerQueue();
  picker.queue.push(nativeDirectory(root));
  const ui = render(<App />);
  fireEvent.click(ui.getByText("Other locations"));
  fireEvent.click(
    ui.getByRole("button", { name: "Inspect external workspaces" }),
  );
  fireEvent.click(ui.getByRole("button", { name: /Open workspace/ }));
  await waitFor(() =>
    assert.ok(ui.getByRole("button", { name: "Inspect project" })),
  );
  fireEvent.click(ui.getByRole("button", { name: "Inspect project" }));
  await idle(ui);
  assert.match(ui.container.textContent!, /Managed project is read-only/);
  assert.ok(ui.getByRole("heading", { name: "History survives" }));
  assert.equal(
    (
      ui.getByRole("button", {
        name: "Create branch from here",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  assert.equal(
    (
      ui.getByRole("button", {
        name: "Restore project copy",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  assert.equal(
    await root.hasDirectory(project.workingPaths["branch-main"].split("/")),
    false,
  );
});

test("managed action preflight notices a folder lost after opening, before it displays a branch form", async () => {
  const root = new InMemoryFileSystemAdapter("Workbench");
  await createWorkspace(root);
  const source = new InMemoryFileSystemAdapter("Source");
  await source.writeFileBytes(["Part"], new Uint8Array([1]));
  const project = await importProject(root, source, "Actuator");
  await captureRevision(
    project.workingFolders["branch-main"]!,
    project.vaultDir,
    { branchId: "branch-main", summary: "Baseline", notes },
  );
  const picker = pickerQueue();
  picker.queue.push(nativeDirectory(root));
  const ui = render(<App />);
  fireEvent.click(ui.getByText("Other locations"));
  fireEvent.click(
    ui.getByRole("button", { name: "Inspect external workspaces" }),
  );
  fireEvent.click(ui.getByRole("button", { name: /Open workspace/ }));
  await waitFor(() =>
    assert.ok(ui.getByRole("button", { name: "Open project" })),
  );
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await idle(ui);
  await root.removeEntry(project.workingPaths["branch-main"].split("/"), {
    recursive: true,
  });
  fireEvent.click(ui.getByRole("button", { name: "Create branch from here" }));
  await waitFor(() =>
    assert.match(
      ui.container.querySelector(".global-integrity")!.textContent!,
      /Managed project is read-only/,
    ),
  );
  assert.ok(!ui.queryByRole("dialog"));
  assert.equal(
    await root.hasDirectory(project.workingPaths["branch-main"].split("/")),
    false,
  );
});

test("legacy adoption is guided through the workspace UI and preserves unsaved working bytes and history", async () => {
  const root = new InMemoryFileSystemAdapter("Workbench");
  await createWorkspace(root);
  const main = new InMemoryFileSystemAdapter("Old Main");
  await main.writeFileBytes(["Part"], new Uint8Array([1, 0, 255]));
  const vault = new InMemoryFileSystemAdapter("Old Vault");
  await initializeProjectVault(main, vault, "Legacy");
  const baseline = await captureRevision(main, vault, {
    branchId: "branch-main",
    summary: "Legacy baseline",
    notes,
  });
  const branch = await createDesignBranch({
    vaultDir: vault,
    destinationParent: new InMemoryFileSystemAdapter("Old Cases"),
    workingFolders: { "branch-main": main },
    sourceRevisionId: baseline.revision.manifest.revisionId,
    name: "Case A",
    reason: "Test adoption",
  });
  await main.writeFileBytes(["Uncaptured"], new Uint8Array([11, 22]));
  const vaultBefore = await snap(vault),
    mainBefore = await snap(main);
  const picker = pickerQueue();
  picker.queue.push(nativeDirectory(root));
  const ui = render(<App />);
  fireEvent.click(ui.getByText("Other locations"));
  fireEvent.click(
    ui.getByRole("button", { name: "Inspect external workspaces" }),
  );
  fireEvent.click(ui.getByRole("button", { name: /Open workspace/ }));
  await waitFor(() =>
    assert.ok(ui.getByRole("button", { name: "Add project" })),
  );
  fireEvent.click(ui.getByText("Advanced: external projects"));
  fireEvent.click(ui.getByRole("button", { name: "Open external projects" }));
  fireEvent.click(ui.getByRole("button", { name: /Open existing vault/ }));
  let dialog = within(ui.getByRole("dialog"));
  picker.queue.push(nativeDirectory(vault), nativeDirectory(main));
  fireEvent.click(dialog.getByRole("button", { name: "Choose vault" }));
  await waitFor(() => assert.ok(dialog.getByText("Old Vault")));
  fireEvent.click(dialog.getByRole("button", { name: "Connect" }));
  await waitFor(() => assert.ok(dialog.getByText("Old Main")));
  fireEvent.click(dialog.getByRole("button", { name: "Open project" }));
  await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
  await idle(ui);
  fireEvent.change(ui.getByRole("combobox", { name: "Active branch" }), {
    target: { value: branch.branch.branchId },
  });
  await idle(ui);
  picker.queue.push(nativeDirectory(branch.workingDir));
  fireEvent.click(ui.getByRole("button", { name: "Connect folder" }));
  await idle(ui);
  fireEvent.click(ui.getByRole("treeitem", { name: "Workbench · External" }));
  fireEvent.click(ui.getByRole("button", { name: "Bring into workspace" }));
  dialog = within(ui.getByRole("dialog"));
  fireEvent.click(
    dialog.getByRole("button", { name: "Copy project into workspace" }),
  );
  await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
  await idle(ui);
  assert.match(ui.container.textContent!, /Continue working in this copy/);
  const adopted = (await openWorkspace(root)).projects[0].project!;
  assert.equal(adopted.record.projectId, baseline.vaultState.project.projectId);
  assert.ok(
    await adopted.workingFolders["branch-main"]!.hasFile(["Uncaptured"]),
  );
  assert.equal(await snap(vault), vaultBefore);
  assert.equal(await snap(main), mainBefore);
  assert.equal(adopted.vaultState.revisions.length, 1);
});
