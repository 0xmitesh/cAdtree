import "../../tests/dom";
import {
  appBusy,
  currentBranchId,
  selectBranch,
  completeHomeAddress,
} from "../../tests/app-controls";
import { indexedDB } from "fake-indexeddb";
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
      ui.container.querySelector("main")?.getAttribute("aria-busy"),
      "false",
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

test("cancelled home folder selection shows one red warning and leaves the welcome actions usable", async () => {
  Object.assign(window, {
    showDirectoryPicker: async () => {
      throw new DOMException("The user aborted a request.", "AbortError");
    },
  });
  const ui = render(<App />);
  fireEvent.click(ui.getByRole("button", { name: "Start my Cadtree home" }));
  await waitFor(() => assert.ok(ui.getByRole("alert")));
  await idle(ui);
  const alert = ui.getByRole("alert");
  assert.equal(ui.getAllByRole("alert").length, 1);
  assert.ok(alert.classList.contains("error"));
  assert.equal(alert.textContent, "Choose an empty dedicated folder, suggested name Cadtree. Use Open Cadtree home for a recognized existing home.");
  assert.ok(alert.closest(".app-status-feedback"));
  assert.equal(ui.queryByRole("dialog"), null);
  assert.equal((ui.getByRole("button", { name: "Start my Cadtree home" }) as HTMLButtonElement).disabled, false);
  fireEvent.click(within(alert).getByRole("button", { name: "Dismiss message" }));
  assert.equal(ui.queryByRole("alert"), null);
  fireEvent.click(ui.getByRole("button", { name: "Open my Cadtree home" }));
  await waitFor(() => assert.match(ui.getByRole("alert").textContent!, /Choose your existing Cadtree home folder/));
  assert.equal(ui.getAllByRole("alert").length, 1);
});

test("rejecting a populated new-home folder shows one warning and retry clears it without touching files", async () => {
  const occupied = new InMemoryFileSystemAdapter("Existing files");
  await occupied.writeFileText(["Keep.SLDPRT"], "unchanged CAD bytes");
  const empty = new InMemoryFileSystemAdapter("New Cadtree");
  const picker = pickerQueue();
  picker.queue.push(nativeDirectory(occupied), nativeDirectory(empty));
  const ui = render(<App />);
  fireEvent.click(ui.getByRole("button", { name: "Start my Cadtree home" }));
  await waitFor(() => assert.equal(ui.getAllByRole("alert").length, 1));
  await idle(ui);
  assert.equal(ui.getAllByRole("alert").length, 1);
  assert.match(ui.getByRole("alert").textContent!, /Choose an empty dedicated folder/);
  assert.equal(ui.getAllByText(/Choose an empty dedicated folder/).length, 1);
  assert.equal(await occupied.readFileText(["Keep.SLDPRT"]), "unchanged CAD bytes");
  assert.equal((await occupied.listEntries()).length, 1);
  assert.equal(ui.queryByRole("dialog"), null);
  fireEvent.click(ui.getByRole("button", { name: "Start my Cadtree home" }));
  await waitFor(() => assert.ok(ui.getByRole("dialog", { name: "Complete home setup" })));
  assert.equal(ui.queryByRole("alert"), null);
  assert.equal((await empty.listEntries()).length, 0);
});

