import test from "node:test";
import assert from "node:assert/strict";
import { historyState, revision } from "../../tests/history-data";
import {
  applyModeFor,
  buildApplyPreview,
  prepareApplyPreview,
  type ApplyPreviewContext,
  type ConflictDecision,
} from "./apply-preview";
import { layoutRevisions, copyBaseOf } from "../history/layout";
import { compareSavedRevisions } from "./snapshot-comparison";
import type { FileEntry, VaultState } from "./types";
const part = "Parts/Part-X.SLDPRT";
const file = (path: string, hash: string): FileEntry => ({
  path,
  sha256: hash,
  size: hash.length,
  lastModified: 0,
});
function fixture() {
  const state = historyState(0);
  const base = revision("base", null, 1);
  base.manifest.files = [
    file(part, "base-x"),
    ...Array.from({ length: 4 }, (_, i) =>
      file(`Parts/Stable${i}.SLDPRT`, `base-${i}`),
    ),
  ];
  base.manifest.directories = ["Parts", "Empty original"];
  const destination = revision("destination", "base", 2);
  destination.manifest.files = [
    ...base.manifest.files.map((f) => ({ ...f })),
    ...Array.from({ length: 15 }, (_, i) =>
      file(`MainOnly/New${i}.SLDPRT`, `main-${i}`),
    ),
  ];
  destination.manifest.directories = [
    "Parts",
    "MainOnly",
    "Empty original",
    "Main empty",
  ];
  const source = revision("source", "base", 3, "case");
  source.manifest.files = base.manifest.files.map((f) => ({
    ...f,
    sha256: f.path === part ? "source-x" : f.sha256,
  }));
  source.manifest.directories = [...base.manifest.directories, "Source empty"];
  state.revisions = [base, destination, source];
  state.branches.push({
    ...state.branches[0],
    branchId: "case",
    name: "Old case",
    isMain: false,
    startingRevisionId: "base",
  });
  state.branchHeads = { "branch-main": "destination", case: "source" };
  return { state, base, source, destination };
}
function context(
  state: VaultState,
  source = "source",
  branch = "branch-main",
): ApplyPreviewContext {
  const result = prepareApplyPreview(state, source, branch);
  if (result.status !== "available") throw new Error(result.reason);
  return result.context;
}
const chosen = (decision: ConflictDecision = "use-source") => ({
  selected: true,
  decision,
});
test("5-file case changes only Part-X while retaining all 20 destination paths and newer unrelated files", () => {
  const { state, destination } = fixture();
  destination.manifest.files[1].sha256 = "newer-main-stable";
  const before = JSON.stringify(state),
    c = context(state);
  assert.equal(c.base.manifest.revisionId, "base");
  assert.equal(c.destination.manifest.revisionId, "destination");
  assert.equal(
    c.rows.filter((r) => r.entry === "file" && r.kind === "available").length,
    1,
  );
  assert.equal(
    c.rows.find((r) => r.path === "MainOnly/New0.SLDPRT")?.kind,
    "no-source-change",
  );
  assert.equal(
    c.rows.find((r) => r.path === "Parts/Stable0.SLDPRT")?.kind,
    "no-source-change",
  );
  const empty = buildApplyPreview(c, {}, "Reason");
  assert.equal(empty.ready, false);
  assert.deepEqual(
    empty.resultFiles,
    [...destination.manifest.files].sort((a, b) =>
      a.path.localeCompare(b.path),
    ),
  );
  const plan = buildApplyPreview(
    c,
    { [part]: chosen() },
    "Reuse the revised pin clearance",
  );
  assert.equal(plan.ready, true);
  assert.equal(plan.resultFiles.length, 20);
  assert.deepEqual(
    plan.resultFiles.map((f) => f.path),
    [...destination.manifest.files.map((f) => f.path)].sort((a, b) =>
      a.localeCompare(b),
    ),
  );
  assert.equal(
    plan.resultFiles.find((f) => f.path === part)?.sha256,
    "source-x",
  );
  assert.equal(
    plan.resultFiles.find((f) => f.path === "Parts/Stable0.SLDPRT")?.sha256,
    "newer-main-stable",
  );
  assert.deepEqual(
    [
      plan.projectId,
      plan.baseRevisionId,
      plan.sourceRevisionId,
      plan.destinationRevisionId,
      plan.destinationBranchId,
    ],
    [state.project.projectId, "base", "source", "destination", "branch-main"],
  );
  assert.equal(plan.actions[0].operation, "replace");
  assert.equal(plan.actions[0].before?.sha256, "base-x");
  assert.equal(plan.actions[0].after?.sha256, "source-x");
  assert.ok(plan.resultDirectories.includes("Main empty"));
  assert.equal(plan.resultDirectories.includes("Source empty"), false);
  assert.equal(JSON.stringify(state), before);
});
test("independent modifications need explicit selected conflict decisions; unselected conflicts preserve Destination", () => {
  const { state, source, destination } = fixture();
  destination.manifest.files[0].sha256 = "destination-x";
  source.manifest.files.push(file("Addition.SLDPRT", "addition"));
  const c = context(state);
  assert.equal(c.rows.find((r) => r.path === part)?.kind, "conflict");
  const unresolved = buildApplyPreview(
    c,
    { [part]: chosen("unresolved") },
    "Resolve this design",
  );
  assert.equal(unresolved.ready, false);
  assert.deepEqual(unresolved.unresolvedPaths, [part]);
  assert.equal(
    unresolved.resultFiles.find((f) => f.path === part)?.sha256,
    "destination-x",
  );
  const keep = buildApplyPreview(
    c,
    { [part]: chosen("keep-destination"), "Addition.SLDPRT": chosen() },
    "Keep Main pin and reuse the addition",
  );
  assert.equal(keep.ready, true);
  assert.equal(keep.actions.find((a) => a.path === part)?.operation, "keep");
  assert.equal(
    keep.resultFiles.find((f) => f.path === part)?.sha256,
    "destination-x",
  );
  const use = buildApplyPreview(
    c,
    { [part]: chosen() },
    "Use the case pin deliberately",
  );
  assert.equal(use.ready, true);
  assert.equal(
    use.resultFiles.find((f) => f.path === part)?.sha256,
    "source-x",
  );
  const skip = buildApplyPreview(
    c,
    { "Addition.SLDPRT": chosen() },
    "Only reuse the addition",
  );
  assert.equal(skip.ready, true);
  assert.equal(
    skip.resultFiles.find((f) => f.path === part)?.sha256,
    "destination-x",
  );
});
test("identical byte changes and source-unchanged paths require no application despite timestamp differences", () => {
  const { state, source, destination } = fixture();
  destination.manifest.files[0] = {
    ...source.manifest.files[0],
    lastModified: 999,
  };
  const c = context(state);
  assert.equal(c.rows.find((r) => r.path === part)?.kind, "already-matches");
  assert.equal(
    buildApplyPreview(c, { [part]: chosen() }, "Reason").ready,
    false,
  );
  assert.equal(buildApplyPreview(c, {}, "Reason").actions.length, 0);
});
test("source additions, deletions, add/add and modify/delete conflicts use presence and hashes consistently", () => {
  const { state, source, destination } = fixture();
  source.manifest.files.push(
    file("New.SLDPRT", "new"),
    file("Independent.SLDPRT", "case-add"),
  );
  destination.manifest.files.push(file("Independent.SLDPRT", "main-add"));
  source.manifest.files = source.manifest.files.filter(
    (f) =>
      f.path !== "Parts/Stable0.SLDPRT" && f.path !== "Parts/Stable1.SLDPRT",
  );
  destination.manifest.files.find(
    (f) => f.path === "Parts/Stable1.SLDPRT",
  )!.sha256 = "main-modified";
  destination.manifest.files = destination.manifest.files.filter(
    (f) => f.path !== part,
  );
  const c = context(state),
    row = (path: string) => c.rows.find((r) => r.path === path)!;
  assert.equal(row("New.SLDPRT").kind, "available");
  assert.equal(row("Parts/Stable0.SLDPRT").sourceChange, "deleted");
  assert.equal(row("Parts/Stable0.SLDPRT").kind, "available");
  assert.equal(row("Parts/Stable1.SLDPRT").kind, "conflict");
  assert.equal(row("Independent.SLDPRT").kind, "conflict");
  assert.equal(row(part).kind, "conflict");
  const plan = buildApplyPreview(
    c,
    {
      "New.SLDPRT": chosen(),
      "Parts/Stable0.SLDPRT": chosen(),
      "Parts/Stable1.SLDPRT": chosen(),
      "Independent.SLDPRT": chosen(),
      [part]: chosen(),
    },
    "Explicit additions and deletions",
  );
  assert.equal(plan.ready, true);
  assert.equal(plan.actions.find((a) => a.path === part)?.operation, "add");
  assert.equal(
    plan.actions.find((a) => a.path === "Parts/Stable1.SLDPRT")?.operation,
    "delete",
  );
  assert.equal(
    plan.resultFiles.some((f) => f.path === "Parts/Stable0.SLDPRT"),
    false,
  );
  assert.equal(
    plan.resultFiles.find((f) => f.path === "Independent.SLDPRT")?.sha256,
    "case-add",
  );
});
test("nested cases find the nearest validated shared ancestor, not the source parent, case root or highest project version", () => {
  const { state, base } = fixture();
  const c1 = revision("c1", "base", 2, "case"),
    d1 = revision("d1", "c1", 3, "case"),
    n1 = revision("n1", "c1", 4, "nested"),
    n2 = revision("n2", "n1", 5, "nested");
  state.revisions = [base, c1, d1, n1, n2];
  state.branchHeads = { "branch-main": "base", case: "d1", nested: "n2" };
  state.branches.push({
    ...state.branches[1],
    branchId: "nested",
    name: "Nested case",
    startingRevisionId: "c1",
  });
  const c = context(state, "n2", "case");
  assert.equal(c.base.manifest.revisionId, "c1");
  assert.equal(c.destination.manifest.revisionId, "d1");
  state.branches.push({
    ...state.branches[1],
    branchId: "uncaptured",
    name: "Case without its own capture",
    startingRevisionId: "c1",
  });
  state.branchHeads.uncaptured = "c1";
  const inherited = context(state, "n2", "uncaptured");
  assert.equal(inherited.destination.manifest.revisionId, "c1");
  assert.equal(inherited.destinationBranchId, "uncaptured");
});
test("missing, corrupt, duplicate, conflicting or cyclic ancestry and ambiguous baselines never produce a guessed plan", () => {
  for (const defect of [
    "missing",
    "corrupt",
    "duplicate",
    "cycle",
    "conflict",
    "heads",
    "no-baseline",
    "branch",
  ]) {
    const { state, source, base } = fixture();
    if (defect === "missing") source.manifest.parentRevisionId = "missing";
    if (defect === "corrupt") base.integrityStatus = "corrupted";
    if (defect === "duplicate") state.revisions.push(structuredClone(base));
    if (defect === "cycle") source.manifest.parentRevisionId = "source";
    if (defect === "conflict")
      state.corruptedRecords.push({
        revisionId: "base",
        recordPath: "duplicate",
        reason: "conflicting",
      });
    if (defect === "heads")
      state.competingHeads["branch-main"] = ["base", "destination"];
    if (defect === "no-baseline") state.branchHeads["branch-main"] = null;
    if (defect === "branch")
      state.branches.push(structuredClone(state.branches[0]));
    assert.equal(
      prepareApplyPreview(state, "source", "branch-main").status,
      "unavailable",
      defect,
    );
    if (defect === "missing" || defect === "cycle" || defect === "heads")
      assert.equal(
        compareSavedRevisions(state, "source", "destination").status,
        "compared",
      );
  }
});
test("file/directory, ancestor-file and case-insensitive collisions block readiness", () => {
  for (const kind of ["directory", "ancestor", "case"]) {
    const { state, source, destination } = fixture();
    const path =
      kind === "ancestor"
        ? "Reserved/Child.SLDPRT"
        : kind === "case"
          ? "Parts/STABLE0.SLDPRT"
          : "Reserved";
    source.manifest.files.push(file(path, "source-add"));
    if (kind === "directory") destination.manifest.directories.push("Reserved");
    if (kind === "ancestor")
      destination.manifest.files.push(file("Reserved", "main-file"));
    const plan = buildApplyPreview(
      context(state),
      { [path]: chosen() },
      "Collision review",
    );
    assert.equal(plan.ready, false, kind);
    assert.ok(plan.collisions.length, kind);
  }
});
test("readiness requires source actions and valid selections (a reason is optional); preserved directories and metadata are copied without mutation", () => {
  const { state } = fixture(),
    c = context(state),
    before = JSON.stringify(state);
  const noReason = buildApplyPreview(c, { [part]: chosen() }, " ");
  assert.equal(noReason.ready, true);
  assert.deepEqual(noReason.blockers, []);
  assert.equal(
    buildApplyPreview(
      c,
      { "MainOnly/New0.SLDPRT": chosen() },
      "Invalid path selection",
    ).ready,
    false,
  );
  const plan = buildApplyPreview(c, { [part]: chosen() }, "Reuse part");
  plan.resultFiles[0].sha256 = "mutated-plan-only";
  plan.actions[0].source!.sha256 = "mutated-action-only";
  assert.equal(JSON.stringify(state), before);
});

