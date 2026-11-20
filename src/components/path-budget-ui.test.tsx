import "../../tests/dom";
import { indexedDB } from "fake-indexeddb";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, waitFor, within, type RenderResult } from "@testing-library/react";
import App from "../App";
import { CreateBranchDialog } from "./CreateBranchDialog";
import { FolderAddressDialog } from "./FolderAddressDialog";
import { compareApplyRecoverSample } from "../../tests/compare-apply-recover-sample";
import { appBusy, completeHomeAddress } from "../../tests/app-controls";
import { nativeDirectory } from "../../tests/native-fs";
import { clearAllConvenienceMetadata, getWorkspacePath } from "../engine/idb-store";
import { InMemoryFileSystemAdapter } from "../engine/fs-adapter";
import { createHome, openHome } from "../engine/home-service";
import { openWorkspace } from "../engine/workspace-service";
import { projectNameHint, workspaceNameHint } from "../utils/path-budget-message";
import type { RevisionManifest } from "../engine/types";

Object.assign(globalThis, { indexedDB });
afterEach(async () => {
  cleanup();
  await clearAllConvenienceMetadata();
  Reflect.deleteProperty(window, "showDirectoryPicker");
});

const body = () => document.body.textContent ?? "";
const settle = (ui: RenderResult) => waitFor(() => assert.equal(appBusy(ui), false));

/** A home address that leaves exactly `remaining` characters for a new workspace named `name`. */
function addressLeaving(remaining: number, name: string): string {
  for (let pad = 0; pad < 300; pad++) {
    const address = `D:\\${"h".repeat(pad)}`;
    if (workspaceNameHint(address, name)!.remaining === remaining) return address;
  }
  throw new Error("no address");
}

async function openHomeAt(ui: RenderResult, home: InMemoryFileSystemAdapter, address: string) {
  Object.defineProperty(window, "showDirectoryPicker", {
    configurable: true,
    value: async () => nativeDirectory(home),
  });
  fireEvent.click(ui.getByRole("button", { name: "Open my Cadtree home" }));
  await completeHomeAddress(ui, address);
  await settle(ui);
}

function createWorkspaceDialog(ui: RenderResult) {
  fireEvent.click(ui.getByRole("button", { name: /Create workspace/ }));
  return within(ui.getByRole("dialog", { name: "Create workspace" }));
}
const typeName = (dialog: ReturnType<typeof within>, label: string, value: string) =>
  fireEvent.change(dialog.getByRole("textbox", { name: label }), { target: { value } });
const submit = (dialog: ReturnType<typeof within>, name: string) =>
  dialog.getByRole("button", { name }) as HTMLButtonElement;

test("workspace name hint: silent above 30, counts below 30, blocks and disables submit when over", async () => {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const address = addressLeaving(40, "a");
  const ui = render(<App />);
  await openHomeAt(ui, home, address);
  const dialog = createWorkspaceDialog(ui);
  typeName(dialog, "Workspace name", "a".repeat(11));
  assert.ok(!/characters? left/.test(body()));
  typeName(dialog, "Workspace name", "a".repeat(12));
  assert.ok(body().includes("29 characters left"));
  assert.equal(submit(dialog, "Create workspace").disabled, false);
  typeName(dialog, "Workspace name", "a".repeat(43));
  assert.ok(body().includes("This location would need a 242-character path; the limit is 240. Shorten the workspace name by 2 characters"));
  assert.equal(submit(dialog, "Create workspace").disabled, true);
  typeName(dialog, "Workspace name", "a".repeat(5));
  assert.equal(submit(dialog, "Create workspace").disabled, false);
  assert.ok(!/characters? left/.test(body()));
});

