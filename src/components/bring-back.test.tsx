import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import {
  ApplyPreviewDialog,
  reconcileChoices,
  type ApplicationController,
} from "./ApplyPreviewDialog";
import { AppliedFrom } from "./ApplicationStatus";
import {
  HistoryRecoveryView,
  type HistoryRecoveryViewProps,
} from "./HistoryRecoveryView";
import { revision, scenarioState } from "../../tests/history-data";
import {
  applyModeFor,
  buildApplyPreview,
  prepareApplyPreview,
} from "../engine/apply-preview";
import { applicationReview } from "../engine/application-service";
import { InMemoryFileSystemAdapter } from "../engine/fs-adapter";
import {
  sealApplication,
  type ApplicationOperation,
} from "../engine/application-records";
afterEach(cleanup);

// Main r1..r6, prototype forks from r2 (p1, p2). r6 (Main's latest) gets an
// extra file and r3 an older-only file so bringing r3 back has all three kinds.
function fixture() {
  const state = scenarioState("branches");
  const file = (p: string) => ({ path: p, sha256: "9".repeat(8), size: 3, lastModified: 0 });
  state.revisions[5].manifest.files.push(file("Extra.txt"));
  state.revisions[2].manifest.files.push(file("Old.txt"));
  return state;
}
const props = (
  state = fixture(),
  activeBranchId = "branch-main",
): HistoryRecoveryViewProps => ({
  vaultState: state,
  activeBranchId,
  progress: null,
  statusBanner: null,
  onVerifySingleRevisionObjects: async () => {},
  onCancelOperation: () => {},
});
const revBtn = (ui: ReturnType<typeof render>, n: string) =>
  ui.getByRole("button", { name: new RegExp(`Rev ${n}:`) });

test("applyModeFor: latest, revert, merge, and no baseline falls back to merge", () => {
  const state = fixture();
  assert.equal(applyModeFor(state, "r6", "branch-main"), "latest");
  assert.equal(applyModeFor(state, "r3", "branch-main"), "revert");
  assert.equal(applyModeFor(state, "p2", "branch-main"), "merge");
  assert.equal(applyModeFor(state, "p2", "prototype"), "latest");
  assert.equal(applyModeFor(state, "r2", "prototype"), "revert");
  assert.equal(applyModeFor(state, "r5", "prototype"), "merge");
  const empty = fixture();
  empty.branchHeads["branch-main"] = null;
  assert.equal(applyModeFor(empty, "r3", "branch-main"), "merge");
  assert.equal(applyModeFor(state, "r3", "no-such-branch"), "merge");
});

test("History detail: latest has no apply button, older Main revision offers Bring back, case revision keeps merge wording", () => {
  const ui = render(<HistoryRecoveryView {...props()} />);
  fireEvent.click(revBtn(ui, "006"));
  assert.equal(ui.queryByRole("button", { name: /Bring back onto|Review changes to apply/ }), null);
  fireEvent.click(revBtn(ui, "003"));
  assert.ok(ui.getByRole("button", { name: "Bring back onto Main…" }));
  assert.equal(ui.queryByRole("button", { name: "Review changes to apply" }), null);
  fireEvent.click(revBtn(ui, "008"));
  assert.ok(ui.getByRole("button", { name: "Review changes to apply" }));
  assert.equal(ui.queryByRole("button", { name: /Bring back onto/ }), null);
});

test("with a case active, an earlier Main revision before the fork says Bring back onto <case>", () => {
  const ui = render(<HistoryRecoveryView {...props(fixture(), "prototype")} />);
  fireEvent.click(revBtn(ui, "001"));
  assert.ok(ui.getByRole("button", { name: "Bring back onto Prototype…" }));
});

