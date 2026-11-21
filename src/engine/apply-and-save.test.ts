import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryFileSystemAdapter,
  type FileSystemDirectoryAdapter,
} from "./fs-adapter";
import { initializeProjectVault, openExistingVault } from "./vault-service";
import { captureRevision } from "./revision-service";
import { createDesignBranch } from "./branch-service";
import { prepareApplyPreview, buildApplyPreview, type ApplyMode } from "./apply-preview";
import {
  applicationReview,
  applyAndSave,
  recoverApplication,
} from "./application-service";
import { branchApplications, type ApplicationReview } from "./application-records";
import { readVerifiedInventory, inventorySignature } from "./copy-service";
import { scanBranchChanges } from "./scanner";
import { getBranchBaseline } from "./branch-state";
import { layoutRevisions } from "../history/layout";
import type { CaptureRevisionInput, VaultState } from "./types";

const notes = { problem: "", modification: "Saved by hand", observations: "" };
const inventory = async (dir: FileSystemDirectoryAdapter) =>
  inventorySignature(await readVerifiedInventory(dir));

async function project() {
  const vault = new InMemoryFileSystemAdapter("SVault"),
    main = new InMemoryFileSystemAdapter("SMain"),
    cases = new InMemoryFileSystemAdapter("SCases");
  const folders: Record<string, FileSystemDirectoryAdapter> = { "branch-main": main };
  const w = (dir: FileSystemDirectoryAdapter, p: string, t: string) =>
    dir.writeFileText(p.split("/"), t);
  await w(main, "A.txt", "a1");
  await w(main, "D.txt", "d1");
  await w(main, "Keep.txt", "keep");
  await initializeProjectVault(main, vault, "Apply and save test");
  const save = (
    dir: FileSystemDirectoryAdapter,
    branchId: string,
    summary: string,
    extra: Partial<CaptureRevisionInput> = {},
  ) =>
    captureRevision(dir, vault, { branchId, summary, notes, workingFolders: folders, ...extra });
  const r1 = await save(main, "branch-main", "R1");
  await w(main, "A.txt", "a2");
  await w(main, "N.txt", "added later");
  await main.removeEntry(["D.txt"]);
  const r2 = await save(main, "branch-main", "R2");
  const options = { workingFolders: folders };
  const review = async (
    sourceId: string,
    mode: ApplyMode,
    reason = "Because",
    destination = "branch-main",
  ): Promise<ApplicationReview> => {
    const prepared = prepareApplyPreview(await openExistingVault(vault), sourceId, destination, mode);
    if (prepared.status !== "available") throw new Error(prepared.reason);
    const selection = Object.fromEntries(
      prepared.context.rows
        .filter((r) => r.kind === "available")
        .map((r) => [r.path, { selected: true, decision: "use-source" as const }]),
    );
    const plan = buildApplyPreview(prepared.context, selection, reason);
    assert.ok(plan.ready, plan.blockers.join(" "));
    return applicationReview(plan, selection);
  };
  const ops = async () => branchApplications(await openExistingVault(vault), "branch-main");
  const head = (s: VaultState) => s.branchHeads["branch-main"];
  return {
    vault, main, cases, folders, options, w, save, review, ops, head,
    r1: r1.revision.manifest, r2: r2.revision.manifest,
  };
}
const files = async (dir: FileSystemDirectoryAdapter) =>
  (await readVerifiedInventory(dir)).files.map((f) => [f.path, f.sha256]).sort();
/** Event number of the `applied` event: staged, attempt+written per change, applied. */
const appliedEventNumber = (steps: number) =>
  String(1 + 2 * steps + 1).padStart(6, "0") + ".json";

