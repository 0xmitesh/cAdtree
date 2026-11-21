import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryFileSystemAdapter,
  type FileSystemDirectoryAdapter,
} from "./fs-adapter";
import { openExistingVault } from "./vault-service";
import { captureRevision } from "./revision-service";
import { createProject, createWorkspace, createManagedBranch } from "./workspace-service";
import {
  buildReplacePlan,
  replaceKeepsCopy,
  replacePlanHash,
  ReplacePlanChangedError,
} from "./apply-preview";
import {
  applicationReview,
  applyAndSave,
  recoverApplication,
  replaceWorkingFiles,
  scanForReplace,
} from "./application-service";
import {
  applicationCaptureBlock,
  applicationStagedPath,
  branchApplications,
} from "./application-records";
import { prepareApplyPreview, buildApplyPreview } from "./apply-preview";
import { getBranchBaseline } from "./branch-state";
import { caseLifecycle } from "./case-lifecycle";
import { changeCaseLifecycle } from "./case-lifecycle-service";
import { readVerifiedInventory } from "./copy-service";
import type { VaultState } from "./types";
import { joinAddress } from "./path-limits";
import { refreshProjectGuide } from "./offline-guide";

const notes = { problem: "", modification: "Saved", observations: "" };
/** 14:05 local time, so the readable folder is "2026-11-19 14.05". */
const NOW = new Date(2026, 10, 19, 14, 5, 0);

async function setup() {
  const root = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(root);
  const project = await createProject(root, "Gripper");
  const containerPath = project.record.containerPath;
  const projectFolder = await root.getDirectory(containerPath.split("/"));
  const vault = project.vaultDir;
  const projectId = project.record.projectId;
  const folders = { ...project.workingFolders } as Record<string, FileSystemDirectoryAdapter>;
  const main = folders["branch-main"]!;
  const w = (dir: FileSystemDirectoryAdapter, p: string, t: string) =>
    dir.writeFileText(p.split("/"), t);
  await w(main, "A.txt", "a1");
  await w(main, "Gone.txt", "gone");
  await w(main, "Keep.txt", "keep");
  await w(main, "Old/Inner.txt", "inner");
  const r1 = await captureRevision(main, vault, {
    branchId: "branch-main",
    summary: "R1",
    notes,
    workingFolders: folders,
  });
  const state = () => openExistingVault(vault);
  /** Plan (and hash) as a confirmation would show it. */
  const plan = async (
    paths: string[],
    branchId = "branch-main",
    dir: FileSystemDirectoryAdapter = main,
  ) => {
    const s = await state();
    const baseline = getBranchBaseline(s, branchId)!;
    const scan = await scanForReplace(dir, branchId, baseline);
    const built = buildReplacePlan(s, scan, baseline.revisionId, paths);
    return { plan: built, hash: replacePlanHash(built), target: baseline.revisionId };
  };
  const discard = async (
    paths: string[],
    branchId = "branch-main",
    dir: FileSystemDirectoryAdapter = main,
  ) => {
    const p = await plan(paths, branchId, dir);
    assert.ok(p.plan.ready, p.plan.blockers.join(" "));
    return replaceWorkingFiles(vault, projectFolder, {
      mode: "discard",
      projectId,
      branchId,
      targetRevisionId: p.target,
      paths,
      expectedPlanHash: p.hash,
      workingFolders: folders,
      now: () => NOW,
    });
  };
  const files = async (dir: FileSystemDirectoryAdapter) =>
    (await readVerifiedInventory(dir)).files.map((f) => [f.path, f.sha256]).sort();
  const dirs = async (dir: FileSystemDirectoryAdapter) =>
    (await readVerifiedInventory(dir)).directories.sort();
  const ops = async (branchId = "branch-main") =>
    branchApplications(await state(), branchId);
  return {
    root, containerPath, projectFolder, vault, projectId, folders, main, w, r1,
    state, plan, discard, files, dirs, ops,
  };
}

/** Makes every kind of unsaved change in Main. */
async function edit(f: Awaited<ReturnType<typeof setup>>) {
  await f.w(f.main, "A.txt", "a2 edited");
  await f.w(f.main, "New.txt", "new");
  await f.main.removeEntry(["Gone.txt"]);
  await f.w(f.main, "Added/Deep/x.txt", "x");
  await f.main.getDirectory(["Empty"], { create: true });
  await f.main.removeEntry(["Old"], { recursive: true });
}

