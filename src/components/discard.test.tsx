import "../../tests/dom";
import { indexedDB } from "fake-indexeddb";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, cleanup, fireEvent, render, renderHook, waitFor, within } from "@testing-library/react";
import App from "../App";
import { compareApplyRecoverSample } from "../../tests/compare-apply-recover-sample";
import { appBusy, openHomeWorkspace, scannedAt, waitForScan } from "../../tests/app-controls";
import { clearAllConvenienceMetadata } from "../engine/idb-store";
import { scenarioState } from "../../tests/history-data";
import { ChangesCaptureView } from "./ChangesCaptureView";
import { DiscardDialog, type DiscardController } from "./DiscardDialog";
import { ApplyPreviewDialog, type ApplicationController } from "./ApplyPreviewDialog";
import { ReplacePlanChangedError, type ReplacePlan } from "../engine/apply-preview";
import type { FileEntry, ScanResult } from "../engine/types";
import {
  discardAllPaths,
  discardSuccessMessage,
  useDiscardActions,
  type DiscardReview,
} from "../app/useDiscardActions";
import type { Context, Perform } from "../app/types";
import { InMemoryFileSystemAdapter } from "../engine/fs-adapter";

Object.assign(globalThis, { indexedDB });
afterEach(async () => {
  cleanup();
  await clearAllConvenienceMetadata();
  Reflect.deleteProperty(window, "showDirectoryPicker");
});

// ---- Pure pieces and a fake controller ----
const entry = (path: string, sha = "1"): FileEntry => ({ path, sha256: sha.repeat(8), size: 3, lastModified: 0 });
function fakePlan(actions: ReplacePlan["actions"], folderActions: ReplacePlan["folderActions"] = [], blockers: string[] = []): ReplacePlan {
  return {
    mode: "discard",
    projectId: "p",
    sourceRevisionId: "r1",
    destinationRevisionId: "r1",
    baseRevisionId: "r1",
    destinationBranchId: "branch-main",
    reason: "",
    actions,
    folderActions,
    blockers,
    ready: !blockers.length,
  };
}
const action = (path: string, before: FileEntry | null, after: FileEntry | null) => ({
  path,
  sourceChange: (!before ? "added" : !after ? "deleted" : "modified") as "added" | "deleted" | "modified",
  decision: "use-source" as const,
  operation: (after ? (before ? "replace" : "add") : "delete") as "replace" | "add" | "delete",
  base: before,
  source: after,
  before,
  after,
});
const reviewOf = (plan: ReplacePlan, paths = ["x"]): DiscardReview => ({
  projectId: "p", branchId: "branch-main", targetRevisionId: "r1", paths, plan, hash: "h",
});
function fakeController(reviews: DiscardReview[], extra: Partial<DiscardController> = {}) {
  const calls = { review: [] as unknown[], discard: [] as DiscardReview[] };
  let i = 0;
  const controller: DiscardController = {
    review: async (branchId, selection) => {
      calls.review.push([branchId, selection]);
      return reviews[Math.min(i++, reviews.length - 1)];
    },
    discard: async (review) => {
      calls.discard.push(review);
      return undefined;
    },
    progress: null,
    cancel: () => {},
    ...extra,
  };
  return { controller, calls };
}

test("Discard dialog: lists what happens to each file and folder and says where the copy goes", async () => {
  const plan = fakePlan(
    [
      action("A.txt", entry("A.txt", "2"), entry("A.txt", "1")),
      action("New.txt", entry("New.txt"), null),
      action("Gone.txt", null, entry("Gone.txt")),
    ],
    [{ path: "Added", operation: "remove", sourceChange: "deleted" }, { path: "Old", operation: "create", sourceChange: "added" }],
  );
  const { controller, calls } = fakeController([reviewOf(plan)]);
  const ui = render(<DiscardDialog branchId="branch-main" selection="all" caseName="Main" controller={controller} onClose={() => {}} />);
  await waitFor(() => assert.ok(ui.getByRole("status", { name: "What will change" })));
  assert.deepEqual(calls.review, [["branch-main", "all"]]);
  const dialog = ui.getByRole("dialog", { name: "Discard all changes in Main" });
  assert.match(dialog.textContent!, /5 changes will be discarded/);
  for (const [name, path] of [
    ["Put back to the saved version", "A.txt"],
    ["Removed (not in the saved version)", "New.txt"],
    ["Brought back (deleted since the last save)", "Gone.txt"],
    ["Folders removed", "Added/"],
    ["Folders brought back", "Old/"],
  ])
    assert.ok(within(ui.getByRole("region", { name })).getByText(path), name);
  assert.match(ui.getByTestId("discard-copy-line").textContent!, /^A copy of your edits will be kept in a folder like Discarded\/\d{4}-\d\d-\d\d \d\d\.\d\d in the project folder\.$/);
});

