import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryFileSystemAdapter,
  type FileSystemDirectoryAdapter,
} from "./fs-adapter";
import { createDesignBranch, BranchCreationError } from "./branch-service";
import {
  getBranchBaseline,
  validateWorkingFolderBindings,
  type WorkingFolderBindings,
} from "./branch-state";
import {
  initializeProjectVault,
  openExistingVault,
  computeBranchRecordChecksum,
  computeManifestPayloadChecksum,
} from "./vault-service";
import { captureRevision } from "./revision-service";
import { enumerateWorkingFolder, scanBranchChanges } from "./scanner";
import {
  restoreRevisionToFolder,
  restoreSelectedFilesToFolder,
} from "./recovery-service";
import { getObjectPathSegments } from "./object-store";
import { hashString } from "./hash";
import { layoutRevisions } from "../history/layout";
import { MAIN_BRANCH_ID, type BranchRecord } from "./types";

const notes = { problem: "", modification: "", observations: "" };
async function setup() {
  const main = new InMemoryFileSystemAdapter("Main working");
  const vault = new InMemoryFileSystemAdapter("Vault");
  const parent = new InMemoryFileSystemAdapter("Cases");
  await main.getDirectory(["Empty", "Nested"], { create: true });
  await main.writeFileBytes(
    ["Assembly.SLDASM"],
    new Uint8Array([0, 255, 128, 17]),
  );
  await main.writeFileBytes(
    ["Parts", "Housing.SLDPRT"],
    new Uint8Array([8, 0, 19, 255]),
  );
  await initializeProjectVault(main, vault, "Actuator");
  const first = (
    await captureRevision(main, vault, {
      branchId: MAIN_BRANCH_ID,
      summary: "Baseline",
      notes,
    })
  ).revision;
  const workingFolders: WorkingFolderBindings = { [MAIN_BRANCH_ID]: main };
  const create = (
    name = "Case A",
    sourceRevisionId = first.manifest.revisionId,
    extra: Partial<Parameters<typeof createDesignBranch>[0]> = {},
  ) =>
    createDesignBranch({
      vaultDir: vault,
      destinationParent: parent,
      workingFolders,
      name,
      reason: "Compare housing clearance",
      sourceRevisionId,
      ...extra,
    });
  return { main, vault, parent, first, workingFolders, create };
}
async function inventory(dir: FileSystemDirectoryAdapter) {
  const result = await enumerateWorkingFolder(dir);
  assert.deepEqual(result.errors, []);
  return {
    files: result.files.map((f) => [f.path, f.sha256, f.size]),
    directories: result.directories,
  };
}

async function establishedBranchWithDamagedMarker(
  mode: "missing" | "malformed",
) {
  const context = await setup();
  const created = await context.create();
  context.workingFolders[created.branch.branchId] = created.workingDir;
  await created.workingDir.writeFileBytes(
    ["Parts", "Housing.SLDPRT"],
    new Uint8Array([17, 0, 255]),
  );
  const saved = await captureRevision(created.workingDir, context.vault, {
    branchId: created.branch.branchId,
    summary: "Established alternative",
    notes,
    workingFolders: context.workingFolders,
  });
  const marker = ["branches", `${created.branch.branchId}.ready.json`];
  if (mode === "missing") await context.vault.removeEntry(marker);
  else await context.vault.writeFileText(marker, "{");
  return { ...context, created, saved, marker };
}

