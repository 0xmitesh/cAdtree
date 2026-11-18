import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  render,
  cleanup,
  fireEvent,
  within,
  waitFor,
} from "@testing-library/react";
import {
  ApplyPreviewDialog,
  type ApplicationController,
} from "./ApplyPreviewDialog";
import { ApplicationStatus, AppliedFromDetails } from "./ApplicationStatus";
import { scenarioState } from "../../tests/history-data";
import {
  prepareApplyPreview,
  buildApplyPreview,
} from "../engine/apply-preview";
import { InMemoryFileSystemAdapter } from "../engine/fs-adapter";
import { applicationReview } from "../engine/application-service";
import {
  sealApplication,
  type ApplicationOperation,
} from "../engine/application-records";
afterEach(cleanup);
function fixture() {
  const state = scenarioState("branches");
  const source = state.revisions[7];
  source.manifest.files.push({
    path: "New.txt",
    size: 3,
    sha256: "new",
    lastModified: 0,
  });
  const preparation = prepareApplyPreview(
    state,
    source.manifest.revisionId,
    "branch-main",
  );
  if (preparation.status !== "available") throw new Error(preparation.reason);
  const choices = {
    "New.txt": { selected: true, decision: "use-source" as const },
  };
  const plan = buildApplyPreview(
    preparation.context,
    choices,
    "Reuse reviewed design",
  );
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
test("preparation requires a final destination confirmation and CAD-close acknowledgement before any apply callback", async () => {
  const f = fixture();
  let preparations = 0,
    applications = 0;
  const controller: ApplicationController = {
    progress: null,
    cancel: () => {},
    destinationLocation: "projects/actuator/working/main",
    prepare: async (review) => {
      preparations++;
      return {
        review,
        plan: buildApplyPreview(
          f.preparation.context,
          review.choices,
          review.reason,
        ),
        destinationName: "main",
        branchName: "Main",
        connection: new InMemoryFileSystemAdapter("main"),
      };
    },
    apply: async () => {
      applications++;
    },
  };
  const ui = render(
    <ApplyPreviewDialog
      state={f.state}
      sourceId={f.source.manifest.revisionId}
      destinationBranchId="branch-main"
      onClose={() => {}}
      application={controller}
    />,
  );
  fireEvent.click(
    ui.getByRole("checkbox", { name: "Select source addition: New.txt" }),
  );
  fireEvent.change(
    ui.getByRole("textbox", {
      name: "Engineering reason for proposed application",
    }),
    { target: { value: "Reuse reviewed design" } },
  );
  fireEvent.click(ui.getByRole("button", { name: "Prepare application" }));
  await waitFor(() =>
    assert.equal(
      ui.getByRole("dialog").getAttribute("aria-labelledby") !== null,
      true,
    ),
  );
  const dialog = await waitFor(() =>
    ui.getByRole("dialog", { name: "Confirm working-file application" }),
  );
  assert.equal(preparations, 1);
  assert.equal(applications, 0);
  assert.match(dialog.textContent!, /working\/main/);
  const apply = within(dialog).getByRole("button", {
    name: "Apply confirmed changes",
  });
  assert.equal((apply as HTMLButtonElement).disabled, true);
  fireEvent.click(
    within(dialog).getByRole("checkbox", {
      name: "I have saved and closed relevant CAD documents and confirm this destination.",
    }),
  );
  fireEvent.click(apply);
  await waitFor(() =>
    ui.getByRole("dialog", { name: "Application completed" }),
  );
  assert.equal(applications, 1);
  assert.match(
    ui.getByRole("dialog").textContent!,
    /Applied to working files — revision not yet saved/,
  );
});
test("failed preparation leaves the review explicit and never calls apply", async () => {
  const f = fixture();
  let applies = 0;
  const controller: ApplicationController = {
    progress: null,
    cancel: () => {},
    prepare: async () => {
      throw new Error("Destination has uncaptured changes. Save first.");
    },
    apply: async () => {
      applies++;
    },
  };
  const ui = render(
    <ApplyPreviewDialog
      state={f.state}
      sourceId={f.source.manifest.revisionId}
      destinationBranchId="branch-main"
      onClose={() => {}}
      application={controller}
    />,
  );
  fireEvent.click(
    ui.getByRole("checkbox", { name: "Select source addition: New.txt" }),
  );
  fireEvent.change(
    ui.getByRole("textbox", {
      name: "Engineering reason for proposed application",
    }),
    { target: { value: "Reuse design" } },
  );
  fireEvent.click(ui.getByRole("button", { name: "Prepare application" }));
  await waitFor(() =>
    assert.match(ui.getByRole("alert").textContent!, /uncaptured changes/),
  );
  assert.equal(applies, 0);
  assert.equal(
    ui.queryByRole("button", { name: "Apply confirmed changes" }),
    null,
  );
});
test("pending status is branch scoped; abandonment is explicit and recovery requires the CAD-close acknowledgement", async () => {
  const f = fixture();
  f.state.applicationOperations = [f.operation];
  let abandons = 0,
    recovers = 0,
    cancels = 0;
  const props = {
    state: f.state,
    branchId: "branch-main",
    busy: false,
    progress: null,
    onCancel: () => {
      cancels++;
    },
    onRecover: async () => {
      recovers++;
    },
    onAbandon: async () => {
      abandons++;
    },
    onRefresh: async () => {},
    onChanges: () => {},
  };
  const ui = render(
    <ApplicationStatus {...props} branchId={f.source.manifest.branchId} />,
  );
  assert.equal(ui.queryByRole("region"), null);
  ui.rerender(<ApplicationStatus {...props} />);
  assert.match(ui.getByRole("region").textContent!, /revision not yet saved/);
  fireEvent.click(
    ui.getByRole("button", { name: "Abandon pending provenance" }),
  );
  assert.equal(abandons, 0);
  fireEvent.click(
    ui.getByRole("button", { name: "Abandon record, keep working edits" }),
  );
  await waitFor(() => assert.equal(abandons, 1));
  f.operation.status = "unresolved";
  ui.rerender(<ApplicationStatus {...props} />);
  fireEvent.click(
    ui.getByRole("button", { name: "Recover interrupted application" }),
  );
  assert.equal(recovers, 0);
  assert.equal(
    (
      ui.getByRole("button", {
        name: "Recover recognized applied files",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  fireEvent.click(
    ui.getByRole("checkbox", {
      name: "I have saved and closed relevant CAD documents.",
    }),
  );
  fireEvent.click(
    ui.getByRole("button", { name: "Recover recognized applied files" }),
  );
  await waitFor(() => assert.equal(recovers, 1));
  assert.equal(cancels, 0);
});
test("Copied files details distinguish originally applied and final captured bytes without replacing engineering notes", () => {
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
        {
          path: "New.txt",
          file: {
            path: "New.txt",
            size: 8,
            sha256: "cad-adjustment",
            lastModified: 1,
          },
        },
      ],
    },
  ];
  f.state.applicationOperations = [f.operation];
  const ui = render(<AppliedFromDetails state={f.state} revisionId="final" />);
  assert.doesNotMatch(ui.container.textContent!, /Engineering reason/);
  assert.match(
    ui.container.textContent!,
    /Adjusted after application before saving/,
  );
  assert.match(ui.container.textContent!, /Originally applied: new/);
  assert.match(ui.container.textContent!, /Final captured: cad-adjustment/);
});
