import type { VaultState } from "./types";
import {
  getBranchComparisonEndpoint,
  branchNameKey,
  hasUnattributedSavedEvidence,
} from "./branch-state";
import {
  comparisonEndpoint,
  type ComparisonEndpoint,
} from "./snapshot-comparison";

type Evidence<T> =
  { status: "available"; value: T } | { status: "unavailable"; reason: string };
export interface CaseActivity {
  origin: ComparisonEndpoint;
  baseline: ComparisonEndpoint;
  main: ComparisonEndpoint;
  ownSaves: Evidence<number>;
}
const unavailable = (
  reason: string,
): { status: "unavailable"; reason: string } => ({
  status: "unavailable",
  reason,
});
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function branchIdentity(state: VaultState, id: string) {
  const matches = state.branches.filter((branch) => branch.branchId === id);
  if (
    matches.length !== 1 ||
    matches[0].projectId !== state.project.projectId ||
    state.branches.some(
      (branch) =>
        branch !== matches[0] &&
        branchNameKey(branch.name) === branchNameKey(matches[0].name),
    )
  )
    throw new Error("Case identity is missing or ambiguous.");
  return matches[0];
}

/** Complete saved metadata only. No folder handles, clocks, file filters or provenance edges. */
export function caseActivity(
  state: VaultState,
  branchId: string,
): CaseActivity {
  let branch;
  try {
    branch = branchIdentity(state, branchId);
  } catch (error) {
    const failed = unavailable(message(error));
    return {
      origin: failed,
      baseline: failed,
      main: mainEndpoint(state),
      ownSaves: failed,
    };
  }
  let origin = comparisonEndpoint(state, branch.startingRevisionId ?? "");
  if (origin.status === "available") {
    try {
      branchIdentity(state, origin.revision.manifest.branchId);
    } catch (error) {
      origin = unavailable(message(error));
    }
  }
  const baseline = getBranchComparisonEndpoint(state, branchId);
  const main = mainEndpoint(state);
  let ownSaves: CaseActivity["ownSaves"];
  try {
    const own = state.revisions.filter(
      (revision) => revision.manifest.branchId === branchId,
    );
    for (const revision of own) {
      const endpoint = comparisonEndpoint(state, revision.manifest.revisionId);
      if (endpoint.status !== "available") throw new Error(endpoint.reason);
    }
    // A record without a readable owner cannot be assigned away from this case.
    if (hasUnattributedSavedEvidence(state))
      throw new Error(
        "Damaged saved records have unknown ownership; the case save count cannot be confirmed.",
      );
    ownSaves = { status: "available", value: own.length };
  } catch (error) {
    ownSaves = unavailable(message(error));
  }
  return { origin, baseline, main, ownSaves };
}

function mainIdentity(state: VaultState) {
  const matches = state.branches.filter((branch) => branch.isMain);
  if (matches.length !== 1)
    throw new Error("Main case identity is missing or ambiguous.");
  return branchIdentity(state, matches[0].branchId);
}
function mainEndpoint(state: VaultState): ComparisonEndpoint {
  try {
    return getBranchComparisonEndpoint(state, mainIdentity(state).branchId);
  } catch (error) {
    return unavailable(message(error));
  }
}
export function designCaseActivities(
  state: VaultState,
): Map<string, CaseActivity> {
  return new Map(
    state.branches
      .filter((branch) => !branch.isMain)
      .map((branch) => [branch.branchId, caseActivity(state, branch.branchId)]),
  );
}