test("Bring back saves the result under one lock: summary, Why, parent, captured provenance and a revert copy link", async () => {
  const f = await project();
  const result = await applyAndSave(f.vault, await f.review(f.r1.revisionId, "revert", "  Undo the R2 trial "), {
    ...f.options,
  });
  assert.equal(result.status, "saved");
  if (result.status !== "saved") return;
  const m = result.revision.manifest;
  assert.equal(m.summary, "Brought back V1");
  assert.equal(result.summary, "Brought back V1");
  assert.deepEqual(m.notes, { problem: "Undo the R2 trial", modification: "", observations: "" });
  assert.equal(m.parentRevisionId, f.r2.revisionId);
  assert.equal(m.branchId, "branch-main");
  assert.deepEqual(m.files.map((x) => [x.path, x.sha256]).sort(), f.r1.files.map((x) => [x.path, x.sha256]).sort());
  assert.deepEqual(await files(f.main), f.r1.files.map((x) => [x.path, x.sha256]).sort());
  const state = await openExistingVault(f.vault);
  assert.equal(f.head(state), m.revisionId);
  const op = (await f.ops()).at(-1)!;
  assert.equal(op.status, "captured");
  assert.equal(op.capturedRevisionId, m.revisionId);
  assert.equal(result.operation.status, "captured");
  assert.equal(op.events.filter((e) => e.kind === "capture").length, 1);
  assert.deepEqual(
    layoutRevisions(state, "branch-main").copies.map((c) => [c.child, c.source, c.mode]),
    [[m.revisionId, f.r1.revisionId, "revert"]],
  );
  // Brought-back D.txt keeps its original identity.
  const id = (rev: string, p: string) =>
    state.components?.revisions[rev]?.files.find((x) => x.path === p)?.componentId;
  assert.ok(id(f.r1.revisionId, "D.txt"));
  assert.equal(id(m.revisionId, "D.txt"), id(f.r1.revisionId, "D.txt"));
  // Nothing left to save.
  const scan = await scanBranchChanges(f.main, "branch-main", m);
  assert.equal(scan.hasChanges, false);
});

test("undo: bringing back the previous version restores it and saves again", async () => {
  const f = await project();
  const first = await applyAndSave(f.vault, await f.review(f.r1.revisionId, "revert"), f.options);
  assert.equal(first.status, "saved");
  const undo = await applyAndSave(f.vault, await f.review(f.r2.revisionId, "revert"), f.options);
  assert.equal(undo.status, "saved");
  if (undo.status !== "saved") return;
  assert.equal(undo.revision.manifest.summary, "Brought back V2");
  assert.equal(undo.revision.manifest.displayNumber, 4);
  assert.deepEqual(await files(f.main), f.r2.files.map((x) => [x.path, x.sha256]).sort());
  assert.deepEqual((await f.ops()).map((o) => o.status), ["captured", "captured"]);
});

test("Copy files from a case saves 'Copied N files from <case>' with identity transfers and a merge copy link", async () => {
  const f = await project();
  const created = await createDesignBranch({
    vaultDir: f.vault,
    destinationParent: f.cases,
    workingFolders: f.folders,
    sourceRevisionId: f.r2.revisionId,
    name: "Lighter collar",
    reason: "Try",
  });
  const caseDir = created.workingDir;
  f.folders[created.branch.branchId] = caseDir;
  await f.w(caseDir, "A.txt", "case a");
  await f.w(caseDir, "Parts/New.txt", "case new");
  const caseRev = (await f.save(caseDir, created.branch.branchId, "Case change")).revision.manifest;
  const result = await applyAndSave(f.vault, await f.review(caseRev.revisionId, "merge"), f.options);
  assert.equal(result.status, "saved");
  if (result.status !== "saved") return;
  const m = result.revision.manifest;
  assert.equal(m.summary, "Copied 2 files from Lighter collar");
  assert.equal(m.parentRevisionId, f.r2.revisionId);
  assert.equal(await f.main.readFileText(["Parts", "New.txt"]), "case new");
  assert.equal(await f.main.readFileText(["A.txt"]), "case a");
  const state = await openExistingVault(f.vault);
  const op = (await f.ops()).at(-1)!;
  assert.equal(op.status, "captured");
  assert.equal(op.capturedRevisionId, m.revisionId);
  const id = (rev: string, p: string) =>
    state.components?.revisions[rev]?.files.find((x) => x.path === p)?.componentId;
  assert.ok(id(caseRev.revisionId, "Parts/New.txt"));
  assert.equal(id(m.revisionId, "Parts/New.txt"), id(caseRev.revisionId, "Parts/New.txt"));
  assert.deepEqual(
    layoutRevisions(state, "branch-main").copies.map((c) => [c.child, c.source, c.mode, c.sourceBranchName]),
    [[m.revisionId, caseRev.revisionId, "merge", "Lighter collar"]],
  );
});

