import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryFileSystemAdapter,
  type FileSystemDirectoryAdapter,
} from "./fs-adapter";
import { openExistingVault } from "./vault-service";
import { captureRevision } from "./revision-service";
import { createProject, createWorkspace } from "./workspace-service";
import {
  buildApplyPreview,
  buildReplacePlan,
  prepareApplyPreview,
  replacePlanHash,
} from "./apply-preview";
import {
  applicationReview,
  applyAndSave,
  replaceWorkingFiles,
  scanForReplace,
} from "./application-service";
import { applicationCaptureBlock, branchApplications } from "./application-records";
import { createIdentityReview } from "./component-identity";
import { getBranchBaseline } from "./branch-state";
import { scanBranchChanges } from "./scanner";
import type { VaultState } from "./types";

const notes = { problem: "", modification: "Saved", observations: "" };
const NOW = new Date(2026, 10, 20, 9, 30, 0);
const MAIN = "branch-main";
const component = (state: VaultState, revisionId: string, path: string) =>
  state.components?.revisions[revisionId]?.files.find((f) => f.path === path)?.componentId;

async function setup() {
  const root = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(root);
  const project = await createProject(root, "Gripper");
  const projectFolder = await root.getDirectory(project.record.containerPath.split("/"));
  const vault = project.vaultDir;
  const projectId = project.record.projectId;
  const folders = { ...project.workingFolders } as Record<string, FileSystemDirectoryAdapter>;
  const main = folders[MAIN]!;
  const w = (p: string, t: string) => main.writeFileText(p.split("/"), t);
  const read = (p: string) => main.readFileText(p.split("/"));
  const has = (p: string) => main.hasFile(p.split("/"));
  const save = (extra: Record<string, unknown> = {}) =>
    captureRevision(main, vault, { branchId: MAIN, summary: "Saved", notes, workingFolders: folders, ...extra });
  await w("A.txt", "a1");
  await w("Gone.txt", "gone");
  await w("Old/Inner.txt", "inner");
  await w("Keep.txt", "keep");
  const r1 = (await save()).revision.manifest.revisionId;
  await w("A.txt", "a2");
  await main.removeEntry(["Gone.txt"]);
  await main.removeEntry(["Old"], { recursive: true });
  const r2 = (await save()).revision.manifest.revisionId;
  const state = () => openExistingVault(vault);
  const plan = async (paths: string[], target: string) => {
    const s = await state();
    const scan = await scanForReplace(main, MAIN, getBranchBaseline(s, MAIN));
    const built = buildReplacePlan(s, scan, target, paths, "restore-file");
    return { plan: built, hash: replacePlanHash(built) };
  };
  const getVersion = async (path: string, target: string) => {
    const p = await plan([path], target);
    assert.ok(p.plan.ready, p.plan.blockers.join(" "));
    return replaceWorkingFiles(vault, projectFolder, {
      mode: "restore-file",
      projectId,
      branchId: MAIN,
      targetRevisionId: target,
      paths: [path],
      expectedPlanHash: p.hash,
      workingFolders: folders,
      now: () => NOW,
    });
  };
  const ops = async () => branchApplications(await state(), MAIN);
  return { vault, projectFolder, projectId, folders, main, w, read, has, save, r1, r2, state, plan, getVersion, ops };
}

test("get this version: a modified file goes back to the older bytes and its current file is kept in Discarded", async () => {
  const f = await setup();
  const result = await f.getVersion("A.txt", f.r1);
  assert.equal(await f.read("A.txt"), "a1");
  assert.equal(result.operation.status, "done");
  assert.equal(result.operation.record?.plan.mode, "restore-file");
  assert.deepEqual(result.plan.actions.map((a) => [a.path, a.operation]), [["A.txt", "replace"]]);
  assert.equal(result.keptAs, "Discarded/2026-11-20 09.30");
  const kept = await f.projectFolder.getDirectory(result.keptAs!.split("/"));
  assert.equal(await kept.readFileText(["A.txt"]), "a2");
  const note = await kept.readFileText(["_DISCARDED cAdtree.txt"]);
  assert.match(note, /Get this version/);
  assert.match(note, /Replaced file: A\.txt/);
  // The record stores the file's component in the target revision.
  const state = await f.state();
  assert.equal(result.operation.record?.plan.componentId, component(state, f.r1, "A.txt"));
  assert.equal((await f.ops())[0].status, "done");
  // Shown as an unsaved change, not saved.
  const scan = await scanBranchChanges(f.main, MAIN, getBranchBaseline(state, MAIN));
  assert.deepEqual(scan.modified.map((m) => m.current.path), ["A.txt"]);
});

test("get this version: a deleted file comes back (nothing to keep) and a missing parent folder is created", async () => {
  const f = await setup();
  const gone = await f.getVersion("Gone.txt", f.r1);
  assert.equal(await f.read("Gone.txt"), "gone");
  assert.equal(gone.keptAs, null);
  const inner = await f.getVersion("Old/Inner.txt", f.r1);
  assert.equal(await f.read("Old/Inner.txt"), "inner");
  assert.deepEqual(inner.plan.folderActions.map((a) => [a.path, a.operation]), [["Old", "create"]]);
  // Other files are untouched.
  assert.equal(await f.read("A.txt"), "a2");
  assert.equal(await f.read("Keep.txt"), "keep");
});