test("an engine block (counter makes the name longer) shows the full message and writes nothing; a warning is added to the success banner", async () => {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  // Leaves 2 characters: fine for "aaaa", but "aaaa (2)" needs 4 more.
  const name = "a".repeat(41);
  const address = addressLeaving(2, name);
  const ui = render(<App />);
  await openHomeAt(ui, home, address);
  let dialog = createWorkspaceDialog(ui);
  typeName(dialog, "Workspace name", name);
  fireEvent.click(submit(dialog, "Create workspace"));
  await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
  await settle(ui);
  assert.ok(body().includes("This location uses 238 of 240 characters. Shorter names leave room for design cases and deeper folders."));
  assert.equal((await openHome(home)).workspaces.length, 1);

  fireEvent.click(ui.getByRole("button", { name: "Back to My workspaces" }));
  await settle(ui);
  dialog = createWorkspaceDialog(ui);
  typeName(dialog, "Workspace name", name.toUpperCase());
  fireEvent.click(submit(dialog, "Create workspace"));
  await waitFor(() => assert.ok(within(ui.getByRole("dialog")).getByRole("alert")));
  const alert = within(ui.getByRole("dialog")).getByRole("alert");
  const lines = [...alert.querySelectorAll("span")].map((s) => s.textContent);
  assert.equal(
    lines[0],
    "This location would need a 242-character path; the limit is 240. Shorten the workspace name by 2 characters, or move your Cadtree home closer to the drive (e.g. C:\\Cadtree).",
  );
  assert.ok(lines[1]!.startsWith(`${address}\\${name.toUpperCase()} (2)\\projects\\`));
  assert.equal(lines[1]!.length, 242);
  assert.equal(lines[2], "If your Cadtree home has moved, update its address in Home options.");
  assert.equal((await openHome(home)).workspaces.length, 1);
});

function manifest(): RevisionManifest {
  return {
    revisionId: "r1",
    branchId: "branch-main",
    displayNumber: 1,
    summary: "Baseline",
    files: [{ path: "Parts/Collar.SLDPRT" }],
    directories: ["Parts"],
  } as unknown as RevisionManifest;
}

function caseDialog(projectAddress: string | undefined) {
  return render(
    <CreateBranchDialog
      source={manifest()}
      sourceBranchName="Main"
      branchNames={[]}
      busy={false}
      progress={null}
      onCreate={async () => {}}
      onClose={() => {}}
      onCancel={() => {}}
      managedDestination="projects/Gripper/working"
      projectAddress={projectAddress}
    />,
  );
}

test("design case dialog: hint below 30 left, block text and disabled submit when over, nothing when the address is unknown", () => {
  // The 32-character incomplete marker is longer than the short source file, so it decides: working/<folder>/<marker>.crswap.
  const unknown = caseDialog(undefined);
  fireEvent.change(unknown.getByRole("textbox", { name: "Case name" }), { target: { value: "x".repeat(300) } });
  assert.ok(!/characters? left|would need/.test(body()));
  unknown.unmount();
  const base = "D:\\Cadtree\\W\\projects\\P";
  const fixed = (base + "\\working\\\\_CADTREE_RECOVERY_INCOMPLETE.txt.crswap").length;
  const room = 240 - fixed; // name length that lands exactly on 240
  const ui = caseDialog(base);
  const name = (n: number) => fireEvent.change(ui.getByRole("textbox", { name: "Case name" }), { target: { value: "c".repeat(n) } });
  const create = () => ui.getByRole("button", { name: "Create design case" }) as HTMLButtonElement;
  name(room - 30);
  assert.ok(!/characters? left/.test(body()));
  name(room - 29);
  assert.ok(body().includes("29 characters left"));
  name(room);
  assert.ok(body().includes("0 characters left"));
  assert.equal(create().disabled, false);
  name(room + 3);
  assert.ok(body().includes("Shorten the design case name by 3 characters"));
  assert.equal(create().disabled, true);
});

test("home setup warns, without blocking, only when the address leaves less than the default name allowances", async () => {
  const saved: string[] = [];
  const ui = render(
    <FolderAddressDialog home folderName="Cadtree" onSave={async (p) => void saved.push(p)} onCancel={() => {}} />,
  );
  assert.ok(body().includes("used for copying locations and to keep paths within Windows' limit"));
  const input = ui.getByRole("textbox", { name: "Cadtree home folder address" });
  const type = (value: string) => fireEvent.change(input, { target: { value } });
  type("D:\\Cadtree");
  assert.ok(!body().includes("This address is long"));
  // A normal 43-character address needs 213 characters: no warning.
  type("/Users/" + "x".repeat(36));
  assert.ok(!body().includes("This address is long"));
  // 75 characters need 245: warns, with the POSIX example.
  const posix = "/Users/" + "x".repeat(68);
  type(posix);
  assert.ok(
    body().includes(
      "This address is long: with typical workspace and project names, projects here would need 245 characters (limit 240). A shorter home such as /Users/<you>/Cadtree leaves more room.",
    ),
  );
  const long = "D:\\" + "h".repeat(120);
  type(long);
  assert.match(body(), /would need \d+ characters \(limit 240\)\. A shorter home such as C:\\Cadtree leaves more room\./);
  fireEvent.click(ui.getByRole("button", { name: "Complete setup" }));
  await waitFor(() => assert.deepEqual(saved, [long]));
});

