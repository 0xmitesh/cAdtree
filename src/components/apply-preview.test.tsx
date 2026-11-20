import "../../tests/dom";
import { pickFile, filePicker } from "../../tests/file-picker";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { ApplyPreviewDialog, deriveChoices, type ApplicationController } from "./ApplyPreviewDialog";
import { HistoryRecoveryView, type HistoryRecoveryViewProps } from "./HistoryRecoveryView";
import { revision, scenarioState, historyState } from "../../tests/history-data";
import { InMemoryFileSystemAdapter } from "../engine/fs-adapter";
import { initializeProjectVault, openExistingVault } from "../engine/vault-service";
import { captureRevision } from "../engine/revision-service";
import { buildApplyPreview, prepareApplyPreview } from "../engine/apply-preview";
import { applyAndSave } from "../engine/application-service";
import type { ApplicationReview } from "../engine/application-records";
afterEach(cleanup);
const path = "Parts/Housing.SLDPRT";
function fixture() {
  const state = scenarioState("branches");
  state.revisions[7].manifest.files.push({ path: "New/Part.SLDPRT", sha256: "new", size: 3, lastModified: 0 });
  return state;
}
const props = (state = fixture()): HistoryRecoveryViewProps => ({
  vaultState: state,
  activeBranchId: "branch-main",
  progress: null,
  statusBanner: null,
  onVerifySingleRevisionObjects: async () => {
    throw new Error("Verification must not run");
  },
  onCancelOperation: () => {},
});
function spy() {
  const sent: ApplicationReview[] = [];
  const controller: ApplicationController = {
    progress: null,
    cancel: () => {},
    applyAndSave: async (review) => {
      sent.push(review);
      return undefined;
    },
  };
  return { sent, controller };
}
const copyButton = (ui: ReturnType<typeof render>) =>
  ui.getByRole("button", { name: "Copy files" }) as HTMLButtonElement;

test("files changed on both sides need Keep mine or Take theirs (no default) before Copy files; unchanged rows are hidden", async () => {
  const state = fixture(), before = JSON.stringify(state);
  const { sent, controller } = spy();
  const ui = render(
    <ApplyPreviewDialog state={state} sourceId="p2" destinationBranchId="branch-main" application={controller} onClose={() => {}} />,
  );
  const both = within(ui.getByRole("group", { name: `Changed in both: ${path}` }));
  const keep = both.getByRole("radio", { name: "Keep mine" }) as HTMLInputElement;
  const take = both.getByRole("radio", { name: "Take theirs" }) as HTMLInputElement;
  assert.equal(keep.checked || take.checked, false, "no default");
  assert.match(ui.getByRole("status", { name: "Changed in both" }).textContent!, /1 file was changed in both/);
  assert.equal(copyButton(ui).disabled, true);
  assert.equal((ui.getByRole("checkbox", { name: "Copy New/Part.SLDPRT" }) as HTMLInputElement).checked, true);
  // Files the case did not change, or that already match, are not listed.
  assert.equal(ui.queryByText("Parts/Shaft.SLDPRT"), null);
  fireEvent.click(take);
  assert.equal(copyButton(ui).disabled, false);
  fireEvent.click(keep);
  assert.equal(copyButton(ui).disabled, false);
  fireEvent.click(copyButton(ui));
  await waitFor(() => assert.equal(sent.length, 1));
  assert.deepEqual(sent[0].choices[path], { selected: true, decision: "keep-destination" });
  assert.deepEqual(sent[0].choices["New/Part.SLDPRT"], { selected: true, decision: "use-source" });
  assert.equal(JSON.stringify(state), before, "the dialog never changes saved state");
});

test("unticking every file and keeping mine leaves nothing to copy and the button disabled", () => {
  const { controller } = spy();
  const ui = render(
    <ApplyPreviewDialog state={fixture()} sourceId="p2" destinationBranchId="branch-main" application={controller} onClose={() => {}} />,
  );
  fireEvent.click(ui.getByRole("checkbox", { name: "Copy New/Part.SLDPRT" }));
  fireEvent.click(ui.getByRole("radio", { name: "Keep mine" }));
  assert.ok(ui.getByText("Nothing will be copied with these choices."));
  assert.equal(copyButton(ui).disabled, true);
});