test("get this version: unsaved edits are kept in Discarded, other unsaved changes are untouched", async () => {
  const f = await setup();
  await f.w("A.txt", "a3 unsaved");
  await f.w("Keep.txt", "keep unsaved");
  const result = await f.getVersion("A.txt", f.r1);
  const kept = await f.projectFolder.getDirectory(result.keptAs!.split("/"));
  assert.equal(await kept.readFileText(["A.txt"]), "a3 unsaved");
  assert.equal(await kept.hasFile(["Keep.txt"]), false);
  assert.equal(await f.read("Keep.txt"), "keep unsaved");
});

test("get this version: a file renamed since that revision, or a different file using its name, is blocked", async () => {
  const f = await setup();
  // Rename A.txt to B.txt with a confirmed identity decision.
  await f.main.removeEntry(["A.txt"]);
  await f.w("B.txt", "a2");
  let s = await f.state();
  let scan = await scanBranchChanges(f.main, MAIN, getBranchBaseline(s, MAIN));
  await f.save({ identityReview: createIdentityReview(s, scan, [{ from: "A.txt", to: "B.txt" }], []) });
  const renamed = await f.plan(["A.txt"], f.r1);
  assert.equal(renamed.plan.ready, false);
  assert.match(renamed.plan.blockers.join(" "), /renamed since that revision/);
  // A new, different file now called Keep.txt (the old one replaced).
  await f.w("Keep.txt", "another file");
  s = await f.state();
  scan = await scanBranchChanges(f.main, MAIN, getBranchBaseline(s, MAIN));
  await f.save({ identityReview: createIdentityReview(s, scan, [], ["Keep.txt"]) });
  assert.match((await f.plan(["Keep.txt"], f.r1)).plan.blockers.join(" "), /different file now uses this name/);
  // The engine refuses too, with nothing written.
  const stillRenamed = await f.plan(["A.txt"], f.r1);
  await assert.rejects(
    replaceWorkingFiles(f.vault, f.projectFolder, {
      mode: "restore-file", projectId: f.projectId, branchId: MAIN, targetRevisionId: f.r1,
      paths: ["A.txt"], expectedPlanHash: stillRenamed.hash, workingFolders: f.folders, now: () => NOW,
    }),
    /renamed since/,
  );
  assert.equal(await f.has("A.txt"), false);
  assert.equal((await f.ops()).length, 0);
});

test("get this version plans: one file only, it must be in that revision, and it must differ", async () => {
  const f = await setup();
  assert.match((await f.plan(["A.txt", "Keep.txt"], f.r1)).plan.blockers.join(" "), /one file/);
  assert.match((await f.plan(["Old"], f.r1)).plan.blockers.join(" "), /no file at Old/);
  assert.match((await f.plan(["Nope.txt"], f.r1)).plan.blockers.join(" "), /no file at Nope\.txt/);
  assert.match((await f.plan(["Keep.txt"], f.r1)).plan.blockers.join(" "), /already matches/);
  assert.match((await f.plan(["A.txt"], f.r2)).plan.blockers.join(" "), /already matches/);
});

test("saving after get this version keeps the file's identity; changed bytes or a later baseline do not", async () => {
  const f = await setup();
  const before = await f.state();
  const goneId = component(before, f.r1, "Gone.txt")!;
  const aId = component(before, f.r2, "A.txt")!;
  await f.getVersion("Gone.txt", f.r1);
  await f.getVersion("A.txt", f.r1);
  assert.equal(applicationCaptureBlock(await f.state(), MAIN), undefined);
  const r3 = (await f.save()).revision.manifest.revisionId;
  let state = await f.state();
  assert.equal(state.components?.status, "available", state.components?.reason);
  assert.equal(component(state, r3, "Gone.txt"), goneId);
  assert.equal(component(state, r3, "A.txt"), aId);
  // Reopening verifies the transfer against the recorded operation.
  state = await openExistingVault(f.vault);
  assert.equal(state.components?.status, "available", state.components?.reason);

  // Restored, then edited before saving: no evidence, so a new identity.
  await f.main.removeEntry(["Old"], { recursive: true }).catch(() => undefined);
  await f.getVersion("Old/Inner.txt", f.r1);
  await f.w("Old/Inner.txt", "inner edited");
  const r4 = (await f.save()).revision.manifest.revisionId;
  state = await f.state();
  const innerId = component(state, f.r1, "Old/Inner.txt");
  assert.ok(component(state, r4, "Old/Inner.txt"));
  assert.notEqual(component(state, r4, "Old/Inner.txt"), innerId);
  // The finished operation on an older baseline is not used again.
  await f.main.removeEntry(["Gone.txt"]);
  await f.save();
  await f.w("Gone.txt", "gone");
  const r6 = (await f.save()).revision.manifest.revisionId;
  state = await f.state();
  assert.notEqual(component(state, r6, "Gone.txt"), goneId);
  assert.equal(state.components?.status, "available", state.components?.reason);
});

