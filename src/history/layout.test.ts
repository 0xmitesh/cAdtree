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
