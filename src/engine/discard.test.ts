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

const notes = { problem: "", modification: "Saved", observations: "" };

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

test("discard all: added, modified and deleted files and folders go back to the latest revision", async () => {
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
  const index = result.operation.record!.plan.actions.findIndex((a) => a.path === "Added/.DS_Store");
  assert.equal(
    await f.vault.readFileText(
      applicationStagedPath("branch-main", result.operation.operationId, "before", index),
    ),
    "finder",
  );
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