test("a finished get this version blocks nothing: another one, Discard and Bring back still work", async () => {
  const f = await setup();
  await f.getVersion("A.txt", f.r1);
  await f.getVersion("Gone.txt", f.r1);
  // Undo with Discard.
  let s = await f.state();
  const scan = await scanForReplace(f.main, MAIN, getBranchBaseline(s, MAIN));
  const discardPlan = buildReplacePlan(s, scan, f.r2, ["A.txt"]);
  await replaceWorkingFiles(f.vault, f.projectFolder, {
    mode: "discard", projectId: f.projectId, branchId: MAIN, targetRevisionId: f.r2,
    paths: ["A.txt"], expectedPlanHash: replacePlanHash(discardPlan), workingFolders: f.folders,
    now: () => new Date(2026, 10, 20, 9, 31),
  });
  assert.equal(await f.read("A.txt"), "a2");
  assert.deepEqual((await f.ops()).map((op) => op.status), ["done", "done", "done"]);
  await f.main.removeEntry(["Gone.txt"]);
  // Bring back R1 (and save it).
  s = await f.state();
  const prepared = prepareApplyPreview(s, f.r1, MAIN, "revert");
  if (prepared.status !== "available") throw new Error(prepared.reason);
  const selection = Object.fromEntries(
    prepared.context.rows
      .filter((r) => r.kind === "available")
      .map((r) => [r.path, { selected: true, decision: "use-source" as const }]),
  );
  const review = applicationReview(buildApplyPreview(prepared.context, selection, ""), selection);
  const saved = await applyAndSave(f.vault, review, { workingFolders: f.folders });
  assert.equal(saved.status, "saved");
  assert.equal(await f.read("Gone.txt"), "gone");
});

test("put back over an unsaved new file at the same path, the file still keeps its identity when saved", async () => {
  const f = await setup();
  const goneId = component(await f.state(), f.r1, "Gone.txt")!;
  await f.w("Gone.txt", "an unsaved new file");
  const result = await f.getVersion("Gone.txt", f.r1);
  assert.equal(result.plan.actions[0].operation, "replace");
  const r3 = (await f.save()).revision.manifest.revisionId;
  const state = await openExistingVault(f.vault);
  assert.equal(state.components?.status, "available", state.components?.reason);
  assert.equal(component(state, r3, "Gone.txt"), goneId);
});

/** Keep.txt (C) in R1 and R2; renamed to K2.txt in R3; deleted in R4. */
async function renamedThenDeleted(f: Awaited<ReturnType<typeof setup>>) {
  await f.main.removeEntry(["Keep.txt"]);
  await f.w("K2.txt", "keep");
  const s = await f.state();
  const scan = await scanBranchChanges(f.main, MAIN, getBranchBaseline(s, MAIN));
  const r3 = (await f.save({ identityReview: createIdentityReview(s, scan, [{ from: "Keep.txt", to: "K2.txt" }], []) })).revision.manifest.revisionId;
  await f.main.removeEntry(["K2.txt"]);
  await f.save();
  return { r3, keepId: component(await f.state(), f.r1, "Keep.txt")! };
}

test("the same component can't be put back at a second path while the first is still there", async () => {
  const f = await setup();
  const { r3, keepId } = await renamedThenDeleted(f);
  assert.equal(component(await f.state(), r3, "K2.txt"), keepId);
  await f.getVersion("Keep.txt", f.r1);
  const blocked = await f.plan(["K2.txt"], r3);
  assert.match(blocked.plan.blockers.join(" "), /This file is already back as Keep\.txt\. Save or discard that first\./);
  // Once Keep.txt no longer holds those bytes, K2.txt can come back.
  await f.w("Keep.txt", "edited");
  assert.ok((await f.plan(["K2.txt"], r3)).plan.ready);
});

test("at save, restored files sharing one component get new identities instead of failing", async () => {
  const f = await setup();
  const { r3, keepId } = await renamedThenDeleted(f);
  await f.getVersion("Keep.txt", f.r1);
  await f.w("Keep.txt", "edited");
  await f.getVersion("K2.txt", r3);
  await f.w("Keep.txt", "keep"); // the bytes Get this version wrote, again
  const r5 = (await f.save()).revision.manifest.revisionId;
  const state = await openExistingVault(f.vault);
  assert.equal(state.components?.status, "available", state.components?.reason);
  const ids = [component(state, r5, "Keep.txt"), component(state, r5, "K2.txt")];
  assert.ok(ids.every((id) => id && id !== keepId));
  assert.notEqual(ids[0], ids[1]);
});

test("renaming onto a file just put back says to save it first", async () => {
  const f = await setup();
  await f.getVersion("Gone.txt", f.r1);
  await f.main.removeEntry(["Keep.txt"]);
  const s = await f.state();
  const scan = await scanBranchChanges(f.main, MAIN, getBranchBaseline(s, MAIN));
  await assert.rejects(
    f.save({ identityReview: createIdentityReview(s, scan, [{ from: "Keep.txt", to: "Gone.txt" }], []) }),
    /just put back with Get this version; save it first, then rename/,
  );
});