test("an edit between the write and the save is not swept in: stays applied, then a normal save links provenance once", async () => {
  const f = await project();
  const review = await f.review(f.r1.revisionId, "revert");
  const steps = 3; // A.txt replace, D.txt add, N.txt delete
  let edited = false;
  f.vault.setHooks({
    onAfterWrite: async (path) => {
      if (edited || !path.endsWith(`/events/${appliedEventNumber(steps)}`)) return;
      edited = true;
      await f.w(f.main, "A.txt", "edited in CAD meanwhile");
    },
  });
  const result = await applyAndSave(f.vault, review, f.options);
  f.vault.setHooks({ onAfterWrite: undefined });
  assert.ok(edited);
  assert.equal(result.status, "not-saved");
  if (result.status !== "not-saved") return;
  assert.match(result.reason, /working files changed while saving/);
  assert.equal(result.summary, "Brought back V1");
  assert.equal(result.operation.status, "applied");
  const state = await openExistingVault(f.vault);
  assert.equal(state.revisions.length, 2);
  assert.equal((await f.ops()).at(-1)!.status, "applied");
  assert.equal(await f.main.readFileText(["A.txt"]), "edited in CAD meanwhile");
  assert.equal(await f.main.readFileText(["D.txt"]), "d1");
  // Save now: an ordinary reviewed save links the pending provenance once.
  const scan = await scanBranchChanges(f.main, "branch-main", getBranchBaseline(state, "branch-main"));
  const saved = await f.save(f.main, "branch-main", result.summary, {
    notes: result.notes,
    reviewedChangesSignature: scan.changesSignature,
  });
  const op = (await f.ops()).at(-1)!;
  assert.equal(op.status, "captured");
  assert.equal(op.capturedRevisionId, saved.revision.manifest.revisionId);
  assert.equal(op.events.filter((e) => e.kind === "capture").length, 1);
  const retry = await f.save(f.main, "branch-main", result.summary, {
    reviewedChangesSignature: scan.changesSignature,
  });
  assert.equal(retry.revision.manifest.revisionId, saved.revision.manifest.revisionId);
  assert.equal((await openExistingVault(f.vault)).revisions.length, 3);
});

test("a save that fails after the write leaves the result applied and the files in place; Save now links once", async () => {
  const f = await project();
  f.vault.setHooks({
    onBeforeWrite: (path) => {
      if (path.includes("/revisions/")) throw new Error("manifest write failed");
    },
  });
  const result = await applyAndSave(f.vault, await f.review(f.r1.revisionId, "revert"), f.options);
  f.vault.setHooks({ onBeforeWrite: undefined });
  assert.equal(result.status, "not-saved");
  if (result.status !== "not-saved") return;
  assert.match(result.reason, /manifest write failed/);
  assert.equal(result.operation.status, "applied");
  assert.deepEqual(await files(f.main), f.r1.files.map((x) => [x.path, x.sha256]).sort());
  assert.equal((await f.ops()).at(-1)!.status, "applied");
  const state = await openExistingVault(f.vault);
  const scan = await scanBranchChanges(f.main, "branch-main", getBranchBaseline(state, "branch-main"));
  const saved = await f.save(f.main, "branch-main", result.summary, {
    reviewedChangesSignature: scan.changesSignature,
  });
  const op = (await f.ops()).at(-1)!;
  assert.equal(op.status, "captured");
  assert.equal(op.capturedRevisionId, saved.revision.manifest.revisionId);
});

test("a lost acknowledgement after the save published is reported as saved, not as unsaved", async () => {
  const f = await project();
  let thrown = false;
  f.vault.setHooks({
    onAfterWrite: (path) => {
      if (!thrown && path.includes("/completed/")) {
        thrown = true;
        throw new Error("completion acknowledgement lost");
      }
    },
  });
  const result = await applyAndSave(f.vault, await f.review(f.r1.revisionId, "revert"), f.options);
  f.vault.setHooks({ onAfterWrite: undefined });
  assert.equal(result.status, "saved");
  if (result.status !== "saved") return;
  assert.match(result.cacheWarning ?? "", /acknowledgement lost/);
  assert.equal(result.operation.status, "captured");
  assert.equal((await openExistingVault(f.vault)).revisions.length, 3);
});

