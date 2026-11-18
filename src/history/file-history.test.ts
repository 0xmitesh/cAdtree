import test from "node:test";
import assert from "node:assert/strict";
import { historyState, revision } from "../../tests/history-data";
import { layoutRevisions } from "./layout";
import { fileHistory, fileHistoryEntries, historicalFilePaths } from "./file-history";
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

const idA = "component-aaaaaaaa-1111-4111-8111-111111111111";
const idB = "component-bbbbbbbb-2222-4222-8222-222222222222";
function trackedState(perRevision: { path: string; componentId: string }[][]) {
  const state = historyState(perRevision.length);
  state.revisions.forEach((r, i) => {
    r.manifest.files = perRevision[i].map((f, n) => ({ path: f.path, sha256: String(n), size: 1, lastModified: 0 }));
  });
  state.components = {
    status: "available",
    revisions: Object.fromEntries(
      state.revisions.map((r, i) => [r.manifest.revisionId, { files: perRevision[i], renames: [], payloadSha256: "f".repeat(64) }]),
    ),
  };
  return state;
}
test("file entries: one per file, a component by its latest path, uncovered paths as paths", () => {
  const state = trackedState([
    [{ path: "old.SLDPRT", componentId: idA }],
    [{ path: "mid.SLDPRT", componentId: idA }],
    [{ path: "new.SLDPRT", componentId: idA }],
  ]);
  state.revisions[0].manifest.files.push({ path: "legacy.SLDPRT", sha256: "z", size: 1, lastModified: 0 });
  assert.deepEqual(
    fileHistoryEntries(state).map(({ value, label }) => [value, label]),
    [
      ["legacy.SLDPRT", "legacy.SLDPRT"],
      [`component:${idA}`, "new.SLDPRT"],
    ],
  );
});
test("file entries: a component that returns to an earlier name is listed by its newest name", () => {
  const state = trackedState([
    [{ path: "a.SLDPRT", componentId: idA }],
    [{ path: "b.SLDPRT", componentId: idA }],
    [{ path: "a.SLDPRT", componentId: idA }],
  ]);
  assert.deepEqual(fileHistoryEntries(state).map((e) => e.label), ["a.SLDPRT"]);
});
test("file entries: a short ID is added only when two entries would share a label", () => {
  // A component was deleted, and a different component later took over the same path.
  const state = trackedState([
    [{ path: "same.SLDPRT", componentId: idA }],
    [{ path: "other.SLDPRT", componentId: idB }],
    [{ path: "same.SLDPRT", componentId: idB }],
  ]);
  state.revisions[2].manifest.files = [{ path: "same.SLDPRT", sha256: "1", size: 1, lastModified: 0 }];
  state.components!.revisions.r3.files = [{ path: "same.SLDPRT", componentId: idB }];
  assert.deepEqual(
    fileHistoryEntries(state).map((e) => e.label),
    ["same.SLDPRT · aaaaaaaa", "same.SLDPRT · bbbbbbbb"],
  );
});
test("file entries: without readable component evidence every path is listed", () => {
  const state = trackedState([[{ path: "x.SLDPRT", componentId: idA }], [{ path: "y.SLDPRT", componentId: idA }]]);
  state.components = { status: "unavailable", reason: "damaged", revisions: {} };
  assert.deepEqual(fileHistoryEntries(state).map((e) => e.value), ["x.SLDPRT", "y.SLDPRT"]);
  state.components = { status: "legacy", revisions: {} };
  assert.deepEqual(fileHistoryEntries(state).map((e) => e.value), ["x.SLDPRT", "y.SLDPRT"]);
});
test("file history keeps a copy link only when both ends stay in the filtered graph", () => {
  const state = stateWithHashes(["a", "a", "b", "b"]);
  state.applicationOperations = [
    {
      operationId: "apply-x",
      destinationBranchId: "branch-main",
      relativePath: "applications/branch-main/x",
      status: "captured",
      capturedRevisionId: "r4",
      events: [],
      record: { sourceBranchId: "branch-main", plan: { sourceRevisionId: "r2", mode: "revert" } },
    } as any,
  ];
  const full = layoutRevisions(state, "branch-main");
  assert.equal(full.copies.length, 1);
  // r2 and r4 are unchanged states of this file, so they drop out of the view.
  const filtered = view(state).graph;
  const kept = new Set(filtered.nodes.map((n) => n.id));
  for (const c of filtered.copies) assert.ok(kept.has(c.child) && kept.has(c.source));
});
test("file history keeps the copy link when both ends survive the filter", () => {
  // r1 adds the file, r2 changes it, r3 changes it again; r3 was brought back from r1.
  const state = stateWithHashes(["a", "b", "c"]);
  state.applicationOperations = [
    {
      operationId: "apply-y",
      destinationBranchId: "branch-main",
      relativePath: "applications/branch-main/y",
      status: "captured",
      capturedRevisionId: "r3",
      events: [],
      record: { sourceBranchId: "branch-main", plan: { sourceRevisionId: "r1", mode: "revert" } },
    } as any,
  ];
  const filtered = view(state).graph;
  assert.deepEqual(
    filtered.copies.map((c) => [c.child, c.source, c.mode]),
    [["r3", "r1", "revert"]],
  );
});
