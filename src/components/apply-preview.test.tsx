import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { ApplyPreviewDialog, reconcileChoices, type ApplicationController } from "./ApplyPreviewDialog";
import {
  HistoryRecoveryView,
  type HistoryRecoveryViewProps,
} from "./HistoryRecoveryView";
import { revision, scenarioState, historyState } from "../../tests/history-data";
import { InMemoryFileSystemAdapter } from "../engine/fs-adapter";
import { initializeProjectVault, openExistingVault } from "../engine/vault-service";
import { captureRevision } from "../engine/revision-service";
import { buildApplyPreview, prepareApplyPreview } from "../engine/apply-preview";
import { prepareApplication } from "../engine/application-service";
afterEach(cleanup);
const path = "Parts/Housing.SLDPRT";
function fixture() {
  const state = scenarioState("branches");
  state.revisions[7].manifest.files.push({
    path: "New/Part.SLDPRT",
    sha256: "new",
    size: 3,
    lastModified: 0,
  });
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
test("preview starts empty, uses explicit conflict decisions, preserves saved state, and never enables Apply", () => {
  const state = fixture(),
    before = JSON.stringify(state);
  const ui = render(
    <ApplyPreviewDialog
      state={state}
      sourceId="p2"
      destinationBranchId="branch-main"
      onClose={() => {}}
    />,
  );
  assert.equal(
    ui.getAllByRole("checkbox").some((e) => (e as HTMLInputElement).checked),
    false,
  );
  assert.ok(ui.getByText(/Current uncaptured working edits are not included/));
  assert.ok(
    ui
      .getByRole("region", { name: "Base saved revision" })
      .textContent?.includes("Rev 002"),
  );
  assert.ok(
    ui
      .getByRole("region", { name: "Destination saved revision" })
      .textContent?.includes("Main"),
  );
  const ready = ui.getByRole("status", { name: "Preview readiness" });
  fireEvent.change(
    ui.getByRole("textbox", {
      name: "Engineering reason for proposed application",
    }),
    { target: { value: "Reuse only reviewed case improvements" } },
  );
  fireEvent.click(
    ui.getByRole("checkbox", {
      name: "Select source addition: New/Part.SLDPRT",
    }),
  );
  assert.ok(ready.textContent?.includes("Ready as a saved-state preview"));
  fireEvent.click(
    ui.getByRole("checkbox", { name: `Select source modification: ${path}` }),
  );
  assert.ok(ready.textContent?.includes("Preview not ready"));
  const decision = ui.getByRole("combobox", {
    name: `Conflict decision: ${path}`,
  });
  assert.equal((decision as HTMLSelectElement).value, "unresolved");
  fireEvent.change(decision, { target: { value: "keep-destination" } });
  assert.ok(ready.textContent?.includes("Ready as a saved-state preview"));
  fireEvent.change(decision, { target: { value: "use-source" } });
  assert.ok(ready.textContent?.includes("Ready as a saved-state preview"));
  fireEvent.click(
    ui.getByRole("checkbox", { name: `Select source modification: ${path}` }),
  );
  fireEvent.click(
    ui.getByRole("checkbox", { name: `Select source modification: ${path}` }),
  );
  assert.equal((decision as HTMLSelectElement).value, "unresolved");
  assert.equal(
    (
      ui.getByRole("button", {
        name: "Apply — unavailable in preview",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  assert.equal(JSON.stringify(state), before);
});
test("source deletion conflicts label the destructive consequence and show overall plus per-file notes at all three saved revisions", () => {
  const state = fixture();
  state.revisions[7].manifest.files = state.revisions[7].manifest.files.filter(
    (f) => f.path !== path,
  );
  const ui = render(
    <ApplyPreviewDialog
      state={state}
      sourceId="p2"
      destinationBranchId="branch-main"
      onClose={() => {}}
    />,
  );
  const article = within(
    ui.getByRole("article", { name: `Conflict: ${path}` }),
  );
  assert.ok(article.getByText(/would DELETE it from the proposed destination/));
  fireEvent.click(
    article.getByRole("checkbox", { name: `Select source deletion: ${path}` }),
  );
  assert.ok(
    article.getByRole("option", {
      name: "Use source state — DELETE destination file",
    }),
  );
  fireEvent.click(
    ui.getByText("Overall engineering notes · Base, Source and Destination"),
  );
  for (const [side, number] of [
    ["Base", "002"],
    ["Source", "008"],
    ["Destination", "006"],
  ]) {
    assert.ok(
      ui
        .getByRole("region", { name: `${side} overall notes at Rev ${number}` })
        .textContent?.includes("Reduce interference"),
    );
  }
  fireEvent.click(article.getByText("Saved file states and notes"));
  assert.ok(
    ui
      .getByRole("region", { name: `Source file notes at Rev 008: ${path}` })
      .textContent?.includes("Shaft binds"),
  );
});
test("source, destination baseline and project changes reset selections, decisions and engineering reason", () => {
  const state = fixture();
  const ui = render(
    <ApplyPreviewDialog
      state={state}
      sourceId="p2"
      destinationBranchId="branch-main"
      onClose={() => {}}
    />,
  );
  const select = () => {
    fireEvent.change(ui.getByRole("textbox"), {
      target: { value: "Reason for preview" },
    });
    fireEvent.click(
      ui.getByRole("checkbox", { name: `Select source modification: ${path}` }),
    );
  };
  select();
  ui.rerender(
    <ApplyPreviewDialog
      state={state}
      sourceId="p1"
      destinationBranchId="branch-main"
      onClose={() => {}}
    />,
  );
  assert.equal((ui.getByRole("textbox") as HTMLTextAreaElement).value, "");
  assert.equal(
    (
      ui.getByRole("checkbox", {
        name: `Select source modification: ${path}`,
      }) as HTMLInputElement
    ).checked,
    false,
  );
  select();
  const newer = structuredClone(state);
  newer.revisions.push(revision("new-head", "r6", 9));
  newer.branchHeads["branch-main"] = "new-head";
  ui.rerender(
    <ApplyPreviewDialog
      state={newer}
      sourceId="p1"
      destinationBranchId="branch-main"
      onClose={() => {}}
    />,
  );
  assert.equal((ui.getByRole("textbox") as HTMLTextAreaElement).value, "");
  assert.equal(
    (
      ui.getByRole("checkbox", {
        name: `Select source modification: ${path}`,
      }) as HTMLInputElement
    ).checked,
    false,
  );
  const second = structuredClone(state);
  second.project.projectId = "second";
  second.branches.forEach((b) => {
    b.projectId = "second";
  });
  second.revisions.forEach((r) => {
    r.manifest.projectId = "second";
    r.completion.projectId = "second";
  });
  ui.rerender(
    <ApplyPreviewDialog
      state={second}
      sourceId="p1"
      destinationBranchId="branch-main"
      onClose={() => {}}
    />,
  );
  assert.equal((ui.getByRole("textbox") as HTMLTextAreaElement).value, "");
});
test("Refresh saved states keeps a conflict decision and the typed reason when the revisions are unchanged", async () => {
  const state = fixture();
  let ui!: ReturnType<typeof render>;
  const dialog = (s: typeof state) => (
    <ApplyPreviewDialog state={s} sourceId="p2" destinationBranchId="branch-main" application={controller} onClose={() => {}} />
  );
  const controller: ApplicationController = {
    progress: null,
    cancel: () => {},
    prepare: async () => { throw new Error("not used"); },
    apply: async () => {},
    refresh: async () => { ui.rerender(dialog(structuredClone(state))); },
  };
  ui = render(dialog(state));
  const decision = () => ui.getByRole("combobox", { name: `Conflict decision: ${path}` }) as HTMLSelectElement;
  const reason = () => ui.getByRole("textbox", { name: "Engineering reason for proposed application" }) as HTMLTextAreaElement;
  fireEvent.click(ui.getByRole("checkbox", { name: `Select source modification: ${path}` }));
  fireEvent.change(decision(), { target: { value: "keep-destination" } });
  fireEvent.change(reason(), { target: { value: "Keep the reviewed housing" } });
  fireEvent.click(ui.getByRole("button", { name: "Refresh saved states" }));
  await waitFor(() => assert.equal((ui.getByRole("button", { name: "Refresh saved states" }) as HTMLButtonElement).disabled, false));
  assert.equal(
    (ui.getByRole("checkbox", { name: `Select source modification: ${path}` }) as HTMLInputElement).checked,
    true,
  );
  assert.equal(decision().value, "keep-destination");
  assert.equal(reason().value, "Keep the reviewed housing");
});
test("unavailable shared ancestry stays explicit while ordinary Compare keeps its endpoint-only rules", () => {
  const state = fixture();
  state.revisions[7].manifest.parentRevisionId = "missing";
  const ui = render(<HistoryRecoveryView {...props(state)} />);
  fireEvent.click(ui.getByRole("button", { name: /Rev 008:/ }));
  fireEvent.click(ui.getByRole("button", { name: "Review changes to apply" }));
  assert.ok(
    within(
      ui.getByRole("dialog", { name: "Review changes to apply — preview" }),
    )
      .getByRole("alert")
      .textContent?.includes("Preview unavailable"),
  );
  assert.equal(
    ui.queryByRole("textbox", {
      name: "Engineering reason for proposed application",
    }),
    null,
  );
  fireEvent.click(ui.getByRole("button", { name: "Close preview" }));
  assert.equal(
    ui.getByRole("button", { name: /Rev 008:/ }).getAttribute("aria-pressed"),
    "true",
  );
  fireEvent.click(ui.getByRole("button", { name: "Compare" }));
  fireEvent.change(ui.getByRole("combobox", { name: "From revision" }), {
    target: { value: "r6" },
  });
  assert.ok(ui.getByRole("status", { name: "Comparison counts" }));
});
test("closing preview preserves History inspection, file filter and export selection; project changes close it", () => {
  const state = fixture();
  const ui = render(<HistoryRecoveryView {...props(state)} />);
  fireEvent.change(ui.getByRole("combobox", { name: "File history" }), {
    target: { value: path },
  });
  fireEvent.click(ui.getByRole("button", { name: /Rev 008:/ }));
  fireEvent.click(
    ui.getByRole("checkbox", { name: `Select ${path} for export` }),
  );
  fireEvent.click(ui.getByRole("button", { name: "Review changes to apply" }));
  fireEvent.click(ui.getByRole("button", { name: "Close preview" }));
  assert.equal(
    (
      ui.getByRole("checkbox", {
        name: `Select ${path} for export`,
      }) as HTMLInputElement
    ).checked,
    true,
  );
  assert.equal(
    (ui.getByRole("combobox", { name: "File history" }) as HTMLSelectElement)
      .value,
    path,
  );
  assert.equal(
    ui.getByRole("button", { name: /Rev 008:/ }).getAttribute("aria-pressed"),
    "true",
  );
  fireEvent.click(ui.getByRole("button", { name: "Review changes to apply" }));
  const second = fixture();
  second.project.projectId = "second";
  ui.rerender(<HistoryRecoveryView {...props(second)} />);
  assert.equal(ui.queryByRole("dialog"), null);
});

// ---- Folder rows ----
const bringBack = (state: ReturnType<typeof historyState>, application?: ApplicationController) => (
  <ApplyPreviewDialog state={state} sourceId="r1" destinationBranchId="branch-main" mode="revert" application={application} onClose={() => {}} />
);
// r1 -> r3 on Main with identical files, so only folders differ.
function folderState() {
  const state = historyState(3);
  state.revisions[2].manifest.files = state.revisions[0].manifest.files.map((f) => ({ ...f }));
  state.revisions[0].manifest.directories.push("Empty one");
  state.revisions[2].manifest.directories.push("Added later");
  return state;
}
const reasonBox = (ui: ReturnType<typeof render>) =>
  ui.getByRole("textbox", { name: "Engineering reason for bringing this back" });

test("folder rows show with a path/, a Folder tag and Create/Remove folder wording; Bring back pre-selects them and enables Prepare for a folder-only difference", async () => {
  const state = folderState();
  const sent: any[] = [];
  const controller: ApplicationController = {
    progress: null,
    cancel: () => {},
    prepare: async (review) => {
      sent.push(review);
      const prep = prepareApplyPreview(state, "r1", "branch-main", "revert");
      if (prep.status !== "available") throw new Error(prep.reason);
      return { review, plan: buildApplyPreview(prep.context, review.choices, review.reason), destinationName: "main", branchName: "Main", connection: new InMemoryFileSystemAdapter("main") };
    },
    apply: async () => {},
  };
  const ui = render(bringBack(state, controller));
  const create = ui.getByRole("checkbox", { name: "Select Create folder: Empty one/" }) as HTMLInputElement;
  const remove = ui.getByRole("checkbox", { name: "Select Remove folder: Added later/" }) as HTMLInputElement;
  assert.equal(create.checked, true);
  assert.equal(remove.checked, true);
  const article = within(ui.getByRole("article", { name: "Source change: Empty one/" }));
  assert.ok(article.getByText("Folder"));
  assert.ok(article.getByText("Create folder"));
  assert.equal(ui.getAllByRole("checkbox").length, 2, "files do not differ, so only the two folder rows are offered");
  const prepare = ui.getByRole("button", { name: "Prepare bring-back" }) as HTMLButtonElement;
  assert.equal(prepare.disabled, true, "a reason is still required");
  fireEvent.change(reasonBox(ui), { target: { value: "Folder layout was better" } });
  assert.equal(prepare.disabled, false);
  assert.match(ui.getByRole("status", { name: "Proposed result summary" }).textContent!, /1 folder created · 1 folder removed/);
  fireEvent.click(prepare);
  const confirm = await waitFor(() => ui.getByRole("dialog", { name: "Confirm bringing back into working files" }));
  assert.ok(within(confirm).getByText("Create folder"));
  assert.ok(within(confirm).getByText("Remove folder"));
  assert.ok(within(confirm).getByText("Empty one/"));
  assert.deepEqual(Object.keys(sent[0].choices).sort(), ["Added later", "Empty one"]);
});

test("Refresh saved states pre-selects a newly selectable folder row in Bring back and keeps other choices", async () => {
  let ui!: ReturnType<typeof render>;
  const controller: ApplicationController = {
    progress: null,
    cancel: () => {},
    prepare: async () => { throw new Error("not used"); },
    apply: async () => {},
    refresh: async () => { ui.rerender(bringBack(folderState(), controller)); },
  };
  const before = folderState();
  before.revisions[0].manifest.directories = before.revisions[0].manifest.directories.filter((d) => d !== "Empty one");
  ui = render(bringBack(before, controller));
  assert.equal(ui.queryByRole("checkbox", { name: "Select Create folder: Empty one/" }) === null, true);
  fireEvent.click(ui.getByRole("checkbox", { name: "Select Remove folder: Added later/" }));
  fireEvent.click(ui.getByRole("button", { name: "Refresh saved states" }));
  await waitFor(() => ui.getByRole("checkbox", { name: "Select Create folder: Empty one/" }));
  assert.equal((ui.getByRole("checkbox", { name: "Select Create folder: Empty one/" }) as HTMLInputElement).checked, true);
  assert.equal((ui.getByRole("checkbox", { name: "Select Remove folder: Added later/" }) as HTMLInputElement).checked, false);
});

test("a removal the destination's own files make impossible is shown as kept, not selectable; merge does not pre-select folders", () => {
  const state = scenarioState("branches");
  // base r2 has Shared; the source (p2) dropped it; Main (r6) put a file in it.
  state.revisions[1].manifest.directories.push("Shared");
  state.revisions[5].manifest.directories.push("Shared");
  state.revisions[5].manifest.files.push({ path: "Shared/Main.txt", sha256: "7".repeat(8), size: 3, lastModified: 0 });
  const ui = render(
    <ApplyPreviewDialog state={state} sourceId="p2" destinationBranchId="branch-main" onClose={() => {}} />,
  );
  const kept = within(ui.getByRole("article", { name: "Kept folder: Shared/" }));
  assert.ok(kept.getByText("Kept: still holds files"));
  assert.equal(kept.queryByRole("checkbox") === null, true);
  assert.equal(ui.getAllByRole("checkbox").some((e) => (e as HTMLInputElement).checked), false);
});

test("when only kept folders remain the empty state says nothing can be applied", () => {
  const state = scenarioState("branches");
  state.revisions[7].manifest.files = state.revisions[1].manifest.files.map((f) => ({ ...f }));
  state.revisions[1].manifest.directories.push("Shared");
  state.revisions[5].manifest.directories.push("Shared");
  state.revisions[5].manifest.files.push({ path: "Shared/Main.txt", sha256: "7".repeat(8), size: 3, lastModified: 0 });
  const ui = render(
    <ApplyPreviewDialog state={state} sourceId="p2" destinationBranchId="branch-main" onClose={() => {}} />,
  );
  assert.ok(ui.getByRole("article", { name: "Kept folder: Shared/" }));
  assert.ok(ui.getByText("No source changes can be applied against this destination."));
});

test("merge offers an available folder row but leaves it unselected", () => {
  const state = scenarioState("branches");
  state.revisions[7].manifest.directories.push("Case folder");
  const ui = render(
    <ApplyPreviewDialog state={state} sourceId="p2" destinationBranchId="branch-main" onClose={() => {}} />,
  );
  const box = ui.getByRole("checkbox", { name: "Select Create folder: Case folder/" }) as HTMLInputElement;
  assert.equal(box.checked, false);
  assert.ok(ui.getByText(/Select to create it/));
  assert.equal(ui.getAllByRole("checkbox").some((e) => (e as HTMLInputElement).checked), false);
});

test("reconciliation treats a path that switched between file and folder as a new row", () => {
  const prep = prepareApplyPreview(folderState(), "r1", "branch-main", "revert");
  if (prep.status !== "available") throw new Error(prep.reason);
  const rows = prep.context.rows;
  const asFile = rows.map((r) => (r.path === "Empty one" ? { ...r, entry: "file" as const } : r));
  const chosen = { selected: false, decision: "use-source" as const };
  const next = reconcileChoices({ "Empty one": chosen, "Added later": chosen }, asFile, rows, true);
  assert.deepEqual(next["Empty one"], { selected: true, decision: "use-source" });
  assert.equal(next["Added later"], chosen);
});

test("a selected folder removal that would still hold files shows the blocker in the readiness list", () => {
  const state = scenarioState("branches");
  state.revisions[1].manifest.directories.push("Shared");
  state.revisions[5].manifest.directories.push("Shared");
  state.revisions[5].manifest.files.push({ path: "Shared/Old.txt", sha256: "7".repeat(8), size: 3, lastModified: 0 });
  state.revisions[1].manifest.files.push({ path: "Shared/Old.txt", sha256: "7".repeat(8), size: 3, lastModified: 0 });
  const ui = render(
    <ApplyPreviewDialog state={state} sourceId="p2" destinationBranchId="branch-main" onClose={() => {}} />,
  );
  fireEvent.click(ui.getByRole("checkbox", { name: "Select Remove folder: Shared/" }));
  assert.ok(ui.getByRole("status", { name: "Preview readiness" }).textContent!.includes("Shared: Kept: still holds files; untick it."));
  fireEvent.click(ui.getByRole("checkbox", { name: "Select source deletion: Shared/Old.txt" }));
  assert.equal(ui.getByRole("status", { name: "Preview readiness" }).textContent!.includes("still holds files"), false);
});

test("the old empty-folder disclaimer is gone", () => {
  const ui = render(bringBack(folderState()));
  assert.equal(ui.queryByText(/Empty-folder-only changes are not selected/) === null, true);
  assert.equal(ui.queryByText(/including empty folders, are retained/) === null, true);
});

test("the 'holds only system files' error from prepare shows in the dialog's error area and nothing is written", async () => {
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
    prepare: (review) => prepareApplication(vault, review, { workingFolders: folders }),
    apply: async () => {},
  };
  const ui = render(
    <ApplyPreviewDialog state={state} sourceId={r1} destinationBranchId="branch-main" mode="revert" application={controller} onClose={() => {}} />,
  );
  assert.ok(ui.getByRole("checkbox", { name: "Select Remove folder: New/" }));
  fireEvent.change(reasonBox(ui), { target: { value: "Back to R1" } });
  fireEvent.click(ui.getByRole("button", { name: "Prepare bring-back" }));
  const alert = await waitFor(() => ui.getByRole("alert"));
  assert.match(alert.textContent!, /Folder "New" holds only system files \(Thumbs\.db\)\. Delete them, or untick the folder, then prepare again\. No working files were changed\./);
  assert.equal(await main.readFileText(["New", "N.txt"]), "n");
  assert.equal((await openExistingVault(vault)).applicationOperations?.length ?? 0, 0);
});