const ALL = ["A.txt", "New.txt", "Gone.txt", "Added", "Empty", "Old"];

test("discard all: added, modified and deleted files and folders go back to the latest version", async () => {
  const f = await setup();
  const clean = { files: await f.files(f.main), dirs: await f.dirs(f.main) };
  await edit(f);
  const { plan } = await f.plan(ALL);
  assert.ok(plan.ready, plan.blockers.join(" "));
  assert.ok(replaceKeepsCopy(plan));
  assert.deepEqual(
    plan.actions.map((a) => [a.path, a.operation]),
    [
      ["A.txt", "replace"],
      ["Added/Deep/x.txt", "delete"],
      ["Gone.txt", "add"],
      ["New.txt", "delete"],
      ["Old/Inner.txt", "add"],
    ],
  );
  assert.deepEqual(
    plan.folderActions.map((a) => [a.path, a.operation]),
    [
      ["Added", "remove"],
      ["Added/Deep", "remove"],
      ["Empty", "remove"],
      ["Old", "create"],
    ],
  );
  const result = await f.discard(ALL);
  assert.equal(result.operation.status, "done");
  assert.deepEqual(await f.files(f.main), clean.files);
  assert.deepEqual(await f.dirs(f.main), clean.dirs);
  const [op] = await f.ops();
  assert.equal(op.status, "done");
  assert.equal(op.record?.plan.mode, "discard");
  assert.deepEqual(
    op.events.map((e) => e.kind).filter((k, i, a) => a.indexOf(k) === i),
    ["staged", "kept", "attempt", "written", "applied"],
  );
  // The vault keeps a verified copy of every replaced unsaved file.
  const actions = op.record!.plan.actions.filter((a) => a.operation !== "keep");
  const aIndex = actions.findIndex((a) => a.path === "A.txt");
  assert.equal(
    await f.vault.readFileText(
      applicationStagedPath("branch-main", op.operationId, "before", aIndex),
    ),
    "a2 edited",
  );
  // The readable copy: replaced bytes, removed folders and the note, written last.
  assert.equal(result.keptAs, "Discarded/2026-11-19 14.05");
  assert.deepEqual(result.keptInsideOnly, []);
  const kept = await f.projectFolder.getDirectory(["Discarded", "2026-11-19 14.05"]);
  assert.equal(await kept.readFileText(["A.txt"]), "a2 edited");
  assert.equal(await kept.readFileText(["New.txt"]), "new");
  assert.equal(await kept.readFileText(["Added", "Deep", "x.txt"]), "x");
  assert.equal(await kept.hasDirectory(["Empty"]), true);
  assert.equal(await kept.hasFile(["Gone.txt"]), false);
  const note = await kept.readFileText(["_DISCARDED cAdtree.txt"]);
  assert.ok(note.includes(`Discarded at (UTC): ${NOW.toISOString()}`), note);
  assert.match(note, /Case: Main/);
  assert.match(note, /Working folder: working\/main/);
  assert.match(note, /Unsaved edit: A\.txt\n    copy in this folder/);
  assert.match(note, /Unsaved deletion: Gone\.txt\n    put back from the saved version/);
  assert.match(note, /Unsaved new folder: Empty/);
  assert.match(note, /HOW TO PUT FILES BACK/);
  assert.equal(op.events.find((e) => e.kind === "kept")?.keptAs, "Discarded/2026-11-19 14.05");
  // Nothing is left to save.
  const scan = await scanForReplace(f.main, "branch-main", getBranchBaseline(await f.state(), "branch-main"));
  assert.equal(scan.hasChanges, false);
});

test("discard one file leaves every other unsaved change alone", async () => {
  const f = await setup();
  await edit(f);
  const before = await f.files(f.main);
  const { plan } = await f.plan(["A.txt"]);
  assert.deepEqual(plan.actions.map((a) => a.path), ["A.txt"]);
  assert.deepEqual(plan.folderActions, []);
  await f.discard(["A.txt"]);
  const after = new Map((await f.files(f.main)) as [string, string][]);
  for (const [path, sha] of before)
    if (path !== "A.txt") assert.equal(after.get(path), sha, path);
  assert.equal(await f.main.readFileText(["A.txt"]), "a1");
  // A deleted file brings back its missing parent folder, recorded as created.
  await f.discard(["Old/Inner.txt"]);
  assert.equal(await f.main.readFileText(["Old", "Inner.txt"]), "inner");
  const last = (await f.ops()).at(-1)!;
  assert.deepEqual(
    last.record!.plan.folderActions.map((a) => [a.path, a.operation]),
    [["Old", "create"]],
  );
});