function controllerSpy() {
  const sent: any[] = [];
  const controller: ApplicationController = {
    progress: null,
    cancel: () => {},
    prepare: async (review) => {
      sent.push(review);
      const prep = prepareApplyPreview(fixture(), "r3", "branch-main", review.mode);
      if (prep.status !== "available") throw new Error(prep.reason);
      return {
        review,
        plan: buildApplyPreview(prep.context, review.choices, review.reason),
        destinationName: "main",
        branchName: "Main",
        connection: new InMemoryFileSystemAdapter("main"),
      };
    },
    apply: async () => {},
  };
  return { sent, controller };
}

test("revert dialog: title, rows pre-selected with revert labels, deselect one then prepare sends revert mode with remaining actions; reason required", async () => {
  const { sent, controller } = controllerSpy();
  const ui = render(
    <HistoryRecoveryView {...props()} application={controller} />,
  );
  fireEvent.click(revBtn(ui, "003"));
  fireEvent.click(ui.getByRole("button", { name: "Bring back onto Main…" }));
  const dialog = ui.getByRole("dialog", { name: "Make Main match Rev 003" });
  const w = within(dialog);
  const boxes = w.getAllByRole("checkbox") as HTMLInputElement[];
  const rows = boxes.filter((b) => /^Select /.test(b.getAttribute("aria-label") ?? ""));
  assert.equal(rows.length, 3);
  assert.ok(rows.every((b) => b.checked));
  assert.ok(w.getByRole("checkbox", { name: "Select Bring back: Old.txt" }));
  assert.ok(w.getByRole("checkbox", { name: "Select Remove (not in Rev 003): Extra.txt" }));
  assert.ok(w.getByRole("checkbox", { name: "Select Replace with Rev 003's version: Parts/Housing.SLDPRT" }));
  assert.match(dialog.textContent!, /Nothing is lost: Main.s latest saved revision stays in history.*Save a revision afterwards/);
  assert.doesNotMatch(dialog.textContent!, /Start with nothing selected/);
  fireEvent.click(w.getByRole("checkbox", { name: "Select Remove (not in Rev 003): Extra.txt" }));
  const prepare = w.getByRole("button", { name: "Prepare bring-back" }) as HTMLButtonElement;
  assert.equal(prepare.disabled, true, "reason is required");
  fireEvent.change(
    w.getByRole("textbox", { name: "Engineering reason for bringing this back" }),
    { target: { value: "Housing change was wrong" } },
  );
  assert.equal(prepare.disabled, false);
  fireEvent.click(prepare);
  const confirm = await waitFor(() =>
    ui.getByRole("dialog", { name: "Confirm bringing back into working files" }),
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].mode, "revert");
  assert.deepEqual(
    Object.entries(sent[0].choices)
      .filter(([, c]: any) => c.selected)
      .map(([p]) => p)
      .sort(),
    ["Old.txt", "Parts/Housing.SLDPRT"],
  );
  assert.doesNotMatch(confirm.textContent!, /Extra\.txt/);
  assert.match(confirm.textContent!, /1 file brought back · 1 replaced/);
  assert.doesNotMatch(confirm.textContent!, /removed/);
  fireEvent.click(within(confirm).getByRole("checkbox"));
  fireEvent.click(within(confirm).getByRole("button", { name: "Bring back confirmed changes" }));
  await waitFor(() => ui.getByRole("dialog", { name: "Bring back completed" }));
  assert.match(ui.getByRole("dialog").textContent!, /Brought back into working files/);
});

test("a renamed-file row shows the engine's revert block message and cannot be selected", () => {
  const state = fixture();
  const cf = (path: string) => ({ path, componentId: "component-1" }) as any;
  state.components = {
    status: "available",
    revisions: {
      r3: { files: [cf("Old.txt")], payloadSha256: "x", renames: [] },
      r6: { files: [cf("Parts/Renamed.SLDPRT")], payloadSha256: "x", renames: [] },
    },
  } as any;
  const ui = render(
    <ApplyPreviewDialog state={state} sourceId="r3" destinationBranchId="branch-main" mode="revert" onClose={() => {}} />,
  );
  const box = ui.getByRole("checkbox", { name: "Select Bring back: Old.txt" }) as HTMLInputElement;
  assert.equal(box.disabled, true);
  assert.equal(box.checked, false);
  assert.match(
    ui.getByRole("article", { name: "Source change: Old.txt" }).textContent!,
    /renamed since that revision\. Bringing back cannot undo renames yet/,
  );
});