for (const mode of ["missing", "malformed"] as const) {
  test(`established branch with ${mode} ready marker remains a damaged identity with inspectable history`, async () => {
    const { vault, created, saved } =
      await establishedBranchWithDamagedMarker(mode);
    const before = await inventory(vault);
    const reopened = await openExistingVault(vault);
    assert.equal(
      reopened.branches.find(
        (branch) => branch.branchId === created.branch.branchId,
      )?.name,
      "Case A",
    );
    assert.match(
      reopened.damagedBranchHeads[created.branch.branchId],
      /ready marker/i,
    );
    assert.ok(
      reopened.corruptedRecords.some(
        (record) =>
          record.recordPath ===
          `branches/${created.branch.branchId}.ready.json`,
      ),
    );
    assert.ok(
      !reopened.incompleteAttempts.some(
        (attempt) =>
          attempt.kind === "uncompleted_branch" &&
          attempt.id === created.branch.branchId,
      ),
    );
    assert.equal(
      reopened.branchHeads[created.branch.branchId],
      saved.revision.manifest.revisionId,
    );
    const graph = layoutRevisions(reopened, created.branch.branchId);
    assert.equal(
      graph.nodes.find((node) => node.id === saved.revision.manifest.revisionId)
        ?.branchName,
      "Case A",
    );
    assert.equal(graph.latestId, null);
    assert.throws(
      () => getBranchBaseline(reopened, created.branch.branchId),
      /ready marker/i,
    );
    assert.deepEqual(
      await inventory(vault),
      before,
      "Reopening and inspection must never repair or rewrite records",
    );
  });

  test(`${mode} marker does not free an established branch name for reuse`, async () => {
    const { vault, create } = await establishedBranchWithDamagedMarker(mode);
    const before = await inventory(vault);
    await assert.rejects(create(" case a "), /already exists/);
    assert.deepEqual(await inventory(vault), before);
  });

  test(`${mode} marker cannot hide an established working folder from destination isolation checks`, async () => {
    const { main, vault, create, created, first, workingFolders } =
      await establishedBranchWithDamagedMarker(mode);
    const before = await inventory(created.workingDir);
    const vaultBefore = await inventory(vault);
    const reopened = await openExistingVault(vault);
    const mainOnly = { [MAIN_BRANCH_ID]: main };
    await assert.rejects(
      validateWorkingFolderBindings(reopened, vault, mainOnly),
      /Reconnect.*Case A/,
    );
    await assert.rejects(
      create("Nested unsafe alternative", first.manifest.revisionId, {
        destinationParent: created.workingDir,
        workingFolders: mainOnly,
      }),
    );
    await assert.rejects(
      captureRevision(main, vault, {
        branchId: MAIN_BRANCH_ID,
        summary: "Unverified isolation",
        notes,
      }),
      /Folder isolation cannot be established/,
    );
    await assert.rejects(
      captureRevision(main, vault, {
        branchId: MAIN_BRANCH_ID,
        summary: "Missing folder",
        notes,
        workingFolders: mainOnly,
      }),
      /Reconnect.*Case A/,
    );
    assert.deepEqual(await inventory(created.workingDir), before);
    const nested = await created.workingDir.getDirectory(
      ["Fresh nested destination"],
      { create: true },
    );
    for (const bindings of [undefined, mainOnly, workingFolders]) {
      await assert.rejects(
        restoreRevisionToFolder({
          vaultDir: vault,
          workingDir: main,
          workingFolders: bindings,
          revisionId: first.manifest.revisionId,
          destinationDir: nested,
        }),
        /Folder isolation|Reconnect.*Case A|nested inside/,
      );
      await assert.rejects(
        restoreSelectedFilesToFolder({
          vaultDir: vault,
          workingDir: main,
          workingFolders: bindings,
          revisionId: first.manifest.revisionId,
          destinationDir: nested,
          selectedPaths: [first.manifest.files[0].path],
        }),
        /Folder isolation|Reconnect.*Case A|nested inside/,
      );
      assert.deepEqual(await nested.listEntries(), []);
    }
    await assert.rejects(
      validateWorkingFolderBindings(reopened, vault, {
        ...workingFolders,
        [MAIN_BRANCH_ID]: nested,
      }),
      /nested inside/,
    );
    assert.deepEqual(
      await inventory(vault),
      vaultBefore,
      "Rejected writes must not repair history or publish new data",
    );
  });
}

test("ready marker field/checksum damage preserves an established identity independently of marker contents", async () => {
  for (const markerValue of [
    null,
    {},
    { projectId: "wrong", branchId: "wrong", recordSha256: "0".repeat(64) },
    "checksum-mismatch",
  ]) {
    const { vault, created, marker } =
      await establishedBranchWithDamagedMarker("malformed");
    await vault.writeFileText(
      marker,
      JSON.stringify(
        markerValue === "checksum-mismatch"
          ? {
              projectId: created.branch.projectId,
              branchId: created.branch.branchId,
              recordSha256: "0".repeat(64),
            }
          : markerValue,
      ),
    );
    const state = await openExistingVault(vault);
    assert.ok(
      state.branches.some(
        (branch) =>
          branch.branchId === created.branch.branchId &&
          branch.name === "Case A",
      ),
    );
    assert.match(
      state.damagedBranchHeads[created.branch.branchId],
      /ready marker/i,
    );
  }
});