test("Discard dialog: deletions alone keep no copy, so there is no copy line", async () => {
  const { controller } = fakeController([reviewOf(fakePlan([action("Gone.txt", null, entry("Gone.txt"))]))]);
  const ui = render(<DiscardDialog branchId="branch-main" selection={["Gone.txt"]} caseName="Main" controller={controller} onClose={() => {}} />);
  await waitFor(() => assert.ok(ui.getByRole("dialog", { name: "Discard this change" }).textContent!.includes("1 change will be discarded")));
  assert.equal(ui.queryByTestId("discard-copy-line"), null);
});

test("Discard dialog: a stale plan (ReplacePlanChangedError) reviews again with a fresh plan; other errors, even with the same words, are shown as they are", async () => {
  const first = reviewOf(fakePlan([action("A.txt", entry("A.txt", "2"), entry("A.txt"))]));
  const second = reviewOf(fakePlan([action("A.txt", entry("A.txt", "3"), entry("A.txt")), action("B.txt", entry("B.txt"), null)]));
  let attempt = 0;
  let closed = 0;
  const { controller, calls } = fakeController([first, second], {
    discard: async () => {
      attempt++;
      if (attempt === 1) throw new ReplacePlanChangedError();
      if (attempt === 2) throw new Error("Changes differ from what you saw; review again. Not a typed error.");
      throw new Error(
        "Too many discards in the same minute (2026-11-20 10.00). Wait a minute and try again. No working files were changed.",
      );
    },
  });
  const ui = render(<DiscardDialog branchId="branch-main" selection="all" caseName="Main" controller={controller} onClose={() => closed++} />);
  const confirm = () => ui.getByRole("button", { name: "Discard" });
  await waitFor(() => assert.equal(confirm().hasAttribute("disabled"), false));
  fireEvent.click(confirm());
  await waitFor(() => assert.ok(ui.getByText("Changes differ from what you saw; review again.")));
  await waitFor(() => assert.match(ui.getByRole("dialog").textContent!, /2 changes will be discarded/));
  assert.equal(calls.review.length, 2, "the review was built again");
  fireEvent.click(confirm());
  await waitFor(() => assert.ok(ui.getByText("Changes differ from what you saw; review again. Not a typed error.")));
  assert.equal(ui.queryByText("Changes differ from what you saw; review again."), null);
  assert.equal(calls.review.length, 2, "text alone does not review again");
  await waitFor(() => assert.equal(confirm().hasAttribute("disabled"), false));
  fireEvent.click(confirm());
  await waitFor(() => assert.ok(ui.getByText(/Wait a minute and try again\. No working files were changed\./)));
  assert.equal(closed, 0);
});

test("Discard dialog: a blocked plan or a blocked case disables Discard", async () => {
  const { controller } = fakeController([reviewOf(fakePlan([action("A.txt", entry("A.txt", "2"), entry("A.txt"))], [], ["Can't read A.txt: locked"]))]);
  const ui = render(<DiscardDialog branchId="branch-main" selection="all" caseName="Main" controller={controller} onClose={() => {}} />);
  await waitFor(() => assert.ok(ui.getByText("Can't read A.txt: locked")));
  assert.ok(ui.getByRole("button", { name: "Discard" }).hasAttribute("disabled"));
  cleanup();
  const blocked = fakeController([reviewOf(fakePlan([action("A.txt", entry("A.txt", "2"), entry("A.txt"))]))], { blockedReason: "This case is hidden." });
  const ui2 = render(<DiscardDialog branchId="branch-main" selection="all" caseName="Main" controller={blocked.controller} onClose={() => {}} />);
  await waitFor(() => assert.ok(ui2.getByRole("status", { name: "What will change" })));
  assert.ok(ui2.getByRole("button", { name: "Discard" }).hasAttribute("disabled"));
});

