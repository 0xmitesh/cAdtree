import test from "node:test";
import assert from "node:assert/strict";
import { historyState, revision } from "../../tests/history-data";
import { caseActivity } from "./case-activity";
import { hashString } from "./hash";
import { getBranchComparisonEndpoint } from "./branch-state";
import { compareSavedRevisions } from "./snapshot-comparison";
import {
  InMemoryFileSystemAdapter,
  type FileSystemDirectoryAdapter,
} from "./fs-adapter";
import {
  initializeProjectVault,
  openExistingVault,
  computeManifestPayloadChecksum,
} from "./vault-service";
import { captureRevision } from "./revision-service";
import { createDesignBranch } from "./branch-service";
import { changeCaseLifecycle } from "./case-lifecycle-service";
import { inventorySignature, readVerifiedInventory } from "./copy-service";
import { prepareApplyPreview, buildApplyPreview } from "./apply-preview";
import {
  applicationReview,
  prepareApplication,
  applyPreparedApplication,
} from "./application-service";

function fixture() {
  const state = historyState(0);
  state.revisions = [
    revision("root", null, 1),
    revision("main20", "root", 20),
    revision("case7", "root", 7, "case"),
    revision("nested50", "case7", 50, "nested"),
  ];
  for (const [id, origin] of [
    ["case", "root"],
    ["nested", "case7"],
    ["no-saves", "main20"],
  ])
    state.branches.push({
      ...state.branches[0],
      branchId: id,
      name: id,
      isMain: false,
      startingRevisionId: origin,
    });
  state.branchHeads = {
    "branch-main": "main20",
    case: "case7",
    nested: "nested50",
    "no-saves": "main20",
  };
  return state;
}
test("ordinary divergence counts saved parent edges, not nonconsecutive display numbers; projection is read-only", () => {
  const state = fixture(),
    before = JSON.stringify(state);
  const info = caseActivity(state, "case");
  assert.deepEqual(info.ownSaves, { status: "available", value: 1 });
  assert.equal(info.origin.status, "available");
  assert.equal(info.divergence.status, "available");
  if (info.divergence.status === "available") {
    assert.equal(info.divergence.value.ancestor.manifest.revisionId, "root");
    assert.equal(info.divergence.value.mainCount, 1);
    assert.equal(info.divergence.value.caseCount, 1);
  }
  assert.equal(info.baseline.status, "available");
  if (info.baseline.status === "available")
    assert.equal(
      info.baseline.revision.manifest.captureCompletedAt,
      state.revisions[2].manifest.captureCompletedAt,
    );
  assert.equal(JSON.stringify(state), before);
});
test("identical inherited baselines have zero divergence and no new case saves", () => {
  const info = caseActivity(fixture(), "no-saves");
  assert.deepEqual(info.ownSaves, { status: "available", value: 0 });
  assert.equal(info.divergence.status, "available");
  if (info.divergence.status === "available") {
    assert.equal(info.divergence.value.ancestor.manifest.revisionId, "main20");
    assert.equal(info.divergence.value.mainCount, 0);
    assert.equal(info.divergence.value.caseCount, 0);
  }
});
test("nested case divergence includes inherited saves while ownership counts only its own saves; nearest shared ancestor is used", () => {
  const state = fixture();
  for (const [own, count] of [
    [true, 1],
    [false, 0],
  ] as const) {
    if (!own) {
      state.revisions = state.revisions.filter(
        (r) => r.manifest.branchId !== "nested",
      );
      state.branchHeads.nested = "case7";
    }
    const info = caseActivity(state, "nested");
    assert.deepEqual(info.ownSaves, { status: "available", value: count });
    assert.equal(info.divergence.status, "available");
    if (info.divergence.status === "available")
      assert.equal(info.divergence.value.caseCount, own ? 2 : 1);
  }
  // A parent case started from newer Main; its child inherits that nearer origin.
  state.revisions[2].manifest.parentRevisionId = "main20";
  state.branches[1].startingRevisionId = "main20";
  const nearer = caseActivity(state, "nested");
  if (nearer.divergence.status !== "available")
    throw new Error(nearer.divergence.reason);
  assert.equal(nearer.divergence.value.ancestor.manifest.revisionId, "main20");
});
test("missing, corrupt, duplicate, cyclic, ambiguous and disconnected ancestry never becomes zero divergence", () => {
  const mutations = [
    (s: ReturnType<typeof fixture>) => {
      s.revisions = s.revisions.filter((r) => r.manifest.revisionId !== "root");
    },
    (s: ReturnType<typeof fixture>) => {
      s.revisions[0].integrityStatus = "corrupted";
    },
    (s: ReturnType<typeof fixture>) => {
      s.revisions.push(structuredClone(s.revisions[0]));
    },
    (s: ReturnType<typeof fixture>) => {
      s.revisions[0].manifest.parentRevisionId = "case7";
    },
    (s: ReturnType<typeof fixture>) => {
      s.competingHeads.case = ["case7", "other"];
    },
    (s: ReturnType<typeof fixture>) => {
      s.branches.push({ ...s.branches[1] });
    },
    (s: ReturnType<typeof fixture>) => {
      s.revisions[2].manifest.parentRevisionId = null;
    },
    (s: ReturnType<typeof fixture>) => {
      s.revisions[0].integrityErrors.push("Damaged metadata");
    },
  ];
  for (const mutate of mutations) {
    const state = fixture();
    mutate(state);
    const info = caseActivity(state, "case");
    assert.equal(info.divergence.status, "unavailable");
    if (info.divergence.status === "unavailable")
      assert.ok(info.divergence.reason);
  }
  const state = fixture();
  state.revisions[0].integrityStatus = "corrupted";
  // Origin/ancestry is damaged, but the direct ownership count is independently known.
  assert.deepEqual(caseActivity(state, "case").ownSaves, {
    status: "available",
    value: 1,
  });
  state.revisions[2].integrityStatus = "corrupted";
  assert.equal(caseActivity(state, "case").ownSaves.status, "unavailable");
});
test("unavailable Main/case baselines remain explicit while trustworthy independent origin information survives", () => {
  const state = fixture();
  state.branchHeads.case = "missing";
  assert.equal(caseActivity(state, "case").baseline.status, "unavailable");
  assert.equal(caseActivity(state, "case").origin.status, "available");
  state.branchHeads["branch-main"] = null;
  assert.equal(caseActivity(state, "case").main.status, "unavailable");
  state.branches.push({ ...state.branches[0], branchId: "other-main" });
  assert.equal(caseActivity(state, "case").main.status, "unavailable");
});