test("committed branch identity with an unvalidated record blocks writes even if folder bindings omit it", async () => {
  for (const mode of ["missing", "malformed"] as const) {
    const { main, vault, created, first, create } =
      await establishedBranchWithDamagedMarker(mode);
    await vault.writeFileText(
      ["branches", `${created.branch.branchId}.branch.json`],
      "{",
    );
    const before = await inventory(vault);
    const reopened = await openExistingVault(vault);
    assert.ok(
      reopened.revisions.some(
        (revision) => revision.manifest.branchId === created.branch.branchId,
      ),
    );
    assert.ok(
      reopened.corruptedRecords.some((record) =>
        record.reason.includes("no validated branch record"),
      ),
    );
    assert.ok(layoutRevisions(reopened, MAIN_BRANCH_ID).nodes.length >= 2);
    await assert.rejects(create("Case A"));
    for (const bindings of [undefined, { [MAIN_BRANCH_ID]: main }]) {
      await assert.rejects(
        captureRevision(main, vault, {
          branchId: MAIN_BRANCH_ID,
          summary: "Unsafe",
          notes,
          workingFolders: bindings,
        }),
        /committed branch identities without valid records/,
      );
      await assert.rejects(
        restoreRevisionToFolder({
          vaultDir: vault,
          destinationDir: new InMemoryFileSystemAdapter("Unknown isolation"),
          revisionId: first.manifest.revisionId,
          workingFolders: bindings,
        }),
        /committed branch identities without valid records/,
      );
    }
    assert.deepEqual(await inventory(vault), before);
  }
});

test("Milestone 2: three complete independent cases share Rev 001, diverge, and continue with global numbering", async () => {
  const { main, vault, first, workingFolders, create } = await setup();
  const original = await inventory(main);
  for (const value of [22, 33]) {
    await main.writeFileBytes(
      ["Parts", "Housing.SLDPRT"],
      new Uint8Array([value, 0, 255]),
    );
    await captureRevision(main, vault, {
      branchId: MAIN_BRANCH_ID,
      summary: `Main ${value}`,
      notes,
    });
  }
  const mainInventory = await inventory(main);
  const mainState = await openExistingVault(vault);
  const mainHistory = JSON.stringify(mainState.revisions);
  const objectCount = async () =>
    JSON.stringify(
      (
        await enumerateWorkingFolder(await vault.getDirectory(["objects"]))
      ).files.map((f) => f.path),
    );
  const objectsBefore = await objectCount();
  const cases = [];
  for (const name of ["Case A", "Case B", "Case C"]) {
    const result = await create(name);
    workingFolders[result.branch.branchId] = result.workingDir;
    cases.push(result);
    assert.deepEqual(await inventory(result.workingDir), original);
    assert.equal(
      (
        await scanBranchChanges(
          result.workingDir,
          result.branch.branchId,
          first.manifest,
        )
      ).canCapture,
      false,
    );
    await assert.rejects(
      captureRevision(result.workingDir, vault, {
        branchId: result.branch.branchId,
        summary: "Unchanged copy",
        notes,
      }),
      /No changes detected/,
    );
    assert.equal(
      result.vaultState.branchHeads[result.branch.branchId],
      first.manifest.revisionId,
    );
    assert.equal(result.branch.startingRevisionId, first.manifest.revisionId);
  }
  const branched = await openExistingVault(vault);
  assert.equal(branched.revisions.length, 3);
  assert.equal(await objectCount(), objectsBefore);
  const baseline = layoutRevisions(
    branched,
    cases[0].branch.branchId,
  ).nodes.find((n) => n.id === first.manifest.revisionId)!;
  assert.deepEqual(baseline.heads.sort(), ["Case A", "Case B", "Case C"]);
  const graphBefore = layoutRevisions(branched, MAIN_BRANCH_ID);
  assert.equal(graphBefore.nodes.length, 3);
  assert.equal(graphBefore.edges.length, 2);
  for (const [index, result] of cases.entries()) {
    await result.workingDir.writeFileBytes(
      ["Parts", "Housing.SLDPRT"],
      new Uint8Array([70 + index, 0, 255]),
    );
    const state = await openExistingVault(vault);
    const scan = await scanBranchChanges(
      result.workingDir,
      result.branch.branchId,
      getBranchBaseline(state, result.branch.branchId),
    );
    assert.equal(scan.baselineRevisionId, first.manifest.revisionId);
    assert.equal(scan.modified.length, 1);
    assert.equal(scan.unchanged.length, 1);
    const saved = await captureRevision(result.workingDir, vault, {
      branchId: result.branch.branchId,
      summary: result.branch.name,
      notes,
      workingFolders,
      reviewedChangesSignature: scan.changesSignature,
    });
    assert.equal(
      saved.revision.manifest.parentRevisionId,
      first.manifest.revisionId,
    );
    assert.equal(saved.revision.manifest.displayNumber, 4 + index);
    assert.equal(saved.revision.manifest.branchId, result.branch.branchId);
    assert.equal(saved.revision.manifest.files.length, 2);
    assert.deepEqual(
      saved.revision.manifest.directories,
      first.manifest.directories,
    );
  }
  assert.deepEqual(await inventory(main), mainInventory);
  assert.equal(
    JSON.stringify(
      (await openExistingVault(vault)).revisions.filter(
        (r) => r.manifest.branchId === MAIN_BRANCH_ID,
      ),
    ),
    mainHistory,
  );
  const all = [
    { branch: { branchId: MAIN_BRANCH_ID }, workingDir: main },
    ...cases,
  ];
  const oldHeads = (await openExistingVault(vault)).branchHeads;
  for (const [index, result] of all.entries()) {
    await result.workingDir.writeFileBytes(
      ["Parts", "Housing.SLDPRT"],
      new Uint8Array([100 + index, 2, 255]),
    );
    const saved = await captureRevision(result.workingDir, vault, {
      branchId: result.branch.branchId,
      summary: `Continue ${index}`,
      notes,
      workingFolders,
    });
    assert.equal(
      saved.revision.manifest.parentRevisionId,
      oldHeads[result.branch.branchId],
    );
    assert.equal(saved.revision.manifest.displayNumber, 7 + index);
  }
  const reopened = await openExistingVault(vault); // No IDB was used at any point.
  assert.equal(reopened.branches.length, 4);
  assert.equal(
    new Set(reopened.revisions.map((r) => r.manifest.displayNumber)).size,
    10,
  );
  const fromAlternative = await create(
    "Case A refinement",
    reopened.branchHeads[cases[0].branch.branchId]!,
  );
  assert.equal(fromAlternative.vaultState.revisions.length, 10);
  assert.equal(
    getBranchBaseline(
      fromAlternative.vaultState,
      fromAlternative.branch.branchId,
    )!.branchId,
    cases[0].branch.branchId,
  );
  const recovered = new InMemoryFileSystemAdapter("Untracked recovery");
  await restoreRevisionToFolder({
    vaultDir: vault,
    destinationDir: recovered,
    revisionId: first.manifest.revisionId,
  });
  assert.equal((await openExistingVault(vault)).branches.length, 5);
  assert.deepEqual(await inventory(recovered), original);
});