test("discardAllPaths takes every change but leaves untracked OS clutter outside discarded folders alone", () => {
  const scan = {
    added: [entry("New.txt"), entry(".DS_Store"), entry("Added/.DS_Store")],
    modified: [{ previous: entry("A.txt"), current: entry("A.txt", "2") }],
    deleted: [entry("Gone.txt")],
    addedDirectories: ["Added"],
    deletedDirectories: ["Old"],
  } as unknown as ScanResult;
  const baseline = { files: [entry("A.txt"), entry("Gone.txt")] } as never;
  assert.deepEqual(discardAllPaths(scan, baseline), ["A.txt", "Added", "Gone.txt", "New.txt", "Old"]);
});

test("success message: count, the copy's folder, and files kept inside cAdtree only", () => {
  const plan = fakePlan([action("A.txt", entry("A.txt", "2"), entry("A.txt")), action("Gone.txt", null, entry("Gone.txt"))]);
  assert.equal(
    discardSuccessMessage({ plan, keptAs: "Discarded/2026-11-20 10.00", keptInsideOnly: [] }),
    "Discarded 2 changes. A copy is in Discarded/2026-11-20 10.00.",
  );
  assert.equal(discardSuccessMessage({ plan: fakePlan([action("Gone.txt", null, entry("Gone.txt"))]), keptAs: null, keptInsideOnly: [] }), "Discarded 1 change.");
  assert.match(
    discardSuccessMessage({ plan, keptAs: "Discarded/x", keptInsideOnly: ["Deep/long.txt"] }),
    /Kept inside cAdtree only \(the path was too long for the Discarded folder\): Deep\/long\.txt\.$/,
  );
});

test("Discard is not offered for a project outside a workspace (the project folder is unknown)", async () => {
  const perform = (async (_k: string, action: (c: Context) => Promise<unknown>) =>
    action({ version: 0, signal: new AbortController().signal, current: () => true, progress: () => {} })) as unknown as Perform;
  const { result } = renderHook(() =>
    useDiscardActions({
      vaultDir: new InMemoryFileSystemAdapter("V"),
      vaultState: scenarioState("single"),
      workingDir: null,
      workingFolders: {},
      activeBranchId: "branch-main",
      managedProject: null,
      workspace: null,
      perform,
      assertProjectWritable: async () => null,
      applyVaultState: () => {},
      requestAutoRefresh: () => {},
      setStatusBanner: () => {},
    }),
  );
  assert.equal(result.current.discardBlock, "Discard is available for projects in a workspace.");
  await assert.rejects(result.current.reviewDiscard("branch-main", "all"), /projects in a workspace/);
});

// ---- Changes view controls ----
function changesView(discard?: DiscardController) {
  const state = scenarioState("single");
  const scan: ScanResult = {
    scannedAt: new Date().toISOString(),
    branchId: "branch-main",
    baselineRevisionId: null,
    baselineDisplayNumber: null,
    added: [entry("New.txt")],
    modified: [{ previous: entry("A.txt"), current: entry("A.txt", "2") } as never],
    deleted: [entry("Gone.txt")],
    unchanged: [],
    directories: [],
    addedDirectories: ["Added"],
    deletedDirectories: [],
    errors: [],
    hasChanges: true,
    canCapture: true,
    totalBytes: 9,
    changesSignature: "sig",
  };
  return render(
    <ChangesCaptureView
      vaultState={state}
      activeBranchId="branch-main"
      workingFolderName="main"
      vaultFolderName="vault"
      scanResult={scan}
      isScanStale={false}
      isScanning={false}
      isCapturing={false}
      progress={null}
      statusBanner={null}
      onScan={async () => {}}
      onCapture={async () => {}}
      onCancelOperation={() => {}}
      onReattachWorkingFolder={async () => {}}
      discard={discard}
    />,
  );
}

