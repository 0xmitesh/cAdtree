import type { FileEntry, VaultState } from "../engine/types";
import { ancestryOf, type RevisionGraph } from "./layout";

export interface FileHistoryRecord {
  kind: "change" | "context" | "unavailable";
  status:
    | "Added"
    | "Modified"
    | "Renamed"
    | "Deleted"
    | "Reintroduced"
    | "Inherited state"
    | "Inherited absence"
    | "History unavailable";
  previousPath?: string;
  file?: FileEntry;
  origins: string[];
}

export function historicalFilePaths(state: VaultState): string[] {
  return [
    ...new Set(
      state.revisions.flatMap((r) => r.manifest.files.map((f) => f.path)),
    ),
  ].sort();
}

export function historicalComponents(state: VaultState): { componentId: string; paths: string[]; label: string }[] {
  if (state.components?.status !== 'available') return [];
  const components = new Map<string, string[]>();
  for (const revision of state.revisions) {
    for (const file of state.components.revisions[revision.manifest.revisionId]?.files ?? []) {
      const paths = components.get(file.componentId) ?? [];
      if (!paths.includes(file.path)) paths.push(file.path);
      components.set(file.componentId, paths);
    }
  }
  return [...components].map(([componentId, paths]) => ({ componentId, paths, label: `${paths[paths.length - 1]} · ${componentId.slice(10, 18)}` })).sort((a,b) => a.label.localeCompare(b.label));
}

/** A read-only projection of complete snapshots. Only validated parent edges from
 * layoutRevisions may establish comparisons or compress unchanged ancestry. */
export function fileHistory(
  state: VaultState,
  graph: RevisionGraph,
  path: string,
  branchId: string | null = null,
  contextId: string | null = null,
  componentId: string | null = null,
): { graph: RevisionGraph; records: Map<string, FileHistoryRecord> } {
  const parent = new Map(graph.edges.map((e) => [e.child, e.parent]));
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const files = new Map(
    graph.nodes.map((n) => [
      n.id,
      n.revision.manifest.files.find((f) => f.path === (componentId
        ? state.components?.revisions[n.id]?.files.find(entry => entry.componentId === componentId)?.path
        : path)),
    ]),
  );
  const records = new Map<string, FileHistoryRecord>();
  const seenFile = new Map<string, boolean>();
  // layoutRevisions supplies a topological order, independent of revision numbers.
  for (const node of [...graph.nodes].reverse()) {
    const pid = parent.get(node.id);
    const file = files.get(node.id);
    const previous = pid ? files.get(pid) : undefined;
    const uncertain =
      Boolean(componentId && (!state.components?.revisions[node.id] || (pid && !state.components?.revisions[pid]))) ||
      node.revision.integrityStatus === "corrupted" ||
      node.warnings.some((w) => /Duplicate|Cyclic/.test(w)) ||
      (node.revision.manifest.parentRevisionId !== null && !pid);
    const trusted =
      node.revision.integrityStatus !== "corrupted" &&
      !node.warnings.some((w) => /Duplicate/.test(w));
    seenFile.set(
      node.id,
      (trusted && Boolean(file)) || Boolean(pid && seenFile.get(pid)),
    );
    if (uncertain) {
      records.set(node.id, {
        kind: "unavailable",
        status: "History unavailable",
        file: trusted ? file : undefined,
        origins: [],
      });
    } else if (file && !previous) {
      records.set(node.id, {
        kind: "change",
        status: pid && seenFile.get(pid) ? "Reintroduced" : "Added",
        file,
        origins: [],
      });
    } else if (file && previous && (file.sha256 !== previous.sha256 || file.path !== previous.path)) {
      records.set(node.id, {
        kind: "change",
        status: file.path !== previous.path ? "Renamed" : "Modified",
        previousPath: file.path !== previous.path ? previous.path : undefined,
        file,
        origins: [],
      });
    } else if (!file && previous) {
      records.set(node.id, {
        kind: "change",
        status: "Deleted",
        file: previous,
        origins: [],
      });
    }
  }
  const warnings = [...graph.warnings];
  if (contextId && nodes.has(contextId) && !records.has(contextId))
    records.set(contextId, {
      kind: "context",
      status: files.get(contextId) ? "Inherited state" : "Inherited absence",
      file: files.get(contextId),
      origins: [],
    });
  for (const branch of state.branches) {
    const id = branch.startingRevisionId;
    if (!id) continue;
    if (!nodes.has(id)) {
      warnings.push(
        `${branch.name}: file inheritance cannot be established; the starting revision is unavailable.`,
      );
      continue;
    }
    // Preserve inherited absence when this case subsequently adds the file.
    // A case that never contained it still has an honestly empty file history.
    const caseHasEvents = graph.nodes.some(
      (node) =>
        node.revision.manifest.branchId === branch.branchId &&
        records.get(node.id)?.kind === "change",
    );
    if (
      !records.has(id) &&
      (files.get(id) || seenFile.get(id) || caseHasEvents)
    )
      records.set(id, {
        kind: "context",
        status: files.get(id) ? "Inherited state" : "Inherited absence",
        file: files.get(id),
        origins: [],
      });
    records.get(id)?.origins.push(branch.name);
  }
  const branch = graph.branches.find((b) => b.id === branchId);
  const scope = branch
    ? new Set(branch.headIds.flatMap((id) => [...ancestryOf(graph, id)]))
    : null;
  const retained = new Set(
    [...records.keys()].filter((id) => !scope || scope.has(id)),
  );
  // Origins of another case alone do not constitute history inside this filter.
  if (![...retained].some((id) => records.get(id)!.kind !== "context"))
    retained.clear();
  const nearest = (start: string | null): string | null => {
    let id = start;
    while (id && !records.has(id)) id = parent.get(id) ?? null;
    return id && retained.has(id) ? id : null;
  };
  const latestId = nearest(graph.latestId);
  const branches = graph.branches.map((b) => ({
    ...b,
    available: b.headIds.length > 0,
    headIds: [
      ...new Set(
        b.headIds.map(nearest).filter((id): id is string => id !== null),
      ),
    ],
  }));
  return {
    records,
    graph: {
      ...graph,
      warnings,
      latestId,
      branches,
      nodes: graph.nodes
        .filter((n) => retained.has(n.id))
        .map((n, row) => ({
          ...n,
          row,
          latest: n.id === latestId,
          heads: branches
            .filter((b) => b.headIds.includes(n.id))
            .map((b) => b.name),
        })),
      edges: graph.nodes.flatMap((n) => {
        if (!retained.has(n.id)) return [];
        const pid = nearest(parent.get(n.id) ?? null);
        return pid ? [{ child: n.id, parent: pid, color: n.color }] : [];
      }),
    },
  };
}
