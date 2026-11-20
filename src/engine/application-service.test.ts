import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryFileSystemAdapter,
  type FileSystemDirectoryAdapter,
} from "./fs-adapter";
import { computeManifestPayloadChecksum, initializeProjectVault, openExistingVault } from "./vault-service";
import { hashString } from "./hash";
import { restoreRevisionToFolder } from "./recovery-service";
import { captureRevision } from "./revision-service";
import { createDesignBranch } from "./branch-service";
import {
  prepareApplyPreview,
  buildApplyPreview,
  type PreviewChoice,
} from "./apply-preview";
import {
  applicationReview,
  recoverApplication,
  abandonApplication,
  requestApplicationWriteAccess,
  createEventFolder,
} from "./application-service";
import { createIdentityReview } from "./component-identity";
import { applyReviewed } from "./fixtures";
import { getBranchBaseline } from "./branch-state";
import { eventIdCandidate, isEventId } from "./ids";
import { sealApplication, applicationStagedPath, applicationPlanPath, appendApplicationEvent } from "./application-records";
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
import { prepareReviewExport, exportRevisionForReview } from "./review-export";
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
  const apply = async () => applyReviewed(vault, await review(), options);
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
  await assert.rejects(f.apply(), /unfinished Copy: its files were written but not saved/);
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
test("dirty files or empty directories and stale baselines/reviews block writes", async () => {
  for (const mode of ["file", "directory", "baseline", "plan"] as const) {
    const f = await fixture();
    const reviewed = await f.review();
    if (mode === "file")
      await f.main.writeFileText(["Uncaptured.txt"], "keep this");
    if (mode === "directory")
      await f.main.getDirectory(["Uncaptured empty"], { create: true });
    if (mode === "baseline") {
      await f.main.writeFileText(["New.txt"], "saved change");
      await f.save(f.main, "branch-main", "New baseline");
    }
    if (mode === "plan") reviewed.reason = "not the confirmed reason";
    const before = await inventory(f.main);
    await assert.rejects(
      applyReviewed(f.vault, reviewed, f.options),
      /uncaptured|changed|review/i,
    );
    if (mode === "file" || mode === "directory")
      await assert.rejects(f.apply(), /Save a revision first/);
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
    const reviewed = await f.review();
    const before = await inventory(f.main);
    if (mode === "object")
      await f.vault.writeFileText(
        getObjectPathSegments(
          f.sourceSave.revision.manifest.files.find((x) => x.path === part)!
            .sha256,
        ),
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
      applyReviewed(f.vault, reviewed, f.options),
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
    const reviewed = await f.review();
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
      applyReviewed(f.vault, reviewed, f.options),
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
      applyReviewed(f.vault, reviewed, f.options),
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
  const reviewed = await f.review();
  f.vault.setHooks({
    onBeforeWrite: (path) => {
      if (path.includes("/events/") && path.endsWith("000004.json"))
        throw new Error("lost final publication");
    },
  });
  await assert.rejects(
    applyReviewed(f.vault, reviewed, f.options),
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
  const reviewed = await f.review();
  const abort = new AbortController();
  await assert.rejects(
    applyReviewed(f.vault, reviewed, {
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
    applyReviewed(f.vault, review, f.options),
    /Resolve every selected conflict/,
  );
  const selection = {
    ...review.choices,
    [part]: { selected: true, decision: "keep-destination" as const },
    // Independent additions at the same path are distinct components.
    'Added.txt': { selected: true, decision: 'keep-destination' as const },
  };
  const request = await f.review(selection);
  // The review carries only choices and a plan hash; the executor recomputes the plan.
  await applyReviewed(f.vault, request, f.options);
  assert.equal(
    await f.main.readFileText(part.split("/")),
    "independent main Part-X",
  );
  assert.equal(await f.main.readFileText(["Added.txt"]), "independently added on Main");
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
    const reviewed = await f.review();
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
      applyReviewed(f.vault, reviewed, f.options),
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
test("two confirmations of one reviewed plan serialize to a single application", async () => {
  const f = await fixture();
  const reviewed = await f.review();
  const results = await Promise.allSettled([
    applyReviewed(f.vault, reviewed, f.options),
    applyReviewed(f.vault, reviewed, f.options),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    (await openExistingVault(f.vault)).applicationOperations!.length,
    1,
  );
  assert.equal((await f.op()).status, "applied");
});
test("an explicit Confirm can renew a read-only folder permission; denied renewal never creates an operation", async () => {
  const f = await fixture();
  const reviewed = await f.review();
  f.main.setHooks({ writePermission: "prompt" });
  await assert.rejects(
    applyReviewed(f.vault, reviewed, f.options),
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

test("a revision that tracks .DS_Store still creates a case, applies and exports with the clutter file written and verified", async () => {
  const vault = new InMemoryFileSystemAdapter("Vault"),
    main = new InMemoryFileSystemAdapter("Main"),
    parent = new InMemoryFileSystemAdapter("Cases"),
    reviews = new InMemoryFileSystemAdapter("Reviews");
  const folders: Record<string, FileSystemDirectoryAdapter> = {
    "branch-main": main,
  };
  await main.writeFileText(["Part.SLDPRT"], "geometry");
  await initializeProjectVault(main, vault, "Clutter");
  const first = await captureRevision(main, vault, {
    branchId: "branch-main",
    summary: "Base",
    notes,
    workingFolders: folders,
  });
  // Model a pre-feature vault (no component or reference evidence).
  await vault.removeEntry(["components"], { recursive: true });
  if (await vault.hasFile(["reference-context.json"]))
    await vault.removeEntry(["reference-context.json"]);
  await vault.removeEntry(["references"], { recursive: true });
  const firstDonePath = [
    "completed",
    `${first.revision.manifest.revisionId}.done.json`,
  ];
  const firstDone = JSON.parse(await vault.readFileText(firstDonePath));
  delete firstDone.referenceContext;
  await vault.writeFileText(firstDonePath, JSON.stringify(firstDone, null, 2));
  // Forge a legacy revision that already tracks `.DS_Store` (untracked clutter is
  // otherwise skipped, so a current capture can never produce one).
  const clutterText = "legacy finder data";
  const clutterSha = hashString(clutterText);
  await vault.writeFileText(getObjectPathSegments(clutterSha), clutterText);
  const forged = {
    ...first.revision.manifest,
    revisionId: "legacy-clutter",
    displayNumber: 2,
    parentRevisionId: first.revision.manifest.revisionId,
    files: [
      ...first.revision.manifest.files,
      {
        path: ".DS_Store",
        size: clutterText.length,
        sha256: clutterSha,
        lastModified: 0,
      },
    ].sort((a, b) => a.path.localeCompare(b.path)),
  };
  forged.manifestPayloadSha256 = computeManifestPayloadChecksum(forged);
  const forgedText = JSON.stringify(forged);
  await vault.writeFileText(
    ["revisions", "legacy-clutter.manifest.json"],
    forgedText,
  );
  const legacyCompletion: Record<string, unknown> = {
    ...firstDone,
  };
  delete legacyCompletion.referenceContext;
  await vault.writeFileText(
    ["completed", "legacy-clutter.done.json"],
    JSON.stringify({
      ...legacyCompletion,
      revisionId: "legacy-clutter",
      displayNumber: 2,
      manifestSha256: hashString(forgedText),
    }),
  );
  const base = { revision: { manifest: forged } };
  // d. The tracked file is absent from main's working folder: reported as deleted.
  const mainScan = await scanBranchChanges(main, "branch-main", forged);
  assert.deepEqual(mainScan.deleted.map((f) => f.path), [".DS_Store"]);

  const created = await createDesignBranch({
    vaultDir: vault,
    destinationParent: parent,
    workingFolders: folders,
    sourceRevisionId: base.revision.manifest.revisionId,
    name: "Clutter case",
    reason: "Verify tracked clutter",
  });
  assert.equal(
    await created.workingDir.readFileText([".DS_Store"]),
    "legacy finder data",
  );
  folders[created.branch.branchId] = created.workingDir;
  await created.workingDir.writeFileText([".DS_Store"], "edited finder data");
  await created.workingDir.writeFileText(["Part.SLDPRT"], "case geometry");
  const caseScan = await scanBranchChanges(
    created.workingDir,
    created.branch.branchId,
    base.revision.manifest,
  );
  assert.deepEqual(caseScan.skippedSystemFiles, []);
  const sourceSave = await captureRevision(created.workingDir, vault, {
    branchId: created.branch.branchId,
    summary: "Case edits",
    notes,
    workingFolders: folders,
  });
  assert.ok(
    sourceSave.revision.manifest.files.some((f) => f.path === ".DS_Store"),
  );

  // Main deletes the tracked file, so applying the case must write it back.
  const mainSave = await captureRevision(main, vault, {
    branchId: "branch-main",
    summary: "Main drops clutter",
    notes,
    workingFolders: folders,
  });
  assert.ok(!mainSave.revision.manifest.files.some((f) => f.path === ".DS_Store"));
  const state = await openExistingVault(vault);
  const prepared = prepareApplyPreview(
    state,
    sourceSave.revision.manifest.revisionId,
    "branch-main",
  );
  if (prepared.status !== "available") throw new Error(prepared.reason);
  const selection = Object.fromEntries(
    prepared.context.rows
      .filter((r) => r.kind === "available" || r.kind === "conflict")
      .map((r) => [r.path, { selected: true, decision: "use-source" as const }]),
  );
  assert.ok(selection[".DS_Store"]);
  const options = { workingFolders: folders };
  const review = applicationReview(
    buildApplyPreview(prepared.context, selection, "Reuse case"),
    selection,
  );
  // An untracked on-disk .DS_Store at a planned path is surfaced before any write.
  await main.writeFileText([".DS_Store"], "untracked finder data");
  await assert.rejects(
    applyReviewed(vault, review, options),
    /untracked system file \.DS_Store.*remove it or save it first/,
  );
  assert.equal(await main.readFileText([".DS_Store"]), "untracked finder data");
  await main.removeEntry([".DS_Store"]);
  const op = await applyReviewed(vault, review, options);
  assert.equal(op.status, "applied");
  assert.equal(await main.readFileText([".DS_Store"]), "edited finder data");

  const plan = prepareReviewExport(
    await openExistingVault(vault),
    sourceSave.revision.manifest.revisionId,
    { kind: "complete", selectedPaths: [], labelFilenames: false },
  );
  const exported = await exportRevisionForReview({
    vaultDir: vault,
    parent: reviews,
    plan,
    folderName: plan.folderName,
    workingFolders: folders,
  });
  const out = await reviews.getDirectory([exported.folderName]);
  assert.equal(await out.readFileText([".DS_Store"]), "edited finder data");
});

test("recovery tolerates an existing root .DS_Store in an otherwise empty destination, writing the saved bytes over it", async () => {
  const vault = new InMemoryFileSystemAdapter("Vault"),
    main = new InMemoryFileSystemAdapter("Main"),
    root = new InMemoryFileSystemAdapter("Root");
  await main.writeFileText(["Part.SLDPRT"], "geometry");
  await initializeProjectVault(main, vault, "Recover clutter");
  const first = await captureRevision(main, vault, {
    branchId: "branch-main",
    summary: "Base",
    notes,
    workingFolders: { "branch-main": main },
  });
  await vault.removeEntry(["components"], { recursive: true });
  if (await vault.hasFile(["reference-context.json"]))
    await vault.removeEntry(["reference-context.json"]);
  await vault.removeEntry(["references"], { recursive: true });
  const donePath = ["completed", `${first.revision.manifest.revisionId}.done.json`];
  const done = JSON.parse(await vault.readFileText(donePath));
  delete done.referenceContext;
  await vault.writeFileText(donePath, JSON.stringify(done, null, 2));
  const text = "saved finder data";
  await vault.writeFileText(getObjectPathSegments(hashString(text)), text);
  const forged = {
    ...first.revision.manifest,
    revisionId: "legacy-clutter",
    displayNumber: 2,
    parentRevisionId: first.revision.manifest.revisionId,
    files: [
      ...first.revision.manifest.files,
      { path: ".DS_Store", size: text.length, sha256: hashString(text), lastModified: 0 },
      { path: "sub/.DS_Store", size: text.length, sha256: hashString(text), lastModified: 0 },
    ].sort((a, b) => a.path.localeCompare(b.path)),
    directories: ["sub"],
  };
  forged.manifestPayloadSha256 = computeManifestPayloadChecksum(forged);
  const forgedText = JSON.stringify(forged);
  await vault.writeFileText(["revisions", "legacy-clutter.manifest.json"], forgedText);
  await vault.writeFileText(
    ["completed", "legacy-clutter.done.json"],
    JSON.stringify({ ...done, revisionId: "legacy-clutter", displayNumber: 2, manifestSha256: hashString(forgedText) }),
  );
  const dest = await root.getDirectory(["dest"], { create: true });
  await dest.writeFileText([".DS_Store"], "finder junk");
  await restoreRevisionToFolder({
    vaultDir: vault,
    destinationDir: dest,
    workingDir: main,
    revisionId: "legacy-clutter",
  });
  assert.equal(await dest.readFileText([".DS_Store"]), text);
  assert.equal(await dest.readFileText(["sub", ".DS_Store"]), text);
  // Nested paths stay exclusive: a pre-existing nested clutter file is a conflict.
  const dest2 = await root.getDirectory(["dest2"], { create: true });
  await dest2.writeFileText(["sub", ".DS_Store"], "junk");
  await assert.rejects(
    restoreRevisionToFolder({ vaultDir: vault, destinationDir: dest2, workingDir: main, revisionId: "legacy-clutter" }),
    /not empty/,
  );
});

test("copyVerifiedTree overwrites only a root clutter file already listed in the destination", async () => {
  const src = new InMemoryFileSystemAdapter("Src"),
    dst = new InMemoryFileSystemAdapter("Dst");
  await src.writeFileText([".DS_Store"], "source finder");
  await src.writeFileText(["sub", ".DS_Store"], "nested finder");
  await src.writeFileText(["a.txt"], "a");
  await dst.writeFileText([".DS_Store"], "junk");
  await copyVerifiedTree(src, dst);
  assert.equal(await dst.readFileText([".DS_Store"]), "source finder");
  assert.equal(await dst.readFileText(["sub", ".DS_Store"]), "nested finder");
});

const FIXED = new Date(Date.UTC(2026, 10, 10, 12, 0, 0));
const BASE_ID = "20261110-120000";
const fixedNow = () => new Date(FIXED);
const interruptAtEvent = (f: Awaited<ReturnType<typeof fixture>>, file: string) =>
  f.vault.setHooks({
    onBeforeWrite: (path) => {
      if (path.includes("/events/") && path.endsWith(file))
        throw new Error("injected interruption");
    },
  });
const unexpectedDirs = async (f: Awaited<ReturnType<typeof fixture>>, rel: string) => {
  const dir = await f.vault.getDirectory(rel.split("/"));
  if (!(await dir.listEntries()).some((e) => e.name === "unexpected")) return [];
  return (await (await dir.getDirectory(["unexpected"])).listEntries()).map((e) => e.name);
};

test("a new apply is stored under a short event ID and completes with plan and events intact", async () => {
  const f = await fixture();
  const op = await f.apply();
  assert.equal(op.status, "applied");
  assert.ok(isEventId(op.operationId), op.operationId);
  assert.equal(op.relativePath, `applications/branch-main/${op.operationId}`);
  assert.equal(op.record!.operationId, op.operationId);
  const listed = await f.op();
  assert.equal(listed.operationId, op.operationId);
  assert.equal(listed.status, "applied");
  assert.deepEqual(listed.events.map((e) => e.kind).at(-1), "applied");
  assert.ok(listed.record!.plan.actions.length > 0);
});

test("two applies in the same second get the base ID and -2; recovery without unexpected bytes creates no unexpected folder", async () => {
  const f = await fixture();
  const options = { ...f.options, now: fixedNow };
  interruptAtEvent(f, "000002.json");
  await assert.rejects(
    applyReviewed(f.vault, await f.review(), options),
    /injected/,
  );
  f.vault.setHooks({ onBeforeWrite: undefined });
  const first = await f.op();
  assert.equal(first.operationId, BASE_ID);
  const recovered = await recoverApplication(f.vault, first.record!.plan.projectId, "branch-main", first.operationId, options);
  assert.deepEqual(recovered.manualPaths, []);
  assert.deepEqual(await unexpectedDirs(f, first.relativePath), []);
  const second = await applyReviewed(f.vault, await f.review(), options);
  assert.equal(second.operationId, `${BASE_ID}-2`);
  assert.equal(second.status, "applied");
  const ids = branchApplications(await openExistingVault(f.vault), "branch-main").map((o) => o.operationId).sort();
  assert.deepEqual(ids, [BASE_ID, `${BASE_ID}-2`]);
});

test("unexpected bytes are staged under unexpected/<eventId>; a second recovery in the same second gets -2", async () => {
  const f = await fixture();
  const options = { ...f.options, now: fixedNow };
  interruptAtEvent(f, "000004.json");
  await assert.rejects(
    applyReviewed(f.vault, await f.review(), options),
    /injected/,
  );
  f.vault.setHooks({ onBeforeWrite: undefined });
  await f.main.writeFileText(part.split("/"), "unexpected later CAD edit");
  const op = await f.op();
  const projectId = op.record!.plan.projectId;
  for (const expected of [[BASE_ID], [BASE_ID, `${BASE_ID}-2`]]) {
    const result = await recoverApplication(f.vault, projectId, "branch-main", op.operationId, options);
    assert.deepEqual(result.manualPaths, [part]);
    assert.deepEqual((await unexpectedDirs(f, op.relativePath)).sort(), expected);
  }
  const folder = await f.vault.getDirectory([...op.relativePath.split("/"), "unexpected", BASE_ID]);
  const entries = await folder.listEntries();
  assert.equal(entries.length, 1);
  assert.match(entries[0].name, /^\d{6}\.bin$/);
  assert.equal((await f.op()).status, "unresolved");
  assert.equal(await f.main.readFileText(part.split("/")), "unexpected later CAD edit");
});

test("old apply-<uuid> operations with recovery-<uuid> evidence still list, recover and report beside new event-ID operations", async () => {
  const f = await fixture();
  // A new-format interrupted operation provides a valid plan to re-seal under the old shape.
  interruptAtEvent(f, "000004.json");
  await assert.rejects(f.apply(), /injected/);
  f.vault.setHooks({ onBeforeWrite: undefined });
  const modern = await f.op();
  assert.ok(isEventId(modern.operationId));
  const legacyId = "apply-123e4567-e89b-42d3-a456-426614174000";
  const { checksum: _drop, ...body } = modern.record!;
  void _drop;
  const legacyRecord = sealApplication({ ...body, operationId: legacyId });
  const legacyPath = ["applications", "branch-main", legacyId];
  await f.vault.writeFileText([...legacyPath, "plan.json"], JSON.stringify(legacyRecord, null, 2), { exclusive: true });
  const oldEvidence = ["unexpected", "recovery-123e4567-e89b-42d3-a456-426614174001", "000001.bin"];
  await f.vault.writeFileText([...legacyPath, ...oldEvidence], "old evidence", { exclusive: true });
  await f.main.writeFileText(part.split("/"), "unexpected later CAD edit");

  const listed = branchApplications(await openExistingVault(f.vault), "branch-main");
  const legacy = listed.find((o) => o.operationId === legacyId)!;
  assert.equal(legacy.status, "unresolved");
  assert.equal(legacy.relativePath, `applications/branch-main/${legacyId}`);
  assert.equal(listed.find((o) => o.operationId === modern.operationId)!.status, "unresolved");
  assert.equal(listed.length, 2);

  const options = { ...f.options, now: fixedNow };
  const result = await recoverApplication(f.vault, modern.record!.plan.projectId, "branch-main", legacyId, options);
  assert.deepEqual(result.manualPaths, [part]);
  assert.deepEqual((await unexpectedDirs(f, legacy.relativePath)).sort(), [BASE_ID, "recovery-123e4567-e89b-42d3-a456-426614174001"].sort());
  const evidence = await readVerifiedInventory(await f.vault.getDirectory(legacyPath));
  assert.ok(evidence.files.some((e) => e.path === `unexpected/recovery-123e4567-e89b-42d3-a456-426614174001/000001.bin`));
  assert.equal(listed.find((o) => o.operationId === modern.operationId)!.status, "unresolved");
});

test("event folder allocation is conservative: clashes move on, other errors pass through, exhaustion writes nothing", async () => {
  const vault = new InMemoryFileSystemAdapter("Alloc");
  for (let attempt = 1; attempt <= 999; attempt++)
    await vault.getDirectory(["p", eventIdCandidate(BASE_ID, attempt)], { create: true });
  const before = (await (await vault.getDirectory(["p"])).listEntries()).length;
  await assert.rejects(
    createEventFolder(vault, fixedNow, (id) => ["p", id], "application"),
    /No free application ID/,
  );
  assert.equal((await (await vault.getDirectory(["p"])).listEntries()).length, before);
  const broken = {
    getDirectory: async () => {
      throw new Error("disk exploded");
    },
  } as unknown as FileSystemDirectoryAdapter;
  await assert.rejects(createEventFolder(broken, fixedNow, (id) => ["p", id], "application"), /disk exploded/);
  assert.equal(await createEventFolder(vault, fixedNow, (id) => ["q", id], "application"), BASE_ID);
});

// ---- Revert mode: bring an older revision back onto its own branch ----
async function revertFixture() {
  const vault = new InMemoryFileSystemAdapter("RVault"),
    main = new InMemoryFileSystemAdapter("RMain");
  const folders: Record<string, FileSystemDirectoryAdapter> = { "branch-main": main };
  const w = (p: string, t: string) => main.writeFileText(p.split("/"), t);
  await w("A.txt", "a1");
  await w("D.txt", "d1");
  await w("Keep.txt", "keep");
  await w("X.txt", "x1");
  await initializeProjectVault(main, vault, "Revert test");
  const save = (summary: string, extra: Partial<CaptureRevisionInput> = {}) =>
    captureRevision(main, vault, {
      branchId: "branch-main",
      summary,
      notes,
      workingFolders: folders,
      ...extra,
    });
  const r1 = await save("R1");
  await w("A.txt", "a2");
  await w("N.txt", "added later");
  const r2 = await save("R2");
  await main.removeEntry(["D.txt"]);
  await w("A.txt", "a3");
  const r3 = await save("R3");
  const ids = {
    r1: r1.revision.manifest.revisionId,
    r2: r2.revision.manifest.revisionId,
    r3: r3.revision.manifest.revisionId,
  };
  const options = { workingFolders: folders };
  const prepareRows = async (sourceId: string, mode?: "merge" | "revert") => {
    const state = await openExistingVault(vault);
    return prepareApplyPreview(state, sourceId, "branch-main", mode);
  };
  const review = async (
    sourceId: string,
    only?: string[],
  ): Promise<ApplicationReview> => {
    const prepared = await prepareRows(sourceId, "revert");
    if (prepared.status !== "available") throw new Error(prepared.reason);
    const selection = Object.fromEntries(
      prepared.context.rows
        .filter((r) => r.kind === "available" || r.kind === "conflict")
        .filter((r) => !only || only.includes(r.path))
        .map((r) => [r.path, { selected: true, decision: "use-source" as const }]),
    );
    return applicationReview(
      buildApplyPreview(prepared.context, selection, "Bring back R1"),
      selection,
    );
  };
  return { vault, main, folders, options, ids, save, w, prepareRows, review };
}
const rowMap = (p: Awaited<ReturnType<typeof prepareApplyPreview>>) => {
  if (p.status !== "available") throw new Error(p.reason);
  return Object.fromEntries(p.context.rows.map((r) => [r.path, r]));
};

test("revert preview: older revision gives replace/delete/add rows, all available; merge mode and the latest revision are rejected", async () => {
  const f = await revertFixture();
  const rows = rowMap(await f.prepareRows(f.ids.r1, "revert"));
  assert.equal(rows["A.txt"].kind, "available");
  assert.equal(rows["N.txt"].kind, "available");
  assert.equal(rows["D.txt"].kind, "available");
  assert.equal(rows["Keep.txt"].kind, "no-source-change");
  const plan = buildApplyPreview(
    (await f.prepareRows(f.ids.r1, "revert") as any).context,
    Object.fromEntries(
      ["A.txt", "N.txt", "D.txt"].map((p) => [p, { selected: true, decision: "use-source" as const }]),
    ),
    "Bring back R1",
  );
  assert.equal(plan.mode, "revert");
  assert.equal(plan.baseRevisionId, f.ids.r3);
  assert.deepEqual(
    plan.actions.map((a) => [a.path, a.operation]),
    [["A.txt", "replace"], ["D.txt", "add"], ["N.txt", "delete"]],
  );
  const merge = await f.prepareRows(f.ids.r1);
  assert.equal(merge.status, "unavailable");
  assert.match((merge as any).reason, /earlier revision in this branch.s history.*Bring back/);
  for (const mode of ["merge", "revert"] as const) {
    const latest = await f.prepareRows(f.ids.r3, mode);
    assert.equal(latest.status, "unavailable");
    assert.match((latest as any).reason, /already the latest saved revision/);
  }
});

test("revert is rejected for a revision that is not an ancestor (case revision)", async () => {
  const f = await revertFixture();
  const parent = new InMemoryFileSystemAdapter("RCases");
  const created = await createDesignBranch({
    vaultDir: f.vault,
    destinationParent: parent,
    workingFolders: f.folders,
    sourceRevisionId: f.ids.r1,
    name: "Side case",
    reason: "Alt",
  });
  const folders = { ...f.folders, [created.branch.branchId]: created.workingDir };
  await created.workingDir.writeFileText(["A.txt"], "case a");
  const saved = await captureRevision(created.workingDir, f.vault, {
    branchId: created.branch.branchId,
    summary: "Case change",
    notes,
    workingFolders: folders,
  });
  const caseId = saved.revision.manifest.revisionId;
  const revert = await f.prepareRows(caseId, "revert");
  assert.equal(revert.status, "unavailable");
  assert.match((revert as any).reason, /not an earlier revision in this branch.s history/);
  assert.equal((await f.prepareRows(caseId, "merge")).status, "available");
});

test("revert all: working folder equals R1, before/ evidence holds Main's previous bytes, nothing else changes", async () => {
  const f = await revertFixture();
  const state = await openExistingVault(f.vault);
  const r1 = state.revisions.find((r) => r.manifest.revisionId === f.ids.r1)!;
  const expected = new Map(r1.manifest.files.map((x) => [x.path, x.sha256]));
  const reviewed = await f.review(f.ids.r1);
  const op = await applyReviewed(f.vault, reviewed, f.options);
  assert.equal(op.status, "applied");
  assert.equal(op.record!.plan.mode, "revert");
  const inv = await readVerifiedInventory(f.main);
  assert.deepEqual(
    inv.files.map((x) => [x.path, x.sha256]).sort(),
    [...expected].sort(),
  );
  assert.equal(await f.main.readFileText(["A.txt"]), "a1");
  assert.equal(await f.main.readFileText(["D.txt"]), "d1");
  assert.equal(await f.main.hasFile(["N.txt"]), false);
  const before = await vaultBeforeTexts(f.vault, op);
  assert.deepEqual(before.sort(), ["a3", "added later"].sort());
  const stored = JSON.parse(
    await f.vault.readFileText(applicationPlanPath("branch-main", op.operationId)),
  );
  assert.equal(stored.plan.mode, "revert");
  assert.equal(stored.review.mode, "revert");
});
async function vaultBeforeTexts(
  vault: FileSystemDirectoryAdapter,
  op: { operationId: string; record?: { plan: { actions: unknown[] } } },
) {
  const out: string[] = [];
  for (let i = 0; i < op.record!.plan.actions.length; i++) {
    const path = applicationStagedPath("branch-main", op.operationId, "before", i);
    if (await vault.hasFile(path)) out.push(await vault.readFileText(path));
  }
  return out;
}

test("revert with only the deleted file selected brings back just that file", async () => {
  const f = await revertFixture();
  const reviewed = await f.review(f.ids.r1, ["D.txt"]);
  await applyReviewed(f.vault, reviewed, f.options);
  assert.equal(await f.main.readFileText(["D.txt"]), "d1");
  assert.equal(await f.main.readFileText(["A.txt"]), "a3");
  assert.equal(await f.main.readFileText(["N.txt"]), "added later");
});

test("revert is blocked by unsaved working changes, like apply", async () => {
  const f = await revertFixture();
  await f.w("A.txt", "unsaved edit");
  await assert.rejects(
    applyReviewed(f.vault, await f.review(f.ids.r1), f.options),
    /uncaptured/,
  );
  assert.equal(await f.main.readFileText(["A.txt"]), "unsaved edit");
});

test("tampered or missing mode: review/plan disagreement is rejected; records without mode read as merge", async () => {
  const f = await revertFixture();
  const review = await f.review(f.ids.r1);
  await assert.rejects(
    applyReviewed(f.vault, { ...review, mode: "merge" }, f.options),
    /earlier revision|changed|Bring back/,
  );
  const op = await applyReviewed(f.vault, review, f.options);
  const { checksum: _c, ...body } = op.record!;
  void _c;
  const plant = async (id: string, record: object) => {
    await f.vault.writeFileText(
      ["applications", "branch-main", id, "plan.json"],
      JSON.stringify(sealApplication({ ...record, operationId: id } as any), null, 2),
      { exclusive: true },
    );
    return branchApplications(await openExistingVault(f.vault), "branch-main").find(
      (o) => o.operationId === id,
    )!;
  };
  // review says merge, plan says revert: the record is not trusted.
  const bad = await plant("20990101-000001", {
    ...body,
    review: { ...body.review, mode: "merge" },
  });
  assert.equal(bad.record, undefined);
  // a revert plan whose base is not the destination baseline is rejected.
  const badBase = await plant("20990101-000004", {
    ...body,
    plan: { ...body.plan, baseRevisionId: body.plan.sourceRevisionId },
  });
  assert.equal(badBase.record, undefined);
  // plan says merge, review says revert: also rejected.
  const bad2 = await plant("20990101-000002", {
    ...body,
    plan: { ...body.plan, mode: "merge" },
  });
  assert.equal(bad2.record, undefined);
  // neither has a mode: an older record, read as merge.
  const { mode: _m1, ...reviewNoMode } = body.review;
  const { mode: _m2, ...planNoMode } = body.plan;
  void _m1;
  void _m2;
  const legacy = await plant("20990101-000003", {
    ...body,
    review: reviewNoMode,
    plan: planNoMode,
  });
  assert.ok(legacy.record);
  assert.equal(legacy.status, "unresolved");
  assert.equal((legacy.record!.review.mode ?? "merge"), "merge");
});

test("interrupted revert recovers through the existing recovery path", async () => {
  const f = await revertFixture();
  const reviewed = await f.review(f.ids.r1);
  const before = await inventory(f.main);
  let interrupted = false;
  f.vault.setHooks({
    onBeforeWrite: async (path) => {
      if (interrupted || !path.includes("/events/") || !path.endsWith("000004.json")) return;
      interrupted = true;
      throw new Error("injected revert");
    },
  });
  await assert.rejects(applyReviewed(f.vault, reviewed, f.options), /injected/);
  f.vault.setHooks({ onBeforeWrite: undefined });
  const state = await openExistingVault(f.vault);
  const op = branchApplications(state, "branch-main").at(-1)!;
  assert.equal(op.status, "unresolved");
  const recovery = await recoverApplication(f.vault, op.record!.plan.projectId, "branch-main", op.operationId, f.options);
  assert.deepEqual(recovery.manualPaths, []);
  assert.equal(await inventory(f.main), before);
});

test("confirmed rename since the revision blocks both rename rows with revert wording; other rows still apply", async () => {
  const f = await revertFixture();
  await f.main.removeEntry(["X.txt"]);
  await f.w("Y.txt", "x1");
  const state0 = await openExistingVault(f.vault);
  const scan = await scanBranchChanges(f.main, "branch-main", getBranchBaseline(state0, "branch-main"));
  const idReview = createIdentityReview(state0, scan, [{ from: "X.txt", to: "Y.txt" }], []);
  const r4 = await f.save("Rename X to Y", {
    identityReview: idReview,
    reviewedChangesSignature: scan.changesSignature,
  });
  void r4;
  const rows = rowMap(await f.prepareRows(f.ids.r1, "revert"));
  for (const p of ["X.txt", "Y.txt"]) {
    assert.match(rows[p].identityBlock ?? "", /renamed since that revision.*cannot undo renames/);
  }
  assert.equal(rows["A.txt"].identityBlock, undefined);
  const reviewed = await f.review(f.ids.r1, ["A.txt", "D.txt"]);
  await applyReviewed(f.vault, reviewed, f.options);
  assert.equal(await f.main.readFileText(["A.txt"]), "a1");
  assert.equal(await f.main.readFileText(["Y.txt"]), "x1");
});

test("bringing back a deleted file then saving keeps its original componentId and identity stays available", async () => {
  const f = await revertFixture();
  const stateBefore = await openExistingVault(f.vault);
  const idIn = (s: typeof stateBefore, rev: string, p: string) =>
    s.components?.revisions[rev]?.files.find((x) => x.path === p)?.componentId;
  const original = idIn(stateBefore, f.ids.r1, "D.txt");
  assert.ok(original);
  assert.equal(idIn(stateBefore, f.ids.r3, "D.txt"), undefined);
  const reviewed = await f.review(f.ids.r1, ["D.txt"]);
  await applyReviewed(f.vault, reviewed, f.options);
  const saved = await f.save("Bring back D");
  const after = await openExistingVault(f.vault);
  assert.equal(after.components?.status, "available");
  assert.equal(idIn(after, saved.revision.manifest.revisionId, "D.txt"), original);
  assert.equal((await openExistingVault(f.vault)).applicationOperations!.at(-1)!.status, "captured");
});

test("revert row stays blocked when a different component now occupies the path; other rows still apply", async () => {
  const f = await revertFixture();
  await f.w("D.txt", "a brand new D");
  await f.save("New D, new component");
  const rows = rowMap(await f.prepareRows(f.ids.r1, "revert"));
  assert.match(rows["D.txt"].identityBlock ?? "", /Different components occupy this path/);
  assert.equal(rows["A.txt"].identityBlock, undefined);
  assert.equal(rows["A.txt"].kind, "available");
  const reviewed = await f.review(f.ids.r1, ["A.txt"]);
  await applyReviewed(f.vault, reviewed, f.options);
  assert.equal(await f.main.readFileText(["A.txt"]), "a1");
  assert.equal(await f.main.readFileText(["D.txt"]), "a brand new D");
});

// ---- Folder changes in Apply (merge and Bring back) ----
async function folderFixture(
  setup: {
    r1: (main: FileSystemDirectoryAdapter) => Promise<void>;
    r2: (main: FileSystemDirectoryAdapter) => Promise<void>;
  },
) {
  const vault = new InMemoryFileSystemAdapter("FVault"),
    main = new InMemoryFileSystemAdapter("FMain");
  const folders: Record<string, FileSystemDirectoryAdapter> = { "branch-main": main };
  await setup.r1(main);
  await initializeProjectVault(main, vault, "Folder test");
  const save = (summary: string) =>
    captureRevision(main, vault, {
      branchId: "branch-main",
      summary,
      notes,
      workingFolders: folders,
    });
  const r1 = (await save("R1")).revision.manifest.revisionId;
  await setup.r2(main);
  const r2 = (await save("R2")).revision.manifest.revisionId;
  const options = { workingFolders: folders };
  const rows = async (sourceId = r1) => {
    const prepared = prepareApplyPreview(await openExistingVault(vault), sourceId, "branch-main", "revert");
    if (prepared.status !== "available") throw new Error(prepared.reason);
    return prepared.context;
  };
  const review = async (only?: string[], reason = "Bring back R1") => {
    const context = await rows();
    const selection = Object.fromEntries(
      context.rows
        .filter((r) => r.kind === "available" || r.kind === "conflict")
        .filter((r) => !only || only.includes(r.path))
        .map((r) => [r.path, { selected: true, decision: "use-source" as const }]),
    );
    const plan = buildApplyPreview(context, selection, reason);
    return { review: applicationReview(plan, selection), plan };
  };
  const apply = async (only?: string[]) =>
    applyReviewed(vault, (await review(only)).review, options);
  const lastOp = async () => branchApplications(await openExistingVault(vault), "branch-main").at(-1)!;
  return { vault, main, folders, options, ids: { r1, r2 }, rows, review, apply, lastOp, save };
}
const dirs = async (dir: FileSystemDirectoryAdapter) => (await readVerifiedInventory(dir)).directories.sort();
const mkdir = (dir: FileSystemDirectoryAdapter, path: string) =>
  dir.getDirectory(path.split("/"), { create: true });
const writeAt = (dir: FileSystemDirectoryAdapter, path: string, text: string) =>
  dir.writeFileText(path.split("/"), text);

test("Bring back recreates an empty folder that the older revision had", async () => {
  const f = await folderFixture({
    r1: async (m) => { await writeAt(m, "A.txt", "a1"); await mkdir(m, "Empty one"); },
    r2: async (m) => { await m.removeEntry(["Empty one"]); await writeAt(m, "A.txt", "a2"); },
  });
  const context = await f.rows();
  assert.deepEqual(
    context.rows.filter((r) => r.entry === "folder").map((r) => [r.path, r.sourceChange, r.kind]),
    [["Empty one", "added", "available"]],
  );
  const op = await f.apply();
  assert.equal(op.status, "applied");
  assert.deepEqual(op.record!.plan.folderActions, [
    { path: "Empty one", operation: "create", sourceChange: "added" },
  ]);
  assert.deepEqual(await dirs(f.main), ["Empty one"]);
  assert.equal(await f.main.readFileText(["A.txt"]), "a1");
  assert.equal((await f.lastOp()).status, "applied");
});

test("Bring back removes a folder the older revision lacked, after its files are deleted", async () => {
  const f = await folderFixture({
    r1: async (m) => { await writeAt(m, "A.txt", "a1"); },
    r2: async (m) => {
      await writeAt(m, "New/Sub/N.txt", "n");
      await writeAt(m, "New/M.txt", "m");
      await mkdir(m, "Empty new");
    },
  });
  const context = await f.rows();
  assert.deepEqual(
    context.rows.filter((r) => r.entry === "folder").map((r) => [r.path, r.kind]),
    [["Empty new", "available"], ["New", "available"], ["New/Sub", "available"]],
  );
  const op = await f.apply();
  assert.equal(op.status, "applied");
  assert.deepEqual(await dirs(f.main), []);
  assert.deepEqual(
    (await readVerifiedInventory(f.main)).files.map((x) => x.path),
    ["A.txt"],
  );
});

test("a folder-only difference can be brought back: the plan is ready with only a folder action", async () => {
  const f = await folderFixture({
    r1: async (m) => { await writeAt(m, "A.txt", "a1"); },
    r2: async (m) => { await mkdir(m, "Only folder"); },
  });
  const { plan } = await f.review();
  assert.equal(plan.ready, true, plan.blockers.join("|"));
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.folderActions.length, 1);
  const op = await f.apply();
  assert.equal(op.status, "applied");
  assert.deepEqual(await dirs(f.main), []);
  assert.equal(await f.main.readFileText(["A.txt"]), "a1");
});

test("merge applies a design case's added empty folder, added folder with a file, and removed folder", async () => {
  const vault = new InMemoryFileSystemAdapter("MVault"),
    main = new InMemoryFileSystemAdapter("MMain"),
    parent = new InMemoryFileSystemAdapter("MCases");
  await writeAt(main, "A.txt", "a1");
  await mkdir(main, "Del empty");
  await initializeProjectVault(main, vault, "Merge folders");
  const folders: Record<string, FileSystemDirectoryAdapter> = { "branch-main": main };
  const save = (dir: FileSystemDirectoryAdapter, branchId: string, summary: string) =>
    captureRevision(dir, vault, { branchId, summary, notes, workingFolders: folders });
  const r1 = await save(main, "branch-main", "R1");
  const created = await createDesignBranch({
    vaultDir: vault,
    destinationParent: parent,
    workingFolders: folders,
    sourceRevisionId: r1.revision.manifest.revisionId,
    name: "Folder case",
    reason: "Reorganise",
  });
  folders[created.branch.branchId] = created.workingDir;
  await created.workingDir.removeEntry(["Del empty"]);
  await mkdir(created.workingDir, "Case empty");
  await writeAt(created.workingDir, "CaseDir/c.txt", "case file");
  const caseSave = await save(created.workingDir, created.branch.branchId, "Case folders");
  await writeAt(main, "MainOnly.txt", "main change");
  await save(main, "branch-main", "Main moves on");
  const prepared = prepareApplyPreview(
    await openExistingVault(vault),
    caseSave.revision.manifest.revisionId,
    "branch-main",
  );
  if (prepared.status !== "available") throw new Error(prepared.reason);
  assert.deepEqual(
    prepared.context.rows.filter((r) => r.entry === "folder").map((r) => [r.path, r.sourceChange, r.kind]),
    [
      ["Case empty", "added", "available"],
      ["CaseDir", "added", "available"],
      ["Del empty", "deleted", "available"],
    ],
  );
  const selection = Object.fromEntries(
    prepared.context.rows
      .filter((r) => r.kind === "available")
      .map((r) => [r.path, { selected: true, decision: "use-source" as const }]),
  );
  const plan = buildApplyPreview(prepared.context, selection, "Reorganise folders");
  assert.equal(plan.ready, true, plan.blockers.join("|"));
  const options = { workingFolders: folders };
  const op = await applyReviewed(vault, applicationReview(plan, selection), options);
  assert.equal(op.status, "applied");
  assert.deepEqual(await dirs(main), ["Case empty", "CaseDir"]);
  assert.equal(await main.readFileText(["CaseDir", "c.txt"]), "case file");
  assert.equal(await main.readFileText(["MainOnly.txt"]), "main change");
});

test("removing a folder that would still hold files is blocked and nothing is removed", async () => {
  const f = await folderFixture({
    r1: async (m) => { await writeAt(m, "A.txt", "a1"); },
    r2: async (m) => { await writeAt(m, "New/N.txt", "n"); },
  });
  // The folder alone, without its file deletion, would leave a file behind.
  const { plan, review } = await f.review(["New"]);
  assert.equal(plan.ready, false);
  assert.ok(plan.blockers.includes("New: Kept: still holds files; untick it."));
  const before = await inventory(f.main);
  await assert.rejects(applyReviewed(f.vault, review, f.options), /still holds files/);
  assert.equal(await inventory(f.main), before);
  assert.equal(branchApplications(await openExistingVault(f.vault), "branch-main").length, 0);
});

test("a folder that gained a destination-side file is a kept row in a merge and cannot be removed", async () => {
  const vault = new InMemoryFileSystemAdapter("KVault"),
    main = new InMemoryFileSystemAdapter("KMain"),
    parent = new InMemoryFileSystemAdapter("KCases");
  await writeAt(main, "A.txt", "a1");
  await mkdir(main, "Shared");
  await initializeProjectVault(main, vault, "Kept folder");
  const folders: Record<string, FileSystemDirectoryAdapter> = { "branch-main": main };
  const save = (dir: FileSystemDirectoryAdapter, branchId: string, summary: string) =>
    captureRevision(dir, vault, { branchId, summary, notes, workingFolders: folders });
  const r1 = await save(main, "branch-main", "R1");
  const created = await createDesignBranch({
    vaultDir: vault,
    destinationParent: parent,
    workingFolders: folders,
    sourceRevisionId: r1.revision.manifest.revisionId,
    name: "Drop shared",
    reason: "Reorganise",
  });
  folders[created.branch.branchId] = created.workingDir;
  await created.workingDir.removeEntry(["Shared"]);
  const caseSave = await save(created.workingDir, created.branch.branchId, "Drop Shared");
  await writeAt(main, "Shared/Main.txt", "main work");
  await save(main, "branch-main", "Main uses Shared");
  const prepared = prepareApplyPreview(
    await openExistingVault(vault),
    caseSave.revision.manifest.revisionId,
    "branch-main",
  );
  if (prepared.status !== "available") throw new Error(prepared.reason);
  assert.deepEqual(
    prepared.context.rows.filter((r) => r.entry === "folder").map((r) => [r.path, r.kind]),
    [["Shared", "kept-holds-files"]],
  );
  const selection = { Shared: { selected: true, decision: "use-source" as const } };
  const plan = buildApplyPreview(prepared.context, selection, "Try");
  assert.equal(plan.ready, false);
  assert.ok(plan.blockers.includes("Shared: Kept: still holds files; untick it."));
  const before = await inventory(main);
  await assert.rejects(
    applyReviewed(vault, applicationReview(plan, selection), { workingFolders: folders }),
    /still holds files/,
  );
  assert.equal(await inventory(main), before);
});

test("a folder holding only an untracked Thumbs.db stops the apply before any write or attempt event", async () => {
  const f = await folderFixture({
    r1: async (m) => { await writeAt(m, "A.txt", "a1"); },
    r2: async (m) => { await writeAt(m, "New/N.txt", "n"); },
  });
  const expected = /Folder "New" holds only system files \(Thumbs\.db\)\. Delete them, or untick the folder, then try again\. No working files were changed\./;
  // Present when the apply starts: refused up front.
  await writeAt(f.main, "New/Thumbs.db", "clutter");
  const before = await inventory(f.main);
  await assert.rejects(applyReviewed(f.vault, (await f.review()).review, f.options), expected);
  assert.equal(await inventory(f.main), before);
  // Appears after the review: stopped before any operation, event or write.
  await f.main.removeEntry(["New", "Thumbs.db"]);
  const reviewed = (await f.review()).review;
  await writeAt(f.main, "New/Thumbs.db", "clutter");
  const later = await inventory(f.main);
  await assert.rejects(applyReviewed(f.vault, reviewed, f.options), expected);
  assert.equal(await inventory(f.main), later);
  assert.equal(await f.main.readFileText(["New", "N.txt"]), "n");
  const state = await openExistingVault(f.vault);
  assert.equal(branchApplications(state, "branch-main").length, 0);
  assert.equal((await f.vault.listEntries()).some((e) => e.name === "applications"), false);
  // The user's file was never touched.
  assert.equal(await f.main.readFileText(["New", "Thumbs.db"]), "clutter");
});

test("interrupted apply with folder changes recovers: created folders removed, removed folders recreated", async () => {
  for (const interruptAt of ["000003.json", "000007.json", "000008.json"]) {
    const f = await folderFixture({
      r1: async (m) => { await writeAt(m, "A.txt", "a1"); await mkdir(m, "Empty one"); },
      r2: async (m) => {
        await m.removeEntry(["Empty one"]);
        await writeAt(m, "A.txt", "a2");
        await mkdir(m, "Added empty");
      },
    });
    const { review: reviewed, plan } = await f.review();
    assert.deepEqual(
      plan.folderActions.map((a) => [a.path, a.operation]),
      [["Added empty", "remove"], ["Empty one", "create"]],
    );
    const before = await inventory(f.main);
    // Events: 1 staged, 2/3 create "Empty one", 4/5 A.txt, 6/7 remove "Added empty", 8 applied.
    let interrupted = false;
    f.vault.setHooks({
      onBeforeWrite: async (path) => {
        if (interrupted || !path.includes("/events/") || !path.endsWith(interruptAt)) return;
        interrupted = true;
        throw new Error("injected folder interruption");
      },
    });
    await assert.rejects(applyReviewed(f.vault, reviewed, f.options), /injected folder/);
    f.vault.setHooks({ onBeforeWrite: undefined });
    const op = await f.lastOp();
    assert.equal(op.status, "unresolved");
    if (interruptAt === "000003.json") assert.deepEqual(await dirs(f.main), ["Added empty", "Empty one"]);
    if (interruptAt !== "000003.json") assert.deepEqual(await dirs(f.main), ["Empty one"]);
    const recovery = await recoverApplication(f.vault, op.record!.plan.projectId, "branch-main", op.operationId, f.options);
    assert.deepEqual(recovery.manualPaths, []);
    assert.equal((await f.lastOp()).status, "recovered");
    assert.equal(await inventory(f.main), before, `after interruption at ${interruptAt}`);
    assert.deepEqual(await dirs(f.main), ["Added empty"]);
  }
});

test("recovering an apply that added a file under a new folder removes that folder; the next apply is not refused", async () => {
  const f = await folderFixture({
    r1: async (m) => { await writeAt(m, "A.txt", "a1"); await writeAt(m, "Dir/Sub/F.txt", "f"); },
    r2: async (m) => { await m.removeEntry(["Dir"], { recursive: true }); },
  });
  const only = ["Dir/Sub/F.txt"];
  const { review: reviewed, plan } = await f.review(only);
  assert.deepEqual(plan.folderActions, []);
  const before = await inventory(f.main);
  let interrupted = false;
  f.vault.setHooks({
    onBeforeWrite: async (path) => {
      // 1 staged, 2/3 attempt/written F.txt, 4 applied.
      if (interrupted || !path.includes("/events/") || !path.endsWith("000004.json")) return;
      interrupted = true;
      throw new Error("injected after file add");
    },
  });
  await assert.rejects(applyReviewed(f.vault, reviewed, f.options), /injected after/);
  f.vault.setHooks({ onBeforeWrite: undefined });
  assert.deepEqual(await dirs(f.main), ["Dir", "Dir/Sub"]);
  const op = await f.lastOp();
  const recovery = await recoverApplication(f.vault, op.record!.plan.projectId, "branch-main", op.operationId, f.options);
  assert.deepEqual(recovery.manualPaths, []);
  assert.deepEqual(await dirs(f.main), []);
  assert.equal(await inventory(f.main), before);
  // The next apply is not refused for "uncaptured ... directory changes".
  const again = await f.apply(only);
  assert.equal(again.status, "applied");
  assert.equal(await f.main.readFileText(["Dir", "Sub", "F.txt"]), "f");
});

test("recovery never deletes a non-empty folder its apply created; it is reported for manual inspection", async () => {
  const f = await folderFixture({
    r1: async (m) => { await writeAt(m, "A.txt", "a1"); await mkdir(m, "Empty one"); },
    r2: async (m) => { await m.removeEntry(["Empty one"]); },
  });
  const reviewed = (await f.review()).review;
  let interrupted = false;
  f.vault.setHooks({
    onBeforeWrite: async (path) => {
      if (interrupted || !path.includes("/events/") || !path.endsWith("000004.json")) return;
      interrupted = true;
      throw new Error("injected");
    },
  });
  await assert.rejects(applyReviewed(f.vault, reviewed, f.options), /injected/);
  f.vault.setHooks({ onBeforeWrite: undefined });
  await writeAt(f.main, "Empty one/Later.txt", "user work");
  const op = await f.lastOp();
  const recovery = await recoverApplication(f.vault, op.record!.plan.projectId, "branch-main", op.operationId, f.options);
  assert.deepEqual(recovery.manualPaths, ["Empty one"]);
  assert.equal(await f.main.readFileText(["Empty one", "Later.txt"]), "user work");
  assert.equal((await f.lastOp()).status, "unresolved");
});

test("sealed record: altered folderActions (extra, missing, wrong operation, file overlap) are rejected; the review hash covers them", async () => {
  const f = await folderFixture({
    r1: async (m) => { await writeAt(m, "A.txt", "a1"); await mkdir(m, "Empty one"); },
    r2: async (m) => { await m.removeEntry(["Empty one"]); await writeAt(m, "A.txt", "a2"); await mkdir(m, "Added empty"); },
  });
  const op = await f.apply();
  const { checksum: _c, ...body } = op.record!;
  void _c;
  const plant = async (id: string, record: object) => {
    await f.vault.writeFileText(
      ["applications", "branch-main", id, "plan.json"],
      JSON.stringify(sealApplication({ ...record, operationId: id } as any), null, 2),
      { exclusive: true },
    );
    return branchApplications(await openExistingVault(f.vault), "branch-main").find((o) => o.operationId === id)!;
  };
  const withFolders = (folderActions: unknown) => ({ ...body, plan: { ...body.plan, folderActions } });
  const good = body.plan.folderActions;
  assert.ok((await plant("20990101-000001", body)).record, "control: untouched record is valid");
  const extra = [...good, { path: "Extra", operation: "create", sourceChange: "added" }];
  const missing = good.slice(1);
  const wrongOp = good.map((a) => ({ ...a, operation: a.operation === "create" ? "remove" : "create" }));
  const wrongChange = good.map((a) => ({ ...a, sourceChange: a.sourceChange === "added" ? "deleted" : "added" }));
  const dup = [...good, good[0]];
  const overlap = [...good, { path: "A.txt", operation: "remove", sourceChange: "deleted" }];
  const bad: [string, unknown][] = [
    ["20990101-000002", extra],
    ["20990101-000003", missing],
    ["20990101-000004", wrongOp],
    ["20990101-000005", wrongChange],
    ["20990101-000006", dup],
    ["20990101-000007", overlap],
    ["20990101-000008", undefined],
  ];
  for (const [id, folderActions] of bad) {
    const planted = await plant(id, withFolders(folderActions));
    assert.equal(planted.record, undefined, `folderActions variant ${id} must be rejected`);
    assert.equal(planted.status, "unavailable");
  }
  // The review hash covers folderActions: dropping a folder choice no longer matches it.
  const f2 = await folderFixture({
    r1: async (m) => { await writeAt(m, "A.txt", "a1"); await mkdir(m, "Empty one"); },
    r2: async (m) => { await m.removeEntry(["Empty one"]); await writeAt(m, "A.txt", "a2"); },
  });
  const { review } = await f2.review();
  const choices = Object.fromEntries(Object.entries(review.choices).filter(([p]) => p !== "Empty one"));
  await assert.rejects(
    applyReviewed(f2.vault, { ...review, choices }, f2.options),
    /changed/,
  );
});

test("case-only folder renames are blocked at review and nothing is written", async () => {
  const scenarios: [string, (m: FileSystemDirectoryAdapter) => Promise<void>, (m: FileSystemDirectoryAdapter) => Promise<void>][] = [
    [
      "empty folder docs -> Docs",
      async (m) => { await writeAt(m, "A.txt", "a1"); await mkdir(m, "docs"); },
      async (m) => { await m.removeEntry(["docs"]); await mkdir(m, "Docs"); },
    ],
    [
      "files moved A/ -> a/",
      async (m) => { await writeAt(m, "A/x.txt", "x"); },
      async (m) => { await m.removeEntry(["A"], { recursive: true }); await writeAt(m, "a/x.txt", "x"); },
    ],
  ];
  for (const [name, r1, r2] of scenarios) {
    const f = await folderFixture({ r1, r2 });
    const { plan, review } = await f.review();
    assert.equal(plan.ready, false, name);
    assert.ok(plan.collisions.length > 0, name);
    assert.ok(plan.blockers.some((b) => /collisions/.test(b)), name);
    const before = await inventory(f.main);
    await assert.rejects(applyReviewed(f.vault, review, f.options), /collisions/, name);
    assert.equal(await inventory(f.main), before, name);
    assert.equal(branchApplications(await openExistingVault(f.vault), "branch-main").length, 0, name);
  }
});

test("a recovery-attempt event is accepted for parents of add/create actions only, not of a delete action", async () => {
  const f = await folderFixture({
    r1: async (m) => { await writeAt(m, "A.txt", "a1"); },
    r2: async (m) => { await writeAt(m, "New/N.txt", "n"); },
  });
  const op = await f.apply(["New/N.txt"]);
  assert.deepEqual(op.record!.plan.actions.map((a) => a.operation), ["delete"]);
  await appendApplicationEvent(f.vault, op, { kind: "recovery-start" });
  await appendApplicationEvent(f.vault, op, { kind: "recovery-attempt", path: "New/N.txt" });
  assert.equal((await f.lastOp()).status, "unresolved");
  await appendApplicationEvent(f.vault, op, { kind: "recovery-attempt", path: "New" });
  const after = await f.lastOp();
  assert.equal(after.status, "unavailable");
  assert.match(after.error ?? "", /unknown action/);
});