test("Changes: Discard all… and Discard in each changed row's menu (files and folders) open the confirmation for that selection", async () => {
  const { controller, calls } = fakeController([reviewOf(fakePlan([action("A.txt", entry("A.txt", "2"), entry("A.txt"))]))]);
  const ui = changesView(controller);
  for (const path of ["New.txt", "A.txt", "Gone.txt"])
    assert.ok(ui.getByRole("button", { name: `Discard — ${path}` }), path);
  fireEvent.click(ui.getByRole("button", { name: "Discard — A.txt" }));
  await waitFor(() => assert.ok(ui.getByRole("dialog", { name: "Discard this change" })));
  assert.deepEqual(calls.review.at(-1), ["branch-main", ["A.txt"]]);
  fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
  fireEvent.click(ui.getByRole("button", { name: "Discard — Added/" }));
  await waitFor(() => assert.deepEqual(calls.review.at(-1), ["branch-main", ["Added"]]));
  assert.ok(ui.getByRole("dialog", { name: "Discard this folder and everything inside it" }));
  fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
  fireEvent.click(ui.getByRole("button", { name: "Discard all…" }));
  await waitFor(() => assert.ok(ui.getByRole("dialog", { name: "Discard all changes in Main" })));
  assert.deepEqual(calls.review.at(-1), ["branch-main", "all"]);
});

test("Changes: a read-only (blocked) case disables Discard; without a controller there are no Discard controls", () => {
  const { controller } = fakeController([], { blockedReason: "This case is hidden. Unhide it first." });
  const ui = changesView(controller);
  assert.ok(ui.getByRole("button", { name: "Discard all…" }).hasAttribute("disabled"));
  assert.ok(ui.getByRole("button", { name: "Discard — A.txt" }).hasAttribute("disabled"));
  assert.equal(ui.getByRole("button", { name: "Discard — A.txt" }).getAttribute("title"), "This case is hidden. Unhide it first.");
  assert.equal(ui.getByRole("button", { name: "Discard all…" }).getAttribute("title"), "This case is hidden. Unhide it first.");
  cleanup();
  const plain = changesView(undefined);
  assert.equal(plain.queryByRole("button", { name: "Discard all…" }), null);
  assert.equal(plain.queryByRole("button", { name: "Discard — A.txt" }), null);
});

// ---- Bring back: Discard them ----
function bringBackFixture() {
  const state = scenarioState("branches");
  state.revisions[2].manifest.files.push(entry("Old.txt", "9"));
  return state;
}

test("Bring back with unsaved changes: Discard them opens Discard all for the case, then returns to Bring back", async () => {
  const { controller: discard, calls } = fakeController([reviewOf(fakePlan([action("A.txt", entry("A.txt", "2"), entry("A.txt"))]))]);
  let saveFirst = 0;
  const application: ApplicationController = {
    applyAndSave: async () => undefined,
    progress: null,
    cancel: () => {},
    unsavedChanges: 1,
    onSaveFirst: () => saveFirst++,
    discard,
  };
  const ui = render(
    <ApplyPreviewDialog state={bringBackFixture()} sourceId="r3" destinationBranchId="branch-main" mode="revert" application={application} onClose={() => {}} />,
  );
  assert.match(ui.getByRole("dialog").textContent!, /Save them first, or discard them \(a copy is kept in the Discarded folder\)\./);
  assert.ok(ui.getByRole("button", { name: "Save my changes first" }));
  fireEvent.click(ui.getByRole("button", { name: "Discard them" }));
  await waitFor(() => assert.ok(ui.getByRole("dialog", { name: "Discard all changes in Main" })));
  assert.deepEqual(calls.review, [["branch-main", "all"]]);
  const confirm = ui.getByRole("button", { name: "Discard" });
  await waitFor(() => assert.equal(confirm.hasAttribute("disabled"), false));
  fireEvent.click(confirm);
  await waitFor(() => assert.ok(ui.getByRole("dialog", { name: "Bring back V3 onto Main" })));
  assert.equal(calls.discard.length, 1);
  assert.equal(saveFirst, 0);
});

// ---- The whole flow in the App with an in-memory home ----
async function openSample() {
  const sample = await compareApplyRecoverSample();
  const ui = render(<App />);
  await openHomeWorkspace(ui, sample.home);
  fireEvent.click(ui.getByRole("button", { name: "Open project" }));
  await waitFor(() => assert.equal(appBusy(ui), false));
  const nav = within(ui.getByRole("navigation", { name: "Primary navigation" }));
  fireEvent.click(nav.getByRole("button", { name: "Changes" }));
  await waitFor(() => assert.ok(scannedAt(ui)));
  const projectFolder = await sample.workspace.root.getDirectory(sample.project.record.containerPath.split("/"));
  return { sample, ui, projectFolder };
}