test("name validation is case-insensitive, normalized, and rechecked under the project lock", async () => {
  const { create, vault } = await setup();
  await assert.rejects(create("  "), /name is required/);
  await assert.rejects(create("ｍａｉｎ"), /already exists/);
  const outcomes = await Promise.allSettled([
    create("Case A"),
    create(" case a "),
  ]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = outcomes.find(
    (r) => r.status === "rejected",
  ) as PromiseRejectedResult;
  assert.match(rejected.reason.message, /already exists/);
  assert.equal((await openExistingVault(vault)).branches.length, 2);
});

test("creation and capture serialize on one writer lock; cancellation while queued publishes nothing", async () => {
  const { main, vault, create } = await setup();
  await main.writeFileBytes(["Assembly.SLDASM"], new Uint8Array([25, 33]));
  const controller = new AbortController();
  const first = create("Case A", undefined, {
    onProgress: (p) => {
      if (p.phase === "restoring_files") controller.abort();
    },
  });
  const cancelled = create("Cancelled", undefined, {
    signal: controller.signal,
  });
  const capture = captureRevision(main, vault, {
    branchId: MAIN_BRANCH_ID,
    summary: "Concurrent Main",
    notes,
  });
  const outcomes = await Promise.allSettled([first, cancelled, capture]);
  assert.deepEqual(
    outcomes.map((r) => r.status),
    ["fulfilled", "rejected", "fulfilled"],
  );
  const state = await openExistingVault(vault);
  assert.equal(state.branches.length, 2);
  assert.deepEqual(
    state.revisions.map((r) => r.manifest.displayNumber),
    [1, 2],
  );
});

test("folder identity and ancestor checks reject overlap and require every branch connection", async () => {
  const { main, vault, create, workingFolders } = await setup();
  await assert.rejects(
    create("A", undefined, { destinationParent: vault }),
    /inside the revision vault/,
  );
  const child = await main.getDirectory(["NestedDestination"], {
    create: true,
  });
  await assert.rejects(
    create("A", undefined, { destinationParent: child }),
    /inside the "Main" working/,
  );
  await assert.rejects(
    create("A", undefined, { workingFolders: {} }),
    /Reconnect.*Main/,
  );
  const a = await create();
  workingFolders[a.branch.branchId] = a.workingDir;
  const state = await openExistingVault(vault);
  await assert.rejects(
    validateWorkingFolderBindings(state, vault, {
      [MAIN_BRANCH_ID]: main,
      [a.branch.branchId]: main,
    }),
    /same directory/,
  );
  const nested = await main.getDirectory(["Nested working folder"], {
    create: true,
  });
  await assert.rejects(
    validateWorkingFolderBindings(state, vault, {
      [MAIN_BRANCH_ID]: main,
      [a.branch.branchId]: nested,
    }),
    /nested inside/,
  );
  await assert.rejects(
    validateWorkingFolderBindings(state, vault, { [MAIN_BRANCH_ID]: main }),
    /Reconnect.*Case A/,
  );
  // Reconnect one at a time after browser metadata is cleared, then verify the complete set.
  await validateWorkingFolderBindings(
    state,
    vault,
    { [MAIN_BRANCH_ID]: main },
    false,
  );
  await validateWorkingFolderBindings(state, vault, workingFolders);
  main.setHooks({ readPermission: "denied" });
  await assert.rejects(create("B"), /Reconnect.*Main/);
  main.setHooks({ readPermission: "granted" });
  const originalResolve = main.resolveRelativePath.bind(main);
  main.resolveRelativePath = async () => {
    throw new Error("Handle revoked");
  };
  await assert.rejects(create("B"), /Handle revoked/);
  main.resolveRelativePath = originalResolve;
});

test("cancelled copies, corrupt objects, permission loss, and destination conflicts never publish ready branches", async () => {
  for (const failure of ["cancel", "corrupt", "permission", "conflict"]) {
    const { vault, first, parent, create } = await setup();
    const controller = new AbortController();
    if (failure === "corrupt")
      await vault.writeFileBytes(
        getObjectPathSegments(first.manifest.files[0].sha256),
        new Uint8Array([3]),
      );
    if (failure === "permission")
      parent.setHooks({
        onBeforeWrite: () => {
          parent.setHooks({ writePermission: "denied" });
        },
      });
    const originalGet = parent.getDirectory.bind(parent);
    if (failure === "conflict")
      parent.getDirectory = async (path, options) => {
        await originalGet(path, { create: true });
        const existing = await originalGet(path);
        await existing.writeFileBytes(["UserFile"], new Uint8Array([9]));
        return originalGet(path, options);
      };
    await assert.rejects(
      create("A", undefined, {
        signal: controller.signal,
        onProgress: (p) => {
          if (failure === "cancel" && p.phase === "restoring_files")
            controller.abort();
        },
      }),
    );
    assert.equal((await openExistingVault(vault)).branches.length, 1, failure);
    assert.equal((await openExistingVault(vault)).revisions.length, 1);
    assert.ok(
      (await parent.listEntries()).length > 0,
      "No user folder was deleted",
    );
  }
});

test("failed branch record writes leave a visible incomplete attempt; retry uses a fresh folder", async () => {
  const { vault, parent, create } = await setup();
  vault.setHooks({
    onBeforeWrite: (path) => {
      if (path.endsWith(".ready.json"))
        throw new Error("Interrupted publication");
    },
  });
  await assert.rejects(create(), (e: BranchCreationError) =>
    Boolean(e.incompleteDestination && e.publicationUncertain),
  );
  let state = await openExistingVault(vault);
  assert.equal(state.branches.length, 1);
  assert.ok(
    state.incompleteAttempts.some((a) => a.path.includes("branch-attempt")),
  );
  vault.setHooks({ onBeforeWrite: undefined });
  await create();
  assert.equal((await parent.listEntries()).length, 2);
  state = await openExistingVault(vault);
  assert.equal(state.branches.length, 2);
});

test("a saved branch survives write acknowledgement errors and reopens independently of convenience metadata", async () => {
  const { vault, create } = await setup();
  vault.setHooks({
    onAfterWrite: (path) => {
      if (
        path.includes("/branches/") &&
        (path.endsWith(".branch.json") || path.endsWith(".ready.json"))
      )
        throw new Error("Lost acknowledgement");
    },
  });
  const result = await create();
  assert.match(result.publicationWarning!, /acknowledgement failed/);
  assert.equal(
    (await openExistingVault(vault)).branchHeads[result.branch.branchId],
    result.branch.startingRevisionId,
  );
  await assert.rejects(
    validateWorkingFolderBindings(await openExistingVault(vault), vault, {}),
    /Reconnect.*Main/,
  );
});

test("partial branch records, partial ready markers, and cancellation before the commit point allow fresh-folder retries", async () => {
  for (const failure of ["record", "marker", "cancel-before-ready"]) {
    const { vault, parent, create } = await setup();
    const controller = new AbortController();
    vault.setHooks({
      onAfterWrite: async (path) => {
        const matches =
          failure === "record"
            ? path.endsWith(".branch.json")
            : failure === "marker" && path.endsWith(".ready.json");
        if (matches) {
          vault.setHooks({ onAfterWrite: undefined });
          await vault.writeFileText(path.split("/").slice(1), "{");
          throw new Error("Interrupted file close");
        }
      },
    });
    await assert.rejects(
      create("Case A", undefined, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (
            failure === "cancel-before-ready" &&
            progress.phase === "publishing_branch"
          )
            controller.abort();
        },
      }),
    );
    const pending = await openExistingVault(vault);
    assert.equal(pending.branches.length, 1, failure);
    assert.ok(
      pending.incompleteAttempts.some(
        (attempt) => attempt.kind === "uncompleted_branch",
      ),
    );
    vault.setHooks({ onAfterWrite: undefined });
    const retry = await create("Case A");
    assert.equal((await parent.listEntries()).length, 2);
    assert.equal(retry.vaultState.revisions.length, 1);
    assert.equal((await openExistingVault(vault)).branches.length, 2);
  }
});