test("editing a home address shows the current address and the 'still where' note", async () => {
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const ui = render(<App />);
  await openHomeAt(ui, home, "D:\\Cadtree");
  fireEvent.click(ui.getByText("Home options"));
  fireEvent.click(ui.getByRole("button", { name: "Edit home folder address" }));
  await waitFor(() =>
    assert.equal(
      (ui.getByRole("textbox", { name: "Cadtree home folder address" }) as HTMLInputElement).value,
      "D:\\Cadtree",
    ),
  );
  assert.ok(body().includes("Is this still where your Cadtree home is? Update it if you moved the folder."));
});

async function openSampleProject() {
  const sample = await compareApplyRecoverSample();
  const ui = render(<App />);
  await openHomeAt(ui, sample.home, "D:\\Cadtree");
  fireEvent.click(ui.getByRole("button", { name: "Open workspace" }));
  await settle(ui);
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await settle(ui);
  return { sample, ui };
}

async function forgetAddresses(ui: RenderResult) {
  const nav = within(ui.getByRole("navigation", { name: "Primary navigation" }));
  fireEvent.click(nav.getByRole("button", { name: "Settings" }));
  fireEvent.click(within(ui.container.querySelector<HTMLElement>(".settings-page")!).getByText("Troubleshooting", { selector: "summary" }));
  fireEvent.click(ui.getByText("Reset folder connections"));
  fireEvent.click(ui.getByRole("button", { name: "Reset all remembered folder connections in this browser" }));
  const dialog = within(ui.getByRole("dialog", { name: "Reset all remembered folder connections?" }));
  fireEvent.click(dialog.getByRole("button", { name: "Reset all remembered folder connections" }));
  await settle(ui);
  await waitFor(() => assert.ok(ui.getByRole("heading", { name: "History." })));
}

const caseCount = async (sample: Awaited<ReturnType<typeof compareApplyRecoverSample>>) => {
  const entry = (await openWorkspace(
    (await openHome(sample.home)).workspaces[0].workspace!.root,
  )).projects[0].project!;
  return entry.vaultState.branches.length;
};

test("a home with no saved address is asked once before creating a design case: Cancel writes nothing, Save continues", async () => {
  const { sample, ui } = await openSampleProject();
  const before = await caseCount(sample);
  await forgetAddresses(ui);
  assert.equal(await getWorkspacePath((await openHome(sample.home)).identity.homeId), "");
  const openCaseDialog = async (name = "Prompted case") => {
    fireEvent.click(ui.getAllByRole("button", { name: "Create design case from this version" })[0]!);
    const dialog = within(await ui.findByRole("dialog", { name: "Create design case" }));
    fireEvent.change(dialog.getByRole("textbox", { name: "Case name" }), { target: { value: name } });
    fireEvent.change(dialog.getByRole("textbox", { name: "Why" }), { target: { value: "Prompt test" } });
    fireEvent.click(dialog.getByRole("button", { name: "Create design case" }));
  };
  await openCaseDialog();
  let prompt = within(await ui.findByRole("dialog", { name: "Add your Cadtree home address" }));
  assert.ok(body().includes("cAdtree needs the full address to keep paths within Windows' limit"));
  fireEvent.click(prompt.getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.ok(!ui.queryByRole("dialog", { name: "Add your Cadtree home address" })));
  await waitFor(() => assert.ok(body().includes("Nothing was created.")));
  assert.equal(await caseCount(sample), before);

  fireEvent.click(within(ui.getByRole("dialog", { name: "Create design case" })).getByRole("button", { name: "Create design case" }));
  prompt = within(await ui.findByRole("dialog", { name: "Add your Cadtree home address" }));
  fireEvent.change(prompt.getByRole("textbox", { name: "Cadtree home folder address" }), { target: { value: "D:\\Cadtree" } });
  fireEvent.click(prompt.getByRole("button", { name: "Complete setup" }));
  await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
  await settle(ui);
  assert.equal(await caseCount(sample), before + 1);
  assert.equal(await getWorkspacePath((await openHome(sample.home)).identity.homeId, nativeDirectory(sample.home)), "D:\\Cadtree");

  // Saved: the next create does not ask again.
  await openCaseDialog("Second case");
  await waitFor(() => assert.ok(!ui.queryByRole("dialog")));
  await settle(ui);
  assert.equal(await caseCount(sample), before + 2);
});