test("a source deletion in both says Take theirs removes the file", () => {
  const state = fixture();
  state.revisions[7].manifest.files = state.revisions[7].manifest.files.filter((f) => f.path !== path);
  const ui = render(<ApplyPreviewDialog state={state} sourceId="p2" destinationBranchId="branch-main" onClose={() => {}} />);
  assert.ok(ui.getByRole("radio", { name: "Take theirs (removes the file)" }));
});

test("an identity-blocked row is greyed: renamed in one case; can't copy yet, and it is not sent", async () => {
  const state = fixture();
  const cf = (p: string, id: string) => ({ path: p, componentId: id }) as any;
  state.components = {
    status: "available",
    revisions: Object.fromEntries(
      state.revisions.map((r) => [
        r.manifest.revisionId,
        {
          files: r.manifest.files.map((file) =>
            cf(file.path === "New/Part.SLDPRT" ? "New/Part.SLDPRT" : file.path, file.path === "New/Part.SLDPRT" ? "component-new" : `component-${file.path}`),
          ),
          payloadSha256: "x",
          renames: [],
        },
      ]),
    ),
  } as any;
  // Main already has the same component under another name.
  (state.components as any).revisions.r6.files.push(cf("Elsewhere.SLDPRT", "component-new"));
  const { sent, controller } = spy();
  const ui = render(
    <ApplyPreviewDialog state={state} sourceId="p2" destinationBranchId="branch-main" application={controller} onClose={() => {}} />,
  );
  const row = ui.getByRole("listitem", { name: "Can't copy: New/Part.SLDPRT" });
  assert.match(row.textContent!, /Renamed in one case; can't copy yet\./);
  assert.equal(within(row).queryByRole("checkbox"), null);
  fireEvent.click(ui.getByRole("radio", { name: "Take theirs" }));
  fireEvent.click(copyButton(ui));
  await waitFor(() => assert.equal(sent.length, 1));
  assert.equal("New/Part.SLDPRT" in sent[0].choices, false);
});

test("a new source or destination baseline resets the choices and the Why", () => {
  const state = fixture();
  const ui = render(<ApplyPreviewDialog state={state} sourceId="p2" destinationBranchId="branch-main" onClose={() => {}} />);
  fireEvent.change(ui.getByRole("textbox", { name: "Why (optional)" }), { target: { value: "Reason" } });
  fireEvent.click(ui.getByRole("radio", { name: "Keep mine" }));
  const newer = structuredClone(state);
  newer.revisions.push(revision("new-head", "r6", 9));
  newer.branchHeads["branch-main"] = "new-head";
  ui.rerender(<ApplyPreviewDialog state={newer} sourceId="p2" destinationBranchId="branch-main" onClose={() => {}} />);
  assert.equal((ui.getByRole("textbox", { name: "Why (optional)" }) as HTMLTextAreaElement).value, "");
  assert.equal((ui.getByRole("radio", { name: "Keep mine" }) as HTMLInputElement).checked, false);
});

test("unavailable shared ancestry stays explicit; Close keeps the History selection and Compare still works", () => {
  const state = fixture();
  state.revisions[7].manifest.parentRevisionId = "missing";
  const ui = render(<HistoryRecoveryView {...props(state)} />);
  fireEvent.click(ui.getByRole("button", { name: /Rev 008:/ }));
  fireEvent.click(ui.getByRole("button", { name: "Copy files from Prototype…" }));
  const dialog = ui.getByRole("dialog", { name: "Copy files from Prototype" });
  assert.match(within(dialog).getByRole("alert").textContent!, /can't be done right now/);
  assert.equal(ui.queryByRole("textbox", { name: "Why (optional)" }), null);
  fireEvent.click(ui.getByRole("button", { name: "Close" }));
  assert.equal(ui.getByRole("button", { name: /Rev 008:/ }).getAttribute("aria-pressed"), "true");
  fireEvent.click(ui.getByRole("button", { name: "Compare" }));
  fireEvent.change(ui.getByRole("combobox", { name: "From revision" }), { target: { value: "r6" } });
  assert.ok(ui.getByRole("status", { name: "Comparison counts" }));
});

test("closing the dialog preserves History inspection and file filter; project changes close it", () => {
  const state = fixture();
  const ui = render(<HistoryRecoveryView {...props(state)} />);
  pickFile(ui, path);
  fireEvent.click(ui.getByRole("button", { name: /Rev 008:/ }));
  fireEvent.click(ui.getByRole("button", { name: "Copy files from Prototype…" }));
  fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
  assert.equal(filePicker(ui).value, path);
  assert.equal(ui.getByRole("button", { name: /Rev 008:/ }).getAttribute("aria-pressed"), "true");
  fireEvent.click(ui.getByRole("button", { name: "Copy files from Prototype…" }));
  const second = fixture();
  second.project.projectId = "second";
  ui.rerender(<HistoryRecoveryView {...props(second)} />);
  assert.equal(ui.queryByRole("dialog"), null);
});

// ---- Folder rows ----
// r1 -> r3 on Main with identical files, so only folders differ.
function folderState() {
  const state = historyState(3);
  state.revisions[2].manifest.files = state.revisions[0].manifest.files.map((f) => ({ ...f }));
  state.revisions[0].manifest.directories.push("Empty one");
  state.revisions[2].manifest.directories.push("Added later");
  return state;
}

test("Bring back lists folder rows with path/ and a Folder tag and sends them for a folder-only difference", async () => {
  const { sent, controller } = spy();
  const ui = render(
    <ApplyPreviewDialog state={folderState()} sourceId="r1" destinationBranchId="branch-main" mode="revert" application={controller} onClose={() => {}} />,
  );
  const folders = within(ui.getByRole("region", { name: "Folders" }));
  assert.ok(folders.getByText("Empty one/"));
  assert.ok(folders.getByText("Will be created"));
  assert.ok(folders.getByText("Will be removed"));
  assert.match(ui.getByRole("status", { name: "What will change" }).textContent!, /0 files will change · 2 folders/);
  fireEvent.click(ui.getByRole("button", { name: "Bring back" }));
  await waitFor(() => assert.equal(sent.length, 1));
  assert.deepEqual(Object.keys(sent[0].choices).sort(), ["Added later", "Empty one"]);
});

test("Copy: folder rows follow their files; an empty added folder is created; a kept folder is shown, not selectable", () => {
  const state = scenarioState("branches");
  state.revisions[7].manifest.directories.push("Case folder", "Docs");
  state.revisions[7].manifest.files.push({ path: "Docs/Spec.txt", sha256: "s", size: 1, lastModified: 0 });
  state.revisions[1].manifest.directories.push("Shared");
  state.revisions[5].manifest.directories.push("Shared");
  state.revisions[5].manifest.files.push({ path: "Shared/Main.txt", sha256: "7".repeat(8), size: 3, lastModified: 0 });
  const ui = render(<ApplyPreviewDialog state={state} sourceId="p2" destinationBranchId="branch-main" onClose={() => {}} />);
  const line = (name: string) => ui.getByText(name).closest("li")!.textContent!;
  assert.match(line("Case folder/"), /Will be created/);
  assert.match(line("Docs/"), /Will be created/);
  assert.match(line("Shared/"), /Kept: still holds files/);
  fireEvent.click(ui.getByRole("checkbox", { name: "Copy Docs/Spec.txt" }));
  assert.match(line("Docs/"), /Not copied/);
  assert.match(line("Case folder/"), /Will be created/);
});

test("deriveChoices: a removed folder is removed only with every file and subfolder in it; added parents follow their children", () => {
  const state = scenarioState("branches");
  state.revisions[1].manifest.directories.push("Old", "Old/Sub");
  state.revisions[1].manifest.files.push({ path: "Old/Sub/A.txt", sha256: "a", size: 1, lastModified: 0 });
  state.revisions[5].manifest.directories.push("Old", "Old/Sub");
  state.revisions[5].manifest.files.push({ path: "Old/Sub/A.txt", sha256: "a", size: 1, lastModified: 0 });
  state.revisions[7].manifest.directories.push("New", "New/Empty");
  const prep = prepareApplyPreview(state, "p2", "branch-main", "merge");
  if (prep.status !== "available") throw new Error(prep.reason);
  const rows = prep.context.rows;
  const all = deriveChoices(rows, false, new Set(), {});
  for (const p of ["Old", "Old/Sub", "Old/Sub/A.txt", "New", "New/Empty"])
    assert.equal(all[p]?.selected, true, p);
  const kept = deriveChoices(rows, false, new Set(["Old/Sub/A.txt"]), {});
  for (const p of ["Old", "Old/Sub", "Old/Sub/A.txt"]) assert.equal(p in kept, false, p);
  assert.equal(kept["New"]?.selected, true);
});

test("deriveChoices: a renamed (identity-blocked) file stays, so its removed folder stays too, with no untick message", () => {
  const state = scenarioState("branches");
  state.revisions[1].manifest.directories.push("Old", "Old/Sub");
  state.revisions[1].manifest.files.push({ path: "Old/Sub/A.txt", sha256: "a", size: 1, lastModified: 0 });
  state.revisions[5].manifest.directories.push("Old", "Old/Sub");
  state.revisions[5].manifest.files.push({ path: "Old/Sub/A.txt", sha256: "a", size: 1, lastModified: 0 });
  const prep = prepareApplyPreview(state, "p2", "branch-main", "merge");
  if (prep.status !== "available") throw new Error(prep.reason);
  const rows = prep.context.rows.map((row) =>
    row.path === "Old/Sub/A.txt" ? { ...row, identityBlock: "Renamed." } : row,
  );
  for (const revert of [false, true]) {
    const choices = deriveChoices(rows, revert, new Set(), {});
    for (const p of ["Old", "Old/Sub", "Old/Sub/A.txt"]) assert.equal(p in choices, false, `${p} (revert ${revert})`);
    const plan = buildApplyPreview({ ...prep.context, rows }, choices, "");
    assert.equal(plan.blockers.some((b) => /untick it/.test(b)), false, `revert ${revert}`);
  }
});

test("the 'holds only system files' error from the save shows in the dialog and nothing is written", async () => {
  const vault = new InMemoryFileSystemAdapter("DVault"),
    main = new InMemoryFileSystemAdapter("DMain");
  const folders = { "branch-main": main };
  await main.writeFileText(["A.txt"], "a1");
  await initializeProjectVault(main, vault, "Dialog folders");
  const notes = { problem: "p", modification: "m", observations: "o" };
  const save = (summary: string) =>
    captureRevision(main, vault, { branchId: "branch-main", summary, notes, workingFolders: folders });
  const r1 = (await save("R1")).revision.manifest.revisionId;
  await main.writeFileText(["New", "N.txt"], "n");
  await save("R2");
  await main.writeFileText(["New", "Thumbs.db"], "clutter");
  const state = await openExistingVault(vault);
  const controller: ApplicationController = {
    progress: null,
    cancel: () => {},
    applyAndSave: (review) => applyAndSave(vault, review, { workingFolders: folders }),
  };
  const ui = render(
    <ApplyPreviewDialog state={state} sourceId={r1} destinationBranchId="branch-main" mode="revert" application={controller} onClose={() => {}} />,
  );
  fireEvent.click(ui.getByRole("button", { name: "Bring back" }));
  const alert = await waitFor(() => ui.getByRole("alert"));
  assert.match(alert.textContent!, /Folder "New" holds only system files \(Thumbs\.db\)\./);
  assert.equal(await main.readFileText(["New", "N.txt"]), "n");
  const after = await openExistingVault(vault);
  assert.equal(after.applicationOperations?.length ?? 0, 0);
  assert.equal(after.revisions.length, 2);
});
