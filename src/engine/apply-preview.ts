import type { FileEntry, ReconstructedRevision, VaultState } from "./types";
import { getBranchBaseline } from "./branch-state";
import {
  compareSnapshotContents,
  comparisonEndpoint,
} from "./snapshot-comparison";
import { ancestryOf, layoutRevisions } from "../history/layout";
import { componentWriteBlock } from './component-identity';
import {
  checkCaseInsensitiveCollisions,
  splitAndValidatePath,
} from "./fs-adapter";

export type SourceChange = "added" | "modified" | "deleted";
export type ConflictDecision = "unresolved" | "keep-destination" | "use-source";
export interface PreviewFileRow {
  identityBlock?: string;
  path: string;
  kind: "no-source-change" | "already-matches" | "available" | "conflict";
  sourceChange: SourceChange | null;
  base: FileEntry | null;
  source: FileEntry | null;
  destination: FileEntry | null;
}
export type ApplyMode = "merge" | "revert";
export interface ApplyPreviewContext {
  mode: ApplyMode;
  projectId: string;
  destinationBranchId: string;
  base: ReconstructedRevision;
  source: ReconstructedRevision;
  destination: ReconstructedRevision;
  rows: PreviewFileRow[];
}
export type ApplyPreviewPreparation =
  | { status: "available"; context: ApplyPreviewContext }
  | { status: "unavailable"; reason: string };
export interface PreviewChoice {
  selected: boolean;
  decision: ConflictDecision;
}
export interface PreviewAction {
  path: string;
  sourceChange: SourceChange;
  decision: ConflictDecision;
  operation: "add" | "replace" | "delete" | "keep" | "unresolved";
  base: FileEntry | null;
  source: FileEntry | null;
  before: FileEntry | null;
  after: FileEntry | null;
}
export interface ApplyPreviewPlan {
  mode: ApplyMode;
  projectId: string;
  sourceRevisionId: string;
  destinationRevisionId: string;
  baseRevisionId: string;
  destinationBranchId: string;
  reason: string;
  actions: PreviewAction[];
  resultFiles: FileEntry[];
  resultDirectories: string[];
  unresolvedPaths: string[];
  collisions: string[];
  blockers: string[];
  ready: boolean;
}
const sameFile = (a: FileEntry | null, b: FileEntry | null) =>
  a === null || b === null ? a === b : a.sha256 === b.sha256;
const copyFile = (file: FileEntry | null) => (file ? { ...file } : null);

/** Read-only preparation. The destination uses the canonical branch baseline;
 * the base follows verified parent edges, never numbering or immediate-parent guesses. */
/**
 * Which Apply flow a source revision takes for a destination branch:
 * "latest" (the branch's newest revision; nothing to do), "revert" (an earlier
 * revision in the branch's own history) or "merge". Falls back to "merge" when
 * the baseline or ancestry cannot be established, so the dialog shows the
 * engine's reason instead of guessing.
 */
export function applyModeFor(
  state: VaultState,
  sourceId: string,
  destinationBranchId: string,
): "merge" | "revert" | "latest" {
  try {
    const baseline = getBranchBaseline(state, destinationBranchId);
    if (!baseline) return "merge";
    if (baseline.revisionId === sourceId) return "latest";
    const graph = layoutRevisions(state, destinationBranchId);
    return ancestryOf(graph, baseline.revisionId).has(sourceId)
      ? "revert"
      : "merge";
  } catch {
    return "merge";
  }
}