test("branch records keep their historical checksum format; ready marker corruption is visible and blocks an unsafe capture", async () => {
  const { vault, create } = await setup();
  const created = await create();
  assert.equal(
    computeBranchRecordChecksum(created.branch),
    created.branch.payloadSha256,
  );
  await vault.writeFileText(
    ["branches", `${created.branch.branchId}.ready.json`],
    "{",
  );
  const state = await openExistingVault(vault);
  assert.ok(
    state.incompleteAttempts.some(
      (attempt) => attempt.id === created.branch.branchId,
    ),
  );
  await assert.rejects(
    captureRevision(created.workingDir, vault, {
      branchId: created.branch.branchId,
      summary: "Unsafe",
      notes,
    }),
    /no longer exists/,
  );
});

test("competing heads after reopening remain visible and cannot be used to create another alternative", async () => {
  const { vault, first, create } = await setup();
  const created = await create();
  for (const displayNumber of [2, 3]) {
    const revisionId = `fork-${displayNumber}`;
    const manifest = {
      ...first.manifest,
      branchId: created.branch.branchId,
      revisionId,
      displayNumber,
      parentRevisionId: first.manifest.revisionId,
    };
    manifest.manifestPayloadSha256 = computeManifestPayloadChecksum(manifest);
    const text = JSON.stringify(manifest);
    await vault.writeFileText(
      ["revisions", `${revisionId}.manifest.json`],
      text,
    );
    await vault.writeFileText(
      ["completed", `${revisionId}.done.json`],
      JSON.stringify({
        ...first.completion,
        branchId: created.branch.branchId,
        revisionId,
        displayNumber,
        manifestSha256: hashString(text),
      }),
    );
  }
  const state = await openExistingVault(vault);
  assert.equal(state.competingHeads[created.branch.branchId].length, 2);
  assert.throws(
    () => getBranchBaseline(state, created.branch.branchId),
    /competing/,
  );
  await assert.rejects(create("From ambiguous case", "fork-2"), /competing/);
});

