import type { ReconstructedRevision, VaultState } from "../src/engine/types";
export function revision(
  id: string,
  parent: string | null,
  number: number,
  branchId = "branch-main",
): ReconstructedRevision {
  const files = [
    {
      path: "Actuator.SLDASM",
      size: 18432,
      sha256: "a".repeat(64),
      lastModified: 0,
    },
    {
      path: "Parts/Housing.SLDPRT",
      size: 32768,
      sha256: (number > 1 ? String(number % 10) : "a").repeat(64),
      lastModified: 0,
    },
    {
      path: "Parts/Output_shaft.SLDPRT",
      size: 12288,
      sha256: "c".repeat(64),
      lastModified: 0,
    },
    {
      path: "Parts/Bearing_retainer.SLDPRT",
      size: 6144,
      sha256: "d".repeat(64),
      lastModified: 0,
    },
    {
      path: "Drawings/Actuator.SLDDRW",
      size: 14336,
      sha256: "e".repeat(64),
      lastModified: 0,
    },
  ];
  const summary = [
    "Initial assembly and component set",
    "Refine housing clearance",
    "Add bearing retainer and update drawing",
    "Adjust shaft tolerance for press fit",
    "Finalize mounting pattern",
    "Review assembly for manufacture",
  ][(number - 1) % 6];
  return {
    manifest: {
      schemaVersion: 1,
      projectId: "visual-project",
      revisionId: id,
      branchId,
      parentRevisionId: parent,
      displayNumber: number,
      captureStartedAt: "2026-10-29T09:00:00Z",
      captureCompletedAt: `2026-10-29T${String(9 + (number % 8)).padStart(2, "0")}:24:00Z`,
      summary,
      notes: {
        problem: "Reduce interference between the housing and output shaft.",
        modification:
          "Increase radial clearance to 0.025 mm. Keep the outer envelope unchanged.",
        observations: "Check fit with the next machined prototype.",
      },
      fileNotes: [
        {
          path: "Parts/Housing.SLDPRT",
          problem: "Shaft binds at operating temperature.",
          modification: "Bore clearance increased by 0.01 mm.",
          observations: "Confirm on prototype.",
        },
      ],
      files,
      directories: ["Parts", "Drawings"],
      manifestPayloadSha256: "f".repeat(64),
    },
    completion: {
      schemaVersion: 1,
      projectId: "visual-project",
      revisionId: id,
      branchId,
      displayNumber: number,
      manifestSha256: "f".repeat(64),
      completedAt: "2026-10-29T12:00:00Z",
    },
    integrityStatus: "manifest_verified",
    integrityErrors: [],
  };
}
export function historyState(count = 6): VaultState {
  return {
    project: {
      schemaVersion: 1,
      projectId: "visual-project",
      name: "Linear actuator",
      createdAt: "2026-10-29T09:00:00Z",
      payloadSha256: "f".repeat(64),
    },
    branches: [
      {
        schemaVersion: 1,
        projectId: "visual-project",
        branchId: "branch-main",
        name: "Main",
        isMain: true,
        startingRevisionId: null,
        reason: "Initial design",
        createdAt: "2026-10-29T09:00:00Z",
        payloadSha256: "f".repeat(64),
      },
    ],
    revisions: Array.from({ length: count }, (_, i) =>
      revision("r" + (i + 1), i ? "r" + i : null, i + 1),
    ),
    branchHeads: { "branch-main": count ? "r" + count : null },
    competingHeads: {},
    damagedBranchHeads: {},
    incompleteAttempts: [],
    corruptedRecords: [],
  };
}
export function scenarioState(scenario: string) {
  const state = historyState(
    scenario === "empty"
      ? 0
      : scenario === "single"
        ? 1
        : scenario === "long"
          ? 120
          : 6,
  );
  if (scenario === "branches") {
    state.branches.push({
      ...state.branches[0],
      branchId: "prototype",
      name: "Prototype",
      isMain: false,
      startingRevisionId: "r2",
    });
    state.revisions.push(
      revision("p1", "r2", 7, "prototype"),
      revision("p2", "p1", 8, "prototype"),
    );
    state.branchHeads.prototype = "p2";
  }
  if (scenario === "damaged") {
    state.revisions[2].manifest.parentRevisionId = "missing-record";
    state.revisions[3].integrityStatus = "corrupted";
    state.revisions[3].integrityErrors = ["Stored file checksum mismatch"];
    state.revisions[5].manifest.summary =
      "Review the exceptionally long housing and thermal compensation changes for the high precision prototype assembly and its manufacturing configuration";
    state.project.name =
      "Linear actuator — high precision prototype with an exceptionally long project name";
    state.competingHeads["branch-main"] = ["r5", "r6"];
    state.damagedBranchHeads["branch-main"] =
      "One branch head contains damaged content.";
    state.corruptedRecords.push({
      recordPath: "completed/unreadable.json",
      revisionId: "unreadable",
      reason: "Completion record is unreadable.",
    });
  }
  return state;
}
