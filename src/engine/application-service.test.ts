import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryFileSystemAdapter,
  type FileSystemDirectoryAdapter,
} from "./fs-adapter";
import { initializeProjectVault, openExistingVault } from "./vault-service";
import { captureRevision } from "./revision-service";
import { createDesignBranch } from "./branch-service";
import {
  prepareApplyPreview,
  buildApplyPreview,
  type PreviewChoice,
} from "./apply-preview";
import {
  applicationReview,
  prepareApplication,
  applyPreparedApplication,
  recoverApplication,
  abandonApplication,
  requestApplicationWriteAccess,
} from "./application-service";
import {
  applicationCaptureBlock,
  branchApplications,
  changedActions,
  type ApplicationReview,
} from "./application-records";
import { getObjectPathSegments } from "./object-store";
import {
  copyVerifiedTree,
  readVerifiedInventory,
  inventorySignature,
} from "./copy-service";
import { scanBranchChanges } from "./scanner";
import type { CaptureRevisionInput } from "./types";
import {
  createWorkspace,
  adoptProject,
  openWorkspace,
} from "./workspace-service";
import { createHome, bringWorkspaceIntoHome } from "./home-service";
const notes = {
  problem: "Engineering intent",
  modification: "Reviewed change",
  observations: "Synthetic only",
};
const part = "Parts/Part-X.SLDPRT";
const inventory = async (dir: FileSystemDirectoryAdapter) =>
  inventorySignature(await readVerifiedInventory(dir));
async function fixture(multiple = false) {
  const vault = new InMemoryFileSystemAdapter("Vault"),
    main = new InMemoryFileSystemAdapter("Main"),
    parent = new InMemoryFileSystemAdapter("Cases");
  for (const path of [
    part,
    "Other/Part-X.SLDPRT",
    "DeleteMe.txt",
    "Assembly.SLDASM",
    "Stable.txt",
  ])
    await main.writeFileText(path.split("/"), `base ${path}`);
  await main.getDirectory(["Empty retained"], { create: true });
  await initializeProjectVault(main, vault, "Apply test");
  const folders: Record<string, FileSystemDirectoryAdapter> = {
    "branch-main": main,
  };
  const save = (
    dir: FileSystemDirectoryAdapter,
    branchId: string,
    summary: string,
    extra: Partial<CaptureRevisionInput> = {},
  ) =>
    captureRevision(dir, vault, {
      branchId,
      summary,
      notes,
      workingFolders: folders,
      ...extra,
    });
  const base = await save(main, "branch-main", "Base five");
  const created = await createDesignBranch({
    vaultDir: vault,
    destinationParent: parent,
    workingFolders: folders,
    sourceRevisionId: base.revision.manifest.revisionId,
    name: "Part-X case",
    reason: "Redesign",
  });
  const source = created.workingDir;
  folders[created.branch.branchId] = source;
  await source.writeFileText(part.split("/"), "source Part-X redesigned");
  if (multiple) {
    await source.removeEntry(["DeleteMe.txt"]);
    await source.writeFileText(["Added.txt"], "source addition");
  }
  const sourceSave = await save(
    source,
    created.branch.branchId,
    "Source changes",
  );
  for (let i = 0; i < 15; i++)
    await main.writeFileText(["MainOnly", `${i}.txt`], `main ${i}`);
  await main.writeFileText(
    ["Other", "Part-X.SLDPRT"],
    "newer destination neighbour",
  );
  const destination = await save(
    main,
    "branch-main",
    "Twenty-file destination",
  );
  const options = { workingFolders: folders };
  const review = async (
    choices?: Record<string, PreviewChoice>,
  ): Promise<ApplicationReview> => {
    const state = await openExistingVault(vault);
    const prepared = prepareApplyPreview(
      state,
      sourceSave.revision.manifest.revisionId,
      "branch-main",
    );
    if (prepared.status !== "available") throw new Error(prepared.reason);
    const selection =
      choices ??
      Object.fromEntries(
        prepared.context.rows
          .filter((r) => r.kind === "available" || r.kind === "conflict")
          .map((r) => [
            r.path,
            { selected: true, decision: "use-source" as const },
          ]),
      );
    return applicationReview(
      buildApplyPreview(prepared.context, selection, "Reuse reviewed Part-X"),
      selection,
    );
  };
  const prepare = async () =>
    prepareApplication(vault, await review(), options);
  const apply = async () =>
    applyPreparedApplication(vault, await prepare(), options);
  const op = async () =>
    branchApplications(await openExistingVault(vault), "branch-main").at(-1)!;
  return {
    vault,
    main,
    source,
    folders,
    options,
    base,
    sourceSave,
    destination,
    review,
    prepare,
    apply,
    op,
    save,
  };
}

