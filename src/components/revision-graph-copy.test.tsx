import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  HistoryRecoveryView,
  type HistoryRecoveryViewProps,
} from "./HistoryRecoveryView";
import { scenarioState } from "../../tests/history-data";

afterEach(cleanup);
function historyProps(
  overrides: Partial<HistoryRecoveryViewProps> = {},
): HistoryRecoveryViewProps {
  return {
    vaultState: scenarioState("branches"),
    activeBranchId: "branch-main",
    progress: null,
    statusBanner: null,
    onVerifySingleRevisionObjects: async () => {},
    onCancelOperation: () => {},
    ...overrides,
  };
}

function stateWithCopies() {
  const state = scenarioState("branches");
  const op = (child: string, source: string, mode: string, branch: string) =>
    ({
      operationId: `apply-${child}`,
      destinationBranchId: "branch-main",
      relativePath: "applications/branch-main/x",
      status: "captured",
      capturedRevisionId: child,
      events: [],
      record: { sourceBranchId: branch, plan: { sourceRevisionId: source, mode, reason: "Because", actions: [] } },
    }) as any;
  state.applicationOperations = [
    op("r6", "p2", "merge", "prototype"),
    op("r5", "r3", "revert", "branch-main"),
  ];
  return state;
}

test("graph draws a dashed line toward the source and names it on the row", () => {
  const ui = render(<HistoryRecoveryView {...historyProps({ vaultState: stateWithCopies() })} />);
  const lines = [...ui.container.querySelectorAll<SVGPathElement>(".graph-copy-line")];
  assert.deepEqual(
    lines.map((l) => [l.dataset.copyChild, l.dataset.copySource, l.dataset.copyMode]).sort(),
    [["r5", "r3", "revert"], ["r6", "p2", "merge"]],
  );
  for (const line of lines) {
    assert.ok(line.getAttribute("stroke-dasharray"));
    assert.match(line.getAttribute("marker-end")!, /^url\(#.+-copy\)$/);
  }
  // Parent edges keep their own solid style.
  const parents = ui.container.querySelectorAll("path[data-child]");
  assert.ok(parents.length > 0);
  // Links run in the gutter right of both dots, so never over a parent line.
  for (const line of lines) assert.match(line.getAttribute("d")!, /^M [\d.]+ [\d.]+ Q .* V .* Q /);
  for (const p of parents) assert.equal(p.getAttribute("stroke-dasharray"), null);
  const merged = ui.getByRole("button", { name: /^Rev 006:/ });
  assert.match(merged.getAttribute("aria-label")!, /, copied from Rev 008$/);
  assert.equal(merged.getAttribute("title"), "copied from Rev 008");
  assert.match(ui.getByRole("button", { name: /^Rev 005:/ }).getAttribute("aria-label")!, /, brought back Rev 003$/);
  assert.equal(ui.getByRole("button", { name: /^Rev 004:/ }).getAttribute("title"), null);
});

test("graph order stays newest first with copy links present", () => {
  const ui = render(<HistoryRecoveryView {...historyProps({ vaultState: stateWithCopies() })} />);
  const withCopies = [...ui.container.querySelectorAll(".graph-hit")].map((r) => /Rev (\d{3})/.exec(r.getAttribute("aria-label")!)![1]);
  cleanup();
  const plain = render(<HistoryRecoveryView {...historyProps({ vaultState: scenarioState("branches") })} />);
  const without = [...plain.container.querySelectorAll(".graph-hit")].map((r) => /Rev (\d{3})/.exec(r.getAttribute("aria-label")!)![1]);
  assert.deepEqual(withCopies, without);
});

test("List view shows the same as small text", () => {
  const ui = render(<HistoryRecoveryView {...historyProps({ vaultState: stateWithCopies() })} />);
  fireEvent.click(ui.getByRole("button", { name: "List" }));
  const rows = [...ui.container.querySelectorAll(".revision-list-row")];
  const text = (n: string) => rows.find((r) => r.textContent!.includes(`Rev ${n}`))!.querySelector(".copy-note")?.textContent;
  assert.equal(text("006"), "copied from Rev 008");
  assert.equal(text("005"), "brought back Rev 003");
  assert.equal(text("004"), undefined);
  assert.equal(ui.container.querySelectorAll(".graph-copy-line").length, 0);
});

test("a copy whose source is not in the history draws nothing and does not crash", () => {
  const state = stateWithCopies();
  state.revisions = state.revisions.filter((r) => r.manifest.revisionId !== "p2");
  state.branchHeads.prototype = "p1";
  const ui = render(<HistoryRecoveryView {...historyProps({ vaultState: state })} />);
  assert.equal(ui.container.querySelectorAll('.graph-copy-line[data-copy-source="p2"]').length, 0);
  assert.equal(ui.getByRole("button", { name: /^Rev 006:/ }).getAttribute("title"), null);
});

test("revision details: one plain line outside Troubleshooting, the byte and identity details inside it", () => {
  const state = scenarioState("branches");
  const file = (sha: string) => ({ path: "New.txt", size: 1, sha256: sha, lastModified: 0 });
  state.applicationOperations = [
    {
      operationId: "apply-detail",
      destinationBranchId: "branch-main",
      relativePath: "applications/branch-main/apply-detail",
      status: "captured",
      capturedRevisionId: "r6",
      events: [{ kind: "capture", revisionId: "r6", finalFiles: [{ path: "New.txt", file: file("final-sha") }] }],
      record: {
        sourceBranchId: "prototype",
        plan: {
          sourceRevisionId: "p2",
          baseRevisionId: "r2",
          destinationRevisionId: "r5",
          mode: "merge",
          reason: "Reuse reviewed design",
          actions: [{ path: "New.txt", operation: "add", before: null, after: file("applied-sha") }],
        },
      },
    } as any,
  ];
  const ui = render(<HistoryRecoveryView {...historyProps({ vaultState: state })} />);
  fireEvent.click(ui.getByRole("button", { name: /^Rev 006:/ }));
  const troubleshooting = ui.container.querySelector<HTMLDetailsElement>(".revision-troubleshooting")!;
  const line = ui.container.querySelector(".applied-from")!;
  assert.equal(line.textContent, "Copied from Rev 008 on Prototype — Reuse reviewed design");
  assert.equal(troubleshooting.contains(line), false);
  assert.equal(troubleshooting.open, false);
  for (const text of [/Before, applied and captured bytes/, /Application record identities/]) {
    assert.ok(troubleshooting.textContent!.match(text), String(text));
    assert.equal(line.parentElement!.textContent!.replace(troubleshooting.textContent!, "").match(text), null);
  }
  // Revisions without provenance show neither.
  fireEvent.click(ui.getByRole("button", { name: /^Rev 004:/ }));
  assert.equal(ui.container.querySelector(".applied-from"), null);
  assert.equal(ui.container.querySelector(".applied-from-details"), null);
});
