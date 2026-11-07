import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { ApplyPreviewDialog } from "./ApplyPreviewDialog";
import {
  HistoryRecoveryView,
  type HistoryRecoveryViewProps,
} from "./HistoryRecoveryView";
import { revision, scenarioState } from "../../tests/history-data";
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
  isRestoring: false,
  progress: null,
  lastRestoreReport: null,
  statusBanner: null,
  onRestoreFullProject: async () => {
    throw new Error("Recovery must not run");
  },
  onRestoreSelectedFiles: async () => {
    throw new Error("Recovery must not run");
  },
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
test("closing preview preserves History inspection, file filter and recovery selection; project changes close it", () => {
  const state = fixture();
  const ui = render(<HistoryRecoveryView {...props(state)} />);
  fireEvent.change(ui.getByRole("combobox", { name: "File history" }), {
    target: { value: path },
  });
  fireEvent.click(ui.getByRole("button", { name: /Rev 008:/ }));
  fireEvent.click(
    ui.getByRole("checkbox", { name: `Select ${path} for recovery` }),
  );
  fireEvent.click(ui.getByRole("button", { name: "Review changes to apply" }));
  fireEvent.click(ui.getByRole("button", { name: "Close preview" }));
  assert.equal(
    (
      ui.getByRole("checkbox", {
        name: `Select ${path} for recovery`,
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
