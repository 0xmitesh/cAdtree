import type { ReconstructedRevision, VaultState } from "./types";
import {
  getBranchBaseline,
  getBranchComparisonEndpoint,
  branchNameKey,
  hasUnattributedSavedEvidence,
} from "./branch-state";
import {
  comparisonEndpoint,
  type ComparisonEndpoint,
} from "./snapshot-comparison";
import {
  ancestryOf,
  layoutRevisions,
  type RevisionGraph,
} from "../history/layout";

type Evidence<T> =
  { status: "available"; value: T } | { status: "unavailable"; reason: string };
export interface CaseActivity {
  origin: ComparisonEndpoint;
  baseline: ComparisonEndpoint;
  main: ComparisonEndpoint;
  ownSaves: Evidence<number>;
  divergence: Evidence<{
    ancestor: ReconstructedRevision;
    mainCount: number;
    caseCount: number;
  }>;
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
    throw new Error("Branch identity is missing or ambiguous.");
  return matches[0];
}

/** Complete saved metadata only. No folder handles, clocks, file filters or provenance edges. */
export function caseActivity(
  state: VaultState,
  branchId: string,
  graph = layoutRevisions(state, branchId),
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
      divergence: failed,
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
  let divergence: CaseActivity["divergence"];
  try {
    if (baseline.status !== "available")
      throw new Error(`Case baseline: ${baseline.reason}`);
    if (main.status !== "available")
      throw new Error(`Main baseline: ${main.reason}`);
    const mainBranch = mainIdentity(state);
    // The existing canonical resolver validates each branch's complete ancestry
    // and connection to its recorded origin. Endpoint-only Compare is separate.
    const savedCase = getBranchBaseline(state, branchId);
    const savedMain = getBranchBaseline(state, mainBranch.branchId);
    if (
      savedCase?.revisionId !== baseline.revision.manifest.revisionId ||
      savedMain?.revisionId !== main.revision.manifest.revisionId
    )
      throw new Error(
        "The canonical saved baselines are unavailable or inconsistent.",
      );
    const casePath = validatedPath(state, graph, savedCase.revisionId);
    const mainPath = validatedPath(state, graph, savedMain.revisionId);
    const caseIds = new Set(casePath);
    const sharedId = mainPath.find((id) => caseIds.has(id));
    if (!sharedId)
      throw new Error(
        "No validated shared ancestor connects the current saved baselines.",
      );
    const ancestor = comparisonEndpoint(state, sharedId);
    if (ancestor.status !== "available") throw new Error(ancestor.reason);
    divergence = {
      status: "available",
      value: {
        ancestor: ancestor.revision,
        mainCount: mainPath.indexOf(sharedId),
        caseCount: casePath.indexOf(sharedId),
      },
    };
  } catch (error) {
    divergence = unavailable(message(error));
  }
  return { origin, baseline, main, ownSaves, divergence };
}

function mainIdentity(state: VaultState) {
  const matches = state.branches.filter((branch) => branch.isMain);
  if (matches.length !== 1)
    throw new Error("Main branch identity is missing or ambiguous.");
  return branchIdentity(state, matches[0].branchId);
}
function mainEndpoint(state: VaultState): ComparisonEndpoint {
  try {
    return getBranchComparisonEndpoint(state, mainIdentity(state).branchId);
  } catch (error) {
    return unavailable(message(error));
  }
}
function validatedPath(
  state: VaultState,
  graph: RevisionGraph,
  headId: string,
): string[] {
  const path = [...ancestryOf(graph, headId)];
  for (let index = 0; index < path.length; index++) {
    const endpoint = comparisonEndpoint(state, path[index]);
    if (endpoint.status !== "available")
      throw new Error(`Ancestry unavailable: ${endpoint.reason}`);
    branchIdentity(state, endpoint.revision.manifest.branchId);
    if (
      (endpoint.revision.manifest.parentRevisionId ?? undefined) !==
      path[index + 1]
    )
      throw new Error("A saved parent edge is missing, cyclic or ambiguous.");
  }
  return path;
}

export function designCaseActivities(
  state: VaultState,
): Map<string, CaseActivity> {
  const graph = layoutRevisions(state, "branch-main");
  return new Map(
    state.branches
      .filter((branch) => !branch.isMain)
      .map((branch) => [
        branch.branchId,
        caseActivity(state, branch.branchId, graph),
      ]),
  );
}