test("another unsaved file edited during the discard is untouched and does not block", async () => {
  const f = await setup();
  await edit(f);
  let edited = false;
  f.root.setHooks({
    onBeforeWrite: async (full) => {
      if (!edited && full.includes("/before/")) {
        edited = true;
        await f.w(f.main, "Keep.txt", "edited meanwhile");
      }
    },
  });
  const result = await f.discard(["A.txt", "New.txt"]);
  assert.ok(edited);
  assert.equal(result.operation.status, "done");
  assert.equal(await f.main.readFileText(["Keep.txt"]), "edited meanwhile");
  assert.equal(await f.main.readFileText(["A.txt"]), "a1");
  assert.equal(await f.main.hasFile(["New.txt"]), false);
});

test("a selected path edited after review stops the discard before anything is written", async () => {
  const f = await setup();
  await edit(f);
  const p = await f.plan(["A.txt", "New.txt"]);
  await f.w(f.main, "A.txt", "edited again after review");
  const before = await f.files(f.main);
  await assert.rejects(
    replaceWorkingFiles(f.vault, f.projectFolder, {
      mode: "discard",
      projectId: f.projectId,
      branchId: "branch-main",
      targetRevisionId: p.target,
      paths: ["A.txt", "New.txt"],
      expectedPlanHash: p.hash,
      workingFolders: f.folders,
    }),
    /Changes differ from what you saw; review again/,
  );
  assert.deepEqual(await f.files(f.main), before);
  assert.deepEqual(await f.ops(), []);
});