test("home creation uses one picker, workspace allocation uses names, and all three workspaces survive navigation and reopening", async () => {
  const picker = pickerQueue();
  const root = new InMemoryFileSystemAdapter("Cadtree");
  picker.queue.push(nativeDirectory(root));
  let ui = render(<App />);
  assert.equal(ui.queryByRole("button", { name: "History" }), null);
  assert.equal(ui.queryByRole("combobox", { name: "Active branch" }), null);
  fireEvent.click(ui.getByRole("button", { name: "Start my Cadtree home" }));
  await completeHomeAddress(ui);
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
        (ui.getByRole("button", { name: "Create project" }) as HTMLButtonElement)
          .disabled,
        false,
      ),
    );
    nav(ui, "My workspaces");
  }
  assert.equal(picker.calls(), 1);
  assert.equal(ui.getAllByRole("button", { name: "Open workspace" }).length, 3);
  assert.equal(ui.queryByRole("button", { name: "History" }), null);
  assert.equal(ui.queryByRole("combobox", { name: "Active branch" }), null);
  cleanup();
  await clearAllConvenienceMetadata();
  picker.queue.push(nativeDirectory(root));
  ui = render(<App />);
  fireEvent.click(ui.getByRole("button", { name: "Open my Cadtree home" }));
  await completeHomeAddress(ui);
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
  fireEvent.click(ui.getByRole("button", { name: "Open my Cadtree home" }));
  await completeHomeAddress(ui);
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
  await selectBranch(ui, caseId);
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
  fireEvent.click(ui.getByRole("treeitem", { name: "autocad" }));
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
  fireEvent.click(ui.getByRole("treeitem", { name: "cam 2" }));
  await waitFor(() => assert.ok(ui.getByRole("heading", { name: "cam 2." })));
  await ready(ui, "Open project");
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await idle(ui);
  nav(ui, "Changes");
  assert.equal(currentBranchId(ui), caseId);
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
    ui.getByRole("treeitem", { name: "autocad" }).getAttribute("aria-disabled"),
    "true",
  );
  fireEvent.click(ui.getByRole("treeitem", { name: "autocad" }));
  nav(ui, "My workspaces");
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
  assert.equal(currentBranchId(ui), caseId);
  nav(ui, "My workspaces");
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
  fireEvent.click(ui.getByRole("button", { name: "Open my Cadtree home" }));
  await completeHomeAddress(ui);
  fireEvent.click(ui.getByText("Home options"));
  fireEvent.click(
    ui.getByRole("button", { name: "Import existing workspace" }),
  );
  fireEvent.click(ui.getByRole("button", { name: "Choose workspace folder" }));
  await waitFor(() => assert.ok(ui.getByRole("heading", { name: "cam 2." })));
  await ready(ui, "Open project");
  assert.match(
    ui.container.textContent!,
    /Original workspace retained unchanged/,
  );
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await idle(ui);
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        copied.push(value);
      },
    },
  });
  fireEvent.click(
    changes(ui).getByRole("button", {
      name: /Copy folder path.*Uncaptured.bin/,
    }),
  );
  await waitFor(() => assert.equal(copied.length, 1));
  assert.ok(copied[0].startsWith("D:\\Cadtree\\"));
  assert.ok(!copied[0].includes("Old external location"));
  assert.equal(ui.queryByRole("dialog"), null);
  assert.equal(picker.calls(), 2);
});

test("home groups retained migration attempts and opens the managed workspace while missing workspaces remain unavailable", async () => {
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
  fireEvent.click(ui.getByRole("button", { name: "Open my Cadtree home" }));
  await completeHomeAddress(ui);
  await ready(ui, "Open workspace");
  assert.equal(ui.getAllByRole("article").length, 2);
  assert.ok(ui.getByText("Location details · 2 retained locations"));
  assert.ok(ui.getByText("Unavailable · Needs attention"));
  fireEvent.click(ui.getByRole("button", { name: "Open workspace" }));
  await waitFor(() => assert.ok(ui.getByRole("heading", { name: "cam 2." })));
  await ready(ui, "Create project");
  nav(ui, "My workspaces");
  assert.equal(ui.getAllByRole("article").length, 2);
  assert.equal(ui.getAllByRole("button", { name: "Open workspace" }).length, 1);
});

