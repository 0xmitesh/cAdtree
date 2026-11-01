import type {
  FileEntry,
  ModifiedFileChange,
  ReconstructedRevision,
  RevisionDiffResult,
  RevisionManifest,
  VaultState,
} from "./types";

export type SnapshotDiff = Pick<
  RevisionDiffResult,
  | "added"
  | "modified"
  | "deleted"
  | "unchanged"
  | "addedDirectories"
  | "deletedDirectories"
  | "unchangedDirectories"
>;
type SnapshotContents = Pick<RevisionManifest, "files" | "directories">;

/** Compare endpoint metadata only. Callers establish that both manifests are trusted. */
export function compareSnapshotContents(
  from: SnapshotContents,
  to: SnapshotContents,
): SnapshotDiff {
  const parentFilesMap = new Map<string, FileEntry>();
  for (const pf of from.files) {
    parentFilesMap.set(pf.path, pf);
  }

  const added: FileEntry[] = [];
  const modified: ModifiedFileChange[] = [];
  const unchanged: FileEntry[] = [];
  const seenCurrentPaths = new Set<string>();

  for (const currFile of to.files) {
    seenCurrentPaths.add(currFile.path);
    const prevFile = parentFilesMap.get(currFile.path);
    if (!prevFile) {
      added.push(currFile);
    } else if (prevFile.sha256 !== currFile.sha256) {
      modified.push({ current: currFile, previous: prevFile });
    } else {
      unchanged.push(currFile);
    }
  }

  const deleted: FileEntry[] = [];
  for (const [prevPath, prevFile] of parentFilesMap.entries()) {
    if (!seenCurrentPaths.has(prevPath)) {
      deleted.push(prevFile);
    }
  }

  added.sort((a, b) => a.path.localeCompare(b.path));
  modified.sort((a, b) => a.current.path.localeCompare(b.current.path));
  deleted.sort((a, b) => a.path.localeCompare(b.path));
  unchanged.sort((a, b) => a.path.localeCompare(b.path));

  const parentDirsSet = new Set(from.directories);
  const currDirsSet = new Set(to.directories);

  const addedDirectories = to.directories
    .filter((d) => !parentDirsSet.has(d))
    .sort((a, b) => a.localeCompare(b));
  const deletedDirectories = from.directories
    .filter((d) => !currDirsSet.has(d))
    .sort((a, b) => a.localeCompare(b));
  const unchangedDirectories = to.directories
    .filter((d) => parentDirsSet.has(d))
    .sort((a, b) => a.localeCompare(b));

  return {
    added,
    modified,
    deleted,
    unchanged,
    addedDirectories,
    deletedDirectories,
    unchangedDirectories,
  };
}

export type ComparisonEndpoint =
  | { status: "available"; revision: ReconstructedRevision }
  | { status: "unavailable"; reason: string };

/** Identity and integrity checks are endpoint-local: broken intervening ancestry
 * does not prevent comparison of two independently verified snapshots. */
export function comparisonEndpoint(
  state: VaultState,
  id: string,
): ComparisonEndpoint {
  const matches = state.revisions.filter((r) => r.manifest.revisionId === id);
  if (!id || matches.length === 0)
    return {
      status: "unavailable",
      reason: "The saved revision is missing or unavailable.",
    };
  if (matches.length !== 1)
    return {
      status: "unavailable",
      reason: "The revision identity is ambiguous (multiple records).",
    };
  const revision = matches[0];
  if (
    revision.integrityStatus === "corrupted" ||
    revision.integrityErrors.length ||
    state.corruptedRecords.some((r) => r.revisionId === id)
  )
    return {
      status: "unavailable",
      reason: "The saved revision has damaged or conflicting record evidence.",
    };
  const { manifest, completion } = revision;
  if (
    !["manifest_verified", "objects_verified"].includes(
      revision.integrityStatus,
    ) ||
    manifest.projectId !== state.project.projectId ||
    completion.projectId !== state.project.projectId ||
    completion.revisionId !== id ||
    completion.branchId !== manifest.branchId ||
    completion.displayNumber !== manifest.displayNumber
  )
    return {
      status: "unavailable",
      reason:
        "The saved revision's verified project or completion identity is inconsistent.",
    };
  return { status: "available", revision };
}

export type SavedRevisionComparison =
  | {
      status: "compared";
      from: ReconstructedRevision;
      to: ReconstructedRevision;
      diff: SnapshotDiff;
    }
  | { status: "unavailable"; reason: string };

export function compareSavedRevisions(
  state: VaultState,
  fromId: string,
  toId: string,
): SavedRevisionComparison {
  const from = comparisonEndpoint(state, fromId);
  const to = comparisonEndpoint(state, toId);
  if (from.status === "unavailable" || to.status === "unavailable")
    return {
      status: "unavailable",
      reason: [
        from.status === "unavailable" ? `From: ${from.reason}` : "",
        to.status === "unavailable" ? `To: ${to.reason}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    };
  return {
    status: "compared",
    from: from.revision,
    to: to.revision,
    diff: compareSnapshotContents(from.revision.manifest, to.revision.manifest),
  };
}
