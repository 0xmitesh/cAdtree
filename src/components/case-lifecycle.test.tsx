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
import { ActiveBranchPicker } from "./ActiveBranchPicker";
import { layoutRevisions } from "../history/layout";
afterEach(cleanup);
test("current-case archive is disabled; Archive/Reopen require explicit confirmation and retain complete state", async () => {
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
  assert.equal(
    (
      ui.getByRole("button", {
        name: `Archive case ${branch.name}`,
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  assert.match(ui.container.textContent!, /Switch to another active branch/);
  assert.equal(ui.queryByRole("button", { name: "Archive case Main" }), null);
  ui.rerender(<DesignCases {...props} activeBranchId="branch-main" />);
  fireEvent.click(
    ui.getByRole("button", { name: `Archive case ${branch.name}` }),
  );
  assert.equal(calls.length, 0);
  fireEvent.click(
    within(ui.getByRole("dialog")).getByRole("button", {
      name: "Archive case",
    }),
  );
  await waitFor(() => assert.equal(calls.length, 1));
  assert.deepEqual(calls[0], [branch.branchId, "archived", null]);
  const archived = {
    ...state,
    caseLifecycles: {
      [branch.branchId]: {
        status: "archived" as const,
        version: "version1",
        sequence: 1,
      },
    },
  };
  ui.rerender(
    <DesignCases {...props} state={archived} activeBranchId="branch-main" />,
  );
  const details = ui.getByText("Archived cases (1)").closest("details")!;
  fireEvent.click(ui.getByText("Archived cases (1)"));
  details.open = true;
  fireEvent.click(
    ui.getByRole("button", { name: `Reopen case ${branch.name}` }),
  );
  fireEvent.click(
    within(ui.getByRole("dialog")).getByRole("button", { name: "Reopen case" }),
  );
  await waitFor(() => assert.equal(calls.length, 2));
  assert.deepEqual(calls[1], [branch.branchId, "active", "version1"]);
  assert.deepEqual(state.branches, original);
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
      <ActiveBranchPicker
        state={state}
        activeBranchId="branch-main"
        busy={false}
        onSelect={async () => {}}
      />
    </>,
  );
  assert.match(ui.container.textContent!, /Lifecycle checksum mismatch/);
  assert.equal(
    ui.queryByRole("button", { name: `Archive case ${branch.name}` }),
    null,
  );
  assert.equal(ui.queryByRole("option", { name: branch.name }), null);
  const graph = layoutRevisions(state, "branch-main");
  assert.ok(
    graph.nodes.some((node) =>
      node.branchName.includes("Lifecycle unavailable"),
    ),
  );
});
test("archive refusal remains actionable without closing the confirmation or changing a working selection", async () => {
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
          "This case has uncaptured directory changes. Save first.",
        );
      }}
      onCancel={() => {}}
    />,
  );
  fireEvent.click(
    ui.getByRole("button", { name: `Archive case ${branch.name}` }),
  );
  fireEvent.click(
    within(ui.getByRole("dialog")).getByRole("button", {
      name: "Archive case",
    }),
  );
  await waitFor(() =>
    assert.match(ui.getByRole("alert").textContent!, /uncaptured directory/),
  );
  assert.ok(ui.getByRole("dialog"));
});