test("older version of the same case: merge says use Bring back, revert uses the baseline as base, latest version is rejected in both modes", () => {
  const { state } = fixture();
  const merge = prepareApplyPreview(state, "base", "branch-main");
  assert.equal(merge.status, "unavailable");
  assert.match((merge as { reason: string }).reason, /earlier version in this case.s history.*Bring back/);
  const r = prepareApplyPreview(state, "base", "branch-main", "revert");
  if (r.status !== "available") throw new Error(r.reason);
  assert.equal(r.context.mode, "revert");
  assert.equal(r.context.base.manifest.revisionId, "destination");
  assert.equal(
    r.context.rows.filter((x) => x.entry === "file" && x.kind === "available").length,
    15,
  );
  // Folders: "MainOnly" holds files the source (the old base) lacks -> removable
  // together with its files; "Main empty" is an empty folder absent in the source.
  assert.deepEqual(
    r.context.rows.filter((x) => x.entry === "folder").map((x) => [x.path, x.sourceChange, x.kind]),
    [["Main empty", "deleted", "available"], ["MainOnly", "deleted", "available"]],
  );
  assert.ok(r.context.rows.every((x) => x.kind !== "conflict"));
  for (const mode of ["merge", "revert"] as const) {
    const latest = prepareApplyPreview(state, "destination", "branch-main", mode);
    assert.equal(latest.status, "unavailable");
    assert.match((latest as { reason: string }).reason, /already the latest saved version/);
  }
  const caseRevert = prepareApplyPreview(state, "source", "branch-main", "revert");
  assert.equal(caseRevert.status, "unavailable");
  assert.match((caseRevert as { reason: string }).reason, /not an earlier version in this case.s history/);
});

