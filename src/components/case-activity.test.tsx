import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { render, cleanup, fireEvent, within } from "@testing-library/react";
import { historyState, revision } from "../../tests/history-data";
import { DesignCases } from "./DesignCases";
afterEach(cleanup);
function fixture() {
  const state = historyState(2);
  state.branches.push({
    ...state.branches[0],
    branchId: "case",
    name: "Alternative",
    isMain: false,
    startingRevisionId: "r1",
  });
  state.branchHeads.case = "r1";
  return state;
}
const controls = {
  activeBranchId: "branch-main",
  busy: false,
  progress: null,
  onChange: async () => {
    throw new Error("Read-only workflow must not change lifecycle");
  },
  onCancel: () => {},
};
test("the design cases panel has no Saved activity and divergence section; Compare uses explicit case → Main endpoints", () => {
  const state = fixture();
  const ui = render(<DesignCases state={state} {...controls} />);
  assert.equal(
    ui.queryByLabelText("Saved activity and divergence for Alternative"),
    null,
  );
  assert.doesNotMatch(ui.container.textContent!, /Saved activity and divergence/);
  assert.equal(ui.container.querySelector(".case-activity"), null);
  fireEvent.click(
    ui.getByRole("button", { name: "Compare Alternative with Main" }),
  );
  const dialog = ui.getByRole("dialog", { name: "Compare saved revisions" });
  assert.equal(
    (
      within(dialog).getByRole("combobox", {
        name: "From revision",
      }) as HTMLSelectElement
    ).value,
    "r1",
  );
  assert.equal(
    (
      within(dialog).getByRole("combobox", {
        name: "To revision",
      }) as HTMLSelectElement
    ).value,
    "r2",
  );
  assert.match(dialog.textContent!, /Scope: All project files/);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Close comparison" }),
  );
  assert.equal(ui.queryByRole("dialog"), null);
});
test("unavailable ancestry leaves healthy endpoint comparison available, and archived discovery/reopen stay intact", () => {
  const state = fixture();
  state.revisions.push(revision("c3", "r1", 3, "case"));
  state.branchHeads.case = "c3";
  state.branchBaselineEndpoints = { "branch-main": "r2", case: "c3" };
  state.revisions[0].manifest.parentRevisionId = "missing";
  state.caseLifecycles = {
    case: { status: "archived", sequence: 1, version: "version" },
  };
  const ui = render(<DesignCases state={state} {...controls} />);
  fireEvent.click(ui.getByText("Archived cases (1)", { exact: true }));
  assert.ok(ui.getByRole("button", { name: "Reopen case Alternative" }));
  const button = ui.getByRole("button", {
    name: "Compare Alternative with Main",
  }) as HTMLButtonElement;
  assert.equal(button.disabled, false);
  fireEvent.click(button);
  const dialog = ui.getByRole("dialog");
  assert.equal(
    (
      within(dialog).getByRole("combobox", {
        name: "From revision",
      }) as HTMLSelectElement
    ).value,
    "c3",
  );
  assert.match(dialog.textContent!, /Alternative · Archived/);
});
test("unknown committed ownership never displays zero saves or offers an automatic guessed baseline", () => {
  const state = fixture();
  state.corruptedRecords.push({
    recordPath: "completed/unreadable.done.json",
    reason: "Unreadable completion",
  });
  const ui = render(<DesignCases state={state} {...controls} />);
  assert.doesNotMatch(
    ui.container.textContent!,
    /No revisions saved on this case yet/,
  );
  assert.equal(
    (
      ui.getByRole("button", {
        name: "Compare Alternative with Main",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
});