function capturedOperation(mode: "merge" | "revert") {
  const state = fixture();
  const source = mode === "revert" ? "r3" : "p2";
  const prep = prepareApplyPreview(state, source, "branch-main", mode);
  if (prep.status !== "available") throw new Error(prep.reason);
  const choices = { "Old.txt": { selected: true, decision: "use-source" as const } };
  const plan = buildApplyPreview(prep.context, choices, "Because");
  const op: ApplicationOperation = {
    operationId: "apply-test",
    destinationBranchId: "branch-main",
    relativePath: "applications/branch-main/apply-test",
    status: "captured",
    capturedRevisionId: "final",
    events: [
      {
        schemaVersion: 1,
        operationId: "apply-test",
        sequence: 1,
        previous: "",
        kind: "capture",
        at: "now",
        revisionId: "final",
        manifestSha256: "h",
        checksum: "h",
        finalFiles: plan.actions.map((a) => ({
          path: a.path,
          file: a.after ? { ...a.after } : null,
        })),
      },
    ] as any,
    record: sealApplication({
      schemaVersion: 1 as const,
      kind: "cadtree-file-application" as const,
      operationId: "apply-test",
      createdAt: "2026-11-01",
      sourceBranchId: prep.context.source.manifest.branchId,
      review: applicationReview(plan, choices),
      plan,
    }),
  };
  state.applicationOperations = [op];
  return state;
}

test("AppliedFrom: a revert says Brought back from <rev> without Base; a merge keeps its wording", () => {
  const revert = render(<AppliedFrom state={capturedOperation("revert")} revisionId="final" />);
  assert.match(revert.container.textContent!, /Brought back from Rev 003/);
  assert.doesNotMatch(revert.container.textContent!, /Applied from|Base:/);
  assert.match(revert.container.textContent!, /Destination baseline:/);
  cleanup();
  const merge = render(<AppliedFrom state={capturedOperation("merge")} revisionId="final" />);
  assert.match(merge.container.textContent!, /Applied from Rev 008 · Prototype/);
  assert.match(merge.container.textContent!, /Base:/);
});

test("revert dialog: two endpoint cards, revert note and counts, Changes to review heading, no merge-only leftovers", () => {
  const ui = render(
    <ApplyPreviewDialog state={fixture()} sourceId="r3" destinationBranchId="branch-main" mode="revert" onClose={() => {}} />,
  );
  assert.ok(ui.getByRole("region", { name: "Latest saved · Main" }).textContent!.includes("Rev 006"));
  assert.ok(ui.getByRole("region", { name: "Bring back · Rev 003" }).textContent!.includes("Rev 003"));
  assert.equal(ui.queryByRole("region", { name: "Base saved revision" }), null);
  assert.ok(ui.getByText("Compares saved byte hashes of the two revisions; it does not merge geometry or verify CAD compatibility."));
  assert.doesNotMatch(ui.container.textContent!, /nearest shared ancestor/);
  assert.match(
    ui.getByRole("status", { name: "Proposed result summary" }).textContent!,
    /1 file brought back · 1 replaced · 1 removed/,
  );
  assert.ok(ui.getByRole("region", { name: "Changes to review" }));
  assert.ok(ui.getByText("Changes to review (3)"));
  assert.match(ui.container.textContent!, /saved states\. Current uncaptured/);
  fireEvent.click(ui.getByText("Overall engineering notes · Latest saved and Bring back"));
  assert.ok(ui.getByRole("region", { name: "Latest saved overall notes at Rev 006" }));
  assert.ok(ui.getByRole("region", { name: "Bring back overall notes at Rev 003" }));
  assert.equal(ui.queryByRole("region", { name: /^(Base|Source|Destination) overall notes/ }), null);
  const article = within(ui.getByRole("article", { name: "Source change: Old.txt" }));
  fireEvent.click(article.getByText("Saved file states and notes"));
  assert.ok(article.getByRole("region", { name: "Bring back file notes at Rev 003: Old.txt" }));
  assert.ok(article.getByRole("region", { name: "Latest saved file notes at Rev 006: Old.txt" }));
  assert.equal(article.queryByRole("region", { name: /^(Base|Source|Destination) file notes/ }), null);
});