test("project dialog: hint and disabled submit from the workspace address; with no saved address Create project asks first and Cancel writes nothing", async () => {
  const sample = await compareApplyRecoverSample();
  let address = "";
  for (let pad = 0; pad < 300 && !address; pad++) {
    const candidate = `D:\\${"h".repeat(pad)}`;
    if (projectNameHint(`${candidate}\\Tutorial Workspace`, "a")!.remaining === 40) address = candidate;
  }
  assert.ok(address);
  const ui = render(<App />);
  await openHomeAt(ui, sample.home, address);
  fireEvent.click(ui.getByRole("button", { name: "Open workspace" }));
  await settle(ui);
  fireEvent.click(ui.getByRole("button", { name: /Create project/ }));
  const dialog = within(ui.getByRole("dialog", { name: "Create project" }));
  await waitFor(() => assert.ok(dialog.getByRole("textbox", { name: "Project name" })));
  const name = (n: number) => typeName(dialog, "Project name", "p".repeat(n));
  // The workspace address resolves asynchronously; wait for the hint to appear.
  await waitFor(() => {
    name(12);
    assert.ok(body().includes("29 characters left"));
  });
  name(11);
  assert.ok(!/characters? left/.test(body()));
  name(43);
  assert.ok(body().includes("Shorten the project name by 2 characters"));
  assert.equal(submit(dialog, "Create project").disabled, true);
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));

  // Forget the address, then Create project must ask first.
  fireEvent.click(ui.getByRole("button", { name: "Back to My workspaces" }));
  await settle(ui);
  fireEvent.click(ui.getByRole("button", { name: "Open workspace" }));
  await settle(ui);
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await settle(ui);
  await forgetAddresses(ui);
  fireEvent.click(ui.getByRole("button", { name: "My workspaces" }));
  await settle(ui);
  fireEvent.click(ui.getByRole("button", { name: "Open workspace" }));
  await settle(ui);
  fireEvent.click(ui.getByRole("button", { name: /Create project/ }));
  const form = within(ui.getByRole("dialog", { name: "Create project" }));
  typeName(form, "Project name", "No address yet");
  fireEvent.click(submit(form, "Create project"));
  const prompt = within(await ui.findByRole("dialog", { name: "Add your Cadtree home address" }));
  fireEvent.click(prompt.getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.ok(body().includes("Nothing was created.")));
  const root = (await openHome(sample.home)).workspaces[0].workspace!.root;
  assert.equal((await openWorkspace(root)).projects.length, 1);
});

test("a second prompt replaces a pending one: the first action is cancelled, one dialog remains, nothing is written", async () => {
  const { sample, ui } = await openSampleProject();
  const before = await caseCount(sample);
  await forgetAddresses(ui);
  fireEvent.click(ui.getAllByRole("button", { name: "Create design case from this version" })[0]!);
  const dialog = within(await ui.findByRole("dialog", { name: "Create design case" }));
  fireEvent.change(dialog.getByRole("textbox", { name: "Case name" }), { target: { value: "Twice" } });
  fireEvent.change(dialog.getByRole("textbox", { name: "Why" }), { target: { value: "Overwrite" } });
  const create = dialog.getByRole("button", { name: "Create design case" });
  fireEvent.click(create);
  await ui.findByRole("dialog", { name: "Add your Cadtree home address" });
  fireEvent.click(create);
  await waitFor(() => assert.ok(body().includes("Nothing was created.")));
  assert.equal(ui.getAllByRole("dialog", { name: "Add your Cadtree home address" }).length, 1);
  fireEvent.click(within(ui.getByRole("dialog", { name: "Add your Cadtree home address" })).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.ok(!ui.queryByRole("dialog", { name: "Add your Cadtree home address" })));
  assert.equal(await caseCount(sample), before);
});