// ---- Folder changes: rows, kept removals and plan shape ----
const folderRowsOf = (c: ApplyPreviewContext) =>
  c.rows.filter((r) => r.entry === "folder");

test("folder rows: added/deleted folders between base and source; no conflicts; already-matching when the destination agrees", () => {
  const { state, base, source, destination } = fixture();
  // Source also adds "Main empty", which the destination already has; it drops "Empty original".
  source.manifest.directories = ["Parts", "Source empty", "Main empty"];
  void base;
  void destination;
  const c = context(state);
  assert.deepEqual(
    folderRowsOf(c).map((r) => [r.path, r.sourceChange, r.kind]),
    [
      ["Empty original", "deleted", "available"],
      ["Main empty", "added", "already-matches"],
      ["Source empty", "added", "available"],
    ],
  );
  const row = folderRowsOf(c).find((r) => r.path === "Source empty")!;
  assert.deepEqual([row.base, row.source, row.destination], [null, null, null]);
  assert.deepEqual(row.folder, { inBase: false, inSource: true, inDestination: false });
  assert.ok(c.rows.every((r) => r.kind !== "conflict" || r.entry === "file"));
  // File rows are unchanged and tagged as files.
  assert.equal(c.rows.find((r) => r.path === part)?.entry, "file");
});