test("a stale plan is refused with ReplacePlanChangedError", async () => {
  const f = await setup();
  await edit(f);
  const p = await f.plan(["A.txt"]);
  await f.w(f.main, "A.txt", "edited again after review");
  const error = await replaceWorkingFiles(f.vault, f.projectFolder, {
    mode: "discard",
    projectId: f.projectId,
    branchId: "branch-main",
    targetRevisionId: p.target,
    paths: ["A.txt"],
    expectedPlanHash: p.hash,
    workingFolders: f.folders,
  }).then(
    () => assert.fail("the discard should be refused"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof ReplacePlanChangedError);
  assert.equal(error.message, "Changes differ from what you saw; review again. Nothing was changed.");
});

test("a file that appears in a folder being removed refuses the discard before any record or copy is written", async () => {
  const f = await setup();
  await f.w(f.main, "Added/x.txt", "x");
  const p = await f.plan(["Added"]);
  assert.ok(p.plan.ready);
  const before = await f.files(f.vault);
  let appeared = false;
  // After the scan under the lock has listed Added/ (while it hashes x.txt), a
  // new file lands in it: the plan still matches, but the folder is not ready.
  f.root.setHooks({
    onBeforeRead: async (full) => {
      if (!appeared && full.endsWith("/working/main/Added/x.txt")) {
        appeared = true;
        await f.w(f.main, "Added/late.txt", "late");
      }
    },
  });
  const error = await replaceWorkingFiles(f.vault, f.projectFolder, {
    mode: "discard",
    projectId: f.projectId,
    branchId: "branch-main",
    targetRevisionId: p.target,
    paths: ["Added"],
    expectedPlanHash: p.hash,
    workingFolders: f.folders,
    now: () => NOW,
  }).then(
    () => assert.fail("the discard should be refused"),
    (e: unknown) => e,
  );
  f.root.setHooks({ onBeforeRead: undefined });
  assert.ok(appeared, "the late file was written during the scan");
  assert.ok(error instanceof ReplacePlanChangedError, String(error));
  assert.match(error.message, /^Changes differ from what you saw: Added\/late\.txt\. Review again\. Nothing was changed\.$/);
  assert.deepEqual(await f.ops(), [], "no operation record");
  assert.deepEqual(await f.files(f.vault), before, "nothing written in the vault");
  assert.equal(await f.projectFolder.hasDirectory(["Discarded"]), false);
  assert.equal(await f.main.readFileText(["Added", "x.txt"]), "x");
  assert.equal(await f.main.readFileText(["Added", "late.txt"]), "late");
});

test("a file that appears in a folder being removed after the copy is kept stops before any working write; the discard is left unfinished, not reviewed again", async () => {
  const f = await setup();
  await f.w(f.main, "Added/x.txt", "x");
  const p = await f.plan(["Added"]);
  let appeared = false;
  // The kept copy's note is written last, after the record and staged copies.
  f.root.setHooks({
    onBeforeWrite: async (full) => {
      if (!appeared && full.includes("/Discarded/") && full.endsWith("_DISCARDED cAdtree.txt")) {
        appeared = true;
        await f.w(f.main, "Added/late.txt", "late");
      }
    },
  });
  const error = await replaceWorkingFiles(f.vault, f.projectFolder, {
    mode: "discard",
    projectId: f.projectId,
    branchId: "branch-main",
    targetRevisionId: p.target,
    paths: ["Added"],
    expectedPlanHash: p.hash,
    workingFolders: f.folders,
    now: () => NOW,
  }).then(
    () => assert.fail("the discard should be refused"),
    (e: unknown) => e,
  );
  f.root.setHooks({ onBeforeWrite: undefined });
  assert.ok(appeared, "the late file was written while the copy was kept");
  assert.ok(error instanceof Error);
  assert.ok(!(error instanceof ReplacePlanChangedError), "not a stale plan: the operation has started");
  assert.equal(
    error.message,
    "Changes differ from what you saw: Added/late.txt. No working files were changed. Choose Put files back as they were (see the notice at the top), then try again.",
  );
  const [op] = await f.ops();
  assert.equal(op.status, "unresolved");
  assert.equal(await f.main.readFileText(["Added", "x.txt"]), "x");
  assert.equal(await f.main.readFileText(["Added", "late.txt"]), "late");
  // Another Discard is refused until this one is undone, and says which one.
  await assert.rejects(f.discard(["Added"]), /^Error: This case has an unfinished Discard\. Choose Put files back as they were \(see the notice at the top\) before starting another\.$/);
  const recovered = await recoverApplication(f.vault, f.projectId, "branch-main", op.operationId, {
    workingFolders: f.folders,
  });
  assert.deepEqual(recovered.manualPaths, []);
  assert.equal((await f.ops())[0].status, "recovered");
  assert.equal(await f.main.readFileText(["Added", "late.txt"]), "late");
});

test("a selected file edited between staging and its write stops the discard; recovery undoes the rest and keeps the edit", async () => {
  const f = await setup();
  await edit(f);
  let n = 0;
  f.root.setHooks({
    onBeforeWrite: async (full) => {
      // Second working-folder write: change New.txt behind cAdtree's back.
      if (full.includes("/working/main/")) {
        n++;
        if (n === 2) {
          f.root.setHooks({ onBeforeWrite: undefined });
          await f.w(f.main, "New.txt", "late edit");
        }
      }
    },
  });
  await assert.rejects(f.discard(["A.txt", "Gone.txt", "New.txt"]), /changed/);
  f.root.setHooks({ onBeforeWrite: undefined });
  const [op] = await f.ops();
  assert.equal(op.status, "unresolved");
  const recovered = await recoverApplication(f.vault, f.projectId, "branch-main", op.operationId, {
    workingFolders: f.folders,
  });
  // The late edit is kept as it is and reported for inspection; the rest is undone.
  assert.deepEqual(recovered.manualPaths, ["New.txt"]);
  assert.equal(await f.main.readFileText(["A.txt"]), "a2 edited");
  assert.equal(await f.main.hasFile(["Gone.txt"]), false);
  assert.equal(await f.main.readFileText(["New.txt"]), "late edit");
  assert.equal((await f.ops())[0].status, "unresolved");
});

test("an interrupted discard is unfinished and recovery restores the discarded changes", async () => {
  const f = await setup();
  await edit(f);
  const edited = { files: await f.files(f.main), dirs: await f.dirs(f.main) };
  let writes = 0;
  f.root.setHooks({
    onBeforeWrite: (full) => {
      if (full.includes("/working/main/") && ++writes === 3)
        throw new Error("disk full");
    },
  });
  await assert.rejects(f.discard(ALL), /disk full/);
  f.root.setHooks({ onBeforeWrite: undefined });
  const [op] = await f.ops();
  assert.equal(op.status, "unresolved");
  // An unfinished discard blocks saving and another discard, like an unfinished Apply.
  assert.ok(applicationCaptureBlock(await f.state(), "branch-main"));
  await assert.rejects(
    replaceWorkingFiles(f.vault, f.projectFolder, {
      mode: "discard", projectId: f.projectId, branchId: "branch-main",
      targetRevisionId: f.r1.revision.manifest.revisionId, paths: ["New.txt"],
      expectedPlanHash: "0".repeat(64), workingFolders: f.folders,
    }),
    /unfinished/,
  );
  const recovered = await recoverApplication(f.vault, f.projectId, "branch-main", op.operationId, {
    workingFolders: f.folders,
  });
  assert.deepEqual(recovered.manualPaths, []);
  assert.equal((await f.ops())[0].status, "recovered");
  assert.deepEqual(await f.files(f.main), edited.files);
  assert.deepEqual(await f.dirs(f.main), edited.dirs);
});

test("untracked OS clutter in a discarded folder is moved with it, never left behind", async () => {
  const f = await setup();
  await f.w(f.main, "Added/x.txt", "x");
  await f.w(f.main, "Added/.DS_Store", "finder");
  await f.w(f.main, ".DS_Store", "finder root");
  const { plan } = await f.plan(["Added"]);
  assert.deepEqual(plan.actions.map((a) => a.path), ["Added/.DS_Store", "Added/x.txt"]);
  const result = await f.discard(["Added"]);
  assert.equal(await f.main.hasDirectory(["Added"]), false);
  // Clutter outside the selection is not touched.
  assert.equal(await f.main.readFileText([".DS_Store"]), "finder root");
  const kept = await f.projectFolder.getDirectory(result.keptAs!.split("/"));
  assert.equal(await kept.readFileText(["Added", ".DS_Store"]), "finder");
  assert.equal(await kept.hasFile([".DS_Store"]), false);
  const index = result.operation.record!.plan.actions.findIndex((a) => a.path === "Added/.DS_Store");
  assert.equal(
    await f.vault.readFileText(
      applicationStagedPath("branch-main", result.operation.operationId, "before", index),
    ),
    "finder",
  );
});

test("untracked lock files follow the clutter rule: left alone outside the selection, moved with a discarded folder", async () => {
  const f = await setup();
  await f.w(f.main, "Added/x.txt", "x");
  await f.w(f.main, "Added/~$x.SLDPRT", "owner");
  await f.w(f.main, "~$root.SLDPRT", "owner root");
  const { plan } = await f.plan(["Added"]);
  assert.deepEqual(plan.actions.map((a) => a.path), ["Added/~$x.SLDPRT", "Added/x.txt"]);
  await f.discard(["Added"]);
  assert.equal(await f.main.hasDirectory(["Added"]), false);
  assert.equal(await f.main.readFileText(["~$root.SLDPRT"]), "owner root");
});

test("plans: nothing selected, no change, unknown path and unrelated scan errors", async () => {
  const f = await setup();
  await edit(f);
  assert.match((await f.plan([])).plan.blockers.join(" "), /Nothing selected/);
  assert.match((await f.plan(["Keep.txt"])).plan.blockers.join(" "), /no unsaved change/);
  assert.match((await f.plan(["Nope.txt"])).plan.blockers.join(" "), /Nothing to discard/);
  (f.main as InMemoryFileSystemAdapter).markFileUnreadable(["Keep.txt"]);
  assert.ok((await f.plan(["A.txt"])).plan.ready);
  assert.match((await f.plan(["Keep.txt"])).plan.blockers.join(" "), /Can't read Keep\.txt/);
  // The modification date alone does not change the plan hash.
  const one = await f.plan(["A.txt"]);
  await f.w(f.main, "A.txt", "a2 edited");
  assert.equal((await f.plan(["A.txt"])).hash, one.hash);
});

test("a finished discard does not block saving, Bring back or hiding the case", async () => {
  const f = await setup();
  await f.w(f.main, "A.txt", "a2");
  await captureRevision(f.main, f.vault, {
    branchId: "branch-main", summary: "R2", notes, workingFolders: f.folders,
  });
  await f.w(f.main, "A.txt", "a3 unsaved");
  await f.discard(["A.txt"]);
  const state: VaultState = await f.state();
  assert.equal(applicationCaptureBlock(state, "branch-main"), undefined);
  // Save.
  await f.w(f.main, "A.txt", "a4");
  await captureRevision(f.main, f.vault, {
    branchId: "branch-main", summary: "R3", notes, workingFolders: f.folders,
  });
  // Bring back R1 (and save it).
  const prepared = prepareApplyPreview(await f.state(), f.r1.revision.manifest.revisionId, "branch-main", "revert");
  if (prepared.status !== "available") throw new Error(prepared.reason);
  const selection = Object.fromEntries(
    prepared.context.rows
      .filter((r) => r.kind === "available")
      .map((r) => [r.path, { selected: true, decision: "use-source" as const }]),
  );
  const review = applicationReview(buildApplyPreview(prepared.context, selection, ""), selection);
  const saved = await applyAndSave(f.vault, review, { workingFolders: f.folders });
  assert.equal(saved.status, "saved");
  // Hide a case after discarding in it.
  const withCase = await createManagedBranch(f.root, f.containerPath, {
    sourceRevisionId: f.r1.revision.manifest.revisionId, name: "Lighter", reason: "Try",
  });
  const caseId = withCase.createdBranchId;
  f.folders[caseId] = withCase.workingFolders[caseId]!;
  const caseDir = f.folders[caseId]!;
  await f.w(caseDir, "A.txt", "case edit");
  await f.discard(["A.txt"], caseId, caseDir);
  assert.equal((await f.ops(caseId))[0].status, "done");
  await changeCaseLifecycle(f.vault, {
    projectId: f.projectId, branchId: caseId, activeBranchId: "branch-main", status: "archived",
    expectedVersion: caseLifecycle(await f.state(), caseId).version,
  }, { workingFolders: f.folders });
  assert.equal(caseLifecycle(await f.state(), caseId).status, "archived");
});

test("discards in the same minute get a counter; deletions alone keep nothing", async () => {
  const f = await setup();
  const names: (string | null)[] = [];
  for (const text of ["one", "two", "three"]) {
    await f.w(f.main, "A.txt", text);
    names.push((await f.discard(["A.txt"])).keptAs);
  }
  assert.deepEqual(names, [
    "Discarded/2026-11-19 14.05",
    "Discarded/2026-11-19 14.05 (2)",
    "Discarded/2026-11-19 14.05 (3)",
  ]);
  const second = await f.projectFolder.getDirectory(["Discarded", "2026-11-19 14.05 (2)"]);
  assert.equal(await second.readFileText(["A.txt"]), "two");
  // A case-only clash counts as taken too.
  await f.projectFolder.getDirectory(["Discarded", "2026-11-19 14.05 (4)".toUpperCase()], { create: true });
  await f.w(f.main, "A.txt", "four");
  assert.equal((await f.discard(["A.txt"])).keptAs, "Discarded/2026-11-19 14.05 (5)");
  // Only a deletion: nothing to keep, no folder.
  await f.main.removeEntry(["Gone.txt"]);
  const result = await f.discard(["Gone.txt"]);
  assert.equal(result.keptAs, null);
  assert.equal(result.operation.status, "done");
  assert.equal(await f.main.readFileText(["Gone.txt"]), "gone");
  // Past the ninth copy in one minute it stops before anything is written,
  // so no unfinished operation is left behind.
  for (let n = 6; n <= 9; n++)
    await f.projectFolder.getDirectory(["Discarded", `2026-11-19 14.05 (${n})`], { create: true });
  await f.w(f.main, "A.txt", "ten");
  const opsBefore = (await f.ops()).length;
  await assert.rejects(f.discard(["A.txt"]), /Too many discards in the same minute/);
  assert.equal(await f.main.readFileText(["A.txt"]), "ten");
  assert.equal((await f.ops()).length, opsBefore);
  assert.ok((await f.ops()).every((op) => op.status === "done"));
});

test("a readable copy whose path is too long is skipped and listed; the vault keeps it", async () => {
  const f = await setup();
  const address = `C:\\${"W".repeat(200)}`;
  f.root.setAddress(address);
  const long = `Deep/${"n".repeat(20)}.txt`;
  await f.w(f.main, long, "long one");
  await f.w(f.main, "A.txt", "short one");
  const failing = joinAddress(address, f.containerPath, "Discarded", "2026-11-19 14.05", long);
  (f.root as InMemoryFileSystemAdapter).simulateFailureAt(failing, new DOMException("too long", "InvalidStateError"));
  const result = await f.discard(["A.txt", "Deep"]);
  assert.deepEqual(result.keptInsideOnly, [long]);
  assert.equal(await f.main.hasDirectory(["Deep"]), false);
  const kept = await f.projectFolder.getDirectory(["Discarded", "2026-11-19 14.05"]);
  assert.equal(await kept.readFileText(["A.txt"]), "short one");
  // No partial readable copy is left behind.
  assert.equal(await kept.hasFile(long.split("/")), false);
  const note = await kept.readFileText(["_DISCARDED cAdtree.txt"]);
  assert.match(note, /KEPT INSIDE cAdtree ONLY/);
  const index = result.operation.record!.plan.actions.findIndex((a) => a.path === long);
  const staged = ["vault", ...applicationStagedPath("branch-main", result.operation.operationId, "before", index)].join("/");
  assert.ok(note.includes(staged), note);
  assert.equal(
    await f.vault.readFileText(applicationStagedPath("branch-main", result.operation.operationId, "before", index)),
    "long one",
  );
});

test("the project Map mentions Discarded/", async () => {
  const f = await setup();
  await f.w(f.main, "A.txt", "edit");
  await f.discard(["A.txt"]);
  const guide = await refreshProjectGuide(f.root, f.containerPath);
  assert.equal(guide.status, "written");
  const map = await f.projectFolder.readFileText(["_MAP cAdtree.txt"]);
  assert.match(map, /Discarded\/<date time>\//);
  assert.match(map, /_DISCARDED cAdtree\.txt/);
});

test("a failed read of the vault copy stops the discard before working files change", async () => {
  const f = await setup();
  await f.w(f.main, "A.txt", "precious edit");
  let armed = false;
  f.root.setHooks({
    onBeforeWrite: (full) => {
      if (full.endsWith("/events/000001.json")) armed = true; // the "staged" event
    },
    onBeforeRead: (full) => {
      if (armed && full.includes("/before/")) throw new DOMException("gone", "NotFoundError");
    },
  });
  await assert.rejects(f.discard(["A.txt"]), /gone/);
  f.root.setHooks({ onBeforeWrite: undefined, onBeforeRead: undefined });
  assert.equal(await f.main.readFileText(["A.txt"]), "precious edit");
  const [op] = await f.ops();
  assert.equal(op.status, "unresolved");
  assert.equal(op.events.some((e) => e.kind === "attempt"), false);
});

test("selecting a folder that exists on both sides takes everything below it that differs", async () => {
  const f = await setup();
  await f.w(f.main, "Old/Inner.txt", "inner edited");
  await f.w(f.main, "Old/Extra/new.txt", "new");
  await f.w(f.main, "Other.txt", "unselected");
  const { plan } = await f.plan(["Old"]);
  assert.ok(plan.ready, plan.blockers.join(" "));
  assert.deepEqual(plan.actions.map((a) => [a.path, a.operation]), [
    ["Old/Extra/new.txt", "delete"],
    ["Old/Inner.txt", "replace"],
  ]);
  assert.deepEqual(plan.folderActions.map((a) => [a.path, a.operation]), [["Old/Extra", "remove"]]);
  // Overlapping selections are fine.
  assert.ok((await f.plan(["Old", "Old/Extra", "Old/Inner.txt"])).plan.ready);
  await f.discard(["Old"]);
  assert.equal(await f.main.readFileText(["Old", "Inner.txt"]), "inner");
  assert.equal(await f.main.hasDirectory(["Old", "Extra"]), false);
  assert.equal(await f.main.readFileText(["Other.txt"]), "unselected");
  // Nothing differs below it any more.
  assert.match((await f.plan(["Old"])).plan.blockers.join(" "), /Old has no unsaved change/);
});