test("5-to-20 apply retains unrelated destination paths, empty directories and source working bytes; reload/edit/capture records exact provenance once", async () => {
  const f = await fixture();
  const sourceBefore = await inventory(f.source);
  const op = await f.apply();
  assert.equal(op.status, "applied");
  assert.equal("resultFiles" in op.record!.plan, false);
  const current = await readVerifiedInventory(f.main);
  assert.equal(current.files.length, 20);
  assert.equal(
    await f.main.readFileText(part.split("/")),
    "source Part-X redesigned",
  );
  assert.equal(
    await f.main.readFileText(["Other", "Part-X.SLDPRT"]),
    "newer destination neighbour",
  );
  assert.equal(await inventory(f.source), sourceBefore);
  assert.ok(current.directories.includes("Empty retained"));
  assert.equal((await f.op()).status, "applied");
  await assert.rejects(f.apply(), /unfinished application/);
  await f.main.writeFileText(
    part.split("/"),
    "CAD-like adjusted Part-X after reference checks",
  );
  const state = await openExistingVault(f.vault);
  const scan = await scanBranchChanges(
    f.main,
    "branch-main",
    state.revisions.find(
      (r) =>
        r.manifest.revisionId === f.destination.revision.manifest.revisionId,
    )!.manifest,
  );
  const result = await f.save(
    f.main,
    "branch-main",
    "Reuse case with CAD adjustments",
    {
      reviewedChangesSignature: scan.changesSignature,
      fileNotes: [{ path: part, ...notes }],
    },
  );
  assert.equal(
    result.revision.manifest.parentRevisionId,
    f.destination.revision.manifest.revisionId,
  );
  assert.equal(result.revision.manifest.displayNumber, 4);
  assert.equal(result.revision.manifest.files.length, 20);
  assert.deepEqual(result.revision.manifest.notes, notes);
  assert.deepEqual(result.revision.manifest.fileNotes, [
    { path: part, ...notes },
  ]);
  const linked = await f.op();
  assert.equal(linked.status, "captured");
  assert.equal(linked.capturedRevisionId, result.revision.manifest.revisionId);
  const capture = linked.events.find((e) => e.kind === "capture")!;
  assert.notEqual(
    capture.finalFiles![0].file!.sha256,
    linked.record!.plan.actions[0].after!.sha256,
  );
  const retried = await f.save(
    f.main,
    "branch-main",
    "Reuse case with CAD adjustments",
    { reviewedChangesSignature: scan.changesSignature },
  );
  assert.equal(
    retried.revision.manifest.revisionId,
    result.revision.manifest.revisionId,
  );
  assert.equal((await openExistingVault(f.vault)).revisions.length, 4);
  assert.equal(
    (await f.op()).events.filter((e) => e.kind === "capture").length,
    1,
  );
  const copied = new InMemoryFileSystemAdapter("Copied vault");
  await copyVerifiedTree(f.vault, copied);
  assert.deepEqual(
    (await openExistingVault(copied)).applicationOperations,
    (await openExistingVault(f.vault)).applicationOperations,
  );
});
test("dirty files or empty directories and stale baselines/reviews block preparation or writes", async () => {
  for (const mode of [
    "file",
    "directory",
    "baseline",
    "plan",
    "connection",
  ] as const) {
    const f = await fixture();
    const prepared = await f.prepare();
    if (mode === "file")
      await f.main.writeFileText(["Uncaptured.txt"], "keep this");
    if (mode === "directory")
      await f.main.getDirectory(["Uncaptured empty"], { create: true });
    if (mode === "baseline") {
      await f.main.writeFileText(["New.txt"], "saved change");
      await f.save(f.main, "branch-main", "New baseline");
    }
    if (mode === "plan") prepared.review.reason = "not the confirmed reason";
    if (mode === "connection")
      prepared.connection = new InMemoryFileSystemAdapter("wrong folder");
    const before = await inventory(f.main);
    await assert.rejects(
      applyPreparedApplication(f.vault, prepared, f.options),
      /uncaptured|changed|review/i,
    );
    if (mode === "file" || mode === "directory")
      await assert.rejects(f.prepare(), /Save a revision first/);
    assert.equal(await inventory(f.main), before);
    assert.equal(
      (await openExistingVault(f.vault)).applicationOperations!.length,
      0,
    );
  }
});
test("additions, replacements and explicit deletions are applied without touching unrelated files", async () => {
  const f = await fixture(true);
  await f.apply();
  assert.equal(await f.main.readFileText(["Added.txt"]), "source addition");
  assert.equal(await f.main.hasFile(["DeleteMe.txt"]), false);
  assert.equal((await readVerifiedInventory(f.main)).files.length, 20);
  assert.deepEqual(
    changedActions((await f.op()).record!).map((a) => a.operation),
    ["add", "delete", "replace"],
  );
});
test("bad source objects and staging failures leave no working writes and a recoverable unfinished record", async () => {
  for (const mode of ["object", "staging", "permission"] as const) {
    const f = await fixture();
    const prepared = await f.prepare();
    const before = await inventory(f.main);
    if (mode === "object")
      await f.vault.writeFileText(
        getObjectPathSegments(prepared.plan.actions[0].after!.sha256),
        "bad object",
      );
    if (mode === "staging")
      f.vault.setHooks({
        onBeforeWrite: (path) => {
          if (path.includes("/source/")) throw new Error("staging failure");
        },
      });
    if (mode === "permission") f.main.setHooks({ writePermission: "denied" });
    await assert.rejects(
      applyPreparedApplication(f.vault, prepared, f.options),
      /object|staging|permission/i,
    );
    f.vault.setHooks({ onBeforeWrite: undefined });
    f.main.setHooks({ writePermission: "granted" });
    assert.equal(await inventory(f.main), before);
    const op = await f.op();
    if (mode === "permission") assert.equal(op, undefined);
    else {
      assert.equal(op.status, "unresolved");
      assert.ok(
        applicationCaptureBlock(
          await openExistingVault(f.vault),
          "branch-main",
        ),
      );
      await recoverApplication(
        f.vault,
        op.record!.plan.projectId,
        "branch-main",
        op.operationId,
        f.options,
      );
      assert.equal((await f.op()).status, "recovered");
    }
  }
});
test("interruption before writes, between operations, and before final acknowledgement never reports partial success; retry cannot duplicate", async () => {
  for (const phase of ["before", "between", "final"] as const) {
    const f = await fixture(true);
    const prepared = await f.prepare();
    const before = await inventory(f.main);
    let interrupted = false;
    f.vault.setHooks({
      onBeforeWrite: async (path) => {
        if (!path.includes("/events/") || interrupted) return;
        // Event 1 staged; 2 attempt, 3 written, 4 attempt... 8 applied.
        if (
          path.endsWith(
            phase === "before"
              ? "000002.json"
              : phase === "between"
                ? "000004.json"
                : "000008.json",
          )
        ) {
          interrupted = true;
          throw new Error(`injected ${phase}`);
        }
      },
    });
    await assert.rejects(
      applyPreparedApplication(f.vault, prepared, f.options),
      /injected/,
    );
    f.vault.setHooks({ onBeforeWrite: undefined });
    const op = await f.op();
    assert.equal(op.status, "unresolved");
    await assert.rejects(
      f.save(f.main, "branch-main", "Must block capture"),
      /unfinished/,
    );
    await assert.rejects(
      applyPreparedApplication(f.vault, prepared, f.options),
      /unfinished/,
    );
    const recovery = await recoverApplication(
      f.vault,
      op.record!.plan.projectId,
      "branch-main",
      op.operationId,
      f.options,
    );
    assert.deepEqual(recovery.manualPaths, []);
    assert.equal((await f.op()).status, "recovered");
    assert.equal(await inventory(f.main), before);
    assert.equal(
      (await openExistingVault(f.vault)).applicationOperations!.length,
      1,
    );
  }
});
test("recovery preserves and copies unexpected later bytes; manual restore permits verified completion", async () => {
  const f = await fixture();
  const prepared = await f.prepare();
  f.vault.setHooks({
    onBeforeWrite: (path) => {
      if (path.includes("/events/") && path.endsWith("000004.json"))
        throw new Error("lost final publication");
    },
  });
  await assert.rejects(
    applyPreparedApplication(f.vault, prepared, f.options),
    /lost final/,
  );
  f.vault.setHooks({ onBeforeWrite: undefined });
  await f.main.writeFileText(part.split("/"), "unexpected later CAD edit");
  const op = await f.op();
  const recovered = await recoverApplication(
    f.vault,
    op.record!.plan.projectId,
    "branch-main",
    op.operationId,
    f.options,
  );
  assert.deepEqual(recovered.manualPaths, [part]);
  assert.equal(
    await f.main.readFileText(part.split("/")),
    "unexpected later CAD edit",
  );
  assert.equal((await f.op()).status, "unresolved");
  const evidence = await readVerifiedInventory(
    await f.vault.getDirectory(op.relativePath.split("/")),
  );
  assert.ok(evidence.files.some((e) => e.path.startsWith("unexpected/")));
  await f.main.writeFileText(part.split("/"), `base ${part}`);
  await recoverApplication(
    f.vault,
    op.record!.plan.projectId,
    "branch-main",
    op.operationId,
    f.options,
  );
  assert.equal((await f.op()).status, "recovered");
});
test("cancellation retains evidence, permissions can be restored, and explicit abandonment leaves successful edits intact", async () => {
  const f = await fixture(true);
  const prepared = await f.prepare();
  const abort = new AbortController();
  await assert.rejects(
    applyPreparedApplication(f.vault, prepared, {
      ...f.options,
      signal: abort.signal,
      onProgress: (p) => {
        if (p.phase === "restoring_files" && p.processedFiles === 1)
          abort.abort();
      },
    }),
    /cancel/i,
  );
  const op = await f.op();
  assert.equal(op.status, "unresolved");
  await recoverApplication(
    f.vault,
    op.record!.plan.projectId,
    "branch-main",
    op.operationId,
    f.options,
  );
  const next = await f.apply();
  const before = await inventory(f.main);
  await abandonApplication(
    f.vault,
    next.record!.plan.projectId,
    "branch-main",
    next.operationId,
  );
  const state = await openExistingVault(f.vault);
  assert.ok(
    state.applicationOperations!.some(
      (o) => o.operationId === next.operationId && o.status === "abandoned",
    ),
  );
  assert.equal(await inventory(f.main), before);
  const captured = await f.save(
    f.main,
    "branch-main",
    "Independent normal revision after abandonment",
  );
  assert.ok(
    !captured.vaultState.applicationOperations!.some(
      (o) => o.capturedRevisionId === captured.revision.manifest.revisionId,
    ),
  );
});
test("capture failure retains provenance; failure after completion publication reconciles exactly once", async () => {
  for (const phase of ["before", "after"] as const) {
    const f = await fixture();
    await f.apply();
    const baseline = f.destination.revision.manifest;
    const scan = await scanBranchChanges(f.main, "branch-main", baseline);
    f.vault.setHooks(
      phase === "before"
        ? {
            onBeforeWrite: (path) => {
              if (path.includes("/completed/"))
                throw new Error("capture interrupted");
            },
          }
        : {
            onAfterWrite: (path) => {
              if (path.includes("/completed/"))
                throw new Error("completion acknowledgement lost");
            },
          },
    );
    await assert.rejects(
      f.save(f.main, "branch-main", "Applied Part-X", {
        reviewedChangesSignature: scan.changesSignature,
      }),
      /interrupted|lost/,
    );
    f.vault.setHooks({ onBeforeWrite: undefined, onAfterWrite: undefined });
    assert.equal(
      (await f.op()).status,
      phase === "before" ? "applied" : "captured",
    );
    const captured = await f.save(f.main, "branch-main", "Applied Part-X", {
      reviewedChangesSignature: scan.changesSignature,
    });
    assert.equal(
      (await f.op()).capturedRevisionId,
      captured.revision.manifest.revisionId,
    );
    assert.equal((await openExistingVault(f.vault)).revisions.length, 4);
    const retry = await f.save(f.main, "branch-main", "Applied Part-X", {
      reviewedChangesSignature: scan.changesSignature,
    });
    assert.equal(
      retry.revision.manifest.revisionId,
      captured.revision.manifest.revisionId,
    );
  }
});
test("malformed application records block writes only for the affected branch and retain evidence", async () => {
  const f = await fixture();
  const op = await f.apply();
  await f.vault.writeFileText(
    [...op.relativePath.split("/"), "events", "000005.json"],
    "partial JSON",
  );
  const state = await openExistingVault(f.vault);
  assert.equal(
    branchApplications(state, "branch-main")[0].status,
    "unavailable",
  );
  assert.ok(applicationCaptureBlock(state, "branch-main"));
  assert.equal(
    applicationCaptureBlock(state, f.sourceSave.revision.manifest.branchId),
    undefined,
  );
  await assert.rejects(
    f.save(f.main, "branch-main", "Must not capture"),
    /unfinished|unavailable/,
  );
  await assert.rejects(
    abandonApplication(
      f.vault,
      state.project.projectId,
      "branch-main",
      op.operationId,
    ),
    /successful/,
  );
});
test("resolved conflicts use only explicit source decisions and ignore arbitrary UI result inventories", async () => {
  const f = await fixture(true);
  await f.main.writeFileText(part.split("/"), "independent main Part-X");
  await f.main.writeFileText(["Added.txt"], "independently added on Main");
  await f.main.writeFileText(
    ["DeleteMe.txt"],
    "Main modified the source-deleted file",
  );
  await f.save(f.main, "branch-main", "Independent destination changes");
  const review = await f.review();
  review.choices[part] = { selected: true, decision: "unresolved" };
  await assert.rejects(
    prepareApplication(f.vault, review, f.options),
    /Resolve every selected conflict/,
  );
  const selection = {
    ...review.choices,
    [part]: { selected: true, decision: "keep-destination" as const },
  };
  const request = await f.review(selection);
  const prepared = await prepareApplication(f.vault, request, f.options);
  prepared.plan.resultFiles = []; // The executor must recompute, not execute UI data.
  await applyPreparedApplication(f.vault, prepared, f.options);
  assert.equal(
    await f.main.readFileText(part.split("/")),
    "independent main Part-X",
  );
  assert.equal(await f.main.readFileText(["Added.txt"]), "source addition");
  assert.equal(await f.main.hasFile(["DeleteMe.txt"]), false);
  assert.equal(
    (await f.op()).record!.plan.actions.find((a) => a.path === part)!.decision,
    "keep-destination",
  );
});
test("lost permission or a working-write acknowledgement leaves recoverable state and preserves unrelated bytes", async () => {
  for (const mode of ["permission", "acknowledgement"] as const) {
    const f = await fixture(true);
    const before = await inventory(f.main);
    const prepared = await f.prepare();
    if (mode === "permission")
      f.main.setHooks({
        onAfterWrite: () => {
          f.main.setHooks({
            readPermission: "denied",
            writePermission: "denied",
          });
        },
      });
    else
      f.main.setHooks({
        onAfterWrite: () => {
          throw new Error("working write acknowledgement lost");
        },
      });
    await assert.rejects(
      applyPreparedApplication(f.vault, prepared, f.options),
      /Permission|acknowledgement/,
    );
    f.main.setHooks({
      readPermission: "granted",
      writePermission: "granted",
      onAfterWrite: undefined,
    });
    const op = await f.op();
    assert.equal(op.status, "unresolved");
    await recoverApplication(
      f.vault,
      op.record!.plan.projectId,
      "branch-main",
      op.operationId,
      f.options,
    );
    assert.equal(await inventory(f.main), before);
    assert.equal((await f.op()).status, "recovered");
  }
});
test("managed adoption and workspace-to-home migration preserve pending disk provenance and before-state copies", async () => {
  const f = await fixture();
  const op = await f.apply();
  const workspace = new InMemoryFileSystemAdapter("Workspace copy");
  await createWorkspace(workspace);
  const adopted = await adoptProject(workspace, f.vault, f.folders);
  const adoptedOp = adopted.vaultState.applicationOperations!.find(
    (o) => o.operationId === op.operationId,
  )!;
  assert.equal(adoptedOp.status, "applied");
  assert.deepEqual(adoptedOp.record, op.record);
  assert.equal(
    await inventory(
      await adopted.vaultDir.getDirectory(op.relativePath.split("/")),
    ),
    await inventory(await f.vault.getDirectory(op.relativePath.split("/"))),
  );
  const home = new InMemoryFileSystemAdapter("Cadtree home");
  await createHome(home);
  const migrated = await bringWorkspaceIntoHome(home, workspace);
  const project = (await openWorkspace(migrated.workspace.root)).projects[0]
    .project!;
  assert.equal(project.vaultState.applicationOperations![0].status, "applied");
  assert.deepEqual(
    project.vaultState.applicationOperations![0].record,
    op.record,
  );
});
test("two confirmations of one prepared plan serialize to a single application", async () => {
  const f = await fixture();
  const prepared = await f.prepare();
  const results = await Promise.allSettled([
    applyPreparedApplication(f.vault, prepared, f.options),
    applyPreparedApplication(f.vault, prepared, f.options),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    (await openExistingVault(f.vault)).applicationOperations!.length,
    1,
  );
  assert.equal((await f.op()).status, "applied");
});
test("explicit preparation can renew a read-only folder permission; denied renewal never creates an operation", async () => {
  const f = await fixture();
  const prepared = await f.prepare();
  f.main.setHooks({ writePermission: "prompt" });
  await assert.rejects(
    applyPreparedApplication(f.vault, prepared, f.options),
    /permission/i,
  );
  await assert.rejects(
    requestApplicationWriteAccess(f.vault, f.main),
    /access.*required/,
  );
  let requests = 0;
  f.main.requestPermission = async (mode) => {
    assert.equal(mode, "readwrite");
    requests++;
    f.main.setHooks({ writePermission: "granted" });
    return "granted";
  };
  await requestApplicationWriteAccess(f.vault, f.main);
  await requestApplicationWriteAccess(f.vault, f.main);
  assert.equal(requests, 1);
  assert.equal(
    (await openExistingVault(f.vault)).applicationOperations!.length,
    0,
  );
});