test("a folder-only selection is a ready plan: create and remove show in folderActions and resultDirectories", () => {
  const { state, source } = fixture();
  source.manifest.directories = ["Parts", "Source empty"];
  const c = context(state);
  const plan = buildApplyPreview(
    c,
    { "Source empty": chosen(), "Empty original": chosen() },
    "Folders only",
  );
  assert.equal(plan.ready, true, plan.blockers.join("|"));
  assert.deepEqual(plan.actions, []);
  assert.deepEqual(plan.folderActions, [
    { path: "Empty original", operation: "remove", sourceChange: "deleted" },
    { path: "Source empty", operation: "create", sourceChange: "added" },
  ]);
  assert.ok(plan.resultDirectories.includes("Source empty"));
  assert.equal(plan.resultDirectories.includes("Empty original"), false);
  assert.ok(plan.resultDirectories.includes("Main empty"));
  // Without any selection the old blocker still applies.
  const none = buildApplyPreview(c, {}, "Nothing");
  assert.ok(none.blockers.some((b) => /Select at least one source change/.test(b)));
  // A folder needs an explicit use-source decision.
  const keep = buildApplyPreview(c, { "Source empty": chosen("keep-destination") }, "Reason");
  assert.equal(keep.ready, false);
  assert.ok(keep.blockers.some((b) => /Select the source state explicitly for Source empty/.test(b)));
});

