import "../../tests/dom";
import { indexedDB } from "fake-indexeddb";
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
import { nativeDirectory } from "../../tests/native-fs";
import { InMemoryFileSystemAdapter } from "../engine/fs-adapter";
import {
  createHome,
  createHomeWorkspace,
  openHome,
  bringWorkspaceIntoHome,
} from "../engine/home-service";
import {
  createWorkspace,
  importProject,
  createManagedBranch,
} from "../engine/workspace-service";
import { captureRevision } from "../engine/revision-service";
import {
  clearAllConvenienceMetadata,
  saveWorkspaceWindowsPath,
} from "../engine/idb-store";

Object.assign(globalThis, { indexedDB });
afterEach(cleanup);
const notes = { problem: "", modification: "", observations: "" };
function pickerQueue() {
  const queue: FileSystemDirectoryHandle[] = [];
  let calls = 0;
  Object.assign(window, {
    showDirectoryPicker: async () => {
      calls++;
      const next = queue.shift();
      if (!next) throw new Error("Unexpected picker");
      return next;
    },
  });
  return { queue, calls: () => calls };
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
const ready = (ui: ReturnType<typeof render>, name: string) =>
  waitFor(() =>
    assert.equal(
      (ui.getAllByRole("button", { name })[0] as HTMLButtonElement).disabled,
      false,
    ),
  );
const changes = (ui: ReturnType<typeof render>) =>
  within(
    [...ui.container.querySelectorAll<HTMLElement>(".changes-page")].find(
      (p) => !p.parentElement!.hidden,
    )!,
  );
async function source(name = "CAD source") {
  const dir = new InMemoryFileSystemAdapter(name);
  await dir.writeFileText(["Parts", "Part.SLDPRT"], "synthetic bytes");
  return dir;
}

test("home creation uses one picker, workspace allocation uses names, and all three workspaces survive navigation and reopening", async () => {
  const picker = pickerQueue();
  const root = new InMemoryFileSystemAdapter("Cadtree");
  picker.queue.push(nativeDirectory(root));
  let ui = render(<App />);
  assert.equal(ui.queryByRole("button", { name: "History" }), null);
  assert.equal(ui.queryByRole("combobox", { name: "Active branch" }), null);
  fireEvent.click(ui.getByRole("button", { name: "Create Cadtree home" }));
  await ready(ui, "Create workspace");
  assert.equal(ui.queryByRole("dialog"), null);
  for (const name of ["Personal SolidWorks", "Client ABC", "AutoCAD"]) {
    fireEvent.click(ui.getByRole("button", { name: "Create workspace" }));
    const dialog = within(ui.getByRole("dialog"));
    assert.equal(dialog.queryByRole("button", { name: "Choose folder" }), null);
    fireEvent.change(dialog.getByRole("textbox", { name: "Workspace name" }), {
      target: { value: name },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Create workspace" }));
    await waitFor(() =>
      assert.ok(ui.getByRole("heading", { name: `${name}.` })),
    );
    await waitFor(() =>
      assert.equal(
        (ui.getByRole("button", { name: "Add project" }) as HTMLButtonElement)
          .disabled,
        false,
      ),
    );
    nav(ui, "All workspaces");
  }
  assert.equal(picker.calls(), 1);
  assert.equal(ui.getAllByRole("button", { name: "Open workspace" }).length, 3);
  assert.equal(ui.queryByRole("button", { name: "History" }), null);
  assert.equal(ui.queryByRole("combobox", { name: "Active branch" }), null);
  cleanup();
  await clearAllConvenienceMetadata();
  picker.queue.push(nativeDirectory(root));
  ui = render(<App />);
  fireEvent.click(ui.getByRole("button", { name: "Open Cadtree home" }));
  await waitFor(() =>
    assert.equal(
      ui.getAllByRole("button", { name: "Open workspace" }).length,
      3,
    ),
  );
  await ready(ui, "Open workspace");
  assert.equal(picker.calls(), 2);
  assert.equal(ui.queryByRole("dialog"), null);
});

test("workspace switching isolates scans, branches and project/branch drafts without additional pickers", async () => {
  const root = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(root);
  const a = await createHomeWorkspace(root, "cam 2");
  const b = await createHomeWorkspace(root, "autocad");
  const c = await createHomeWorkspace(root, "Client ABC");
  let projectA = await importProject(
    a.workspace.root,
    await source(),
    "Actuator",
  );
  const first = await captureRevision(
    projectA.workingFolders["branch-main"]!,
    projectA.vaultDir,
    {
      branchId: "branch-main",
      summary: "Main baseline",
      notes,
      workingFolders: projectA.workingFolders,
    },
  );
  const created = await createManagedBranch(
    a.workspace.root,
    projectA.record.containerPath,
    {
      sourceRevisionId: first.revision.manifest.revisionId,
      name: "Case A",
      reason: "Compare",
    },
  );
  projectA = created;
  const caseId = created.createdBranchId;
  await projectA.workingFolders[caseId]!.writeFileText(["Case-only.bin"], "A");
  await importProject(b.workspace.root, await source(), "Actuator");
  await importProject(c.workspace.root, await source(), "Other");
  const picker = pickerQueue();
  picker.queue.push(nativeDirectory(root));
  const ui = render(<App />);
  fireEvent.click(ui.getByRole("button", { name: "Open Cadtree home" }));
  await waitFor(() =>
    assert.equal(
      ui.getAllByRole("button", { name: "Open workspace" }).length,
      3,
    ),
  );
  await ready(ui, "Open workspace");
  const card = ui.getByRole("heading", { name: "cam 2" }).closest("article")!;
  fireEvent.click(within(card).getByRole("button", { name: "Open workspace" }));
  await ready(ui, "Open project");
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await idle(ui);
  fireEvent.change(ui.getByRole("combobox", { name: "Active branch" }), {
    target: { value: caseId },
  });
  await idle(ui);
  nav(ui, "Changes");
  fireEvent.change(
    changes(ui).getByRole("textbox", { name: /Revision summary/ }),
    { target: { value: "Case A draft" } },
  );
  fireEvent.click(
    changes(ui).getByRole("button", { name: "Add note for Case-only.bin" }),
  );
  fireEvent.change(
    changes(ui).getByRole("textbox", { name: "Case-only.bin: problem" }),
    { target: { value: "Case A engineering note" } },
  );
  const switcher = ui.getByRole("combobox", { name: "Switch workspace" });
  const options = (await openHome(root)).workspaces;
  fireEvent.change(switcher, {
    target: { value: options.find((e) => e.name === "autocad")!.key },
  });
  await waitFor(() => assert.ok(ui.getByRole("heading", { name: "autocad." })));
  await ready(ui, "Open project");
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await idle(ui);
  assert.equal(changes(ui).queryByText("Case-only.bin"), null);
  assert.equal(
    (
      changes(ui).getByRole("textbox", {
        name: /Revision summary/,
      }) as HTMLInputElement
    ).value,
    "",
  );
  fireEvent.change(
    changes(ui).getByRole("textbox", { name: /Revision summary/ }),
    { target: { value: "AutoCAD draft" } },
  );
  fireEvent.change(ui.getByRole("combobox", { name: "Switch workspace" }), {
    target: { value: options.find((e) => e.name === "cam 2")!.key },
  });
  await waitFor(() => assert.ok(ui.getByRole("heading", { name: "cam 2." })));
  await ready(ui, "Open project");
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await idle(ui);
  nav(ui, "Changes");
  assert.equal(
    (ui.getByRole("combobox", { name: "Active branch" }) as HTMLSelectElement)
      .value,
    caseId,
  );
  assert.equal(
    (
      changes(ui).getByRole("textbox", {
        name: /Revision summary/,
      }) as HTMLInputElement
    ).value,
    "Case A draft",
  );
  assert.equal(
    (
      changes(ui).getByRole("textbox", {
        name: "Case-only.bin: problem",
      }) as HTMLTextAreaElement
    ).value,
    "Case A engineering note",
  );
  assert.equal(picker.calls(), 1);
  assert.equal(ui.queryByRole("dialog"), null);
  // A delayed scan cannot switch workspaces or install another context mid-operation.
  let release!: () => void;
  let entered = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  root.setHooks({
    onBeforeRead: async (path) => {
      if (path.endsWith("/Part.SLDPRT") && !entered) {
        entered = true;
        await gate;
      }
    },
  });
  fireEvent.click(
    changes(ui).getByRole("button", { name: "Scan for changes" }),
  );
  await waitFor(() => assert.equal(entered, true));
  assert.equal(
    (
      ui.getByRole("combobox", {
        name: "Switch workspace",
      }) as HTMLSelectElement
    ).disabled,
    true,
  );
  fireEvent.change(ui.getByRole("combobox", { name: "Switch workspace" }), {
    target: { value: options.find((e) => e.name === "autocad")!.key },
  });
  nav(ui, "All workspaces");
  release();
  await idle(ui);
  root.setHooks({ onBeforeRead: undefined });
  assert.equal(
    (
      changes(ui).getByRole("textbox", {
        name: /Revision summary/,
      }) as HTMLInputElement
    ).value,
    "Case A draft",
  );
  assert.equal(
    (ui.getByRole("combobox", { name: "Active branch" }) as HTMLSelectElement)
      .value,
    caseId,
  );
  nav(ui, "All workspaces");
  assert.equal(ui.getAllByRole("button", { name: "Open workspace" }).length, 3);
});

test("guided whole-workspace migration identifies managed location and never reuses the old Windows root", async () => {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const original = new InMemoryFileSystemAdapter("cam 2");
  const ws = await createWorkspace(original);
  const p = await importProject(original, await source(), "Actuator");
  await p.workingFolders["branch-main"]!.writeFileText(
    ["Uncaptured.bin"],
    "current edits",
  );
  await saveWorkspaceWindowsPath(
    ws.identity.workspaceId,
    "D:\\Old external location",
  );
  const picker = pickerQueue();
  picker.queue.push(nativeDirectory(home), nativeDirectory(original));
  const ui = render(<App />);
  fireEvent.click(ui.getByRole("button", { name: "Open Cadtree home" }));
  await waitFor(() =>
    assert.equal(
      (
        ui.getByRole("button", {
          name: "Bring existing workspace into Cadtree",
        }) as HTMLButtonElement
      ).disabled,
      false,
    ),
  );
  fireEvent.click(
    ui.getByRole("button", { name: "Bring existing workspace into Cadtree" }),
  );
  await waitFor(() => assert.ok(ui.getByRole("heading", { name: "cam 2." })));
  await ready(ui, "Open project");
  assert.match(
    ui.container.textContent!,
    /Original workspace retained unchanged/,
  );
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await idle(ui);
  fireEvent.click(
    changes(ui).getByRole("button", {
      name: /Copy folder path.*Uncaptured.bin/,
    }),
  );
  await waitFor(() =>
    assert.ok(ui.getByRole("dialog", { name: "Set up folder-path copying" })),
  );
  assert.match(ui.getByRole("dialog").textContent!, /Cadtree home/);
  assert.equal(
    (
      ui.getByRole("textbox", {
        name: "Cadtree home folder path",
      }) as HTMLInputElement
    ).value,
    "",
  );
  assert.equal(picker.calls(), 2);
});

test("home groups retained migration attempts, shows missing workspaces, and resolves original/managed identity explicitly", async () => {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const original = new InMemoryFileSystemAdapter("cam 2");
  await createWorkspace(original);
  const abort = new AbortController();
  await assert.rejects(
    bringWorkspaceIntoHome(home, original, {
      signal: abort.signal,
      onProgress: (p) => {
        if (p.phase === "publishing_completion") abort.abort();
      },
    }),
  );
  await bringWorkspaceIntoHome(home, original);
  const missing = await createHomeWorkspace(home, "Missing workspace");
  await home.removeEntry([missing.directory], { recursive: true });
  const picker = pickerQueue();
  picker.queue.push(nativeDirectory(home), nativeDirectory(original));
  const ui = render(<App />);
  fireEvent.click(ui.getByRole("button", { name: "Open Cadtree home" }));
  await ready(ui, "Open workspace");
  assert.equal(ui.getAllByRole("article").length, 2);
  assert.ok(ui.getByText("Location details · 2 retained locations"));
  assert.ok(ui.getByText("Unavailable · Needs attention"));
  fireEvent.click(ui.getByText("Other locations"));
  fireEvent.click(
    ui.getByRole("button", { name: "Inspect external workspaces" }),
  );
  fireEvent.click(ui.getByRole("button", { name: /Open workspace/ }));
  await waitFor(() =>
    assert.ok(ui.getByRole("dialog", { name: "Choose workspace location" })),
  );
  fireEvent.click(ui.getByRole("button", { name: "Open managed workspace" }));
  await waitFor(() => assert.ok(ui.getByRole("heading", { name: "cam 2." })));
  await ready(ui, "Add project");
  nav(ui, "All workspaces");
  assert.equal(ui.getAllByRole("article").length, 2);
  assert.equal(ui.getAllByRole("button", { name: "Open workspace" }).length, 1);
});