const notes = {
  problem: "Design intent",
  modification: "Change",
  observations: "Saved engineering notes",
};
async function savedFixture() {
  const main = new InMemoryFileSystemAdapter("Main"),
    vault = new InMemoryFileSystemAdapter("Vault"),
    parent = new InMemoryFileSystemAdapter("Cases");
  await main.writeFileText(["Part-X"], "Base");
  await main.writeFileText(["Other"], "Base other");
  await initializeProjectVault(main, vault, "Activity test");
  const workingFolders: Record<string, FileSystemDirectoryAdapter> = {
    "branch-main": main,
  };
  const save = (branchId: string) =>
    captureRevision(workingFolders[branchId], vault, {
      branchId,
      summary: "Saved design",
      notes,
      workingFolders,
    });
  const root = await save("branch-main");
  const branch = await createDesignBranch({
    vaultDir: vault,
    destinationParent: parent,
    workingFolders,
    sourceRevisionId: root.revision.manifest.revisionId,
    name: "Case",
    reason: "Explore",
  });
  workingFolders[branch.branch.branchId] = branch.workingDir;
  await branch.workingDir.writeFileText(["Part-X"], "Case redesign");
  const source = await save(branch.branch.branchId);
  await main.writeFileText(["Other"], "Main development");
  const destination = await save("branch-main");
  return {
    main,
    vault,
    parent,
    branch,
    root,
    source,
    destination,
    workingFolders,
    save,
  };
}
test("real reconstructed healthy endpoints can Compare despite missing ancestry, without weakening canonical write validation", async () => {
  const f = await savedFixture();
  const root = f.root.revision.manifest;
  root.parentRevisionId = "missing-ancestor";
  root.manifestPayloadSha256 = computeManifestPayloadChecksum(root);
  const completion = {
    ...f.root.revision.completion,
    manifestSha256: hashString(JSON.stringify(root)),
  };
  await f.vault.writeFileText(
    ["revisions", `${root.revisionId}.manifest.json`],
    JSON.stringify(root),
  );
  await f.vault.writeFileText(
    ["completed", `${root.revisionId}.done.json`],
    JSON.stringify(completion),
  );
  const state = await openExistingVault(f.vault);
  const info = caseActivity(state, f.branch.branch.branchId);
  assert.equal(info.divergence.status, "unavailable");
  assert.equal(info.baseline.status, "available");
  assert.equal(info.main.status, "available");
  assert.equal(
    compareSavedRevisions(
      state,
      f.source.revision.manifest.revisionId,
      f.destination.revision.manifest.revisionId,
    ).status,
    "compared",
  );
  await assert.rejects(() => f.save("branch-main"));
});
test("canonical reconstruction refuses damaged/competing baseline identities for automatic Compare with Main", async () => {
  const f = await savedFixture();
  await f.vault.writeFileText(
    ["revisions", `${f.source.revision.manifest.revisionId}.manifest.json`],
    "broken",
  );
  const state = await openExistingVault(f.vault);
  assert.equal(
    getBranchComparisonEndpoint(state, f.branch.branch.branchId).status,
    "unavailable",
  );
  assert.equal(
    caseActivity(state, f.branch.branch.branchId).ownSaves.status,
    "unavailable",
  );
  const ambiguous = fixture();
  ambiguous.competingHeads.case = ["case7", "other"];
  assert.equal(
    getBranchComparisonEndpoint(ambiguous, "case").status,
    "unavailable",
  );
});
test("archived cases remain inspectable and the activity/Compare workflow writes no managed bytes or records", async () => {
  const f = await savedFixture(),
    branchId = f.branch.branch.branchId;
  await changeCaseLifecycle(
    f.vault,
    {
      projectId: f.root.vaultState.project.projectId,
      branchId,
      activeBranchId: "branch-main",
      status: "archived",
      expectedVersion: null,
    },
    { workingFolders: f.workingFolders },
  );
  const before = await Promise.all(
    [f.vault, f.main, f.parent].map(async (dir) =>
      inventorySignature(await readVerifiedInventory(dir)),
    ),
  );
  const state = await openExistingVault(f.vault);
  assert.equal(caseActivity(state, branchId).divergence.status, "available");
  assert.equal(
    compareSavedRevisions(
      state,
      f.source.revision.manifest.revisionId,
      f.destination.revision.manifest.revisionId,
    ).status,
    "compared",
  );
  const after = await Promise.all(
    [f.vault, f.main, f.parent].map(async (dir) =>
      inventorySignature(await readVerifiedInventory(dir)),
    ),
  );
  assert.deepEqual(after, before);
});
test("selective application provenance never adds ancestry; only a later normal capture adds a Main revision", async () => {
  const f = await savedFixture(),
    branchId = f.branch.branch.branchId;
  const beforeState = await openExistingVault(f.vault);
  const before = caseActivity(beforeState, branchId).divergence;
  const prepared = prepareApplyPreview(
    beforeState,
    f.source.revision.manifest.revisionId,
    "branch-main",
  );
  if (prepared.status !== "available") throw new Error(prepared.reason);
  const choices = {
    "Part-X": { selected: true, decision: "use-source" as const },
  };
  const plan = buildApplyPreview(
    prepared.context,
    choices,
    "Reuse selected Part-X",
  );
  const review = applicationReview(plan, choices);
  const options = { workingFolders: f.workingFolders };
  const ticket = await prepareApplication(f.vault, review, options);
  await applyPreparedApplication(f.vault, ticket, options);
  assert.deepEqual(
    caseActivity(await openExistingVault(f.vault), branchId).divergence,
    before,
  );
  await f.save("branch-main");
  const captured = await openExistingVault(f.vault);
  const info = caseActivity(captured, branchId);
  assert.equal(info.divergence.status, "available");
  if (info.divergence.status === "available") {
    assert.equal(info.divergence.value.mainCount, 2);
    assert.equal(info.divergence.value.caseCount, 1);
    assert.equal(
      info.divergence.value.ancestor.manifest.revisionId,
      f.root.revision.manifest.revisionId,
    );
  }
  const withoutProvenance = { ...captured, applicationOperations: [] };
  assert.deepEqual(caseActivity(withoutProvenance, branchId), info);
});