test("missing/damaged starting revisions and ambiguous heads block scans and captures after reopening", async () => {
  const { vault, create, first, main } = await setup();
  const result = await create();
  const record: BranchRecord = {
    ...result.branch,
    startingRevisionId: "missing-revision",
  };
  record.payloadSha256 = computeBranchRecordChecksum(record);
  const branchText = JSON.stringify(record);
  await vault.writeFileText(
    ["branches", `${record.branchId}.branch.json`],
    branchText,
  );
  await vault.writeFileText(
    ["branches", `${record.branchId}.ready.json`],
    JSON.stringify({
      projectId: record.projectId,
      branchId: record.branchId,
      recordSha256: hashString(branchText),
    }),
  );
  const state = await openExistingVault(vault);
  assert.match(state.damagedBranchHeads[record.branchId], /missing/);
  assert.throws(() => getBranchBaseline(state, record.branchId), /missing/);
  await assert.rejects(
    captureRevision(result.workingDir, vault, {
      branchId: record.branchId,
      summary: "Blocked",
      notes,
    }),
    /missing/,
  );
  await vault.writeFileText(
    ["revisions", `${first.manifest.revisionId}.manifest.json`],
    "{",
  );
  await assert.rejects(create("B"), /damaged/);
  await assert.rejects(
    captureRevision(main, vault, {
      branchId: MAIN_BRANCH_ID,
      summary: "Blocked Main",
      notes,
    }),
    /damaged/,
  );
});

