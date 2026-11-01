import type { ReconstructedRevision, VaultState } from "../engine/types";

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
  }[];
  edges: { child: string; parent: string; color: string }[];
  warnings: string[];
  lanes: number;
  latestId: string | null;
}

/** Pure metadata-only projection. No timestamps, file access, or stored state mutations.
 * Parent edges are the sole source of topology. Broken/ambiguous ancestry stays visible.
 */
export function layoutRevisions(
  state: VaultState,
  activeBranchId: string,
): RevisionGraph {
  const branches = [...state.branches].sort(
    (a, b) =>
      Number(b.isMain) - Number(a.isMain) ||
      a.branchId.localeCompare(b.branchId),
  );
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
      warn(id, "Duplicate revision identity; ancestry is ambiguous");
    if (revision.integrityStatus === "corrupted")
      warn(id, "Damaged revision; ancestry is unverified");
    if (pid && !records.has(pid)) warn(id, "Recorded parent is missing");
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
      warn(id, "Recorded parent is damaged");
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
      "Latest revision cannot be established while the current branch history needs attention.",
    );
  if (latestId && !records.has(latestId))
    warnings.push("The current branch head is missing from readable history.");
  for (const [bid, heads] of Object.entries(state.competingHeads)) {
    if (heads.length)
      warnings.push(
        `${branches.find((b) => b.branchId === bid)?.name ?? "Unknown branch"} has ${heads.length} competing heads. Saving is blocked until resolved.`,
      );
    for (const id of heads) warn(id, "Competing branch head");
  }
  const nodes = ordered.reverse().map((id, row) => {
    const revision = records.get(id)!;
    return {
      id,
      revision,
      row,
      lane: lanes.get(id)!,
      branchName:
        branches.find((b) => b.branchId === revision.manifest.branchId)?.name ??
        "Unknown branch",
      color:
        branchColors[
          (branchLane.get(revision.manifest.branchId) ?? 0) %
            branchColors.length
        ],
      latest: id === latestId,
      warnings: nodeWarnings.get(id) ?? [],
      heads: branches
        .filter(
          (b) =>
            state.branchHeads[b.branchId] === id ||
            state.competingHeads[b.branchId]?.includes(id),
        )
        .map((b) => b.name),
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return {
    nodes,
    branches: branches.map((branch, index) => ({
      id: branch.branchId,
      name: branch.name,
      color: branchColors[index % branchColors.length],
      current: branch.branchId === activeBranchId,
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
