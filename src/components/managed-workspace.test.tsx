import "../../tests/dom";
import {
  openTestHome,
  openHomeWorkspace,
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
} from "@testing-library/react";
import App from "../App";
import { createHome, createHomeWorkspace, openHome } from "../engine/home-service";
import { InMemoryFileSystemAdapter } from "../engine/fs-adapter";
import { nativeDirectory } from "../../tests/native-fs";
import {
  openWorkspace,
  importProject,
} from "../engine/workspace-service";
import { openExistingVault } from "../engine/vault-service";
import { captureRevision } from "../engine/revision-service";
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
      ui.container.querySelector("main")?.getAttribute("aria-busy"),
      "false",
    ),
  );
test("projects use name-only creation and picker-only import, including cancellation and duplicate-name feedback", async () => {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const { workspace: { root } } = await createHomeWorkspace(home, "Workbench");
  const picker = pickerQueue();
  const ui = render(<App />);
  await openHomeWorkspace(ui, home);
  fireEvent.click(ui.getByRole("button", { name: "Create project" }));
  let dialog = within(ui.getByRole("dialog", { name: "Create project" }));
  assert.equal(dialog.getAllByRole("textbox").length, 1);
  assert.equal(dialog.queryByRole("button", { name: /Choose/ }), null);
  fireEvent.change(dialog.getByRole("textbox", { name: "Project name" }), { target: { value: "New design" } });
  fireEvent.click(dialog.getByRole("button", { name: "Create project" }));
  await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
  await idle(ui);
  assert.equal(picker.calls(), 0);
  const project = (await openWorkspace(root)).projects[0].project!;
  assert.equal(project.record.name, "New design");
  assert.deepEqual(await project.workingFolders["branch-main"]!.listEntries(), []);
  assert.equal(project.vaultState.revisions.length, 0);
  fireEvent.click(ui.getByRole("treeitem", { name: "Workbench" }));
  fireEvent.click(ui.getByRole("button", { name: "Create project" }));
  dialog = within(ui.getByRole("dialog"));
  fireEvent.change(dialog.getByRole("textbox", { name: "Project name" }), { target: { value: " new DESIGN " } });
  fireEvent.click(dialog.getByRole("button", { name: "Create project" }));
  await waitFor(() => assert.match(dialog.getByRole("alert").textContent!, /already present/));
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  Object.assign(window, { showDirectoryPicker: async () => { throw new DOMException("Cancelled", "AbortError"); } });
  fireEvent.click(ui.getByRole("button", { name: "Import existing project" }));
  dialog = within(ui.getByRole("dialog"));
  assert.equal(dialog.queryByRole("textbox"), null);
  fireEvent.click(dialog.getByRole("button", { name: "Choose project folder" }));
  await waitFor(() => assert.equal((dialog.getByRole("button", { name: "Choose project folder" }) as HTMLButtonElement).disabled, false));
  assert.equal(dialog.queryByRole("alert"), null);
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  assert.equal((await openWorkspace(root)).projects.length, 1);
});