test("merge dialog keeps three cards and singular/plural counts", () => {
  const state = scenarioState("branches");
  state.revisions[7].manifest.files.push({ path: "New/Part.SLDPRT", sha256: "new", size: 3, lastModified: 0 });
  const ui = render(
    <ApplyPreviewDialog state={state} sourceId="p2" destinationBranchId="branch-main" onClose={() => {}} />,
  );
  for (const side of ["Base", "Source", "Destination"])
    assert.ok(ui.getByRole("region", { name: `${side} saved revision` }));
  assert.ok(ui.getByRole("region", { name: "Source changes to review" }));
  const summary = () => ui.getByRole("status", { name: "Proposed result summary" }).textContent!;
  assert.match(summary(), /^Proposed result: \d+ files0 additions · 0 replacements · 0 deletions$/);
  fireEvent.click(ui.getByRole("checkbox", { name: "Select source addition: New/Part.SLDPRT" }));
  assert.match(summary(), /1 addition · 0 replacements · 0 deletions/);
});

test("revert completion names both revisions; merge completion keeps its wording", async () => {
  const run = async (mode: "revert" | "merge", sourceId: string, checkboxName: string) => {
    const state = fixture();
    if (mode === "merge") state.revisions[7].manifest.files.push({ path: "New.txt", sha256: "new", size: 3, lastModified: 0 });
    const controller: ApplicationController = {
      progress: null,
      cancel: () => {},
      prepare: async (review) => {
        const prep = prepareApplyPreview(state, sourceId, "branch-main", mode);
        if (prep.status !== "available") throw new Error(prep.reason);
        return { review, plan: buildApplyPreview(prep.context, review.choices, review.reason), destinationName: "main", branchName: "Main", connection: new InMemoryFileSystemAdapter("main") };
      },
      apply: async () => {},
    };
    const ui = render(<ApplyPreviewDialog state={state} sourceId={sourceId} destinationBranchId="branch-main" mode={mode} application={controller} onClose={() => {}} />);
    if (mode === "merge") fireEvent.click(ui.getByRole("checkbox", { name: checkboxName }));
    const label = mode === "revert" ? "Engineering reason for bringing this back" : "Engineering reason for proposed application";
    fireEvent.change(ui.getByRole("textbox", { name: label }), { target: { value: "why" } });
    if (mode === "revert") assert.match(ui.container.textContent!, /Prepare bring-back to check the working folder, then review and confirm/);
    fireEvent.click(ui.getByRole("button", { name: mode === "revert" ? "Prepare bring-back" : "Prepare application" }));
    const confirm = await waitFor(() => ui.getByRole("dialog", { name: /^Confirm/ }));
    fireEvent.click(within(confirm).getByRole("checkbox"));
    fireEvent.click(within(confirm).getByRole("button", { name: /confirmed changes$/ }));
    return { ui, confirm };
  };
  const rv = await run("revert", "r3", "");
  assert.ok(within(rv.confirm).getByText("Confirmed changes"));
  const done = await waitFor(() => rv.ui.getByRole("dialog", { name: "Bring back completed" }));
  assert.match(done.textContent!, /Rev 003 and Main's latest saved revision both stay in history\./);
  assert.match(done.textContent!, /keep this bring-back in the revision's history/);
  assert.doesNotMatch(done.textContent!, /Design Case|provenance/);
  cleanup();
  const mg = await run("merge", "p2", "Select source addition: New.txt");
  const doneM = await waitFor(() => mg.ui.getByRole("dialog", { name: "Application completed" }));
  assert.match(doneM.textContent!, /The source Design Case and its saved history remain available\./);
  assert.match(doneM.textContent!, /application provenance/);
});

test("revert counts pluralise", () => {
  const state = fixture();
  state.revisions[2].manifest.files.push({ path: "Old2.txt", sha256: "9".repeat(8), size: 3, lastModified: 0 });
  const ui = render(
    <ApplyPreviewDialog state={state} sourceId="r3" destinationBranchId="branch-main" mode="revert" onClose={() => {}} />,
  );
  assert.match(
    ui.getByRole("status", { name: "Proposed result summary" }).textContent!,
    /2 files brought back · 1 replaced · 1 removed/,
  );
});

const renamedBlock = (state: ReturnType<typeof fixture>) => {
  const cf = (path: string) => ({ path, componentId: "component-1" }) as any;
  state.components = {
    status: "available",
    revisions: {
      r3: { files: [cf("Old.txt")], payloadSha256: "x", renames: [] },
      r6: { files: [cf("Parts/Renamed.SLDPRT")], payloadSha256: "x", renames: [] },
    },
  } as any;
  return state;
};

test("Refresh saved states keeps deselected rows and the typed reason when the revisions are unchanged", async () => {
  let ui!: ReturnType<typeof render>;
  const dialog = (state: ReturnType<typeof fixture>, controller: ApplicationController) => (
    <ApplyPreviewDialog state={state} sourceId="r3" destinationBranchId="branch-main" mode="revert" application={controller} onClose={() => {}} />
  );
  const controller: ApplicationController = {
    progress: null,
    cancel: () => {},
    prepare: async () => { throw new Error("not used"); },
    apply: async () => {},
    refresh: async () => { ui.rerender(dialog(fixture(), controller)); },
  };
  ui = render(dialog(fixture(), controller));
  const extra = () => ui.getByRole("checkbox", { name: "Select Remove (not in Rev 003): Extra.txt" }) as HTMLInputElement;
  const reason = () => ui.getByRole("textbox", { name: "Engineering reason for bringing this back" }) as HTMLTextAreaElement;
  fireEvent.click(extra());
  fireEvent.change(reason(), { target: { value: "Housing change was wrong" } });
  assert.equal(extra().checked, false);
  fireEvent.click(ui.getByRole("button", { name: "Refresh saved states" }));
  await waitFor(() => assert.equal((ui.getByRole("button", { name: "Refresh saved states" }) as HTMLButtonElement).disabled, false));
  assert.equal(extra().checked, false, "deselected row stays deselected");
  assert.equal(reason().value, "Housing change was wrong");
  assert.equal((ui.getByRole("checkbox", { name: "Select Bring back: Old.txt" }) as HTMLInputElement).checked, true);
});

test("Refresh saved states drops the choice of a row that became blocked, and the plan leaves it out", async () => {
  const sent: any[] = [];
  let ui!: ReturnType<typeof render>;
  const dialog = (state: ReturnType<typeof fixture>, controller: ApplicationController) => (
    <ApplyPreviewDialog state={state} sourceId="r3" destinationBranchId="branch-main" mode="revert" application={controller} onClose={() => {}} />
  );
  const controller: ApplicationController = {
    progress: null,
    cancel: () => {},
    prepare: async (review) => {
      sent.push(review);
      const state = renamedBlock(fixture());
      const prep = prepareApplyPreview(state, "r3", "branch-main", review.mode);
      if (prep.status !== "available") throw new Error(prep.reason);
      return { review, plan: buildApplyPreview(prep.context, review.choices, review.reason), destinationName: "main", branchName: "Main", connection: new InMemoryFileSystemAdapter("main") };
    },
    apply: async () => {},
    refresh: async () => { ui.rerender(dialog(renamedBlock(fixture()), controller)); },
  };
  ui = render(dialog(fixture(), controller));
  fireEvent.change(ui.getByRole("textbox", { name: "Engineering reason for bringing this back" }), { target: { value: "Because" } });
  fireEvent.click(ui.getByRole("button", { name: "Refresh saved states" }));
  await waitFor(() => assert.equal((ui.getByRole("checkbox", { name: "Select Bring back: Old.txt" }) as HTMLInputElement).disabled, true));
  assert.equal((ui.getByRole("checkbox", { name: "Select Bring back: Old.txt" }) as HTMLInputElement).checked, false);
  fireEvent.click(ui.getByRole("button", { name: "Prepare bring-back" }));
  await waitFor(() => ui.getByRole("dialog", { name: "Confirm bringing back into working files" }));
  assert.equal("Old.txt" in sent[0].choices, false);
  assert.deepEqual(
    Object.entries(sent[0].choices).filter(([, c]: any) => c.selected).map(([p]) => p).sort(),
    ["Extra.txt", "Parts/Housing.SLDPRT"],
  );
});

test("reconcileChoices: new available rows are pre-selected in revert only; vanished, blocked or re-kinded rows are dropped; unchanged returns the same object", () => {
  const rowsOf = (state: ReturnType<typeof fixture>, source: string, mode: "revert" | "merge") => {
    const prep = prepareApplyPreview(state, source, "branch-main", mode);
    if (prep.status !== "available") throw new Error(prep.reason);
    return prep.context.rows;
  };
  const full = rowsOf(fixture(), "r3", "revert");
  const without = (path: string) => full.filter((row) => row.path !== path);
  const chosen = { selected: false, decision: "use-source" as const };
  // revert: Old.txt newly appeared and was never chosen -> pre-selected; the user's other choice is kept
  const kept = { "Extra.txt": chosen };
  const added = reconcileChoices(kept, without("Old.txt"), full, true);
  assert.equal(added["Extra.txt"], chosen);
  assert.deepEqual(added["Old.txt"], { selected: true, decision: "use-source" });
  // merge: a newly available row is not pre-selected
  const mergeRows = rowsOf(fixture(), "p2", "merge");
  assert.deepEqual(reconcileChoices({}, [], mergeRows, false), {});
  // unchanged -> same object
  const same = { "Extra.txt": chosen, "Old.txt": chosen, "Parts/Housing.SLDPRT": chosen };
  assert.equal(reconcileChoices(same, full, full, true), same);
  // vanished row -> dropped
  const gone = reconcileChoices({ "Old.txt": chosen, "Extra.txt": chosen, "Parts/Housing.SLDPRT": chosen }, full, without("Old.txt"), true);
  assert.deepEqual(Object.keys(gone).sort(), ["Extra.txt", "Parts/Housing.SLDPRT"]);
  // re-kinded row: Old.txt was already-matches, is now available -> old choice replaced by the pre-selection
  const rekinded = reconcileChoices(
    { "Old.txt": chosen },
    full.map((row) => (row.path === "Old.txt" ? { ...row, kind: "already-matches" as const } : row)),
    full,
    true,
  );
  assert.notEqual(rekinded["Old.txt"], chosen);
  assert.deepEqual(rekinded["Old.txt"], { selected: true, decision: "use-source" });
  // blocked row -> dropped and not re-selected
  const blocked = rowsOf(renamedBlock(fixture()), "r3", "revert");
  const afterBlock = reconcileChoices({ "Old.txt": chosen }, full, blocked, true);
  assert.equal("Old.txt" in afterBlock, false);
});