test("a removed folder that would still hold files is a blocker; with its file deletion selected it is fine", () => {
  const { state, base, source, destination } = fixture();
  const baseOnly = file("Shared/Base.SLDPRT", "shared-base");
  base.manifest.files.push(baseOnly);
  base.manifest.directories.push("Shared");
  destination.manifest.files.push({ ...baseOnly });
  destination.manifest.directories.push("Shared");
  source.manifest.files = source.manifest.files.filter((f) => !f.path.startsWith("Shared/"));
  const c = context(state);
  assert.equal(c.rows.find((r) => r.path === "Shared")?.kind, "available");
  const folderOnly = buildApplyPreview(c, { Shared: chosen() }, "Reason");
  assert.equal(folderOnly.ready, false);
  assert.ok(folderOnly.blockers.includes("Shared: Kept: still holds files; untick it."));
  const both = buildApplyPreview(
    c,
    { Shared: chosen(), "Shared/Base.SLDPRT": chosen() },
    "Reason",
  );
  assert.equal(both.ready, true, both.blockers.join("|"));
  assert.equal(both.resultDirectories.includes("Shared"), false);
  assert.equal(both.resultFiles.some((f) => f.path.startsWith("Shared/")), false);
  // The destination gained a file there: no selection can remove the folder.
  destination.manifest.files.push(file("Shared/Main.SLDPRT", "main-shared"));
  const kept = context(state);
  assert.equal(kept.rows.find((r) => r.path === "Shared")?.kind, "kept-holds-files");
  const blocked = buildApplyPreview(
    kept,
    { Shared: chosen(), "Shared/Base.SLDPRT": chosen() },
    "Reason",
  );
  assert.equal(blocked.ready, false);
  assert.ok(blocked.blockers.includes("Shared: Kept: still holds files; untick it."));
  assert.equal(blocked.folderActions.length, 0);
  // Unselected, the kept row is simply left alone.
  assert.equal(buildApplyPreview(kept, { "Shared/Base.SLDPRT": chosen() }, "R").ready, true);
});

test("nested removals: a parent is removable only together with its subfolders", () => {
  const { state, base, source, destination } = fixture();
  for (const m of [base.manifest, destination.manifest]) m.directories.push("Deep", "Deep/Inner");
  void source;
  const c = context(state);
  assert.deepEqual(
    folderRowsOf(c).filter((r) => r.path.startsWith("Deep")).map((r) => [r.path, r.kind]),
    [["Deep", "available"], ["Deep/Inner", "available"]],
  );
  const parentOnly = buildApplyPreview(c, { Deep: chosen() }, "Reason");
  assert.ok(parentOnly.blockers.includes("Deep: Kept: still holds files; untick it."));
  const both = buildApplyPreview(c, { Deep: chosen(), "Deep/Inner": chosen() }, "Reason");
  assert.equal(both.ready, true, both.blockers.join("|"));
  assert.equal(both.resultDirectories.some((d) => d.startsWith("Deep")), false);
});

