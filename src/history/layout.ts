import type { ReconstructedRevision, VaultState } from "../engine/types";
import { caseLabel, caseLifecycle } from "../engine/case-lifecycle";

export const branchColors = [
  "#087f80",
  "#7060b8",
  "#c16b32",
  "#3174ad",
  "#b04478",
  "#64832c",
];
export interface GraphNode {
  id: string;
  revision: ReconstructedRevision;
  lane: number;
  row: number;
  color: string;
  branchName: string;
  heads: string[];
  latest: boolean;
  warnings: string[];
  /** The revision belongs to a hidden case (shown faded). */
  hidden: boolean;
}
export interface GraphCopy {
  child: string;
  source: string;
  mode: "merge" | "revert";
  sourceBranchName: string;
}
export interface RevisionGraph {
  nodes: GraphNode[];
  branches: {
    id: string;
    name: string;
    color: string;
    headIds: string[];
    current: boolean;
    available?: boolean;
    /** A hidden case (only listed when hidden cases are shown). */
    hidden?: boolean;
  }[];
  edges: { child: string; parent: string; color: string }[];
  /** Secondary provenance links, never topology: a revision saved after files
   * were copied from `source` (merge mode) or brought back from an earlier
   * revision of its own branch (revert mode). Recorded evidence only. */
  copies: GraphCopy[];
  warnings: string[];
  lanes: number;
  latestId: string | null;
}

export interface LayoutOptions {
  /** Leave hidden cases out (History's default view). Their revisions that a
   * shown case branched from or copied from stay, marked hidden, together with
   * their ancestors, so no shown line starts from nowhere. Engine callers
   * leave this off and get the complete graph. */
  hideHiddenCases?: boolean;
}

/** Pure metadata-only projection. No timestamps, file access, or stored state mutations.
 * Parent edges are the sole source of topology. Broken/ambiguous ancestry stays visible.
 */