test("UI imports into a workspace, creates cases without parent pickers, and reconnects all cases with one root", async () => {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const source = new InMemoryFileSystemAdapter("Original CAD");
  await source.writeFileBytes(
    ["Parts", "Part.SLDPRT"],
    new Uint8Array([0, 255, 42]),
  );
  await source.getDirectory(["Empty"], { create: true });
  const before = await snap(source);
  const picker = pickerQueue();
  let ui = render(<App />);
  await openTestHome(ui, home);
  fireEvent.click(ui.getByRole("button", { name: /Create workspace/ }));
  let dialog = within(ui.getByRole("dialog"));
  fireEvent.change(dialog.getByRole("textbox", { name: "Workspace name" }), {
    target: { value: "Workbench" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Create workspace" }));
  await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
  const root = (await openHome(home)).workspaces[0].workspace!.root;
  fireEvent.click(ui.getByRole("button", { name: "Import existing project" }));
  dialog = within(ui.getByRole("dialog"));
  assert.equal(dialog.queryByRole("textbox"), null);
  picker.queue.push(nativeDirectory(source));
  fireEvent.click(dialog.getByRole("button", { name: "Choose project folder" }));
  await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
  await idle(ui);
  assert.match(ui.container.textContent!, /Continue working in this copy/);
  let project = (await openWorkspace(root)).projects[0].project!;
  assert.equal(project.vaultState.revisions.length, 0);
  assert.equal(project.record.name, source.name);
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
      ui.getByRole("button", { name: "Create design case from this revision" }),
    );
    await waitFor(() => assert.ok(ui.queryByRole("dialog")));
    dialog = within(ui.getByRole("dialog"));
    assert.ok(!dialog.queryByRole("button", { name: "Choose parent folder" }));
    fireEvent.change(dialog.getByRole("textbox", { name: "Case name" }), {
      target: { value: name },
    });
    fireEvent.change(
      dialog.getByRole("textbox", { name: "Engineering reason" }),
      { target: { value: `Explore ${name}` } },
    );
    fireEvent.click(dialog.getByRole("button", { name: "Create design case" }));
    await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
    await idle(ui);
  }
  assert.equal(picker.calls(), pickerCount);
  project = (await openWorkspace(root)).projects[0].project!;
  assert.equal(project.vaultState.revisions.length, 1);
  assert.equal(project.vaultState.branches.length, 4);
  assert.equal(ui.queryByRole("button", { name: "Restore project copy" }), null);
  assert.equal(
    await root.hasDirectory([...project.record.containerPath.split("/"), "recoveries"]),
    false,
  );
  assert.equal(await snap(source), before);
  assert.equal((await openExistingVault(project.vaultDir)).branches.length, 4);
  // Reopening from a clean app has no per-branch handle cache.
  cleanup();
  const reopenCount = picker.calls();
  ui = render(<App />);
  await openHomeWorkspace(ui, home);
  await waitFor(() =>
    assert.ok(ui.getByRole("button", { name: "Open project" })),
  );
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await idle(ui);
  assert.equal(
    ui.container.querySelectorAll(".project-context-header option").length,
    4,
  );
  assert.equal(picker.calls(), reopenCount);
  const caseA = project.vaultState.branches.find(
    (branch) => branch.name === "Case A",
  )!;
  await selectBranch(ui, caseA.branchId);
  await idle(ui);
  assert.equal(picker.calls(), reopenCount);
  assert.ok(
    !ui.container
      .querySelector(".settings-troubleshooting .settings-row")!
      .textContent!.includes("Not connected"),
  );
  assert.equal(await snap(source), before);
});

test("UI surfaces missing managed leaves before branch actions and preserves read-only history", async () => {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const { workspace: { root } } = await createHomeWorkspace(home, "Workbench");
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
  const ui = render(<App />);
  await openHomeWorkspace(ui, home);
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
        name: "Create design case from this revision",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  assert.equal(
    (
      ui.getByRole("button", {
        name: "Export for review",
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
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const { workspace: { root } } = await createHomeWorkspace(home, "Workbench");
  const source = new InMemoryFileSystemAdapter("Source");
  await source.writeFileBytes(["Part"], new Uint8Array([1]));
  const project = await importProject(root, source, "Actuator");
  await captureRevision(
    project.workingFolders["branch-main"]!,
    project.vaultDir,
    { branchId: "branch-main", summary: "Baseline", notes },
  );
  const picker = pickerQueue();
  const ui = render(<App />);
  await openHomeWorkspace(ui, home);
  await waitFor(() =>
    assert.ok(ui.getByRole("button", { name: "Open project" })),
  );
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await idle(ui);
  await root.removeEntry(project.workingPaths["branch-main"].split("/"), {
    recursive: true,
  });
  fireEvent.click(ui.getByRole("button", { name: "Create design case from this revision" }));
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

test("path messages name the real workspace folder, not the display name", async () => {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const { workspace } = await createHomeWorkspace(home, "Acme: Rigs");
  assert.equal(workspace.identity.name, "Acme: Rigs");
  assert.equal(workspace.root.name, "Acme- Rigs");
  const ui = render(<App />);
  await openHomeWorkspace(ui, home);
  fireEvent.click(ui.getByRole("button", { name: "Create project" }));
  const dialog = within(ui.getByRole("dialog", { name: "Create project" }));
  fireEvent.change(dialog.getByRole("textbox", { name: "Project name" }), {
    target: { value: "Rig" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Create project" }));
  await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
  await idle(ui);
  const text = ui.container.textContent!;
  assert.match(text, /Save your CAD files in Acme- Rigs\/projects\//);
  assert.ok(!text.includes("Acme: Rigs/"));
});