// ---- Copy remembers earlier copies ----
type CopyState = ReturnType<typeof historyState>;
function version(
  id: string,
  parent: string | null,
  number: number,
  branchId: string,
  files: Record<string, string>,
) {
  const r = revision(id, parent, number, branchId);
  r.manifest.files = Object.entries(files).map(([p, h]) => file(p, h));
  r.manifest.directories = [];
  return r;
}
function addCase(state: CopyState, branchId: string, startingRevisionId: string) {
  state.branches.push({
    ...state.branches[0],
    branchId,
    name: branchId,
    isMain: false,
    startingRevisionId,
  });
}
function addCopy(
  state: CopyState,
  child: string,
  source: string,
  destinationBranchId: string,
  sourceBranchId: string,
  status = "captured",
  mode: "merge" | "revert" = "merge",
) {
  state.applicationOperations = [
    ...(state.applicationOperations ?? []),
    {
      operationId: `apply-${child}-${source}`,
      destinationBranchId,
      relativePath: `applications/${destinationBranchId}/x`,
      status,
      capturedRevisionId: child,
      events: [],
      record: { sourceBranchId, plan: { sourceRevisionId: source, mode } },
    } as never,
  ];
}
/** Main m1; case X: x1, x2; X2 was copied into Main as m2; X saved x3 afterwards. */
function copiedOnce(mainBracket = "b2") {
  const state = historyState(0);
  addCase(state, "x", "m1");
  state.revisions = [
    version("m1", null, 1, "branch-main", { "Bracket.txt": "b0", "Other.txt": "o0" }),
    version("x1", "m1", 2, "x", { "Bracket.txt": "b1", "Other.txt": "o0" }),
    version("x2", "x1", 3, "x", { "Bracket.txt": "b2", "Other.txt": "o0", "New.txt": "n2" }),
    version("m2", "m1", 4, "branch-main", {
      "Bracket.txt": mainBracket,
      "Other.txt": "o0",
      "New.txt": "n2",
    }),
    version("x3", "x2", 5, "x", { "Bracket.txt": "b3", "Other.txt": "o0", "New.txt": "n2" }),
  ];
  state.branchHeads = { "branch-main": "m2", x: "x3" };
  addCopy(state, "m2", "x2", "branch-main", "x");
  return state;
}
const kindOf = (c: ApplyPreviewContext, path: string) =>
  c.rows.find((r) => r.entry === "file" && r.path === path)?.kind;

