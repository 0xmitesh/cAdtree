import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { render, cleanup, fireEvent, within } from "@testing-library/react";
import {
  HistoryRecoveryView,
  type HistoryRecoveryViewProps,
} from "./HistoryRecoveryView";
import { historyState, scenarioState } from "../../tests/history-data";
afterEach(cleanup);
const path = "Parts/Housing.SLDPRT";
function props(
  overrides: Partial<HistoryRecoveryViewProps> = {},
): HistoryRecoveryViewProps {
  return {
    vaultState: historyState(3),
    activeBranchId: "branch-main",
    progress: null,
    statusBanner: null,
    onExportForReview: async () => {
      throw new Error("Export must not run");
    },
    onVerifySingleRevisionObjects: async () => {},
    onCancelOperation: () => {},
    ...overrides,
  };
}
test("file dropdown filters both views, shows notes, preserves ancestry scope, and restores All files", () => {
  const state = scenarioState("branches");
  state.revisions.forEach((r) => {
    r.manifest.files[1].sha256 = r.manifest.revisionId === "r1" ? "a" : "b";
  });
  const ui = render(<HistoryRecoveryView {...props({ vaultState: state })} />);
  fireEvent.click(ui.getByRole("button", { name: "Prototype" }));
  fireEvent.change(ui.getByRole("combobox", { name: "File history" }), {
    target: { value: path },
  });
  assert.equal(
    ui.container.querySelectorAll('.graph-row[data-file-history-kind="change"]')
      .length,
    2,
  );
  assert.equal(
    ui.container.querySelectorAll(
      '.graph-row[data-file-history-kind="context"]',
    ).length,
    0,
  );
  assert.ok(
    ui
      .getByRole("region", { name: "Selected file history" })
      .textContent?.includes("Bore clearance increased"),
  );
  fireEvent.click(ui.getByRole("button", { name: /Rev 001:/ }));
  // Newest first: the next newer revision is above.
  fireEvent.keyDown(ui.getByRole("button", { name: /Rev 001:/ }), {
    key: "ArrowUp",
  });
  assert.ok(
    ui
      .getByRole("button", { name: /Rev 002:/ })
      .getAttribute("aria-pressed") === "true",
  );
  fireEvent.click(ui.getByRole("button", { name: "List" }));
  assert.equal(ui.container.querySelectorAll(".revision-list-row").length, 2);
  fireEvent.change(ui.getByRole("combobox", { name: "File history" }), {
    target: { value: "" },
  });
  assert.equal(ui.container.querySelectorAll(".revision-list-row").length, 8);
  assert.equal(
    ui.getByRole("button", { name: "Prototype" }).getAttribute("aria-pressed"),
    "true",
  );
});
test("deleted file selection cannot export absence; parent inspection and selected-file export keep exact revision identity", () => {
  const state = historyState(3);
  state.revisions[1].manifest.files[1].sha256 =
    state.revisions[0].manifest.files[1].sha256;
  state.revisions[2].manifest.files = state.revisions[2].manifest.files.filter(
    (f) => f.path !== path,
  );
  const ui = render(<HistoryRecoveryView {...props({ vaultState: state })} />);
  fireEvent.change(ui.getByRole("combobox", { name: "File history" }), {
    target: { value: path },
  });
  assert.equal(
    (
      ui.getByRole("checkbox", {
        name: `Select ${path} for export`,
      }) as HTMLInputElement
    ).disabled,
    true,
  );
  assert.equal(
    (
      ui.getByRole("button", {
        name: "Select file for export",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  fireEvent.click(ui.getByRole("button", { name: /View in parent revision/ }));
  assert.ok(
    ui
      .getByRole("region", { name: "Selected file history" })
      .textContent?.includes("Context only"),
  );
  assert.equal(
    (
      ui.getByRole("checkbox", {
        name: `Select ${path} for export`,
      }) as HTMLInputElement
    ).checked,
    true,
  );
  assert.equal(ui.queryByRole("button", { name: /Copy selected files/ }), null);
  assert.equal(ui.queryByRole("button", { name: "Restore project copy" }), null);
  fireEvent.click(ui.getByRole("button", { name: "Export for review" }));
  const dialog = within(ui.getByRole("dialog"));
  fireEvent.click(dialog.getByRole("radio", { name: /Selected files/ }));
  assert.equal(
    (dialog.getByRole("checkbox", { name: `Export ${path}` }) as HTMLInputElement).checked,
    true,
  );
});
test("empty branch scope is explained and project switching resets file and branch scope", () => {
  const state = scenarioState("branches");
  state.revisions.forEach((r) => {
    r.manifest.files = r.manifest.files.filter((f) => f.path !== path);
  });
  state.revisions[5].manifest.files.push({
    path,
    sha256: "a",
    size: 1,
    lastModified: 0,
  });
  const ui = render(<HistoryRecoveryView {...props({ vaultState: state })} />);
  fireEvent.click(ui.getByRole("button", { name: "Prototype" }));
  fireEvent.change(ui.getByRole("combobox", { name: "File history" }), {
    target: { value: path },
  });
  assert.ok(ui.getByText(/No recorded history for this file within Prototype/));
  assert.equal(
    ui.queryByRole("complementary", { name: "Revision details" }),
    null,
  );
  const next = historyState(1);
  next.project.projectId = "another-project";
  ui.rerender(<HistoryRecoveryView {...props({ vaultState: next })} />);
  assert.equal(
    (ui.getByRole("combobox", { name: "File history" }) as HTMLSelectElement)
      .value,
    "",
  );
  assert.equal(
    ui.getByRole("button", { name: "Main" }).getAttribute("aria-pressed"),
    "false",
  );
});
test("file filtering keeps damaged evidence visible and preserves export blocking", () => {
  const state = historyState(2);
  state.revisions[1].integrityStatus = "corrupted";
  const ui = render(<HistoryRecoveryView {...props({ vaultState: state })} />);
  fireEvent.change(ui.getByRole("combobox", { name: "File history" }), {
    target: { value: path },
  });
  fireEvent.click(ui.getByRole("button", { name: /Rev 002:/ }));
  assert.ok(
    ui
      .getByRole("region", { name: "Selected file history" })
      .textContent?.includes("History unavailable"),
  );
  assert.ok(ui.getByText("Damaged revision · export blocked"));
  assert.equal(
    (
      ui.getByRole("button", {
        name: "Export for review",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  assert.equal(
    ui.queryByRole("checkbox", { name: `Select ${path} for export` }),
    null,
  );
});
