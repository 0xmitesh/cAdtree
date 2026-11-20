import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { render, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import { ApplyPreviewDialog, type ApplicationController } from "./ApplyPreviewDialog";
import { ApplicationStatus, AppliedFromDetails } from "./ApplicationStatus";
import { scenarioState } from "../../tests/history-data";
import { prepareApplyPreview, buildApplyPreview } from "../engine/apply-preview";
import { applicationReview } from "../engine/application-service";
import {
  sealApplication,
  type ApplicationOperation,
  type ApplicationReview,
} from "../engine/application-records";
afterEach(cleanup);
function fixture() {
  const state = scenarioState("branches");
  const source = state.revisions[7];
  source.manifest.files.push({ path: "New.txt", size: 3, sha256: "new", lastModified: 0 });
  const preparation = prepareApplyPreview(state, source.manifest.revisionId, "branch-main");
  if (preparation.status !== "available") throw new Error(preparation.reason);
  const choices = { "New.txt": { selected: true, decision: "use-source" as const } };
  const plan = buildApplyPreview(preparation.context, choices, "Reuse reviewed design");
  const operation: ApplicationOperation = {
    operationId: "apply-test",
    destinationBranchId: "branch-main",
    relativePath: "applications/branch-main/apply-test",
    status: "applied",
    events: [],
    record: sealApplication({
      schemaVersion: 1 as const,
      kind: "cadtree-file-application" as const,
      operationId: "apply-test",
      createdAt: "2026-11-01",
      sourceBranchId: source.manifest.branchId,
      review: applicationReview(plan, choices),
      plan,
    }),
  };
  return { state, source, preparation, operation };
}
function spy(extra: Partial<ApplicationController> = {}) {
  const sent: ApplicationReview[] = [];
  const controller: ApplicationController = {
    progress: null,
    cancel: () => {},
    applyAndSave: async (review) => {
      sent.push(review);
      return undefined;
    },
    ...extra,
  };
  return { sent, controller };
}
test("Copy files: the case's files are ticked by default, base is hidden, one Copy files button saves with an optional Why", async () => {
  const f = fixture();
  const { sent, controller } = spy();
  let closed = 0;
  const ui = render(
    <ApplyPreviewDialog state={f.state} sourceId={f.source.manifest.revisionId} destinationBranchId="branch-main" onClose={() => closed++} application={controller} />,
  );
  const dialog = ui.getByRole("dialog", { name: "Copy files from Prototype" });
  assert.doesNotMatch(dialog.textContent!, /Base|Prepare|Engineering reason|Destination/);
  const box = within(dialog).getByRole("checkbox", { name: "Copy New.txt" }) as HTMLInputElement;
  assert.equal(box.checked, true);
  fireEvent.click(within(dialog).getByRole("radio", { name: "Take theirs" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Copy files" }));
  await waitFor(() => assert.equal(closed, 1));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].mode, "merge");
  assert.equal(sent[0].reason, "");
  assert.deepEqual(sent[0].choices["New.txt"], { selected: true, decision: "use-source" });
});
test("a failed Copy shows its error in the dialog and nothing closes", async () => {
  const f = fixture();
  const { controller } = spy({
    applyAndSave: async () => {
      throw new Error("Destination has uncaptured changes. Save first.");
    },
  });
  let closed = 0;
  const ui = render(
    <ApplyPreviewDialog state={f.state} sourceId={f.source.manifest.revisionId} destinationBranchId="branch-main" onClose={() => closed++} application={controller} />,
  );
  fireEvent.click(ui.getByRole("radio", { name: "Keep mine" }));
  fireEvent.click(ui.getByRole("button", { name: "Copy files" }));
  await waitFor(() => assert.match(ui.getByRole("alert").textContent!, /uncaptured changes/));
  assert.equal(closed, 0);
});
test("Copy files with unsaved changes offers Save my changes first instead", () => {
  const f = fixture();
  let saveFirst = 0;
  const { controller } = spy({ unsavedChanges: 1, onSaveFirst: () => saveFirst++ });
  const ui = render(
    <ApplyPreviewDialog state={f.state} sourceId={f.source.manifest.revisionId} destinationBranchId="branch-main" onClose={() => {}} application={controller} />,
  );
  assert.match(ui.getByRole("dialog").textContent!, /Main has 1 unsaved change\./);
  assert.equal(ui.queryByRole("button", { name: "Copy files" }), null);
  fireEvent.click(ui.getByRole("button", { name: "Save my changes first" }));
  assert.equal(saveFirst, 1);
});
test("the status is branch scoped: not saved offers Save now only, with no Abandon or Refresh", () => {
  const f = fixture();
  f.state.applicationOperations = [f.operation];
  const saved: string[] = [];
  const props = {
    state: f.state,
    branchId: "branch-main",
    busy: false,
    progress: null,
    onCancel: () => {},
    onRecover: async () => {},
    onSaveNow: (op: ApplicationOperation) => saved.push(op.operationId),
    onDontSave: async () => {},
  };
  const ui = render(<ApplicationStatus {...props} branchId={f.source.manifest.branchId} />);
  assert.equal(ui.queryByRole("region"), null);
  ui.rerender(<ApplicationStatus {...props} />);
  assert.equal(
    ui.getByRole("region").textContent!.split("Save now")[0],
    "Copied 1 file from Prototype, but it wasn't saved. Your working files are fine.",
  );
  assert.equal(ui.queryByRole("button", { name: /Abandon|Refresh|Undo/ }), null);
  assert.doesNotMatch(ui.container.textContent!, /not yet saved/);
  fireEvent.click(ui.getByRole("button", { name: "Save now" }));
  assert.deepEqual(saved, ["apply-test"]);
  ui.rerender(<ApplicationStatus {...props} notSavedReasons={{ "apply-test": "disk full" }} />);
  assert.match(ui.getByRole("region").textContent!, /but it wasn't saved: disk full\. Your working files are fine\./);
  f.operation.status = "unresolved";
  ui.rerender(<ApplicationStatus {...props} />);
  assert.ok(ui.getByRole("button", { name: "Undo the unfinished Copy" }));
  assert.equal(ui.queryByRole("button", { name: "Save now" }), null);
});
test("Copied files details distinguish originally applied and final captured bytes without replacing notes", () => {
  const f = fixture();
  f.operation.status = "captured";
  f.operation.capturedRevisionId = "final";
  f.operation.events = [
    {
      schemaVersion: 1,
      operationId: "apply-test",
      sequence: 1,
      previous: "",
      kind: "capture",
      at: "now",
      revisionId: "final",
      manifestSha256: "hash",
      checksum: "hash",
      finalFiles: [
        { path: "New.txt", file: { path: "New.txt", size: 8, sha256: "cad-adjustment", lastModified: 1 } },
      ],
    },
  ];
  f.state.applicationOperations = [f.operation];
  const ui = render(<AppliedFromDetails state={f.state} revisionId="final" />);
  assert.doesNotMatch(ui.container.textContent!, /Engineering reason/);
  assert.match(ui.container.textContent!, /Adjusted after application before saving/);
  assert.match(ui.container.textContent!, /Originally applied: new/);
  assert.match(ui.container.textContent!, /Final captured: cad-adjustment/);
});
