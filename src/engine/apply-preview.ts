import type { FileEntry, ReconstructedRevision, ScanResult, VaultState } from "./types";
import { hashString } from "./hash";
import { formatRevisionNumber } from "./vault-service";
import { getBranchBaseline } from "./branch-state";
import {
  compareSnapshotContents,
  comparisonEndpoint,
} from "./snapshot-comparison";
import {
  ancestryOf,
  copyBaseOf,
  layoutRevisions,
  sharedHistoryOf,
} from "../history/layout";
import { componentWriteBlock } from './component-identity';
import {
  checkCaseInsensitiveCollisions,
  splitAndValidatePath,
} from "./fs-adapter";

export type SourceChange = "added" | "modified" | "deleted";
export type ConflictDecision = "unresolved" | "keep-destination" | "use-source";
/** Shown beside a folder row that cannot be removed because it would still hold something. */
export const FOLDER_KEPT_MESSAGE = "Kept: still holds files";
export interface PreviewFileRow {
  /** "file" rows describe one tracked file; "folder" rows one folder that was added or
   * removed between base and source (empty folders included). The path is the key of
   * `choices` for both; a file and a folder never share a path. */
  entry: "file" | "folder";
  identityBlock?: string;
  path: string;
  /** "kept-holds-files": a folder removal that the destination's own files make
   * impossible whatever is selected. Never selectable. Folder rows only. */
  kind:
    | "no-source-change"
    | "already-matches"
    | "available"
    | "conflict"
    | "kept-holds-files";
  sourceChange: SourceChange | null;
  /** Always null for folder rows. */
  base: FileEntry | null;
  source: FileEntry | null;
  destination: FileEntry | null;
  /** Folder rows only: presence of the folder in each endpoint. */
  folder?: { inBase: boolean; inSource: boolean; inDestination: boolean };
}
export type ApplyMode = "merge" | "revert";
export interface ApplyPreviewContext {
  mode: ApplyMode;
  projectId: string;
  destinationBranchId: string;
  base: ReconstructedRevision;
  source: ReconstructedRevision;
  destination: ReconstructedRevision;
  /** Copy only: the base was reached through an earlier Copy, not the parent
   * line alone. Display only; nothing is stored. */
  baseViaCopy: boolean;
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
/** A folder to create ("added" in the source) or remove ("deleted" in the source). */
export interface PreviewFolderAction {
  path: string;
  operation: "create" | "remove";
  sourceChange: "added" | "deleted";
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
  /** Selected folder changes, sorted by path. */
  folderActions: PreviewFolderAction[];
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

/**
 * Folder rows: one per folder that differs between base and source (empty folders
 * included). Folders have no conflicts and no identity. A removal is "kept" up front
 * ("kept-holds-files") when the destination holds something below the folder that no
 * selection can remove: a destination file the source does not delete (or whose
 * deletion is blocked), or a subfolder that is itself kept or not being removed.
 * buildApplyPreview decides the exact outcome against the real selections.
 */
function folderRows(
  base: ReconstructedRevision,
  source: ReconstructedRevision,
  destination: ReconstructedRevision,
  fileRows: PreviewFileRow[],
): PreviewFileRow[] {
  const diff = compareSnapshotContents(base.manifest, source.manifest);
  const baseDirs = new Set(base.manifest.directories);
  const sourceDirs = new Set(source.manifest.directories);
  const destDirs = new Set(destination.manifest.directories);
  const fileRowByPath = new Map(fileRows.map((row) => [row.path, row]));
  // A file row can remove its destination file only if the source deletes it and
  // the removal is selectable.
  const removableFile = (path: string) => {
    const row = fileRowByPath.get(path);
    return Boolean(
      row &&
        !row.source &&
        row.base &&
        (row.kind === "available" || row.kind === "conflict") &&
        !row.identityBlock,
    );
  };
  const depth = (path: string) => path.split("/").length;
  const removable = new Set<string>();
  const kept = new Set<string>();
  const deleted = diff.deletedDirectories
    .filter((path) => destDirs.has(path) && !fileRowByPath.has(path))
    .sort((a, b) => depth(b) - depth(a) || a.localeCompare(b));
  for (const path of deleted) {
    const prefix = `${path}/`;
    const holdsFile = destination.manifest.files.some(
      (file) => file.path.startsWith(prefix) && !removableFile(file.path),
    );
    const holdsFolder = [...destDirs].some(
      (dir) => dir.startsWith(prefix) && !removable.has(dir),
    );
    (holdsFile || holdsFolder ? kept : removable).add(path);
  }
  const rows: PreviewFileRow[] = [];
  const folderRow = (
    path: string,
    sourceChange: "added" | "deleted",
    kind: PreviewFileRow["kind"],
  ): PreviewFileRow => ({
    entry: "folder",
    path,
    kind,
    sourceChange,
    base: null,
    source: null,
    destination: null,
    folder: {
      inBase: baseDirs.has(path),
      inSource: sourceDirs.has(path),
      inDestination: destDirs.has(path),
    },
  });
  // A path that is a file in some endpoint keeps its file row; the folder row is
  // skipped so `choices` stays unambiguous (the files carry the change).
  for (const path of diff.addedDirectories)
    if (!fileRowByPath.has(path))
      rows.push(
        folderRow(path, "added", destDirs.has(path) ? "already-matches" : "available"),
      );
  for (const path of diff.deletedDirectories)
    if (!fileRowByPath.has(path))
      rows.push(
        folderRow(
          path,
          "deleted",
          !destDirs.has(path)
            ? "already-matches"
            : kept.has(path)
              ? "kept-holds-files"
              : "available",
        ),
      );
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

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
        throw new Error(`Case identity "${id}" is missing or ambiguous.`);
    };
    assertBranch(destinationBranchId);
    const sourceEndpoint = comparisonEndpoint(state, sourceId);
    if (sourceEndpoint.status !== "available")
      throw new Error(`Source unavailable. ${sourceEndpoint.reason}`);
    assertBranch(sourceEndpoint.revision.manifest.branchId);
    const baseline = getBranchBaseline(state, destinationBranchId);
    if (!baseline)
      throw new Error(
        "The active case has no saved version. Save a version before reviewing this change.",
      );
    const destinationEndpoint = comparisonEndpoint(state, baseline.revisionId);
    if (destinationEndpoint.status !== "available")
      throw new Error(
        `The destination’s saved version is unavailable. ${destinationEndpoint.reason}`,
      );
    const versionLabel = formatRevisionNumber(
      sourceEndpoint.revision.manifest.displayNumber,
    );
    if (sourceId === baseline.revisionId)
      throw new Error(
        `${versionLabel} is already the latest saved version of this case; there is nothing to bring back or copy.`,
      );
    const graph = layoutRevisions(state, destinationBranchId);
    // Revert uses the parent line only. Copy also counts earlier Copies as
    // shared history (`copyBaseOf`), and falls back to the parent line when
    // that is ambiguous.
    const sourceAncestors = ancestryOf(graph, sourceId);
    const parentBaseId = [...ancestryOf(graph, baseline.revisionId)].find(
      (id) => sourceAncestors.has(id),
    );
    const copyBase =
      mode === "merge"
        ? copyBaseOf(graph, sourceId, baseline.revisionId)
        : null;
    const baseId = copyBase?.baseId ?? parentBaseId;
    const baseViaCopy = copyBase?.viaCopy ?? false;
    if (!baseId)
      throw new Error(
        "cAdtree could not find a common starting version. The history may be missing, damaged or unclear. No plan was guessed.",
      );
    if (mode === "merge" && baseId === sourceId)
      throw new Error(
        baseViaCopy
          ? `Everything in ${versionLabel} is already in this case from an earlier copy. There's nothing new to copy.`
          : `${versionLabel} is an earlier version in this case's history, so copying it would change nothing. Use "Bring back" to put its files back.`,
      );
    if (mode === "revert" && baseId !== sourceId)
      throw new Error(
        `${versionLabel} is not an earlier version in this case's history. Bringing back is only for earlier versions of the same case; use "Copy files from…" to take changes from another case.`,
      );
    const parents = new Map(
      graph.edges.map((edge) => [edge.child, edge.parent]),
    );
    const checkVersion = (id: string) => {
      const endpoint = comparisonEndpoint(state, id);
      if (endpoint.status !== "available")
        throw new Error(
          `The shared history is unavailable at "${id}". ${endpoint.reason}`,
        );
      assertBranch(endpoint.revision.manifest.branchId);
      if (
        graph.nodes
          .find((node) => node.id === id)
          ?.warnings.some((warning) =>
            /Duplicate|Cyclic|Damaged/.test(warning),
          )
      )
        throw new Error("The shared history is unclear or damaged.");
    };
    const validatePath = (start: string) => {
      let id = start;
      const seen = new Set<string>();
      while (true) {
        if (seen.has(id))
          throw new Error("The shared history loops back on itself.");
        seen.add(id);
        checkVersion(id);
        if (id === baseId) return;
        const parentId = parents.get(id);
        if (!parentId)
          throw new Error(
            "A link between versions could not be checked. No plan was guessed.",
          );
        id = parentId;
      }
    };
    if (baseViaCopy) {
      // Every version on the way from either end to the base, through earlier
      // copies too, must be readable and unambiguous.
      const baseHistory = sharedHistoryOf(graph, baseId);
      checkVersion(baseId);
      for (const head of [sourceId, baseline.revisionId])
        for (const id of sharedHistoryOf(graph, head))
          if (!baseHistory.has(id)) checkVersion(id);
    } else {
      validatePath(sourceId);
      validatePath(baseline.revisionId);
    }
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
        if (endpoints.some((e, index) => !e && [base, source, destination][index].manifest.files.some(f => f.path === path))) identityBlock = 'File records are unavailable for an older version. Use a version saved after file tracking was turned on.';
        else {
          const ids = endpoints.map(e => e?.files.find(f => f.path === path)?.componentId);
          const presentIds = ids.filter(Boolean);
          if (new Set(presentIds).size > 1) identityBlock = 'Different files use this path in these versions. This is not supported.';
          for (const componentId of presentIds) {
            if (endpoints.some(e => e?.files.some(f => f.componentId === componentId && f.path !== path))) identityBlock = mode === 'revert' ? 'This file was renamed since that version. Bringing back cannot undo renames yet. Export that version, or create a design case from it, to get the older file.' : 'This file has different names in these versions, so it is blocked; no file name is guessed.';
          }
        }
      }
      return {
        entry: "file" as const,
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
    rows.push(...folderRows(base, source, destination, rows));
    return {
      status: "available",
      context: {
        mode,
        projectId: state.project.projectId,
        destinationBranchId,
        base,
        source,
        destination,
        baseViaCopy,
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
  const isFolder = (row: PreviewFileRow) => row.entry === "folder";
  const selectable = new Map(
    context.rows
      .filter((row) => row.kind === "available" || row.kind === "conflict")
      .map((row) => [row.path, row]),
  );
  const keptFolders = new Set(
    context.rows
      .filter((row) => isFolder(row) && row.kind === "kept-holds-files")
      .map((row) => row.path),
  );
  const folderActions: PreviewFolderAction[] = [];
  for (const [path, choice] of Object.entries(choices).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!choice.selected) continue;
    if (keptFolders.has(path)) {
      blockers.push(`${path}: ${FOLDER_KEPT_MESSAGE}; untick it.`);
      continue;
    }
    const row = selectable.get(path);
    if (row && isFolder(row)) {
      if (choice.decision !== "use-source") {
        blockers.push(`Select the source state explicitly for ${path}.`);
        continue;
      }
      folderActions.push({
        path,
        operation: row.sourceChange === "added" ? "create" : "remove",
        sourceChange: row.sourceChange as "added" | "deleted",
      });
      continue;
    }
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
  // Result folders = destination folders + selected created folders + the parents
  // that result files and created folders need - selected removed folders. A
  // selected removal whose folder still has a result file or a surviving result
  // subfolder below it is a blocker: cAdtree never deletes a folder that is not
  // empty in the result (the source deletes files only when they are selected).
  const directories = new Set(context.destination.manifest.directories);
  const collisions: string[] = [];
  const caseClashInput: string[] = [];
  const created = folderActions.filter((a) => a.operation === "create");
  const removed = new Set(
    folderActions.filter((a) => a.operation === "remove").map((a) => a.path),
  );
  try {
    for (const action of created) directories.add(action.path);
    for (const path of [
      ...result.keys(),
      ...created.map((action) => action.path),
    ]) {
      const segments = splitAndValidatePath(path);
      for (let i = 1; i < segments.length; i++)
        directories.add(segments.slice(0, i).join("/"));
    }
    for (const path of removed) {
      splitAndValidatePath(path);
      const prefix = `${path}/`;
      if (
        [...result.keys()].some((file) => file.startsWith(prefix)) ||
        [...directories].some((dir) => dir.startsWith(prefix) && !removed.has(dir))
      )
        blockers.push(`${path}: ${FOLDER_KEPT_MESSAGE}; untick it.`);
    }
    // Case-only clashes are judged before removals: a removed folder still exists
    // when the apply writes (a case-only rename cannot be written safely).
    caseClashInput.push(...directories);
    for (const path of removed) directories.delete(path);
    for (const path of result.keys())
      if (directories.has(path))
        collisions.push(`File/directory path collision at "${path}".`);
    collisions.push(
      ...checkCaseInsensitiveCollisions([...result.keys(), ...caseClashInput]),
    );
  } catch (error) {
    collisions.push(error instanceof Error ? error.message : String(error));
  }
  if (
    !folderActions.length &&
    !actions.some((action) =>
      ["add", "replace", "delete"].includes(action.operation),
    )
  )
    blockers.push("Select at least one source change to preview.");
  if (unresolvedPaths.length)
    blockers.push(
      "Resolve every selected conflict before this preview can be ready.",
    );
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
    folderActions,
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

// ---------------------------------------------------------------------------
// Replace plans: Discard (and, later, Get this version)
// ---------------------------------------------------------------------------

/**
 * Operations that make selected working paths match a saved revision without
 * saving: "discard" (target = the branch's latest revision) and, later,
 * "restore-file" (one file from an older revision). They reuse the Apply records,
 * staging, events and recovery, but their plan starts from the CURRENT working
 * bytes (a full-hash scan), not from a manifest.
 */
export type ReplaceMode = "discard" | "restore-file";
export const isReplaceMode = (mode: unknown): mode is ReplaceMode =>
  mode === "discard" || mode === "restore-file";

/**
 * A replace plan in the Apply record shape: base = before = the current working
 * file (null if it is missing), source = after = the target revision's file (null
 * if the target does not have it), decision "use-source". `sourceRevisionId` is
 * the target; `destinationRevisionId` and `baseRevisionId` are the branch's
 * latest saved revision. Folder actions: "create" for a folder the target has and
 * the working folder lacks (missing parents of written files included), "remove"
 * for one the working folder has and the target lacks.
 */
export interface ReplacePlan {
  mode: ReplaceMode;
  projectId: string;
  sourceRevisionId: string;
  destinationRevisionId: string;
  baseRevisionId: string;
  destinationBranchId: string;
  reason: string;
  actions: PreviewAction[];
  folderActions: PreviewFolderAction[];
  /**
   * Get this version: the component of the file in the target revision, when
   * component tracking has evidence for it (capture keeps this identity).
   */
  componentId?: string;
  blockers: string[];
  ready: boolean;
}

/**
 * Discard / Get this version refused because the working files no longer match
 * the plan the user confirmed (or something appeared in a folder it removes).
 * Nothing was changed; the caller builds a fresh plan and asks again. UI code
 * recognises it with `instanceof`, never by its text.
 */
export class ReplacePlanChangedError extends Error {
  constructor(paths: readonly string[] = []) {
    super(
      paths.length
        ? `Changes differ from what you saw: ${paths.join(", ")}. Review again. Nothing was changed.`
        : "Changes differ from what you saw; review again. Nothing was changed.",
    );
    this.name = "ReplacePlanChangedError";
  }
}

const sameBytes = (a: FileEntry | null, b: FileEntry | null) =>
  a && b ? a.sha256 === b.sha256 && a.size === b.size : a === b;
const isBelow = (path: string, folder: string) => path.startsWith(`${folder}/`);
const related = (a: string, b: string) =>
  a === b || isBelow(a, b) || isBelow(b, a);

/**
 * Read-only. Builds the plan that makes each selected path (a file or a folder;
 * a folder brings everything below it that differs) match `targetRevisionId`.
 * `scan` must be a full-hash scan of the branch's working folder that keeps OS
 * clutter (see `scanForReplace`), so clutter inside a folder being removed is
 * moved to the kept copy instead of being left behind or deleted. Unselected
 * unsaved changes are not part of the plan and never block it.
 */
export function buildReplacePlan(
  state: VaultState,
  scan: ScanResult,
  targetRevisionId: string,
  paths: readonly string[],
  mode: ReplaceMode = "discard",
): ReplacePlan {
  const blockers: string[] = [];
  const branchId = scan.branchId;
  let baselineId = "";
  const fileActions = new Map<string, PreviewAction>();
  const creates = new Set<string>();
  const removes = new Set<string>();
  let componentId: string | undefined;
  try {
    if (!isReplaceMode(mode)) throw new Error(`Unknown replace mode "${String(mode)}".`);
    const identityBlock = componentWriteBlock(state);
    if (identityBlock) throw new Error(identityBlock);
    const baseline = getBranchBaseline(state, branchId);
    if (!baseline)
      throw new Error("This case has no saved version yet, so there is nothing to go back to.");
    baselineId = baseline.revisionId;
    if (scan.baselineRevisionId !== baseline.revisionId)
      throw new Error("Changes differ from what you saw; review again.");
    if (mode === "discard" && targetRevisionId !== baseline.revisionId)
      throw new Error("Discard goes back to the latest saved version of this case only.");
    const endpoint = comparisonEndpoint(state, targetRevisionId);
    if (endpoint.status !== "available")
      throw new Error(`The saved version is unavailable. ${endpoint.reason}`);
    const target = endpoint.revision.manifest;
    const workingFiles = new Map<string, FileEntry>(
      [...scan.added, ...scan.modified.map((m) => m.current), ...scan.unchanged].map(
        (file) => [file.path, file],
      ),
    );
    const workingDirs = new Set(scan.directories);
    const targetFiles = new Map(target.files.map((file) => [file.path, file]));
    const targetDirs = new Set(target.directories);
    const addFile = (path: string, explicit: boolean) => {
      if (fileActions.has(path)) return;
      const before = workingFiles.get(path) ?? null;
      const after = targetFiles.get(path) ?? null;
      if (sameBytes(before, after)) {
        if (explicit)
          blockers.push(
            mode === "restore-file"
              ? `${path} already matches that version.`
              : `${path} has no unsaved change.`,
          );
        return;
      }
      fileActions.set(path, {
        path,
        sourceChange: !before ? "added" : !after ? "deleted" : "modified",
        decision: "use-source",
        operation: after ? (before ? "replace" : "add") : "delete",
        base: copyFile(before),
        source: copyFile(after),
        before: copyFile(before),
        after: copyFile(after),
      });
    };
    if (mode === "restore-file") {
      // Get this version puts one file back; it never removes anything.
      if (paths.length !== 1) throw new Error("Get this version takes one file.");
      const [path] = paths;
      splitAndValidatePath(path);
      if (!targetFiles.has(path))
        throw new Error(`That version has no file at ${path}.`);
      componentId = restoredComponent(state, target.revisionId, baseline.revisionId, path);
      // The same component already put back at another path (and still there,
      // unchanged) would give two files one identity at the next save.
      const elsewhere = componentId
        ? (state.applicationOperations ?? []).flatMap((op) => {
            const plan = op.record?.plan;
            const action = plan?.actions.find((a) => a.after);
            const current = action && workingFiles.get(action.path);
            return op.status === "done" &&
              op.destinationBranchId === branchId &&
              plan?.mode === "restore-file" &&
              plan.componentId === componentId &&
              plan.destinationRevisionId === baseline.revisionId &&
              action!.path !== path &&
              current &&
              sameBytes(current, action!.after)
              ? [action!.path]
              : [];
          })
        : [];
      if (elsewhere.length)
        throw new Error(`This file is already back as ${elsewhere[0]}. Save or discard that first.`);
    }
    for (const path of [...new Set(paths)].sort()) {
      splitAndValidatePath(path);
      const isFile = workingFiles.has(path) || targetFiles.has(path);
      const isDir = workingDirs.has(path) || targetDirs.has(path);
      if (isFile && isDir) {
        blockers.push(`File/folder clash at "${path}".`);
        continue;
      }
      if (isFile) {
        addFile(path, true);
        continue;
      }
      const inWorking = workingDirs.has(path),
        inTarget = targetDirs.has(path);
      if (!inWorking && !inTarget) {
        blockers.push(`Nothing to discard at ${path}.`);
        continue;
      }
      // The folder itself if it differs, and everything below it that differs
      // (folders on one side only, files that differ), OS clutter included.
      let differs = inWorking !== inTarget;
      if (inWorking && !inTarget) removes.add(path);
      if (inTarget && !inWorking) creates.add(path);
      for (const dir of new Set([...workingDirs, ...targetDirs])) {
        if (!isBelow(dir, path)) continue;
        if (workingDirs.has(dir) === targetDirs.has(dir)) continue;
        (workingDirs.has(dir) ? removes : creates).add(dir);
        differs = true;
      }
      for (const file of new Set([...workingFiles.keys(), ...targetFiles.keys()])) {
        if (!isBelow(file, path)) continue;
        if (!sameBytes(workingFiles.get(file) ?? null, targetFiles.get(file) ?? null)) differs = true;
        addFile(file, false);
      }
      if (!differs) blockers.push(`${path} has no unsaved change.`);
    }
    // Every missing parent of a written file or created folder is created
    // explicitly, so recovery knows exactly which folders this operation made.
    for (const path of [
      ...[...fileActions.values()].filter((a) => a.after).map((a) => a.path),
      ...creates,
    ]) {
      const segments = path.split("/");
      for (let i = 1; i < segments.length; i++) {
        const parent = segments.slice(0, i).join("/");
        if (workingFiles.has(parent))
          blockers.push(`File/folder clash at "${parent}".`);
        else if (removes.has(parent))
          blockers.push(`${parent} is removed but ${path} needs it.`);
        else if (!workingDirs.has(parent)) creates.add(parent);
      }
    }
    for (const folder of creates)
      if (workingFiles.has(folder))
        blockers.push(`File/folder clash at "${folder}".`);
    // A folder is removed only if nothing would remain in it.
    for (const folder of removes) {
      const remains =
        [...workingFiles.keys()].some(
          (file) => isBelow(file, folder) && fileActions.get(file)?.after !== null,
        ) || [...workingDirs].some((dir) => isBelow(dir, folder) && !removes.has(dir));
      if (remains) blockers.push(`${folder} still holds files that are not discarded.`);
    }
    // Unreadable entries block only where they touch the selection.
    const touched = [...fileActions.keys(), ...creates, ...removes];
    for (const error of scan.errors)
      if (touched.some((path) => related(path, error.path)))
        blockers.push(`Can't read ${error.path}: ${error.error}`);
    // A written name must not clash (case only) with an entry that stays.
    const staying = [
      ...[...workingFiles.keys()].filter((path) => fileActions.get(path)?.after !== null),
      ...[...workingDirs].filter((dir) => !removes.has(dir)),
    ];
    const byKey = new Map(staying.map((path) => [path.toLowerCase(), path]));
    for (const path of [
      ...[...fileActions.values()].filter((a) => a.after && !a.before).map((a) => a.path),
      ...creates,
    ]) {
      const other = byKey.get(path.toLowerCase());
      if (other && other !== path)
        blockers.push(`Case-insensitive path collision between "${other}" and "${path}".`);
    }
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }
  const actions = [...fileActions.values()].sort((a, b) => a.path.localeCompare(b.path));
  const folderActions: PreviewFolderAction[] = [
    ...[...creates].map((path) => ({ path, operation: "create" as const, sourceChange: "added" as const })),
    ...[...removes].map((path) => ({ path, operation: "remove" as const, sourceChange: "deleted" as const })),
  ].sort((a, b) => a.path.localeCompare(b.path));
  if (!blockers.length && !actions.length && !folderActions.length)
    blockers.push("Nothing selected to discard.");
  const unique = [...new Set(blockers)];
  return {
    mode,
    projectId: state.project.projectId,
    sourceRevisionId: targetRevisionId,
    destinationRevisionId: baselineId,
    baseRevisionId: baselineId,
    destinationBranchId: branchId,
    reason: "",
    actions,
    folderActions,
    ...(componentId ? { componentId } : {}),
    blockers: unique,
    ready: unique.length === 0,
  };
}

/**
 * Get this version: the component the file had in the target revision, checked
 * against the latest saved revision of the case. Throws (a blocker) when that
 * component now lives at another path (renamed since) or another component now
 * uses the path: identity is never guessed or swapped. Undefined when there is
 * no component evidence for the file in the target (tracking off, or a revision
 * from before it was enabled): capture then treats it like any other file.
 */
function restoredComponent(
  state: VaultState,
  targetRevisionId: string,
  baselineRevisionId: string,
  path: string,
): string | undefined {
  const evidence = state.components;
  if (evidence?.status !== "available") return undefined;
  const componentId = evidence.revisions[targetRevisionId]?.files.find(
    (file) => file.path === path,
  )?.componentId;
  if (!componentId) return undefined;
  const current = evidence.revisions[baselineRevisionId];
  if (!current)
    throw new Error(
      "File records are unavailable for the latest saved version of this case. Export that version to get the older file.",
    );
  if (current.files.some((file) => file.componentId === componentId && file.path !== path))
    throw new Error(
      "This file was renamed since that version. Get this version cannot follow renames yet. Export that version, or create a design case from it, to get the older file.",
    );
  const occupant = current.files.find((file) => file.path === path)?.componentId;
  if (occupant && occupant !== componentId)
    throw new Error(
      "A different file now uses this name. Get this version cannot swap file identities yet. Export that version, or create a design case from it, to get the older file.",
    );
  return componentId;
}

/**
 * The hash a replace confirmation carries. A file's modification date is left
 * out (touching a file without changing its bytes is not a different plan);
 * paths, sizes and checksums are all in.
 */
export function replacePlanHash(plan: ReplacePlan): string {
  const bytes = (file: FileEntry | null) =>
    file ? { path: file.path, size: file.size, sha256: file.sha256 } : null;
  return hashString(
    JSON.stringify({
      ...plan,
      actions: plan.actions.map((action) => ({
        ...action,
        base: bytes(action.base),
        source: bytes(action.source),
        before: bytes(action.before),
        after: bytes(action.after),
      })),
    }),
  );
}

/** True when the plan keeps something in Discarded/ (a file with unsaved bytes or a folder it removes). */
export function replaceKeepsCopy(plan: Pick<ReplacePlan, "actions" | "folderActions">): boolean {
  return (
    plan.actions.some((action) => action.before !== null) ||
    plan.folderActions.some((action) => action.operation === "remove")
  );
}
