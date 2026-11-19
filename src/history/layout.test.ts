import test from "node:test";
import assert from "node:assert/strict";
import { ancestryOf, layoutRevisions } from "./layout";
import {
  historyState,
  revision,
  scenarioState,
} from "../../tests/history-data";
test("empty, single, and Main-only records have truthful lanes and latest markers", () => {
  assert.equal(layoutRevisions(historyState(0), "branch-main").nodes.length, 0);
  const one = layoutRevisions(historyState(1), "branch-main");
  assert.equal(one.edges.length, 0);
  assert.equal(one.nodes[0].latest, true);
  const graph = layoutRevisions(historyState(), "branch-main");
  assert.equal(graph.lanes, 1);
  assert.equal(graph.edges.length, 5);
  assert.equal(graph.nodes.filter((n) => n.latest).length, 1);
});
test("topology follows parents, never timestamps or display numbers; input is not mutated", () => {
  const state = historyState(3);
  state.revisions[0].manifest.displayNumber = 900;
  state.revisions[1].manifest.captureCompletedAt = "1900-01-01";
  const before = JSON.stringify(state);
  const graph = layoutRevisions(state, "branch-main");
  assert.deepEqual(
    graph.nodes.map((n) => n.id),
    ["r3", "r2", "r1"],
  );
  assert.equal(JSON.stringify(state), before);
  state.revisions.reverse();
  assert.deepEqual(layoutRevisions(state, "branch-main"), graph);
});
test("branches share ancestry and keep their own lanes", () => {
  const graph = layoutRevisions(scenarioState("branches"), "branch-main");
  assert.ok(graph.lanes >= 2);
  assert.deepEqual([...ancestryOf(graph, "p2")], ["p2", "p1", "r2", "r1"]);
  for (const e of graph.edges)
    assert.ok(
      graph.nodes.find((n) => n.id === e.child)!.row <
        graph.nodes.find((n) => n.id === e.parent)!.row,
    );
});
test("missing, corrupted, duplicate, and cyclic parent records never fabricate edges", () => {
  const state = historyState(5);
  state.revisions[0].manifest.parentRevisionId = "r2"; // cycle
  state.revisions[2].manifest.parentRevisionId = "absent";
  state.revisions[3].integrityStatus = "corrupted";
  state.revisions.push(revision("r5", "r3", 50)); // duplicate identity
  const graph = layoutRevisions(state, "branch-main");
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.nodes.length, 5);
  for (const id of ["r1", "r2", "r3", "r4", "r5"])
    assert.ok(graph.nodes.find((n) => n.id === id)!.warnings.length);
});
test("competing same-branch heads have separate lanes and remain explicit", () => {
  const state = historyState(2);
  state.revisions.push(revision("fork", "r1", 3));
  state.competingHeads["branch-main"] = ["r2", "fork"];
  const graph = layoutRevisions(state, "branch-main");
  assert.notEqual(
    graph.nodes.find((n) => n.id === "r2")!.lane,
    graph.nodes.find((n) => n.id === "fork")!.lane,
  );
  assert.ok(graph.warnings.some((w) => /competing/.test(w)));
  assert.equal(graph.latestId, null);
  assert.equal(
    graph.nodes.some((n) => n.latest),
    false,
  );
});
test("120 revisions retain every node and all parent edges", () => {
  const graph = layoutRevisions(historyState(120), "branch-main");
  assert.equal(graph.nodes.length, 120);
  assert.equal(graph.edges.length, 119);
  assert.equal(graph.lanes, 1);
  assert.equal(graph.nodes[119].row, 119);
});
test("disconnected records use distinct lanes rather than appearing on an unrelated parent path", () => {
  const state = historyState(4);
  state.revisions[2].manifest.parentRevisionId = "missing";
  const graph = layoutRevisions(state, "branch-main");
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  assert.notEqual(nodes.get("r2")!.lane, nodes.get("r3")!.lane);
  assert.equal(nodes.get("r3")!.lane, nodes.get("r4")!.lane);
  assert.deepEqual(
    graph.edges.map((edge) => [edge.child, edge.parent]),
    [
      ["r2", "r1"],
      ["r4", "r3"],
    ],
  );
});
function withCopy(
  state: ReturnType<typeof scenarioState>,
  child: string,
  source: string,
  mode: "merge" | "revert" = "merge",
  status = "captured",
  sourceBranchId = "prototype",
) {
  state.applicationOperations = [
    ...(state.applicationOperations ?? []),
    {
      operationId: `apply-${child}-${source}`,
      destinationBranchId: "branch-main",
      relativePath: "applications/branch-main/x",
      status,
      capturedRevisionId: child,
      events: [],
      record: { sourceBranchId, plan: { sourceRevisionId: source, mode } },
    } as any,
  ];
  return state;
}
test("a captured copy adds a secondary link without touching parents, lanes or rows", () => {
  const plain = layoutRevisions(scenarioState("branches"), "branch-main");
  const graph = layoutRevisions(
    withCopy(scenarioState("branches"), "r6", "p2"),
    "branch-main",
  );
  assert.deepEqual(plain.copies, []);
  assert.deepEqual(graph.copies, [
    { child: "r6", source: "p2", mode: "merge", sourceBranchName: "Prototype" },
  ]);
  assert.deepEqual(graph.edges, plain.edges);
  assert.deepEqual(
    graph.nodes.map((n) => [n.id, n.lane, n.row]),
    plain.nodes.map((n) => [n.id, n.lane, n.row]),
  );
  assert.equal(graph.lanes, plain.lanes);
  // Copies are not ancestry.
  assert.equal(ancestryOf(graph, "r6").has("p2"), false);
});
test("a bring back links to the earlier revision of the same branch", () => {
  const graph = layoutRevisions(
    withCopy(scenarioState("branches"), "r6", "r3", "revert", "captured", "branch-main"),
    "branch-main",
  );
  assert.deepEqual(
    graph.copies.map((c) => [c.child, c.source, c.mode]),
    [["r6", "r3", "revert"]],
  );
});
test("no recorded evidence, no link: uncaptured, missing, damaged or self sources are ignored", () => {
  for (const state of [
    withCopy(scenarioState("branches"), "r6", "p2", "merge", "applied"),
    withCopy(scenarioState("branches"), "r6", "gone"),
    withCopy(scenarioState("branches"), "gone", "p2"),
    withCopy(scenarioState("branches"), "r6", "r6"),
  ]) {
    assert.deepEqual(layoutRevisions(state, "branch-main").copies, []);
  }
  const damaged = withCopy(scenarioState("branches"), "r6", "p2");
  damaged.revisions.find((r) => r.manifest.revisionId === "p2")!.integrityStatus =
    "corrupted";
  assert.deepEqual(layoutRevisions(damaged, "branch-main").copies, []);
  const unreadable = scenarioState("branches");
  unreadable.applicationOperations = [
    {
      operationId: "x",
      destinationBranchId: "*",
      relativePath: "applications",
      status: "unavailable",
      events: [],
      error: "unreadable",
    } as any,
  ];
  assert.deepEqual(layoutRevisions(unreadable, "branch-main").copies, []);
});
function hideCase(state: ReturnType<typeof scenarioState>, branchId: string) {
  state.caseLifecycles = {
    ...(state.caseLifecycles ?? {}),
    [branchId]: { status: "archived", version: "v1", sequence: 1 },
  };
  return state;
}
const assertNoLineFromNowhere = (graph: ReturnType<typeof layoutRevisions>) => {
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const e of graph.edges) assert.ok(ids.has(e.child) && ids.has(e.parent));
  for (const c of graph.copies) assert.ok(ids.has(c.child) && ids.has(c.source));
  for (const b of graph.branches) for (const h of b.headIds) assert.ok(ids.has(h));
};
test("Hide case: a hidden case's own revisions and chip leave the graph; Show hidden cases brings them back faded", () => {
  const state = hideCase(scenarioState("branches"), "prototype");
  const full = layoutRevisions(state, "branch-main");
  const shown = layoutRevisions(state, "branch-main", { hideHiddenCases: false });
  assert.deepEqual(shown, full);
  assert.deepEqual(
    full.nodes.filter((n) => n.hidden).map((n) => n.id),
    ["p2", "p1"],
  );
  assert.equal(full.branches.find((b) => b.id === "prototype")?.hidden, true);
  const hidden = layoutRevisions(state, "branch-main", { hideHiddenCases: true });
  assert.deepEqual(
    hidden.nodes.map((n) => n.id),
    ["r6", "r5", "r4", "r3", "r2", "r1"],
  );
  assert.deepEqual(hidden.branches.map((b) => b.id), ["branch-main"]);
  assert.equal(hidden.lanes, 1);
  assert.ok(hidden.nodes.every((n) => !n.hidden && n.heads.join() !== "Prototype · Hidden"));
  assertNoLineFromNowhere(hidden);
  // Colours stay the same when hidden cases are shown again.
  assert.equal(
    full.branches.find((b) => b.id === "branch-main")!.color,
    hidden.branches.find((b) => b.id === "branch-main")!.color,
  );
  // Nothing is hidden without a hidden case.
  const plain = scenarioState("branches");
  assert.deepEqual(
    layoutRevisions(plain, "branch-main", { hideHiddenCases: true }),
    layoutRevisions(plain, "branch-main"),
  );
});
test("Hide case: revisions a shown case branched from or copied from stay (faded) with their ancestors", () => {
  const state = hideCase(scenarioState("branches"), "prototype");
  // A shown case started from the hidden case's p1 and has no revisions of its own yet.
  state.branches.push({
    ...state.branches[0],
    branchId: "child",
    name: "Child",
    isMain: false,
    startingRevisionId: "p1",
  });
  state.branchHeads.child = "p1";
  // Main's r6 copied files from the hidden case's p2.
  withCopy(state, "r6", "p2");
  const graph = layoutRevisions(state, "branch-main", { hideHiddenCases: true });
  const ids = graph.nodes.map((n) => n.id);
  assert.ok(ids.includes("p1") && ids.includes("p2"));
  assert.deepEqual(
    graph.nodes.filter((n) => n.hidden).map((n) => n.id).sort(),
    ["p1", "p2"],
  );
  assert.ok(graph.edges.some((e) => e.child === "p1" && e.parent === "r2"));
  assert.deepEqual(
    graph.copies.map((c) => [c.child, c.source]),
    [["r6", "p2"]],
  );
  assert.deepEqual(graph.branches.map((b) => b.id), ["branch-main", "child"]);
  assertNoLineFromNowhere(graph);
  // Without the copy, p2 (only the hidden case's own work) leaves the graph.
  const noCopy = hideCase(scenarioState("branches"), "prototype");
  noCopy.branches.push({ ...state.branches.at(-1)! });
  noCopy.branchHeads.child = "p1";
  const graph2 = layoutRevisions(noCopy, "branch-main", { hideHiddenCases: true });
  assert.ok(graph2.nodes.some((n) => n.id === "p1"));
  assert.ok(!graph2.nodes.some((n) => n.id === "p2"));
  assertNoLineFromNowhere(graph2);
});
test("Hide case: the working case is never left out, and a hidden case's copy of shown work leaves no dangling line", () => {
  const state = hideCase(scenarioState("branches"), "prototype");
  const working = layoutRevisions(state, "prototype", { hideHiddenCases: true });
  assert.ok(working.nodes.some((n) => n.id === "p2" && !n.hidden));
  // p2 (hidden) copied from Main's r5: the hidden child goes, so does its copy line.
  withCopy(state, "p2", "r5");
  const graph = layoutRevisions(state, "branch-main", { hideHiddenCases: true });
  assert.deepEqual(graph.copies, []);
  assertNoLineFromNowhere(graph);
});
test("Hide case: a shown revision's damaged parent on a hidden case stays visible beside its warning", () => {
  const state = hideCase(scenarioState("branches"), "prototype");
  state.revisions.find((r) => r.manifest.revisionId === "p1")!.integrityStatus = "corrupted";
  state.revisions.push(revision("m7", "p1", 9));
  state.branchHeads["branch-main"] = "m7";
  const graph = layoutRevisions(state, "branch-main", { hideHiddenCases: true });
  const ids = graph.nodes.map((n) => n.id);
  assert.ok(ids.includes("m7") && ids.includes("p1"));
  assert.ok(ids.includes("r2"), "the damaged parent's own ancestors stay too");
  assert.ok(!ids.includes("p2"));
  assert.ok(graph.nodes.find((n) => n.id === "m7")!.warnings.some((w) => /damaged/.test(w)));
});