test("a second copy from the same case compares with the earlier copy: only new changes are offered", () => {
  const state = copiedOnce();
  const c = context(state, "x3");
  assert.equal(c.base.manifest.revisionId, "x2");
  assert.equal(c.baseViaCopy, true);
  assert.equal(kindOf(c, "Bracket.txt"), "available", "a plain change, not Changed in both");
  assert.equal(kindOf(c, "New.txt"), "no-source-change", "already taken");
  assert.equal(kindOf(c, "Other.txt"), "no-source-change");
  const plan = buildApplyPreview(
    c,
    { "Bracket.txt": chosen() },
    "",
  );
  assert.equal(plan.ready, true);
  assert.equal(plan.baseRevisionId, "x2");
  assert.equal(plan.actions.find((a) => a.path === "Bracket.txt")?.operation, "replace");
});
test("a file left out last time is not offered again unless the case changes it again", () => {
  // Main kept its own bracket (b0) when X2 was copied.
  const state = copiedOnce("b0");
  state.revisions.find((r) => r.manifest.revisionId === "x3")!.manifest.files =
    [file("Bracket.txt", "b2"), file("Other.txt", "o0"), file("New.txt", "n2"), file("Later.txt", "l3")];
  const c = context(state, "x3");
  assert.equal(c.base.manifest.revisionId, "x2");
  assert.equal(kindOf(c, "Bracket.txt"), "no-source-change");
  assert.equal(kindOf(c, "Later.txt"), "available");
  // Changed again in the case: offered (and changed in both, since Main kept its own).
  state.revisions.find((r) => r.manifest.revisionId === "x3")!.manifest.files[0].sha256 = "b3";
  assert.equal(kindOf(context(state, "x3"), "Bracket.txt"), "conflict");
});
test("without the earlier copy link the old starting point is used", () => {
  const state = copiedOnce();
  state.applicationOperations = [];
  const c = context(state, "x3");
  assert.equal(c.base.manifest.revisionId, "m1");
  assert.equal(c.baseViaCopy, false);
  assert.equal(kindOf(c, "Bracket.txt"), "conflict");
});
test("copying back in the other direction: Main into a case after the case copied from Main", () => {
  const state = historyState(0);
  addCase(state, "x", "m1");
  state.revisions = [
    version("m1", null, 1, "branch-main", { "Main.txt": "a0", "Case.txt": "c0" }),
    version("m2", "m1", 2, "branch-main", { "Main.txt": "a2", "Case.txt": "c0" }),
    version("x1", "m1", 3, "x", { "Main.txt": "a0", "Case.txt": "c1" }),
    // x2: Main's m2 copied into the case.
    version("x2", "x1", 4, "x", { "Main.txt": "a2", "Case.txt": "c1" }),
    version("m3", "m2", 5, "branch-main", { "Main.txt": "a3", "Case.txt": "c0" }),
  ];
  state.branchHeads = { "branch-main": "m3", x: "x2" };
  addCopy(state, "x2", "m2", "x", "branch-main");
  const c = context(state, "m3", "x");
  assert.equal(c.base.manifest.revisionId, "m2");
  assert.equal(c.baseViaCopy, true);
  assert.equal(kindOf(c, "Main.txt"), "available");
  assert.equal(kindOf(c, "Case.txt"), "no-source-change");
  // And back: copying the case into Main starts from m2, which the case already holds.
  const back = context(state, "x2", "branch-main");
  assert.equal(back.base.manifest.revisionId, "m2");
  assert.equal(back.baseViaCopy, true);
});
test("a version copied into a case is still a Copy, never a Bring back", () => {
  const state = copiedOnce();
  assert.equal(applyModeFor(state, "x2", "branch-main"), "merge");
  assert.equal(applyModeFor(state, "x3", "branch-main"), "merge");
  assert.equal(applyModeFor(state, "m1", "branch-main"), "revert");
  const reverted = prepareApplyPreview(state, "x2", "branch-main", "revert");
  assert.equal(reverted.status, "unavailable");
});
test("copies that cross back and forth leave two candidates: the parent-line starting point is used", () => {
  const state = historyState(0);
  addCase(state, "x", "m1");
  state.revisions = [
    version("m1", null, 1, "branch-main", { "F.txt": "f0" }),
    version("m2", "m1", 2, "branch-main", { "F.txt": "f0", "M.txt": "m2" }),
    version("x1", "m1", 3, "x", { "F.txt": "f0", "X.txt": "x1" }),
    version("x2", "x1", 4, "x", { "F.txt": "f0", "X.txt": "x1" }),
    version("m3", "m2", 5, "branch-main", { "F.txt": "f0", "M.txt": "m2", "X.txt": "x1" }),
    version("x3", "x2", 6, "x", { "F.txt": "f0", "M.txt": "m2", "X.txt": "x1" }),
  ];
  state.branchHeads = { "branch-main": "m3", x: "x3" };
  addCopy(state, "m3", "x1", "branch-main", "x");
  addCopy(state, "x3", "m2", "x", "branch-main");
  const c = context(state, "x3");
  assert.equal(c.base.manifest.revisionId, "m1");
  assert.equal(c.baseViaCopy, false);
});
test("an unreadable, unfinished or damaged copy record adds nothing", () => {
  const unfinished = copiedOnce();
  unfinished.applicationOperations![0].status = "applied";
  assert.equal(context(unfinished, "x3").base.manifest.revisionId, "m1");
  const unreadable = copiedOnce();
  unreadable.applicationOperations = [
    {
      operationId: "x",
      destinationBranchId: "*",
      relativePath: "applications",
      status: "unavailable",
      events: [],
      error: "unreadable",
    } as never,
  ];
  assert.equal(context(unreadable, "x3").base.manifest.revisionId, "m1");
  const damagedSource = copiedOnce();
  damagedSource.revisions.find((r) => r.manifest.revisionId === "x2")!.integrityStatus =
    "corrupted";
  const result = prepareApplyPreview(damagedSource, "x3", "branch-main");
  assert.equal(result.status, "unavailable", "x3 follows the damaged x2: no plan");
});
test("a damaged version on the path through an earlier copy refuses; nothing is guessed", () => {
  const state = copiedOnce();
  // Main continues after the copy; the version in between is damaged.
  state.revisions.push(version("m3", "m2", 6, "branch-main", { "Bracket.txt": "b2" }));
  state.revisions.push(version("m4", "m3", 7, "branch-main", { "Bracket.txt": "b2" }));
  state.branchHeads["branch-main"] = "m4";
  assert.equal(context(state, "x3").base.manifest.revisionId, "x2");
  state.revisions.find((r) => r.manifest.revisionId === "m3")!.integrityErrors = ["damaged"];
  const result = prepareApplyPreview(state, "x3", "branch-main");
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable")
    assert.match(result.reason, /shared history is unavailable/);
  // A damaged version that is not on any path in use does not block.
  const harmless = copiedOnce();
  harmless.revisions.push(version("y1", "m1", 9, "branch-main", {}));
  harmless.revisions.find((r) => r.manifest.revisionId === "y1")!.integrityErrors = ["damaged"];
  assert.equal(context(harmless, "x3").base.manifest.revisionId, "x2");
});
test("already copied: the source is the base only because of the copy, so there is nothing new", () => {
  const state = copiedOnce();
  const result = prepareApplyPreview(state, "x2", "branch-main");
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable")
    assert.equal(
      result.reason,
      "Everything in V3 is already in this case from an earlier copy. There's nothing new to copy.",
    );
  // A parent-line ancestor keeps the Bring back message.
  const ancestor = prepareApplyPreview(state, "m1", "branch-main");
  assert.equal(ancestor.status, "unavailable");
  if (ancestor.status === "unavailable")
    assert.match(ancestor.reason, /Use "Bring back"/);
});
test("an undone copy no longer counts: after Bring back, copying again offers everything the undo removed", () => {
  const state = copiedOnce();
  // "To undo, bring back m1": m3 on Main has m1's files again.
  state.revisions.push(
    version("m3", "m2", 6, "branch-main", { "Bracket.txt": "b0", "Other.txt": "o0" }),
  );
  state.branchHeads["branch-main"] = "m3";
  addCopy(state, "m3", "m1", "branch-main", "branch-main", "captured", "revert");
  // Copying X2 again is an ordinary copy, not "already copied".
  const again = context(state, "x2");
  assert.equal(again.base.manifest.revisionId, "m1");
  assert.equal(again.baseViaCopy, false);
  assert.equal(kindOf(again, "New.txt"), "available");
  assert.equal(kindOf(again, "Bracket.txt"), "available");
  // Copying X3: the file the undo removed is offered again.
  const next = context(state, "x3");
  assert.equal(next.base.manifest.revisionId, "m1");
  assert.equal(kindOf(next, "New.txt"), "available");
  assert.equal(kindOf(next, "Bracket.txt"), "available");
  // Without the Bring back link the earlier copy would still count.
  state.applicationOperations = state.applicationOperations!.slice(0, 1);
  assert.equal(context(state, "x3").base.manifest.revisionId, "x2");
});
test("copyBaseOf is linear: 2,000 versions with a copy and a Bring back run well under the bound", () => {
  const state = historyState(2000);
  addCase(state, "x", "r1");
  state.revisions.push(
    version("x1", "r1", 2001, "x", { "X.txt": "x1" }),
    version("x2", "x1", 2002, "x", { "X.txt": "x2" }),
  );
  state.branchHeads.x = "x2";
  addCopy(state, "r1000", "x1", "branch-main", "x");
  addCopy(state, "r1500", "r1200", "branch-main", "branch-main", "captured", "revert");
  const graph = layoutRevisions(state, "branch-main");
  const started = performance.now();
  const result = copyBaseOf(graph, "x2", "r2000");
  const elapsed = performance.now() - started;
  assert.deepEqual(result, { baseId: "x1", viaCopy: true });
  assert.ok(elapsed < 200, `took ${elapsed} ms`);
});
