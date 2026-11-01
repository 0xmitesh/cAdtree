import test from "node:test";
import assert from "node:assert/strict";
import { historyState, revision } from "../../tests/history-data";
import {
  compareSavedRevisions,
  compareSnapshotContents,
} from "./snapshot-comparison";
import { computeRevisionDiff } from "./vault-service";
import type { FileEntry } from "./types";
const file = (
  path: string,
  hash = "a",
  size = 5,
  lastModified = 0,
): FileEntry => ({ path, sha256: hash.repeat(64), size, lastModified });
function endpoints() {
  const state = historyState(4);
  const from = state.revisions[0],
    to = state.revisions[3];
  from.manifest.files = [
    file("Assembly.SLDASM"),
    file("Parts/Pin.SLDPRT"),
    file("Other/Pin.SLDPRT"),
    file("Drawings/Design.SLDDRW"),
    file("Retired/Legacy.SLDPRT"),
  ];
  to.manifest.files = [
    file("Assembly.SLDASM", "a", 5, 999),
    file("Parts/Pin.SLDPRT", "b", 9),
    file("Other/Pin.SLDPRT"),
    ...Array.from({ length: 17 }, (_, n) => file(`New/Part${n}.SLDPRT`)),
  ];
  from.manifest.directories = [
    "Parts",
    "Other",
    "Drawings",
    "Retired",
    "Empty before",
  ];
  to.manifest.directories = ["Parts", "Other", "New", "Empty after"];
  return { state, from, to };
}
test("5-file to 20-file nonadjacent endpoints compare complete saved snapshots without mutation", () => {
  const { state, from, to } = endpoints();
  const before = JSON.stringify(state);
  const result = compareSavedRevisions(
    state,
    from.manifest.revisionId,
    to.manifest.revisionId,
  );
  assert.equal(result.status, "compared");
  if (result.status !== "compared") return;
  assert.deepEqual(
    [
      result.diff.added.length,
      result.diff.deleted.length,
      result.diff.modified.length,
      result.diff.unchanged.length,
    ],
    [17, 2, 1, 2],
  );
  assert.equal(result.diff.modified[0].current.path, "Parts/Pin.SLDPRT");
  assert.ok(result.diff.unchanged.some((f) => f.path === "Other/Pin.SLDPRT"));
  assert.ok(result.diff.unchanged.some((f) => f.path === "Assembly.SLDASM"));
  assert.deepEqual(result.diff.addedDirectories, ["Empty after", "New"]);
  assert.deepEqual(result.diff.deletedDirectories, [
    "Drawings",
    "Empty before",
    "Retired",
  ]);
  assert.equal(JSON.stringify(state), before);
});
test("cross-branch comparisons and healthy endpoints ignore broken intervening ancestry", () => {
  const { state, from, to } = endpoints();
  from.manifest.branchId = "alternative";
  from.completion.branchId = "alternative";
  from.manifest.parentRevisionId = "missing-origin";
  state.revisions[1].integrityStatus = "corrupted";
  state.revisions[2].manifest.parentRevisionId = "unavailable";
  state.corruptedRecords.push({
    recordPath: "revisions/r2",
    revisionId: "r2",
    reason: "damaged",
  });
  const result = compareSavedRevisions(state, "r1", "r4");
  assert.equal(result.status, "compared");
  if (result.status === "compared")
    assert.equal(result.diff.modified.length, 1);
  assert.equal(computeRevisionDiff(to, state).status, "compared");
});
test("Swap reverses additions/deletions, directories, and modified before/after values", () => {
  const { state } = endpoints();
  const forward = compareSavedRevisions(state, "r1", "r4"),
    reverse = compareSavedRevisions(state, "r4", "r1");
  if (forward.status !== "compared" || reverse.status !== "compared")
    return assert.fail("comparison unavailable");
  assert.deepEqual(reverse.diff.added, forward.diff.deleted);
  assert.deepEqual(reverse.diff.deleted, forward.diff.added);
  assert.deepEqual(
    reverse.diff.addedDirectories,
    forward.diff.deletedDirectories,
  );
  assert.deepEqual(
    reverse.diff.deletedDirectories,
    forward.diff.addedDirectories,
  );
  assert.deepEqual(reverse.diff.modified[0], {
    previous: forward.diff.modified[0].current,
    current: forward.diff.modified[0].previous,
  });
});
test("same revision and equal hashes are unchanged regardless of timestamp, size or notes", () => {
  const { state, from } = endpoints();
  const result = compareSavedRevisions(state, "r1", "r1");
  if (result.status !== "compared")
    return assert.fail("comparison unavailable");
  assert.deepEqual(
    [
      result.diff.added.length,
      result.diff.modified.length,
      result.diff.deleted.length,
    ],
    [0, 0, 0],
  );
  assert.equal(result.diff.unchanged.length, 5);
  const changedMetadata = {
    ...from.manifest,
    files: from.manifest.files.map((f) => ({
      ...f,
      size: f.size + 123,
      lastModified: 12345,
    })),
  };
  assert.equal(
    compareSnapshotContents(from.manifest, changedMetadata).modified.length,
    0,
  );
});
test("missing, damaged, conflicting, ambiguous, cross-project or mismatched completion endpoints are unavailable in either direction", () => {
  for (const defect of [
    "missing",
    "corrupt",
    "conflict",
    "duplicate",
    "project",
    "completion",
    "unverified",
  ] as const) {
    for (const reverse of [false, true]) {
      const { state, from } = endpoints();
      if (defect === "missing") state.revisions = state.revisions.slice(1);
      if (defect === "corrupt") from.integrityStatus = "corrupted";
      if (defect === "conflict")
        state.corruptedRecords.push({
          revisionId: "r1",
          recordPath: "duplicate",
          reason: "conflicting",
        });
      if (defect === "duplicate")
        state.revisions.push(revision("r1", null, 100));
      if (defect === "project") from.manifest.projectId = "other-project";
      if (defect === "completion") from.completion.revisionId = "other-id";
      if (defect === "unverified")
        from.integrityStatus = "unknown" as typeof from.integrityStatus;
      const result = compareSavedRevisions(
        state,
        reverse ? "r4" : "r1",
        reverse ? "r1" : "r4",
      );
      assert.equal(
        result.status,
        "unavailable",
        `${defect} / reverse=${reverse}`,
      );
      assert.equal("diff" in result, false);
    }
  }
});
test("renames remain deletion/addition; parent-based diff retains baseline, unavailable and actual-parent behavior through the shared helper", () => {
  const { state, from, to } = endpoints();
  to.manifest.parentRevisionId = "r1";
  const parent = computeRevisionDiff(to, state);
  const arbitrary = compareSavedRevisions(state, "r1", "r4");
  assert.equal(parent.status, "compared");
  if (arbitrary.status !== "compared")
    return assert.fail("comparison unavailable");
  const { status, parentRevisionId, parentDisplayNumber, ...contents } = parent;
  assert.deepEqual(contents, arbitrary.diff);
  const baseline = computeRevisionDiff(from, state);
  assert.equal(baseline.status, "baseline");
  assert.equal(baseline.added.length, 5);
  to.manifest.parentRevisionId = "missing";
  assert.equal(computeRevisionDiff(to, state).status, "unavailable");
  const renamed = compareSnapshotContents(
    { files: [file("Before.SLDPRT")], directories: [] },
    { files: [file("After.SLDPRT")], directories: [] },
  );
  assert.deepEqual(
    [renamed.added.length, renamed.deleted.length, renamed.modified.length],
    [1, 1, 0],
  );
});
