import type { FileSystemDirectoryAdapter } from "./fs-adapter";
import { validateDirectoryIsolation } from "./fs-adapter";
import type { RevisionManifest, VaultState } from "./types";
import {
  comparisonEndpoint,
  type ComparisonEndpoint,
} from "./snapshot-comparison";

export type WorkingFolderBindings = Record<
  string,
  FileSystemDirectoryAdapter | undefined
>;

export function branchNameKey(name: string): string {
  return name.trim().normalize("NFKC").toLowerCase();
}

/** Unreadable completion evidence without an attributable owner prevents exact
 * activity counts and automatic current-endpoint selection, not manual Compare. */
export function hasUnattributedSavedEvidence(state: VaultState): boolean {
  return state.corruptedRecords.some((record) =>
    record.revisionId
      ? !state.revisions.some(
          (revision) => revision.manifest.revisionId === record.revisionId,
        )
      : record.recordPath.startsWith("completed/"),
  );
}

/** Read-only saved endpoint from the canonical head reconstruction, independent
 * of intervening ancestry. Never use this weaker validation for a write operation. */
export function getBranchComparisonEndpoint(
  state: VaultState,
  branchId: string,
): ComparisonEndpoint {
  try {
    const matches = state.branches.filter((b) => b.branchId === branchId);
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
    if (
      state.competingHeads[branchId]?.length ||
      hasUnattributedSavedEvidence(state)
    )
      throw new Error(
        "The current saved endpoint is ambiguous or has unattributed damaged record evidence.",
      );
    let id: string | null;
    if (state.branchBaselineEndpoints) {
      if (!Object.hasOwn(state.branchBaselineEndpoints, branchId))
        throw new Error(
          "The current saved endpoint cannot be established from the case records.",
        );
      id = state.branchBaselineEndpoints[branchId];
    } else {
      // Compatibility for callers with an already reconstructed legacy in-memory state.
      // Without independent endpoint evidence retain the strict canonical rules.
      id = getBranchBaseline(state, branchId)?.revisionId ?? null;
    }
    return comparisonEndpoint(state, id ?? "");
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Resolve a branch's own baseline, refusing missing, damaged, or ambiguous ancestry. */
export function getBranchBaseline(
  state: VaultState,
  branchId: string,
): RevisionManifest | null {
  const branch = state.branches.find((b) => b.branchId === branchId);
  if (!branch)
    throw new Error("Selected case no longer exists in this vault.");
  if (state.damagedBranchHeads[branchId])
    throw new Error(state.damagedBranchHeads[branchId]);
  if (state.competingHeads[branchId]?.length) {
    throw new Error(
      `Case "${branch.name}" has competing heads. Saving is blocked.`,
    );
  }
  if (!branch.isMain && !branch.startingRevisionId) {
    throw new Error(
      `Case "${branch.name}" has no starting version. Saving is blocked.`,
    );
  }
  if (branch.startingRevisionId)
    assertRevisionAncestry(state, branch.startingRevisionId);
  const id = state.branchHeads[branchId] ?? branch.startingRevisionId;
  let cursor = id;
  const seen = new Set<string>();
  while (cursor && cursor !== branch.startingRevisionId) {
    if (seen.has(cursor))
      throw new Error(`Case "${branch.name}" has cyclic ancestry.`);
    seen.add(cursor);
    const revision = state.revisions.find(
      (r) => r.manifest.revisionId === cursor,
    );
    if (!revision || revision.manifest.branchId !== branchId)
      throw new Error(
        `Case "${branch.name}" does not connect to its recorded origin.`,
      );
    cursor = revision.manifest.parentRevisionId;
  }
  if (branch.startingRevisionId && cursor !== branch.startingRevisionId)
    throw new Error(
      `Case "${branch.name}" does not connect to its recorded starting version.`,
    );
  return id ? assertRevisionAncestry(state, id) : null;
}

export function assertRevisionAncestry(
  state: VaultState,
  revisionId: string,
): RevisionManifest {
  const seen = new Set<string>();
  let id: string | null = revisionId;
  let result: RevisionManifest | undefined;
  while (id) {
    if (seen.has(id))
      throw new Error("Cyclic version ancestry. Operation blocked.");
    seen.add(id);
    const matches = state.revisions.filter((r) => r.manifest.revisionId === id);
    if (matches.length !== 1 || matches[0].integrityStatus === "corrupted") {
      throw new Error(
        `Starting or parent version "${id}" is missing, ambiguous, or damaged. Operation blocked.`,
      );
    }
    const rev = matches[0];
    if (
      state.competingHeads[rev.manifest.branchId]?.length ||
      state.damagedBranchHeads[rev.manifest.branchId]
    ) {
      throw new Error(
        `The source history for "${id}" is damaged or has competing heads. Operation blocked.`,
      );
    }
    result ??= rev.manifest;
    id = rev.manifest.parentRevisionId;
  }
  return result!;
}

/** Committed revision ownership must be accounted for before any write operation. */
function assertKnownCommittedBranchIdentities(state: VaultState): void {
  const known = new Set(state.branches.map((branch) => branch.branchId));
  const unaccounted = [
    ...new Set(
      state.revisions.flatMap((revision) => [
        revision.manifest.branchId,
        revision.completion.branchId,
      ]),
    ),
  ].filter((branchId) => !known.has(branchId));
  if (unaccounted.length)
    throw new Error(
      `Folder isolation cannot be established for committed case identities without valid records: ${unaccounted.join(", ")}. Restore their case records before writing; history remains available for read-only inspection.`,
    );
}

/** Existing callers may omit bindings only when branch identity/publication is healthy. */
export async function validateOperationWorkingFolders(
  state: VaultState,
  vault: FileSystemDirectoryAdapter,
  bindings?: WorkingFolderBindings,
): Promise<void> {
  assertKnownCommittedBranchIdentities(state);
  if (bindings) await validateWorkingFolderBindings(state, vault, bindings);
  else if (
    state.corruptedRecords.some((record) =>
      record.recordPath.startsWith("branches/"),
    )
  ) {
    throw new Error(
      "Folder isolation cannot be established while case publication records are damaged. Reconnect all case working folders before writing; read-only inspection remains available.",
    );
  }
}

/** Partial reconnection is allowed, but operations require every branch connection. */
export async function validateWorkingFolderBindings(
  state: VaultState,
  vault: FileSystemDirectoryAdapter,
  bindings: WorkingFolderBindings,
  requireAll = true,
): Promise<void> {
  if (requireAll) assertKnownCommittedBranchIdentities(state);
  const connected: { name: string; dir: FileSystemDirectoryAdapter }[] = [];
  for (const branch of state.branches) {
    const dir = bindings[branch.branchId];
    let readable = false;
    try {
      readable = Boolean(
        dir && (await dir.queryPermission("read")) === "granted",
      );
    } catch {
      /* A stale handle needs explicit reconnection. */
    }
    if (!dir || !readable) {
      if (requireAll)
        throw new Error(
          `Reconnect the working folder for "${branch.name}" to verify folder isolation. Select that case, then Connect folder.`,
        );
      continue;
    }
    await validateDirectoryIsolation(
      dir,
      vault,
      `"${branch.name}" working folder`,
      "Version vault",
    );
    for (const other of connected) {
      await validateDirectoryIsolation(
        dir,
        other.dir,
        `"${branch.name}" working folder`,
        `"${other.name}" working folder`,
      );
    }
    connected.push({ name: branch.name, dir });
  }
}