const folderNames = async (dir: FileSystemDirectoryAdapter) =>
  (await dir.listEntries()).map((e) => e.name).sort();

test("design case folders use readable names, counters, and never reuse 'main'", async () => {
  const { parent, create, workingFolders } = await setup();
  const make = async (name: string) => {
    const result = await create(name);
    workingFolders[result.branch.branchId] = result.workingDir;
    return result;
  };
  const a = await make("Lighter collar");
  assert.equal(a.workingDir.name, "Lighter collar");
  await make("Lighter/collar");
  const slash = await make("Lighter-collar");
  assert.equal(slash.workingDir.name, "Lighter-collar (2)");
  const dot = await make("main.");
  assert.equal(dot.workingDir.name, "main (2)");
  await parent.getDirectory(["lighter  case"], { create: true });
  await parent.getDirectory(["Quiet part"], { create: true });
  const ci = await make("Quiet Part");
  assert.equal(ci.workingDir.name, "Quiet Part (2)");
  const reserved = await make("CON");
  assert.equal(reserved.workingDir.name, "CON (2)");
  const uni = await make("Ünïcode 設計 案");
  assert.equal(uni.workingDir.name, "Ünïcode 設計 案");
  assert.deepEqual(await folderNames(parent), [
    "CON (2)",
    "Lighter collar",
    "Lighter-collar",
    "Lighter-collar (2)",
    "Quiet Part (2)",
    "Quiet part",
    "lighter  case",
    "main (2)",
    "Ünïcode 設計 案",
  ].sort());
});

test("a failed case leaves its folder; retry with the same name gets (2) and the breadcrumb matches", async () => {
  const { vault, parent, create } = await setup();
  const controller = new AbortController();
  await assert.rejects(
    create("Lighter collar", undefined, {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === "restoring_files") controller.abort();
      },
    }),
  );
  const leftover = await parent.getDirectory(["Lighter collar"]);
  await leftover.writeFileBytes(["Mark.bin"], new Uint8Array([1]));
  const crumbs = async () => {
    const staging = await vault.getDirectory(["staging"]);
    const names = (await staging.listEntries()).map((e) => e.name);
    return Promise.all(
      names
        .filter((n) => n.endsWith(".branch-attempt.json"))
        .map(async (n) =>
          JSON.parse(await vault.readFileText(["staging", n])).destinationName,
        ),
    );
  };
  assert.deepEqual(await crumbs(), ["Lighter collar"]);
  vault.setHooks({
    onBeforeWrite: (path) => {
      if (path.endsWith(".ready.json")) throw new Error("Interrupted");
    },
  });
  await assert.rejects(create("Lighter collar"), (e: BranchCreationError) =>
    /Lighter collar \(2\)/.test(e.message),
  );
  assert.deepEqual((await crumbs()).sort(), [
    "Lighter collar",
    "Lighter collar (2)",
  ]);
  vault.setHooks({ onBeforeWrite: undefined });
  const retry = await create("Lighter collar");
  assert.equal(retry.workingDir.name, "Lighter collar (3)");
  assert.deepEqual(
    [...(await leftover.readFileBytes(["Mark.bin"]))],
    [1],
  );
});