test("an interrupted write throws, stays unresolved, saves nothing and is undone by the existing recovery", async () => {
  const f = await project();
  const before = await inventory(f.main);
  let interrupted = false;
  f.vault.setHooks({
    onBeforeWrite: (path) => {
      if (interrupted || !path.endsWith("/events/000004.json")) return;
      interrupted = true;
      throw new Error("injected interruption");
    },
  });
  await assert.rejects(
    applyAndSave(f.vault, await f.review(f.r1.revisionId, "revert"), f.options),
    /injected interruption/,
  );
  f.vault.setHooks({ onBeforeWrite: undefined });
  const op = (await f.ops()).at(-1)!;
  assert.equal(op.status, "unresolved");
  assert.equal((await openExistingVault(f.vault)).revisions.length, 2);
  const recovery = await recoverApplication(f.vault, op.record!.plan.projectId, "branch-main", op.operationId, f.options);
  assert.deepEqual(recovery.manualPaths, []);
  assert.equal((await f.ops()).at(-1)!.status, "recovered");
  assert.equal(await inventory(f.main), before);
});

test("unsaved changes in the destination are refused before any write; edits are kept", async () => {
  const f = await project();
  const review = await f.review(f.r1.revisionId, "revert");
  await f.w(f.main, "A.txt", "unsaved edit");
  await assert.rejects(applyAndSave(f.vault, review, f.options), /unsaved file or folder changes/);
  assert.equal(await f.main.readFileText(["A.txt"]), "unsaved edit");
  assert.deepEqual(await f.ops(), []);
  assert.equal((await openExistingVault(f.vault)).revisions.length, 2);
});

test("no deadlock: applyAndSave and a concurrent capture serialise on the one project lock", async () => {
  const f = await project();
  const review = await f.review(f.r1.revisionId, "revert");
  const [applied, other] = await Promise.allSettled([
    applyAndSave(f.vault, review, f.options),
    f.save(f.main, "branch-main", "Concurrent save"),
  ]);
  assert.equal(applied.status, "fulfilled");
  assert.equal(applied.status === "fulfilled" && applied.value.status, "saved");
  // The second request ran after the first released the lock: nothing left to save.
  assert.equal(other.status, "rejected");
  assert.match(String((other as PromiseRejectedResult).reason), /No changes detected/);
});

test("the reason is optional: an empty reason gives a ready plan, a valid record and an empty Why", async () => {
  const f = await project();
  const review = await f.review(f.r1.revisionId, "revert", "");
  assert.equal(review.reason, "");
  const result = await applyAndSave(f.vault, review, f.options);
  assert.equal(result.status, "saved");
  if (result.status !== "saved") return;
  assert.equal(result.revision.manifest.notes.problem, "");
  const op = (await f.ops()).at(-1)!;
  assert.equal(op.status, "captured");
  assert.equal(op.record!.plan.reason, "");
});

test("an unreadable untracked lock file in the destination neither blocks nor strands Bring back or Copy", async () => {
  const f = await project();
  await f.w(f.main, "~$A.txt", "owner");
  f.main.markFileUnreadable(["~$A.txt"]);
  const result = await applyAndSave(f.vault, await f.review(f.r1.revisionId, "revert"), f.options);
  assert.equal(result.status, "saved");
  assert.equal(await f.main.readFileText(["A.txt"]), "a1");
  assert.equal((await f.ops()).at(-1)!.status, "captured");
  assert.ok(!(await openExistingVault(f.vault)).revisions.at(-1)!.manifest.files.some((x) => x.path === "~$A.txt"));
  // Copy files from a case, with the lock file still unreadable.
  const created = await createDesignBranch({
    vaultDir: f.vault, destinationParent: f.cases, workingFolders: f.folders,
    sourceRevisionId: f.r2.revisionId, name: "Lighter collar", reason: "Try",
  });
  f.folders[created.branch.branchId] = created.workingDir;
  await f.w(created.workingDir, "Keep.txt", "case keep");
  const caseRev = (await f.save(created.workingDir, created.branch.branchId, "Case change")).revision.manifest;
  const copied = await applyAndSave(f.vault, await f.review(caseRev.revisionId, "merge"), f.options);
  assert.equal(copied.status, "saved");
  assert.equal(await f.main.readFileText(["Keep.txt"]), "case keep");
});

test("an unreadable tracked file still refuses Bring back before any write", async () => {
  const f = await project();
  f.main.markFileUnreadable(["Keep.txt"]);
  const before = await f.main.readFileText(["A.txt"]);
  await assert.rejects(applyAndSave(f.vault, await f.review(f.r1.revisionId, "revert"), f.options), /Keep\.txt/);
  assert.equal(await f.main.readFileText(["A.txt"]), before);
  assert.equal((await f.ops()).length, 0);
});