export function prepareApplyPreview(
  state: VaultState,
  sourceId: string,
  destinationBranchId: string,
  mode: ApplyMode = "merge",
): ApplyPreviewPreparation {
  try {
    if (mode !== "merge" && mode !== "revert")
      throw new Error(`Unknown apply mode "${String(mode)}".`);
    const identityBlock = componentWriteBlock(state);
    if (identityBlock) throw new Error(identityBlock);
    const assertBranch = (id: string) => {
      const matches = state.branches.filter((branch) => branch.branchId === id);
      if (
        matches.length !== 1 ||
        matches[0].projectId !== state.project.projectId
      )
        throw new Error(`Branch identity "${id}" is missing or ambiguous.`);
    };
    assertBranch(destinationBranchId);
    const sourceEndpoint = comparisonEndpoint(state, sourceId);
    if (sourceEndpoint.status !== "available")
      throw new Error(`Source unavailable. ${sourceEndpoint.reason}`);
    assertBranch(sourceEndpoint.revision.manifest.branchId);
    const baseline = getBranchBaseline(state, destinationBranchId);
    if (!baseline)
      throw new Error(
        "The active working branch has no saved baseline. Save a revision before reviewing an application preview.",
      );
    const destinationEndpoint = comparisonEndpoint(state, baseline.revisionId);
    if (destinationEndpoint.status !== "available")
      throw new Error(
        `Destination baseline unavailable. ${destinationEndpoint.reason}`,
      );
    if (sourceId === baseline.revisionId)
      throw new Error(
        `${sourceId} is already the latest saved revision of this branch; there is nothing to bring back or apply.`,
      );
    const graph = layoutRevisions(state, destinationBranchId);
    const sourceAncestors = ancestryOf(graph, sourceId);
    const destinationAncestors = ancestryOf(graph, baseline.revisionId);
    const baseId = [...destinationAncestors].find((id) =>
      sourceAncestors.has(id),
    );
    if (!baseId)
      throw new Error(
        "No trustworthy shared ancestor could be established. Parent history may be missing, damaged, ambiguous, cyclic, or disconnected. No application plan was guessed.",
      );
    if (mode === "merge" && baseId === sourceId)
      throw new Error(
        `${sourceId} is an earlier revision in this branch's history, so applying it would change nothing. Use "Bring back" to restore files from it.`,
      );
    if (mode === "revert" && baseId !== sourceId)
      throw new Error(
        `${sourceId} is not an earlier revision in this branch's history. Bringing back is only for earlier revisions in the same history; use Apply changes instead.`,
      );
    const parents = new Map(
      graph.edges.map((edge) => [edge.child, edge.parent]),
    );
    const validatePath = (start: string) => {
      let id = start;
      const seen = new Set<string>();
      while (true) {
        if (seen.has(id))
          throw new Error("Cyclic shared ancestry is unavailable.");
        seen.add(id);
        const endpoint = comparisonEndpoint(state, id);
        if (endpoint.status !== "available")
          throw new Error(
            `Shared ancestry unavailable at "${id}". ${endpoint.reason}`,
          );
        assertBranch(endpoint.revision.manifest.branchId);
        if (
          graph.nodes
            .find((node) => node.id === id)
            ?.warnings.some((warning) =>
              /Duplicate|Cyclic|Damaged/.test(warning),
            )
        )
          throw new Error("Shared ancestry is ambiguous or damaged.");
        if (id === baseId) return;
        const parentId = parents.get(id);
        if (!parentId)
          throw new Error(
            "A parent relationship could not be validated. No application plan was guessed.",
          );
        id = parentId;
      }
    };
    validatePath(sourceId);
    validatePath(baseline.revisionId);
    // Revert: the destination baseline is the base, so every difference to the
    // older source is an ordinary, conflict-free source change.
    const baseEndpoint = comparisonEndpoint(
      state,
      mode === "revert" ? baseline.revisionId : baseId,
    );
    if (baseEndpoint.status !== "available")
      throw new Error(`Base unavailable. ${baseEndpoint.reason}`);
    const base = baseEndpoint.revision,
      source = sourceEndpoint.revision,
      destination = destinationEndpoint.revision;
    const sourceDiff = compareSnapshotContents(base.manifest, source.manifest);
    const changes = new Map<string, SourceChange>([
      ...sourceDiff.added.map((file) => [file.path, "added"] as const),
      ...sourceDiff.modified.map(
        (change) => [change.current.path, "modified"] as const,
      ),
      ...sourceDiff.deleted.map((file) => [file.path, "deleted"] as const),
    ]);
    const baseFiles = new Map(
      base.manifest.files.map((file) => [file.path, file]),
    );
    const sourceFiles = new Map(
      source.manifest.files.map((file) => [file.path, file]),
    );
    const destinationFiles = new Map(
      destination.manifest.files.map((file) => [file.path, file]),
    );
    const paths = [
      ...new Set([
        ...baseFiles.keys(),
        ...sourceFiles.keys(),
        ...destinationFiles.keys(),
      ]),
    ].sort();
    const rows: PreviewFileRow[] = paths.map((path) => {
      const b = baseFiles.get(path) ?? null,
        s = sourceFiles.get(path) ?? null,
        d = destinationFiles.get(path) ?? null;
      const evidence = state.components;
      const endpoints = [base, source, destination].map(r => evidence?.revisions[r.manifest.revisionId]);
      let identityBlock: string | undefined;
      if (evidence?.status === 'available') {
        if (endpoints.some((e, index) => !e && [base, source, destination][index].manifest.files.some(f => f.path === path))) identityBlock = 'Component evidence is unavailable at a legacy endpoint. Use a saved revision after its registration boundary.';
        else {
          const ids = endpoints.map(e => e?.files.find(f => f.path === path)?.componentId);
          const presentIds = ids.filter(Boolean);
          if (new Set(presentIds).size > 1) identityBlock = 'Different components occupy this path. Applying across component identities is not supported.';
          for (const componentId of presentIds) {
            if (endpoints.some(e => e?.files.some(f => f.componentId === componentId && f.path !== path))) identityBlock = mode === 'revert' ? 'This file was renamed since that revision. Bringing back cannot undo renames yet. Export that revision, or create a design case from it, to get the older file.' : 'This component has different paths across the saved endpoints. Rename-dependent application is blocked; no destination filename is guessed.';
          }
        }
      }
      return {
        identityBlock,
        path,
        base: b,
        source: s,
        destination: d,
        sourceChange: changes.get(path) ?? null,
        kind: sameFile(s, b)
          ? "no-source-change"
          : sameFile(s, d)
            ? "already-matches"
            : sameFile(d, b)
              ? "available"
              : "conflict",
      };
    });
    return {
      status: "available",
      context: {
        mode,
        projectId: state.project.projectId,
        destinationBranchId,
        base,
        source,
        destination,
        rows,
      },
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** An explicit, ephemeral plan. Unresolved choices retain Destination provisionally.
 * No filesystem access, mutation, durable provenance or authorization for working edits. */
export function buildApplyPreview(
  context: ApplyPreviewContext,
  choices: Record<string, PreviewChoice>,
  reason: string,
): ApplyPreviewPlan {
  const result = new Map(
    context.destination.manifest.files.map((file) => [file.path, { ...file }]),
  );
  const actions: PreviewAction[] = [];
  const blockers: string[] = [];
  const selectable = new Map(
    context.rows
      .filter((row) => row.kind === "available" || row.kind === "conflict")
      .map((row) => [row.path, row]),
  );
  for (const [path, choice] of Object.entries(choices).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!choice.selected) continue;
    const row = selectable.get(path);
    if (
      !row ||
      !["unresolved", "keep-destination", "use-source"].includes(
        choice.decision,
      )
    ) {
      blockers.push(`Invalid source-change selection: ${path}`);
      continue;
    }
    if (row.kind === "available" && choice.decision !== "use-source") {
      blockers.push(`Select the source state explicitly for ${path}.`);
      continue;
    }
    const operation =
      choice.decision === "unresolved"
        ? "unresolved"
        : choice.decision === "keep-destination"
          ? "keep"
          : row.source
            ? row.destination
              ? "replace"
              : "add"
            : "delete";
    if (row.identityBlock && choice.decision !== 'keep-destination') {
      blockers.push(`${path}: ${row.identityBlock}`);
      continue;
    }
    const after =
      choice.decision === "use-source" ? row.source : row.destination;
    if (choice.decision === "use-source") {
      if (row.source) result.set(path, { ...row.source });
      else result.delete(path);
    }
    actions.push({
      path,
      sourceChange: row.sourceChange!,
      decision: choice.decision,
      operation,
      base: copyFile(row.base),
      source: copyFile(row.source),
      before: copyFile(row.destination),
      after: copyFile(after),
    });
  }
  const unresolvedPaths = actions
    .filter((action) => action.decision === "unresolved")
    .map((action) => action.path);
  const directories = new Set(context.destination.manifest.directories);
  const collisions: string[] = [];
  try {
    for (const path of result.keys()) {
      const segments = splitAndValidatePath(path);
      for (let i = 1; i < segments.length; i++)
        directories.add(segments.slice(0, i).join("/"));
    }
    for (const path of result.keys())
      if (directories.has(path))
        collisions.push(`File/directory path collision at "${path}".`);
    collisions.push(
      ...checkCaseInsensitiveCollisions([...result.keys(), ...directories]),
    );
  } catch (error) {
    collisions.push(error instanceof Error ? error.message : String(error));
  }
  if (
    !actions.some((action) =>
      ["add", "replace", "delete"].includes(action.operation),
    )
  )
    blockers.push("Select at least one source change to preview.");
  if (unresolvedPaths.length)
    blockers.push(
      "Resolve every selected conflict before this preview can be ready.",
    );
  if (!reason.trim())
    blockers.push("Enter an engineering reason for the proposed application.");
  if (collisions.length)
    blockers.push(
      "Resolve file/directory path collisions; this result cannot be marked ready.",
    );
  return {
    mode: context.mode,
    projectId: context.projectId,
    sourceRevisionId: context.source.manifest.revisionId,
    destinationRevisionId: context.destination.manifest.revisionId,
    baseRevisionId: context.base.manifest.revisionId,
    destinationBranchId: context.destinationBranchId,
    reason,
    actions,
    resultFiles: [...result.values()].sort((a, b) =>
      a.path.localeCompare(b.path),
    ),
    resultDirectories: [...directories].sort(),
    unresolvedPaths,
    collisions: [...new Set(collisions)],
    blockers,
    ready: blockers.length === 0,
  };
}