test("App: Discard one file, then Discard all; files go back, a copy is kept in Discarded/<name>, the notice says so and Changes rescans", async () => {
  const { sample, ui, projectFolder } = await openSample();
  const original = await sample.main.readFileBytes(["Bracket.SLDPRT"]);
  await sample.main.writeFileText(["Bracket.SLDPRT"], "my edit");
  await sample.main.writeFileText(["Note.txt"], "new note");
  await sample.main.removeEntry(["Spacer.SLDPRT"]);
  await waitForScan(ui);
  assert.ok(ui.getByText("Note.txt"));

  // One file.
  fireEvent.click(ui.getByRole("button", { name: "Discard — Bracket.SLDPRT" }));
  const one = await waitFor(() => ui.getByRole("dialog", { name: "Discard this change" }));
  await waitFor(() => assert.match(one.textContent!, /1 change will be discarded/));
  assert.ok(within(one).getByTestId("discard-copy-line"));
  fireEvent.click(within(one).getByRole("button", { name: "Discard" }));
  await waitFor(() => assert.ok(ui.getByText(/^Discarded 1 change\. A copy is in Discarded\/.+\.$/)));
  assert.ok(ui.getByRole("button", { name: "Copy folder path" }));
  assert.ok(Buffer.from(await sample.main.readFileBytes(["Bracket.SLDPRT"])).equals(Buffer.from(original)), "Bracket.SLDPRT is back");
  assert.equal(await sample.main.readFileText(["Note.txt"]), "new note", "other unsaved files are untouched");
  const discarded = await projectFolder.getDirectory(["Discarded"]);
  const [first] = (await discarded.listEntries()).map((e) => e.name);
  assert.equal(await discarded.readFileText([first, "Bracket.SLDPRT"]), "my edit");
  // Booleans only: a failing comparison of DOM elements would print them in full.
  await waitFor(() => assert.ok(!ui.queryByRole("button", { name: "Discard — Bracket.SLDPRT" }), "Changes was checked again"), { timeout: 5000 });

  // Everything else.
  await waitFor(() => assert.equal(appBusy(ui), false));
  fireEvent.click(ui.getByRole("button", { name: "Discard all…" }));
  const all = await waitFor(() => ui.getByRole("dialog", { name: "Discard all changes in Main" }));
  await waitFor(() => assert.match(all.textContent!, /2 changes will be discarded/));
  assert.ok(within(all).getByRole("region", { name: "Removed (not in the saved version)" }));
  assert.ok(within(all).getByRole("region", { name: "Brought back (deleted since the last save)" }));
  fireEvent.click(within(all).getByRole("button", { name: "Discard" }));
  await waitFor(() => assert.ok(ui.getByText(/^Discarded 2 changes\. A copy is in Discarded\/.+\.$/)));
  await waitFor(() => assert.ok(ui.getByText(/No changes since/)), { timeout: 5000 });
  assert.equal(await sample.main.hasFile(["Spacer.SLDPRT"]), true);
  const names = (await discarded.listEntries()).map((e) => e.name).sort();
  assert.equal(names.length, 2, `two kept copies: ${names.join(", ")}`);
  const second = names.find((n) => n !== first)!;
  assert.equal(await discarded.readFileText([second, "Note.txt"]), "new note");
});

test("App: files that change after the review are not discarded; the dialog asks to review again", async () => {
  const { sample, ui } = await openSample();
  await sample.main.writeFileText(["Bracket.SLDPRT"], "edit one");
  await waitForScan(ui);
  fireEvent.click(ui.getByRole("button", { name: "Discard all…" }));
  const dialog = await waitFor(() => ui.getByRole("dialog", { name: "Discard all changes in Main" }));
  await waitFor(() => assert.match(dialog.textContent!, /1 change will be discarded/));
  await sample.main.writeFileText(["Bracket.SLDPRT"], "edit two");
  fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
  await waitFor(() => assert.ok(within(dialog).getByText("Changes differ from what you saw; review again.")));
  assert.equal(await sample.main.readFileText(["Bracket.SLDPRT"]), "edit two", "nothing was changed");
  await waitFor(() => assert.equal(within(dialog).getByRole("button", { name: "Discard" }).hasAttribute("disabled"), false));
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
  });
  await waitFor(() => assert.ok(ui.getByText(/^Discarded 1 change\./)));
  assert.notEqual(await sample.main.readFileText(["Bracket.SLDPRT"]), "edit two");
});