test("sidebar explorer expands independently, navigates projects and branches across workspaces, and retains scoped drafts", async () => {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const cam = await createHomeWorkspace(home, "cam 2");
  const client = await createHomeWorkspace(home, "Concept Lab");
  let p = await importProject(cam.workspace.root, await source(), "Actuator");
  const baseline = await captureRevision(
    p.workingFolders["branch-main"]!,
    p.vaultDir,
    {
      branchId: "branch-main",
      summary: "Baseline",
      notes,
      workingFolders: p.workingFolders,
    },
  );
  const branched = await createManagedBranch(
    cam.workspace.root,
    p.record.containerPath,
    {
      sourceRevisionId: baseline.revision.manifest.revisionId,
      name: "Case A",
      reason: "Compare",
    },
  );
  p = branched;
  await p.workingFolders[branched.createdBranchId]!.writeFileText(
    ["Case-only.bin"],
    "case change",
  );
  await p.workingFolders["branch-main"]!.writeFileText(
    ["Pending.bin"],
    "main change",
  );
  await importProject(client.workspace.root, await source(), "Cable Guide");
  const picker = pickerQueue();
  picker.queue.push(nativeDirectory(home));
  const ui = render(<App />);
  fireEvent.click(ui.getByRole("button", { name: "Open my Cadtree home" }));
  await completeHomeAddress(ui);
  await ready(ui, "Open workspace");
  const tree = within(ui.getByRole("tree", { name: "Workspace explorer" }));
  const camFolder = tree.getByRole("treeitem", { name: "cam 2" });
  fireEvent.click(tree.getByRole("button", { name: "Expand cam 2" }));
  assert.equal(camFolder.getAttribute("aria-expanded"), "true");
  assert.equal(ui.queryByRole("combobox", { name: "Active branch" }), null);
  fireEvent.click(tree.getByRole("treeitem", { name: "Actuator, cam 2" }));
  await idle(ui);
  assert.ok(
    !within(ui.getByRole("navigation")).queryByRole("button", {
      name: "cam 2",
    }),
  );
  nav(ui, "Changes");
  fireEvent.change(
    changes(ui).getByRole("textbox", { name: /Revision summary/ }),
    { target: { value: "Main draft" } },
  );
  fireEvent.click(tree.getByRole("treeitem", { name: "cam 2" }));
  assert.ok(ui.getByRole("heading", { name: "cam 2." }));
  nav(ui, "Changes");
  assert.equal(
    (
      changes(ui).getByRole("textbox", {
        name: /Revision summary/,
      }) as HTMLInputElement
    ).value,
    "Main draft",
  );
  const main = tree.getByRole("treeitem", { name: "Main, Actuator, cam 2" });
  act(() => main.focus());
  fireEvent.keyDown(main, { key: "ArrowDown" });
  assert.ok(
    document.activeElement ===
      tree.getByRole("treeitem", { name: "Case A, Actuator, cam 2" }),
  );
  assert.equal(currentBranchId(ui), "branch-main");
  fireEvent.keyDown(
    tree.getByRole("treeitem", { name: "Case A, Actuator, cam 2" }),
    { key: "Enter" },
  );
  await idle(ui);
  assert.equal(currentBranchId(ui), branched.createdBranchId);
  assert.equal(
    tree
      .getByRole("treeitem", { name: "Case A, Actuator, cam 2" })
      .getAttribute("aria-selected"),
    "true",
  );
  nav(ui, "Changes");
  assert.ok(changes(ui).getByText("Case-only.bin"));
  fireEvent.click(tree.getByRole("button", { name: "Expand Concept Lab" }));
  fireEvent.click(
    tree.getByRole("treeitem", { name: "Cable Guide, Concept Lab" }),
  );
  await idle(ui);
  assert.ok(
    !within(ui.getByRole("navigation")).queryByRole("button", {
      name: "Concept Lab",
    }),
  );
  assert.equal(changes(ui).queryByText("Case-only.bin"), null);
  fireEvent.click(tree.getByRole("treeitem", { name: "Actuator, cam 2" }));
  await idle(ui);
  fireEvent.click(
    tree.getByRole("treeitem", { name: "Main, Actuator, cam 2" }),
  );
  await idle(ui);
  nav(ui, "Changes");
  assert.equal(
    (
      changes(ui).getByRole("textbox", {
        name: /Revision summary/,
      }) as HTMLInputElement
    ).value,
    "Main draft",
  );
  fireEvent.click(tree.getByRole("button", { name: "Collapse cam 2" }));
  assert.equal(tree.queryByRole("treeitem", { name: "Actuator, cam 2" }), null);
  assert.equal(currentBranchId(ui), "branch-main");
  assert.equal(picker.calls(), 1);
});

test("folder browser opens in a dialog, supports keyboard traversal, and closes after navigation", async () => {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  await createHomeWorkspace(home, "Client ABC");
  const picker = pickerQueue();
  picker.queue.push(nativeDirectory(home));
  const ui = render(<App />);
  fireEvent.click(ui.getByRole("button", { name: "Open my Cadtree home" }));
  await completeHomeAddress(ui);
  await ready(ui, "Open workspace");
  fireEvent.click(ui.getByRole("button", { name: "Browse folders" }));
  const dialog = within(ui.getByRole("dialog", { name: "Browse folders" }));
  const tree = within(dialog.getByRole("tree"));
  const root = tree.getByRole("treeitem", { name: "Cadtree home" });
  act(() => root.focus());
  fireEvent.keyDown(root, { key: "ArrowDown" });
  const client = tree.getByRole("treeitem", { name: "Client ABC" });
  assert.ok(document.activeElement === client);
  fireEvent.keyDown(client, { key: "Enter" });
  await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
  assert.ok(ui.getByRole("heading", { name: "Client ABC." }));
  assert.ok(
    !within(ui.getByRole("navigation")).queryByRole("button", {
      name: "Client ABC",
    }),
  );
});
