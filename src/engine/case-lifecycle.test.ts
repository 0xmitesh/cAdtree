import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryFileSystemAdapter,
  type FileSystemDirectoryAdapter,
} from "./fs-adapter";
import { captureRevision } from "./revision-service";
import { initializeProjectVault, openExistingVault } from "./vault-service";
import { createDesignBranch } from "./branch-service";
import { caseLifecycle, lifecyclePath, sealLifecycle } from "./case-lifecycle";
import {
  changeCaseLifecycle,
  UnsavedCaseChangesError,
} from "./case-lifecycle-service";
import { inventorySignature, readVerifiedInventory } from "./copy-service";
import { prepareApplyPreview, buildApplyPreview } from "./apply-preview";
import { applicationReview } from "./application-service";
import { applyReviewed } from "./fixtures";
import { compareSavedRevisions } from "./snapshot-comparison";
import { layoutRevisions } from "../history/layout";
import { fileHistory } from "../history/file-history";
import { restoreRevisionToFolder } from "./recovery-service";
import {
  createWorkspace,
  adoptProject,
  openWorkspace,
} from "./workspace-service";
import { createHome, bringWorkspaceIntoHome } from "./home-service";

const notes = {
  problem: "Design intent",
  modification: "Engineering change",
  observations: "Synthetic case notes",
};
const part = "Parts/P.SLDPRT";
const snapshot = async (dir: FileSystemDirectoryAdapter) =>
  inventorySignature(await readVerifiedInventory(dir));
