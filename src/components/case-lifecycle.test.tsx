import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  render,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { scenarioState } from "../../tests/history-data";
import { DesignCases } from "./DesignCases";
import { layoutRevisions } from "../history/layout";
import { UnsavedCaseChangesError } from "../engine/case-lifecycle-service";
afterEach(cleanup);
test("Hide case/Unhide require explicit confirmation; Main can't be hidden; hidden rows show only with Show hidden cases", async () => {
  const state = scenarioState("branches");
  const branch = state.branches.find((b) => !b.isMain)!;
  const original = structuredClone(state.branches);
  let calls: unknown[] = [];
  const props = {
    state,
    activeBranchId: branch.branchId,
    busy: false,
    progress: null,
    onCancel: () => {},
    onChange: async (...args: unknown[]) => {
      calls.push(args);
    },
  };
  const ui = render(<DesignCases {...props} />);
  // The working case can be hidden: the dialog says the app switches to Main.
  fireEvent.click(
    ui.getByRole("button", { name: `Hide case ${branch.name}` }),
  );
  assert.match(
    ui.getByRole("dialog").textContent!,
    /You are working on this case\. cAdtree switches you to Main/,
  );
  fireEvent.click(
    within(ui.getByRole("dialog")).getByRole("button", { name: "Cancel" }),
  );
  assert.equal(ui.queryByRole("button", { name: "Hide case Main" }), null);
  ui.rerender(<DesignCases {...props} activeBranchId="branch-main" />);
  fireEvent.click(
    ui.getByRole("button", { name: `Hide case ${branch.name}` }),
  );
  assert.equal(calls.length, 0);
  assert.doesNotMatch(ui.getByRole("dialog").textContent!, /switches you to Main/);
  fireEvent.click(
    within(ui.getByRole("dialog")).getByRole("button", {
      name: "Hide case",
    }),
  );
  await waitFor(() => assert.equal(calls.length, 1));
  assert.deepEqual(calls[0], [branch.branchId, "archived", null, undefined]);
  const hidden = {
    ...state,
    caseLifecycles: {
      [branch.branchId]: {
        status: "archived" as const,
        version: "version1",
        sequence: 1,
        unsavedAtHide: 3,
      },
    },
  };
  ui.rerender(
    <DesignCases {...props} state={hidden} activeBranchId="branch-main" />,
  );
  assert.equal(
    ui.queryByRole("button", { name: `Unhide case ${branch.name}` }),
    null,
  );
  assert.match(ui.container.textContent!, /1 hidden case\. Turn on Show hidden cases to see it\./);
  ui.rerender(
    <DesignCases
      {...props}
      state={hidden}
      activeBranchId="branch-main"
      showHidden
    />,
  );
  const row = ui
    .getByRole("button", { name: `Unhide case ${branch.name}` })
    .closest(".case-row")!;
  assert.ok(row.classList.contains("hidden-case"));
  assert.match(row.textContent!, /Hidden/);
  assert.equal(
    row.querySelector(".case-unsaved-badge")?.textContent,
    "3 unsaved changes",
  );
  fireEvent.click(
    ui.getByRole("button", { name: `Unhide case ${branch.name}` }),
  );
  fireEvent.click(
    within(ui.getByRole("dialog")).getByRole("button", { name: "Unhide" }),
  );
  await waitFor(() => assert.equal(calls.length, 2));
  assert.deepEqual(calls[1], [branch.branchId, "active", "version1", undefined]);
  assert.deepEqual(state.branches, original);
});
test("unsaved changes: the first confirm shows the warning, the second carries the acknowledged signature", async () => {
  const state = scenarioState("branches");
  const branch = state.branches.find((b) => !b.isMain)!;
  const calls: unknown[][] = [];
  const ui = render(
    <DesignCases
      state={state}
      activeBranchId="branch-main"
      busy={false}
      progress={null}
      onCancel={() => {}}
      onChange={async (...args) => {
        calls.push(args);
        if (calls.length === 1)
          throw new UnsavedCaseChangesError(
            "This case has 2 unsaved changes. They stay in its folder and show again when you unhide it.",
            2,
            "signature-1",
            false,
          );
      }}
    />,
  );
  fireEvent.click(ui.getByRole("button", { name: `Hide case ${branch.name}` }));
  const dialog = within(ui.getByRole("dialog"));
  fireEvent.click(dialog.getByRole("button", { name: "Hide case" }));
  await waitFor(() =>
    assert.match(
      ui.getByRole("dialog").textContent!,
      /This case has 2 unsaved changes\. They stay in its folder/,
    ),
  );
  assert.equal(ui.queryByRole("alert"), null);
  fireEvent.click(dialog.getByRole("button", { name: "Hide case" }));
  await waitFor(() => assert.equal(calls.length, 2));
  assert.deepEqual(calls[1], [branch.branchId, "archived", null, "signature-1"]);
  await waitFor(() => assert.ok(ui.queryByRole("dialog") === null));
});
test("unavailable lifecycle evidence stays explicit and does not become an active working option", () => {
  const state = scenarioState("branches");
  const branch = state.branches.find((b) => !b.isMain)!;
  state.caseLifecycles = {
    [branch.branchId]: {
      status: "unavailable",
      version: null,
      sequence: 0,
      error: "Lifecycle checksum mismatch",
    },
  };
  const ui = render(
    <>
      <DesignCases
        state={state}
        activeBranchId="branch-main"
        busy={false}
        progress={null}
        onChange={async () => {}}
        onCancel={() => {}}
      />
    </>,
  );
  assert.match(ui.container.textContent!, /Lifecycle checksum mismatch/);
  assert.equal(
    ui.queryByRole("button", { name: `Hide case ${branch.name}` }),
    null,
  );
  const graph = layoutRevisions(state, "branch-main");
  assert.ok(
    graph.nodes.some((node) =>
      node.branchName.includes("Lifecycle unavailable"),
    ),
  );
});
test("hide refusal remains actionable without closing the confirmation or changing a working selection", async () => {
  const state = scenarioState("branches");
  const branch = state.branches.find((b) => !b.isMain)!;
  const ui = render(
    <DesignCases
      state={state}
      activeBranchId="branch-main"
      busy={false}
      progress={null}
      onChange={async () => {
        throw new Error(
          "This case has a Bring back or Copy that isn't saved yet. Finish saving first, then hide the case.",
        );
      }}
      onCancel={() => {}}
    />,
  );
  fireEvent.click(
    ui.getByRole("button", { name: `Hide case ${branch.name}` }),
  );
  fireEvent.click(
    within(ui.getByRole("dialog")).getByRole("button", {
      name: "Hide case",
    }),
  );
  await waitFor(() =>
    assert.match(ui.getByRole("alert").textContent!, /Finish saving first/),
  );
  assert.ok(ui.getByRole("dialog"));
});
