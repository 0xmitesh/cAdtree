import test from "node:test";
import assert from "node:assert/strict";
import { historyState, revision } from "../../tests/history-data";
import { layoutRevisions } from "./layout";
import { fileHistory, historicalFilePaths } from "./file-history";
const path = "Parts/Pin.SLDPRT";
function stateWithHashes(hashes: (string | null)[]) {
  const state = historyState(hashes.length);
  state.revisions.forEach((r, i) => {
    r.manifest.files =
      hashes[i] === null
        ? []
        : [{ path, sha256: hashes[i]!, size: 5, lastModified: i }];
  });
  return state;
}
const view = (
  state: ReturnType<typeof historyState>,
  branch: string | null = null,
) => fileHistory(state, layoutRevisions(state, "branch-main"), path, branch);
test("ten complete snapshots yield addition plus three modifications, including a revert", () => {
  const state = stateWithHashes([
    "a",
    "a",
    "b",
    "b",
    "b",
    "c",
    "c",
    "a",
    "a",
    "a",
  ]);
  state.revisions.forEach((r) =>
    r.manifest.files.push({
      path: "Other/Pin.SLDPRT",
      sha256: r.manifest.revisionId,
      size: 8,
      lastModified: 0,
    }),
  );
  const before = JSON.stringify(state);
  const result = view(state);
  assert.deepEqual(
    result.graph.nodes.map((n) => n.id),
    ["r8", "r6", "r3", "r1"],
  );
  assert.deepEqual(
    [...result.records.values()].map((r) => r.status),
    ["Added", "Modified", "Modified", "Modified"],
  );
  assert.equal(result.graph.latestId, "r8");
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(historicalFilePaths(state), ["Other/Pin.SLDPRT", path]);
});
test("alternative ancestry inherits the older origin, never Main's later bytes", () => {
  const state = stateWithHashes(["a", "a", "b", "c"]);
  state.branches.push({
    ...state.branches[0],
    branchId: "alt",
    name: "Alternative",
    isMain: false,
    startingRevisionId: "r2",
  });
  const alt1 = revision("alt1", "r2", 5, "alt");
  alt1.manifest.files = [{ ...state.revisions[0].manifest.files[0] }];
  const alt2 = revision("alt2", "alt1", 6, "alt");
  alt2.manifest.files = [{ ...alt1.manifest.files[0], sha256: "d" }];
  state.revisions.push(alt1, alt2);
  state.branchHeads.alt = "alt2";
  const result = view(state);
  assert.equal(result.records.has("alt1"), false);
  assert.deepEqual(result.records.get("r2")?.origins, ["Alternative"]);
  assert.equal(result.records.get("r2")?.kind, "context");
  assert.equal(result.records.get("r2")?.file?.sha256, "a");
  assert.equal(
    result.graph.edges.find((e) => e.child === "alt2")?.parent,
    "r2",
  );
  assert.deepEqual(
    view(state, "alt").graph.nodes.map((n) => n.id),
    ["alt2", "r2", "r1"],
  );
  assert.equal(view(state, "alt").graph.latestId, null);
  state.revisions[0].manifest.displayNumber = 999;
  assert.equal(
    view(state).graph.edges.find((e) => e.child === "alt2")?.parent,
    "r2",
  );
  state.branchHeads.alt = "r2";
  assert.deepEqual(
    view(state, "alt").graph.nodes.map((n) => n.id),
    ["r2", "r1"],
  );
});
test("deletion and reintroduction are events and deleted paths remain selectable", () => {
  const state = stateWithHashes([null, "a", null, null, "a", null]);
  assert.deepEqual(
    view(state).graph.nodes.map((n) => n.id),
    ["r6", "r5", "r3", "r2"],
  );
  assert.deepEqual(
    [...view(state).records.values()].map((r) => r.status),
    ["Added", "Deleted", "Reintroduced", "Deleted"],
  );
  assert.deepEqual(historicalFilePaths(state), [path]);
});
test("branch with no selected-file history is empty; unchanged origin after deletion remains explicit", () => {
  const state = stateWithHashes([null, null, "a", null, null]);
  state.branches.push({
    ...state.branches[0],
    branchId: "empty",
    name: "Empty",
    isMain: false,
    startingRevisionId: "r2",
  });
  state.branchHeads.empty = "r2";
  assert.equal(view(state, "empty").graph.nodes.length, 0);
  state.branches.push({
    ...state.branches[0],
    branchId: "absent",
    name: "Absent",
    isMain: false,
    startingRevisionId: "r5",
  });
  state.branchHeads.absent = "r5";
  assert.equal(view(state).records.get("r5")?.kind, "context");
  assert.equal(view(state).records.get("r5")?.file, undefined);
});
test("damaged, missing, duplicate and cyclic evidence never becomes deletion or unchanged", () => {
  for (const defect of ["corrupt", "missing", "duplicate", "cycle"]) {
    const state = stateWithHashes(["a", null, "a"]);
    if (defect === "corrupt") state.revisions[0].integrityStatus = "corrupted";
    if (defect === "missing")
      state.revisions[1].manifest.parentRevisionId = "missing";
    if (defect === "duplicate")
      state.revisions.push(structuredClone(state.revisions[0]));
    if (defect === "cycle") state.revisions[0].manifest.parentRevisionId = "r2";
    const result = view(state);
    assert.equal(
      result.records.get("r2")?.status,
      "History unavailable",
      defect,
    );
    assert.equal(
      result.graph.edges.some((e) => e.child === "r2"),
      false,
      defect,
    );
  }
});
test("an addition on a case connects to inherited absence before Main introduced the file", () => {
  const state = stateWithHashes([null, null, "main"]);
  state.branches.push({
    ...state.branches[0],
    branchId: "alt",
    name: "Alternative",
    isMain: false,
    startingRevisionId: "r2",
  });
  const added = revision("alt1", "r2", 4, "alt");
  added.manifest.files = [{ path, sha256: "alt", size: 1, lastModified: 0 }];
  state.revisions.push(added);
  state.branchHeads.alt = "alt1";
  const result = view(state, "alt");
  assert.deepEqual(
    result.graph.nodes.map((n) => n.id),
    ["alt1", "r2"],
  );
  assert.equal(result.records.get("r2")?.status, "Inherited absence");
  assert.equal(
    result.graph.edges.find((e) => e.child === "alt1")?.parent,
    "r2",
  );
  assert.equal(result.records.get("alt1")?.status, "Added");
  state.revisions[2].manifest.files = [];
  assert.equal(view(state, "branch-main").graph.nodes.length, 0);
});