async function fixture() {
  const main = new InMemoryFileSystemAdapter("Main"),
    vault = new InMemoryFileSystemAdapter("Vault"),
    parent = new InMemoryFileSystemAdapter("Cases");
  await main.writeFileText(part.split("/"), "Main baseline");
  await main.writeFileText(["Assembly.SLDASM"], "assembly");
  await main.getDirectory(["Empty"], { create: true });
  await initializeProjectVault(main, vault, "Lifecycle project");
  const folders: Record<string, FileSystemDirectoryAdapter> = {
    "branch-main": main,
  };
  const save = (branchId: string, summary: string) =>
    captureRevision(folders[branchId], vault, {
      branchId,
      summary,
      notes,
      fileNotes: [{ path: part, ...notes }],
      workingFolders: folders,
    });
  const first = await save("branch-main", "Main baseline");
  const create = async (
    name: string,
    sourceId = first.revision.manifest.revisionId,
  ) => {
    const result = await createDesignBranch({
      vaultDir: vault,
      destinationParent: parent,
      workingFolders: folders,
      sourceRevisionId: sourceId,
      name,
      reason: `Explore ${name}`,
    });
    folders[result.branch.branchId] = result.workingDir;
    return result;
  };
  const a = await create("Parent case");
  await a.workingDir.writeFileText(part.split("/"), "Parent redesign");
  const revisionA = await save(a.branch.branchId, "Parent saved");
  const child = await create(
    "Child case",
    revisionA.revision.manifest.revisionId,
  );
  const b = await create("Other case");
  await b.workingDir.writeFileText(part.split("/"), "Other redesign");
  const revisionB = await save(b.branch.branchId, "Other saved");
  const state = () => openExistingVault(vault);
  const options = { workingFolders: folders };
  const change = async (
    status: "active" | "archived",
    branchId = a.branch.branchId,
    extra: Partial<Parameters<typeof changeCaseLifecycle>[1]> = {},
  ) =>
    changeCaseLifecycle(
      vault,
      {
        projectId: first.vaultState.project.projectId,
        branchId,
        activeBranchId: "branch-main",
        status,
        expectedVersion: caseLifecycle(await state(), branchId).version,
        ...extra,
      },
      options,
    );
  const review = async (
    sourceId = revisionB.revision.manifest.revisionId,
    destinationBranchId = a.branch.branchId,
  ) => {
    const preparation = prepareApplyPreview(
      await state(),
      sourceId,
      destinationBranchId,
    );
    if (preparation.status !== "available") throw new Error(preparation.reason);
    const choices = Object.fromEntries(
      preparation.context.rows
        .filter((row) => row.kind === "available" || row.kind === "conflict")
        .map((row) => [
          row.path,
          { selected: true, decision: "use-source" as const },
        ]),
    );
    return applicationReview(
      buildApplyPreview(preparation.context, choices, "Reuse selected part"),
      choices,
    );
  };
  return {
    main,
    vault,
    parent,
    folders,
    a,
    b,
    child,
    first,
    revisionA,
    revisionB,
    save,
    create,
    change,
    state,
    options,
    review,
  };
}
test("legacy Active → archive → reload → reopen preserves identities, working bytes, empty folders and every historical record", async () => {
  const f = await fixture();
  const before = await f.state();
  const working = await Promise.all(Object.values(f.folders).map(snapshot));
  const vaultBefore = await readVerifiedInventory(f.vault);
  assert.equal(caseLifecycle(before, f.a.branch.branchId).status, "active");
  const archived = await f.change("archived");
  assert.equal(
    caseLifecycle(archived.state, f.a.branch.branchId).status,
    "archived",
  );
  assert.equal(
    caseLifecycle(await f.state(), f.child.branch.branchId).status,
    "active",
  );
  const duplicate = await f.change("archived", f.a.branch.branchId, {
    expectedVersion: null,
  });
  assert.equal(duplicate.alreadySet, true);
  const reloaded = await f.state();
  assert.deepEqual(reloaded.branches, before.branches);
  assert.deepEqual(reloaded.revisions, before.revisions);
  assert.deepEqual(reloaded.branchHeads, before.branchHeads);
  const vaultAfter = await readVerifiedInventory(f.vault);
  assert.deepEqual(
    vaultAfter.files.filter((file) => !file.path.startsWith("case-lifecycle/")),
    vaultBefore.files,
  );
  assert.deepEqual(
    vaultAfter.directories.filter((path) => path !== "case-lifecycle"),
    vaultBefore.directories,
  );
  assert.deepEqual(
    await Promise.all(Object.values(f.folders).map(snapshot)),
    working,
  );
  // Reopening itself neither reads nor restores a missing working connection.
  const reopened = await changeCaseLifecycle(
    f.vault,
    {
      projectId: before.project.projectId,
      branchId: f.a.branch.branchId,
      activeBranchId: "branch-main",
      status: "active",
      expectedVersion: caseLifecycle(reloaded, f.a.branch.branchId).version,
    },
    { workingFolders: {} },
  );
  assert.equal(
    caseLifecycle(reopened.state, f.a.branch.branchId).status,
    "active",
  );
  assert.deepEqual(reopened.state.branches, before.branches);
  assert.deepEqual(
    await Promise.all(Object.values(f.folders).map(snapshot)),
    working,
  );
  await assert.rejects(
    f.change("archived", f.a.branch.branchId, { expectedVersion: null }),
    /hidden or unhidden since you looked/,
  );
});
test("Main, current working case and invalid identities cannot be archived; concurrent repeats create one outcome", async () => {
  const f = await fixture();
  for (const extra of [
    { branchId: "branch-main" },
    { activeBranchId: f.a.branch.branchId },
    { projectId: "wrong-project" },
    { branchId: "missing" },
  ])
    await assert.rejects(
      f.change("archived", f.a.branch.branchId, extra),
      /Main|Switch to another|changed/,
    );
  assert.deepEqual((await f.state()).caseLifecycles, {});
  const result = await Promise.all([
    f.change("archived"),
    f.change("archived"),
  ]);
  assert.equal(result.filter((r) => r.alreadySet).length, 1);
  assert.equal(caseLifecycle(await f.state(), f.a.branch.branchId).sequence, 1);
});
test("dirty files, empty-directory changes, missing connections and unreadable evidence block archive without touching drafts or files", async () => {
  for (const kind of [
    "file",
    "new-directory",
    "deleted-directory",
    "unreadable",
    "missing",
  ]) {
    const f = await fixture();
    const dir = f.a.workingDir;
    if (kind === "file")
      await dir.writeFileText(part.split("/"), "uncaptured edit");
    if (kind === "new-directory")
      await dir.getDirectory(["Uncaptured empty"], { create: true });
    if (kind === "deleted-directory") await dir.removeEntry(["Empty"]);
    if (kind === "unreadable")
      f.parent.setHooks({
        onBeforeRead: (path) => {
          if (path.endsWith("P.SLDPRT")) throw new Error("unreadable part");
        },
      });
    if (kind === "missing") delete f.folders[f.a.branch.branchId];
    await assert.rejects(
      f.change("archived"),
      kind === "unreadable" || kind === "missing"
        ? /can't be read|unreadable|Reconnect/
        : /unsaved change/,
    );
    f.parent.setHooks({ onBeforeRead: undefined });
    assert.deepEqual((await f.state()).caseLifecycles, {});
    if (kind === "file")
      assert.equal(await dir.readFileText(part.split("/")), "uncaptured edit");
  }
});
test("applied, unresolved and unavailable application evidence blocks archive through existing resolution rules", async () => {
  for (const mode of ["applied", "unresolved", "unavailable"]) {
    const f = await fixture();
    const review = await f.review();
    if (mode === "unresolved")
      f.vault.setHooks({
        onBeforeWrite: (path) => {
          if (path.includes("/source/")) throw new Error("interrupted staging");
        },
      });
    try {
      await applyReviewed(f.vault, review, f.options);
    } catch (error) {
      assert.equal(mode, "unresolved");
    }
    f.vault.setHooks({ onBeforeWrite: undefined });
    if (mode === "unavailable") {
      const op = (await f.state()).applicationOperations![0];
      await f.vault.writeFileText(
        [...op.relativePath.split("/"), "events", "000005.json"],
        "damaged",
      );
    }
    await assert.rejects(
      f.change("archived"),
      mode === "applied" ? /Finish saving first/ : /unfinished or unreadable/,
    );
    assert.deepEqual((await f.state()).caseLifecycles, {});
  }
});
test("archived destinations reject capture and an already-reviewed application at engine boundaries", async () => {
  const f = await fixture();
  const request = await f.review();
  await f.change("archived");
  await assert.rejects(
    f.save(f.a.branch.branchId, "Blocked capture"),
    /hidden/,
  );
  await assert.rejects(applyReviewed(f.vault, request, f.options), /hidden/);
  await f.change("active");
  await applyReviewed(f.vault, request, f.options);
  assert.equal((await f.state()).applicationOperations![0].status, "applied");
});
test("archived sources retain graph/file history, Compare, notes, application, new-case origins, reserved names and fresh recovery", async () => {
  const f = await fixture();
  await f.change("archived");
  let state = await f.state();
  assert.equal(
    compareSavedRevisions(
      state,
      f.first.revision.manifest.revisionId,
      f.revisionA.revision.manifest.revisionId,
    ).status,
    "compared",
  );
  const graph = layoutRevisions(state, "branch-main");
  assert.ok(
    graph.nodes.some(
      (node) =>
        node.id === f.revisionA.revision.manifest.revisionId &&
        node.branchName.endsWith(" · Hidden"),
    ),
  );
  assert.ok(
    fileHistory(state, graph, part, null, null).graph.nodes.some(
      (node) => node.id === f.revisionA.revision.manifest.revisionId,
    ),
  );
  const sourceBefore = await snapshot(f.a.workingDir);
  await applyReviewed(
    f.vault,
    await f.review(f.revisionA.revision.manifest.revisionId, "branch-main"),
    f.options,
  );
  assert.equal(await snapshot(f.a.workingDir), sourceBefore);
  assert.equal(
    caseLifecycle(await f.state(), f.a.branch.branchId).status,
    "archived",
  );
  await assert.rejects(f.create("Parent case"), /already exists/);
  const created = await f.create(
    "New from archived",
    f.revisionA.revision.manifest.revisionId,
  );
  state = await f.state();
  assert.equal(
    created.branch.startingRevisionId,
    f.revisionA.revision.manifest.revisionId,
  );
  assert.equal(caseLifecycle(state, created.branch.branchId).status, "active");
  assert.equal(caseLifecycle(state, f.child.branch.branchId).status, "active");
  await f.child.workingDir.writeFileText(
    ["Child-only.txt"],
    "independent child development",
  );
  const childSave = await f.save(
    f.child.branch.branchId,
    "Child remains active",
  );
  assert.equal(
    childSave.revision.manifest.parentRevisionId,
    f.revisionA.revision.manifest.revisionId,
  );
  const recovery = new InMemoryFileSystemAdapter("Fresh recovery");
  await restoreRevisionToFolder({
    vaultDir: f.vault,
    destinationDir: recovery,
    revisionId: f.revisionA.revision.manifest.revisionId,
    workingFolders: f.folders,
  });
  assert.equal(await snapshot(recovery), sourceBefore);
  assert.deepEqual(
    state.revisions.find(
      (r) => r.manifest.revisionId === f.revisionA.revision.manifest.revisionId,
    )!.manifest.notes,
    notes,
  );
});
test("damaged, unreadable, missing-sequence and unsupported lifecycle evidence never becomes Active", async () => {
  for (const mode of [
    "checksum",
    "project",
    "gap",
    "schema",
    "unreadable",
    "unknown",
    "empty-folder",
  ]) {
    const f = await fixture();
    await f.change("archived");
    const path = lifecyclePath(f.a.branch.branchId, 1);
    if (mode === "unreadable")
      f.vault.setHooks({
        onBeforeRead: (p) => {
          if (p.includes("case-lifecycle/"))
            throw new Error("record unreadable");
        },
      });
    else if (mode === "gap") {
      const text = await f.vault.readFileText(path);
      await f.vault.removeEntry(path);
      await f.vault.writeFileText(lifecyclePath(f.a.branch.branchId, 2), text);
    } else if (mode === "empty-folder") await f.vault.removeEntry(path);
    else if (mode === "unknown")
      await f.vault.writeFileText(
        ["case-lifecycle", "unknown.json"],
        "unexpected",
      );
    else {
      const record = JSON.parse(await f.vault.readFileText(path));
      if (mode === "checksum") record.checksum = "bad";
      if (mode === "project") record.projectId = "wrong";
      if (mode === "schema") record.schemaVersion = 2;
      await f.vault.writeFileText(path, JSON.stringify(record));
    }
    const state = await f.state();
    assert.equal(
      caseLifecycle(state, f.a.branch.branchId).status,
      "unavailable",
    );
    await assert.rejects(
      f.save(f.a.branch.branchId, "Must block"),
      /lifecycle records are unavailable/i,
    );
    await assert.rejects(
      f.change("active"),
      /Lifecycle records are unavailable/,
    );
    f.vault.setHooks({ onBeforeRead: undefined });
  }
});
test("partial lifecycle writes are unavailable; lost acknowledgements reconcile by readback without duplicate records", async () => {
  for (const mode of ["before", "partial", "ack", "readback"]) {
    const f = await fixture();
    const before = await snapshot(f.a.workingDir);
    if (mode === "ack")
      f.vault.setHooks({
        onAfterWrite: (path) => {
          if (path.includes("case-lifecycle/"))
            throw new Error("lost acknowledgement");
        },
      });
    else if (mode === "readback")
      f.vault.setHooks({
        onBeforeRead: (path) => {
          if (path.includes("case-lifecycle/"))
            throw new Error("readback unavailable");
        },
      });
    else
      f.vault.setHooks({
        onBeforeWrite: async (path) => {
          if (!path.includes("case-lifecycle/")) return;
          f.vault.setHooks({ onBeforeWrite: undefined });
          if (mode === "partial")
            await f.vault.writeFileText(
              lifecyclePath(f.a.branch.branchId, 1),
              "partial JSON",
            );
          throw new Error("write interrupted");
        },
      });
    if (mode === "ack")
      assert.equal(
        caseLifecycle((await f.change("archived")).state, f.a.branch.branchId)
          .status,
        "archived",
      );
    else await assert.rejects(f.change("archived"), /not confirmed/);
    f.vault.setHooks({
      onBeforeWrite: undefined,
      onAfterWrite: undefined,
      onBeforeRead: undefined,
    });
    const lifecycle = caseLifecycle(await f.state(), f.a.branch.branchId);
    assert.equal(
      lifecycle.status,
      mode === "before"
        ? "active"
        : mode === "partial"
          ? "unavailable"
          : "archived",
    );
    assert.equal(await snapshot(f.a.workingDir), before);
    if (mode === "ack" || mode === "readback") {
      assert.equal(
        (
          await f.change("archived", f.a.branch.branchId, {
            expectedVersion: null,
          })
        ).alreadySet,
        true,
      );
      assert.equal(
        caseLifecycle(await f.state(), f.a.branch.branchId).sequence,
        1,
      );
    }
  }
});
test("adoption and workspace migration retain lifecycle metadata, case publication hashes and archived folder isolation", async () => {
  const f = await fixture();
  await f.change("archived");
  const workspace = new InMemoryFileSystemAdapter("Workspace");
  await createWorkspace(workspace);
  const adopted = await adoptProject(workspace, f.vault, f.folders);
  assert.deepEqual(
    adopted.vaultState.caseLifecycles,
    (await f.state()).caseLifecycles,
  );
  const home = new InMemoryFileSystemAdapter("Cadtree");
  await createHome(home);
  const migrated = await bringWorkspaceIntoHome(home, workspace);
  const project = (await openWorkspace(migrated.workspace.root)).projects[0]
    .project!;
  assert.equal(
    caseLifecycle(project.vaultState, f.a.branch.branchId).status,
    "archived",
  );
  assert.deepEqual(project.vaultState.branches, (await f.state()).branches);
  const wrong = { ...f.folders, "branch-main": f.a.workingDir };
  await f.main.writeFileText(["New.txt"], "new Main work");
  await assert.rejects(
    captureRevision(f.main, f.vault, {
      branchId: "branch-main",
      summary: "Invalid isolation",
      notes,
      workingFolders: wrong,
    }),
    /same|isolat|overlap/i,
  );
  const missing = { ...f.folders };
  delete missing[f.a.branch.branchId];
  await assert.rejects(
    captureRevision(f.main, f.vault, {
      branchId: "branch-main",
      summary: "Missing archive binding",
      notes,
      workingFolders: missing,
    }),
    /Reconnect/,
  );
});
test("Hide case: a clean case records 0 unsaved changes; unhide records none", async () => {
  const f = await fixture();
  const hidden = await f.change("archived");
  const lifecycle = caseLifecycle(hidden.state, f.a.branch.branchId);
  assert.equal(lifecycle.status, "archived");
  assert.equal(lifecycle.unsavedAtHide, 0);
  const record = JSON.parse(
    await f.vault.readFileText(lifecyclePath(f.a.branch.branchId, 1)),
  );
  assert.equal(record.status, "archived");
  assert.equal(record.unsavedAtHide, 0);
  const shown = await f.change("active");
  assert.equal(caseLifecycle(shown.state, f.a.branch.branchId).status, "active");
  assert.equal(
    caseLifecycle(shown.state, f.a.branch.branchId).unsavedAtHide,
    undefined,
  );
  assert.equal(
    "unsavedAtHide" in
      JSON.parse(
        await f.vault.readFileText(lifecyclePath(f.a.branch.branchId, 2)),
      ),
    false,
  );
});
test("Hide case with unsaved changes: warns first, hides only with the matching signature and keeps the files", async () => {
  const f = await fixture();
  const dir = f.a.workingDir;
  await dir.writeFileText(part.split("/"), "unsaved edit");
  await dir.writeFileText(["New.txt"], "new file");
  await dir.getDirectory(["New folder"], { create: true });
  const working = await snapshot(dir);
  const warning = await f.change("archived").then(
    () => assert.fail("hide must stop for a warning"),
    (error: unknown) => error as UnsavedCaseChangesError,
  );
  assert.ok(warning instanceof UnsavedCaseChangesError);
  assert.equal(warning.stale, false);
  assert.equal(warning.changeCount, 3);
  assert.match(
    warning.message,
    /This case has 3 unsaved changes\. They stay in its folder and show again when you unhide it\./,
  );
  assert.deepEqual((await f.state()).caseLifecycles, {});
  // A further edit after the warning: the acknowledged signature is stale.
  await dir.writeFileText(["Another.txt"], "edited after the warning");
  const stale = await f
    .change("archived", f.a.branch.branchId, {
      acknowledgedChangesSignature: warning.changesSignature,
    })
    .then(
      () => assert.fail("a stale acknowledgement must not hide"),
      (error: unknown) => error as UnsavedCaseChangesError,
    );
  assert.ok(stale instanceof UnsavedCaseChangesError);
  assert.equal(stale.stale, true);
  assert.equal(stale.changeCount, 4);
  assert.match(stale.message, /differ from what you saw/);
  assert.deepEqual((await f.state()).caseLifecycles, {});
  const hidden = await f.change("archived", f.a.branch.branchId, {
    acknowledgedChangesSignature: stale.changesSignature,
  });
  const lifecycle = caseLifecycle(hidden.state, f.a.branch.branchId);
  assert.equal(lifecycle.status, "archived");
  assert.equal(lifecycle.unsavedAtHide, 4);
  assert.equal(await dir.readFileText(part.split("/")), "unsaved edit");
  assert.equal(await dir.readFileText(["Another.txt"]), "edited after the warning");
  assert.notEqual(await snapshot(dir), working);
  // Still read-only while hidden; unhide shows the same changes again.
  await assert.rejects(f.save(f.a.branch.branchId, "Blocked"), /hidden/);
  await f.change("active");
  await f.save(f.a.branch.branchId, "Saved after unhide");
});
test("Hide case refuses scan errors, Main and the current case even with an acknowledgement", async () => {
  const f = await fixture();
  await f.a.workingDir.writeFileText(part.split("/"), "unsaved edit");
  f.parent.setHooks({
    onBeforeRead: (path) => {
      if (path.endsWith("P.SLDPRT")) throw new Error("unreadable part");
    },
  });
  await assert.rejects(
    f.change("archived", f.a.branch.branchId, {
      acknowledgedChangesSignature: "anything",
    }),
    /can't be read/,
  );
  f.parent.setHooks({ onBeforeRead: undefined });
  await assert.rejects(
    f.change("archived", "branch-main", { acknowledgedChangesSignature: "x" }),
    /Main cannot be hidden/,
  );
  await assert.rejects(
    f.change("archived", f.a.branch.branchId, {
      activeBranchId: f.a.branch.branchId,
    }),
    /Switch to another case/,
  );
  assert.deepEqual((await f.state()).caseLifecycles, {});
});
test("lifecycle records with an invalid unsavedAtHide are unavailable", async () => {
  for (const value of [-1, 1.5, "2"]) {
    const f = await fixture();
    await f.change("archived");
    const path = lifecyclePath(f.a.branch.branchId, 1);
    const { checksum: _checksum, ...body } = JSON.parse(
      await f.vault.readFileText(path),
    );
    body.unsavedAtHide = value;
    await f.vault.writeFileText(
      path,
      JSON.stringify(sealLifecycle(body)),
    );
    assert.equal(
      caseLifecycle(await f.state(), f.a.branch.branchId).status,
      "unavailable",
    );
  }
});