export function layoutRevisions(
  state: VaultState,
  activeBranchId: string,
  options: LayoutOptions = {},
): RevisionGraph {
  const allBranches = [...state.branches].sort(
    (a, b) =>
      Number(b.isMain) - Number(a.isMain) ||
      a.branchId.localeCompare(b.branchId),
  );
  // The working case is never treated as hidden, even if its record says so.
  const hiddenBranches = new Set(
    allBranches
      .filter(
        (b) =>
          !b.isMain &&
          b.branchId !== activeBranchId &&
          caseLifecycle(state, b.branchId).status === "archived",
      )
      .map((b) => b.branchId),
  );
  const leaveOut = Boolean(options.hideHiddenCases && hiddenBranches.size);
  const branches = leaveOut
    ? allBranches.filter((b) => !hiddenBranches.has(b.branchId))
    : allBranches;
  // Colours follow the complete branch list so they don't change when hidden cases are shown.
  const colorIndex = new Map(allBranches.map((b, i) => [b.branchId, i]));
  const branchLane = new Map(branches.map((b, i) => [b.branchId, i]));
  const records = new Map<string, ReconstructedRevision>();
  const duplicate = new Set<string>();
  for (const revision of [...state.revisions].sort(
    (a, b) =>
      a.manifest.revisionId.localeCompare(b.manifest.revisionId) ||
      a.manifest.summary.localeCompare(b.manifest.summary),
  )) {
    const id = revision.manifest.revisionId;
    if (records.has(id)) duplicate.add(id);
    else records.set(id, revision);
  }
  const warnings: string[] = [];
  const nodeWarnings = new Map<string, string[]>();
  const parent = new Map<string, string>();
  const warn = (id: string, message: string) =>
    nodeWarnings.set(id, [...(nodeWarnings.get(id) ?? []), message]);
  for (const [id, revision] of records) {
    const pid = revision.manifest.parentRevisionId;
    if (duplicate.has(id))
      warn(id, "Duplicate version ID; the history above it is unclear");
    if (revision.integrityStatus === "corrupted")
      warn(id, "Damaged version; the history above it is unchecked");
    if (pid && !records.has(pid)) warn(id, "The earlier version it follows is missing");
    if (
      pid &&
      records.has(pid) &&
      revision.integrityStatus !== "corrupted" &&
      records.get(pid)!.integrityStatus !== "corrupted" &&
      !duplicate.has(id) &&
      !duplicate.has(pid)
    )
      parent.set(id, pid);
    if (pid && records.get(pid)?.integrityStatus === "corrupted")
      warn(id, "The earlier version it follows is damaged");
  }
  // Each node has at most one parent. Detect cycles iteratively, including self-parenting.
  const done = new Set<string>();
  for (const id of records.keys()) {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = id;
    while (cursor && !done.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      chain.push(cursor);
      cursor = parent.get(cursor);
    }
    if (cursor && seen.has(cursor)) {
      for (const member of chain.slice(chain.indexOf(cursor))) {
        parent.delete(member);
        warn(member, "Cyclic parent relationship; edge omitted");
      }
    }
    chain.forEach((member) => done.add(member));
  }
  if (leaveOut) {
    const kept = new Set<string>();
    const keep = (id: string | null | undefined) => {
      let cursor = id ?? undefined;
      while (cursor && records.has(cursor) && !kept.has(cursor)) {
        kept.add(cursor);
        // Follow the drawn edge, or else the recorded parent when it is readable at
        // all (a damaged or duplicate parent stays visible next to its warning).
        const recorded = records.get(cursor)!.manifest.parentRevisionId;
        cursor =
          parent.get(cursor) ??
          (recorded && records.has(recorded) ? recorded : undefined);
      }
    };
    for (const [id, revision] of records)
      if (!hiddenBranches.has(revision.manifest.branchId)) keep(id);
    for (const branch of branches) {
      keep(branch.startingRevisionId);
      keep(state.branchHeads[branch.branchId]);
      state.competingHeads[branch.branchId]?.forEach(keep);
    }
    for (const op of state.applicationOperations ?? []) {
      const child = op.capturedRevisionId;
      if (
        op.status === "captured" &&
        child &&
        records.has(child) &&
        !hiddenBranches.has(records.get(child)!.manifest.branchId)
      )
        keep(op.record?.plan?.sourceRevisionId);
    }
    // Kept revisions include every ancestor, so no kept revision loses its parent edge.
    for (const id of [...records.keys()])
      if (!kept.has(id)) {
        records.delete(id);
        parent.delete(id);
      }
  }
  const children = new Map<string, string[]>();
  for (const [child, pid] of parent)
    children.set(pid, [...(children.get(pid) ?? []), child]);
  const compare = (a: string, b: string) =>
    records.get(a)!.manifest.displayNumber -
      records.get(b)!.manifest.displayNumber || a.localeCompare(b);
  const queue = [...records.keys()]
    .filter((id) => !parent.has(id))
    .sort(compare);
  const ordered: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    ordered.push(id);
    queue.push(...(children.get(id) ?? []));
    queue.sort(compare);
  }
  const lanes = new Map<string, number>();
  const branchEntries = new Set<string>();
  let nextLane = Math.max(1, branchLane.size);
  for (const id of ordered) {
    const revision = records.get(id)!;
    const bid = revision.manifest.branchId;
    if (!branchLane.has(bid)) branchLane.set(bid, nextLane++);
    let lane = branchLane.get(bid)!;
    const pid = parent.get(id);
    if (pid && records.get(pid)!.manifest.branchId === bid) {
      const siblings = (children.get(pid) ?? [])
        .filter((s) => records.get(s)!.manifest.branchId === bid)
        .sort(compare);
      lane = siblings[0] === id ? lanes.get(pid)! : nextLane++;
    } else {
      // Disconnected records and independent entries into the same branch must
      // not sit on a path that would imply an unrecorded parent relationship.
      if (branchEntries.has(bid)) lane = nextLane++;
      branchEntries.add(bid);
    }
    lanes.set(id, lane);
  }
  const candidateHead = state.branchHeads[activeBranchId] ?? null;
  const latestId =
    state.competingHeads[activeBranchId]?.length ||
    state.damagedBranchHeads[activeBranchId] ||
    records.get(candidateHead ?? "")?.integrityStatus === "corrupted" ||
    duplicate.has(candidateHead ?? "")
      ? null
      : candidateHead;
  if (candidateHead && !latestId)
    warnings.push(
      "The latest version cannot be found while this case’s history needs attention.",
    );
  if (latestId && !records.has(latestId))
    warnings.push("The latest version of this case is missing from the readable history.");
  for (const [bid, heads] of Object.entries(state.competingHeads)) {
    if (heads.length)
      warnings.push(
        `${allBranches.find((b) => b.branchId === bid)?.name ?? "Unknown case"} has ${heads.length} latest versions that compete. Saving is blocked until this is resolved.`,
      );
    for (const id of heads) warn(id, "Two latest versions");
  }
  const nodes = ordered.reverse().map((id, row) => {
    const revision = records.get(id)!;
    return {
      id,
      revision,
      row,
      lane: lanes.get(id)!,
      branchName: caseLabel(state, revision.manifest.branchId),
      color:
        branchColors[
          (colorIndex.get(revision.manifest.branchId) ??
            branchLane.get(revision.manifest.branchId) ??
            0) % branchColors.length
        ],
      latest: id === latestId,
      warnings: nodeWarnings.get(id) ?? [],
      hidden: hiddenBranches.has(revision.manifest.branchId),
      heads: branches
        .filter(
          (b) =>
            state.branchHeads[b.branchId] === id ||
            state.competingHeads[b.branchId]?.includes(id),
        )
        .map((b) => caseLabel(state, b.branchId)),
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  // Applied provenance: only a captured operation with a readable, unambiguous
  // revision at both ends yields a link. It never changes lanes, rows or parents.
  const usable = (id: string | undefined): id is string =>
    Boolean(
      id &&
        records.has(id) &&
        !duplicate.has(id) &&
        records.get(id)!.integrityStatus !== "corrupted",
    );
  const copies: GraphCopy[] = [];
  for (const op of state.applicationOperations ?? []) {
    if (op.status !== "captured" || !op.record) continue;
    const child = op.capturedRevisionId;
    const source = op.record.plan?.sourceRevisionId;
    const mode = op.record.plan?.mode === "revert" ? "revert" : "merge";
    if (!usable(child) || !usable(source) || child === source) continue;
    if (copies.some((c) => c.child === child && c.source === source)) continue;
    copies.push({
      child,
      source,
      mode,
      sourceBranchName: caseLabel(state, op.record.sourceBranchId),
    });
  }
  return {
    nodes,
    branches: branches.map((branch) => ({
      id: branch.branchId,
      name: caseLabel(state, branch.branchId),
      color: branchColors[colorIndex.get(branch.branchId)! % branchColors.length],
      current: branch.branchId === activeBranchId,
      ...(hiddenBranches.has(branch.branchId) ? { hidden: true } : {}),
      headIds: [
        ...new Set([
          ...(state.branchHeads[branch.branchId]
            ? [state.branchHeads[branch.branchId]!]
            : []),
          ...(state.competingHeads[branch.branchId] ?? []),
        ]),
      ].filter((id) => records.has(id)),
    })),
    edges: [...parent].map(([child, pid]) => ({
      child,
      parent: pid,
      color: nodeById.get(child)!.color,
    })),
    copies,
    warnings,
    lanes: Math.max(1, ...nodes.map((n) => n.lane + 1)),
    latestId: records.has(latestId ?? "") ? latestId : null,
  };
}

export function ancestryOf(graph: RevisionGraph, headId: string): Set<string> {
  const parent = new Map(graph.edges.map((e) => [e.child, e.parent]));
  const ids = new Set<string>();
  let id: string | undefined = headId;
  while (id && !ids.has(id)) {
    ids.add(id);
    id = parent.get(id);
  }
  return ids;
}

/**
 * What counts as "already in" a version, one step back, for Copy: its parent,
 * plus the source of every earlier Copy saved as that version (usable
 * `graph.copies` links, merge mode). A saved Bring back makes its version equal
 * its source, so its steps back are the Bring back source(s) only: the versions
 * between them, and any copies saved there, no longer count.
 */
function sharedPredecessors(graph: RevisionGraph): Map<string, string[]> {
  const parent = new Map(graph.edges.map((e) => [e.child, e.parent]));
  const merges = new Map<string, string[]>();
  const reverts = new Map<string, string[]>();
  for (const link of graph.copies) {
    const into = link.mode === "revert" ? reverts : merges;
    into.set(link.child, [...(into.get(link.child) ?? []), link.source]);
  }
  const result = new Map<string, string[]>();
  for (const id of new Set([...parent.keys(), ...merges.keys(), ...reverts.keys()])) {
    const back = reverts.get(id);
    result.set(
      id,
      back ?? [...(parent.has(id) ? [parent.get(id)!] : []), ...(merges.get(id) ?? [])],
    );
  }
  return result;
}

function historyFrom(
  predecessors: Map<string, string[]>,
  headId: string,
): Set<string> {
  const ids = new Set<string>();
  const pending = [headId];
  while (pending.length) {
    const id = pending.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    for (const back of predecessors.get(id) ?? []) pending.push(back);
  }
  return ids;
}

/**
 * A version's shared history for Copy: itself and everything it counts as
 * already containing, following `sharedPredecessors` (parent line plus earlier
 * Copies, restarting from the source at a Bring back). Loop-safe, linear.
 */
export function sharedHistoryOf(graph: RevisionGraph, headId: string): Set<string> {
  return historyFrom(sharedPredecessors(graph), headId);
}

export interface CopyBase {
  baseId: string;
  /** True when the base is not on both parent lines, so it was reached through
   * an earlier Copy. */
  viaCopy: boolean;
}

/**
 * The starting point for copying `sourceId` into the branch whose newest
 * version is `destinationHeadId`: the latest version both sides share, where
 * earlier Copies count as shared history and a Bring back restarts from its
 * source. Exactly one latest shared version is used; if copies cross back and
 * forth and there are several candidates (or none), it falls back to the first
 * shared version on the parent lines. Returns null when nothing settles it.
 * Linear in the size of the history.
 */
export function copyBaseOf(
  graph: RevisionGraph,
  sourceId: string,
  destinationHeadId: string,
): CopyBase | null {
  const sourceLine = ancestryOf(graph, sourceId);
  const destinationLine = ancestryOf(graph, destinationHeadId);
  const parentBase = [...destinationLine].find((id) => sourceLine.has(id)) ?? null;
  const predecessors = sharedPredecessors(graph);
  const sourceShared = historyFrom(predecessors, sourceId);
  const shared = [...historyFrom(predecessors, destinationHeadId)].filter((id) =>
    sourceShared.has(id),
  );
  // Shared history is closed downward, so a shared version is non-latest
  // exactly when it is a step back from another shared version.
  const behind = new Set<string>();
  for (const id of shared)
    for (const back of predecessors.get(id) ?? []) if (back !== id) behind.add(back);
  const latest = shared.filter((id) => !behind.has(id));
  if (latest.length === 1) {
    const baseId = latest[0];
    return {
      baseId,
      viaCopy: !(sourceLine.has(baseId) && destinationLine.has(baseId)),
    };
  }
  return parentBase ? { baseId: parentBase, viaCopy: false } : null;
}
