import { useEffect, useId, useMemo, useRef } from "react";
import { GitBranch } from "lucide-react";
import { type RevisionGraph as Graph } from "../history/layout";
import { formatRevisionNumber } from "../engine/vault-service";
import type { FileHistoryRecord } from "../history/file-history";
import { formatTimestamp } from "../utils/format";

const NODE_RADIUS = 22;
const revisionName = (graph: Graph, id: string) => {
  const node = graph.nodes.find((n) => n.id === id);
  return node ? formatRevisionNumber(node.revision.manifest.displayNumber) : null;
};
/** Plain wording for a recorded copy, e.g. "copied from V10". */
function copyNotes(graph: Graph, childId: string): string[] {
  return graph.copies
    .filter((c) => c.child === childId)
    .flatMap((c) => {
      const name = revisionName(graph, c.source);
      if (!name) return [];
      return [c.mode === "revert" ? `brought back ${name}` : `copied from ${name}`];
    });
}

export function RevisionGraph({
  graph,
  selectedId,
  onSelect,
  mode,
  highlightBranchId,
  onHighlightBranch,
  fileRecords,
}: {
  graph: Graph;
  selectedId: string | null;
  onSelect: (id: string) => void;
  mode: "graph" | "list";
  highlightBranchId: string | null;
  onHighlightBranch: (id: string | null) => void;
  fileRecords?: Map<string, FileHistoryRecord>;
}) {
  const rowHeight = fileRecords ? 140 : 104;
  const viewport = useRef<HTMLDivElement>(null);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const centeredStructure = useRef<string | null>(null);
  const markerPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const highlightedBranch = graph.branches.find(
    (branch) => branch.id === highlightBranchId,
  );
  // Case emphasis is a light accent on the case's own revisions (not the earlier
  // history it branched from); nothing is faded. A case with no revisions of its
  // own yet marks its head, the starting revision. File history uses the chips as
  // an ancestry filter instead (applied upstream), so it gets no accent.
  const ancestry = useMemo(() => {
    if (!highlightedBranch || fileRecords) return null;
    const own = graph.nodes
      .filter((node) => node.revision.manifest.branchId === highlightedBranch.id)
      .map((node) => node.id);
    return new Set(own.length ? own : highlightedBranch.headIds);
  }, [graph, highlightedBranch, fileRecords]);
  // Graph and list both read newest first; the graph's arrows point down to parents.
  const visualNodes = graph.nodes;
  const positions = new Map(
    visualNodes.map((node, index) => [
      node.id,
      { x: 60 + node.lane * 76, y: 62 + index * rowHeight },
    ]),
  );
  const labelX = 104 + (graph.lanes - 1) * 76;
  const width = Math.max(490, labelX + 350);
  const height = Math.max(300, graph.nodes.length * rowHeight + 28);
  const edgeColors = [...new Set(graph.edges.map((edge) => edge.color))];
  const hiddenNode = new Set(
    graph.nodes.filter((node) => node.hidden).map((node) => node.id),
  );
  const register = (id: string, element: HTMLButtonElement | null) => {
    if (element) refs.current.set(id, element);
    else refs.current.delete(id);
  };
  const reveal = (id: string, focus = false) => {
    const button = refs.current.get(id);
    if (focus) button?.focus({ preventScroll: true });
    // Scroll only the graph's own viewport, keeping the surrounding page still.
    const position = positions.get(id);
    if (mode === "graph" && viewport.current && position) {
      viewport.current.scrollTo({
        top: Math.max(0, position.y - viewport.current.clientHeight / 2),
        left: Math.max(0, position.x - viewport.current.clientWidth / 3),
      });
    } else {
      button?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };
  // Imperative positioning after entering the diagram; selection itself remains shared.
  useEffect(() => {
    const structure = `${mode}:${graph.nodes.map((n) => n.id).join(":")}`;
    if (centeredStructure.current === structure) return;
    centeredStructure.current = structure;
    if (mode !== "graph") return;
    const button = refs.current.get(selectedId ?? "");
    const container = viewport.current;
    if (button && container) {
      const index = graph.nodes.findIndex((node) => node.id === selectedId);
      if (index >= 0)
        container.scrollTop = Math.max(
          0,
          62 + index * rowHeight - container.clientHeight / 2,
        );
    }
  }, [mode, graph.nodes, selectedId, rowHeight]);
  const keyboard = (event: React.KeyboardEvent, index: number) => {
    let next: number;
    if (event.key === "ArrowDown" || event.key === "ArrowRight")
      next = Math.min(visualNodes.length - 1, index + 1);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft")
      next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = visualNodes.length - 1;
    else return;
    event.preventDefault();
    const id = visualNodes[next].id;
    onSelect(id);
    reveal(id, true);
  };
  const toggleBranch = (id: string) => {
    if (highlightBranchId === id) {
      onHighlightBranch(null);
      return;
    }
    onHighlightBranch(id);
    // Outside File history a case chip also selects the case's latest revision.
    const head = fileRecords
      ? undefined
      : graph.branches.find((branch) => branch.id === id)?.headIds[0];
    if (head) {
      onSelect(head);
      reveal(head);
    }
  };
  const changeCount = fileRecords
    ? graph.nodes.filter((n) => fileRecords.get(n.id)?.kind === "change").length
    : 0;
  const unavailableCount = fileRecords
    ? graph.nodes.filter((n) => fileRecords.get(n.id)?.kind === "unavailable")
        .length
    : 0;
  return (
    <section
      className="history-canvas"
      aria-label={mode === "graph" ? "Version graph" : "Version list"}
      style={
        ancestry && highlightedBranch
          ? ({ "--case-color": highlightedBranch.color } as React.CSSProperties)
          : undefined
      }
    >
      <div className="canvas-bar">
        <span>
          {fileRecords
            ? `${changeCount} ${changeCount === 1 ? "change" : "changes"} to this file`
            : `${graph.nodes.length} versions`}{" "}
          {fileRecords && unavailableCount > 0 ? (
            <span className="muted">
              {`· ${unavailableCount} ${unavailableCount === 1 ? "version" : "versions"} could not be compared`}
            </span>
          ) : null}
          {!fileRecords ? (
            <span className="muted">· complete project states</span>
          ) : null}
        </span>
      </div>
      <div className="graph-toolbar">
        <div
          className="branch-legend"
          aria-label={
            fileRecords
              ? "Filter file history by branch ancestry"
              : "Show a case's versions"
          }
        >
          {graph.branches.map((branch) => (
            <button
              key={branch.id}
              className={`branch-filter${branch.hidden ? " hidden-case" : ""}`}
              style={{ "--branch-color": branch.color } as React.CSSProperties}
              aria-pressed={highlightBranchId === branch.id}
              disabled={
                branch.available === undefined
                  ? !branch.headIds.length
                  : !branch.available
              }
              title={
                fileRecords
                  ? `Filter to ${branch.name} ancestry; does not switch the working branch`
                  : branch.current
                    ? `Show ${branch.name} versions · current branch`
                    : `Show ${branch.name} versions`
              }
              onClick={() => toggleBranch(branch.id)}
            >
              <GitBranch size={13} />
              <span>{branch.name}</span>
              {branch.current ? (
                <span className="current-branch-marker" aria-hidden="true">
                  ●
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
      {fileRecords ? (
        <p className="file-history-help muted small">
            Recorded file and confirmed name changes are shown. Branch buttons filter ancestry;
          they do not switch the working branch. Origin markers provide context.
        </p>
      ) : null}
      {fileRecords && !graph.nodes.length ? (
        <div className="file-history-empty" role="status">
          No recorded history for this file within{" "}
          {highlightedBranch?.name ?? "the chosen branch filter"}. Try another
          branch or show all branches.
        </div>
      ) : null}
      <div
        hidden={Boolean(fileRecords && !graph.nodes.length)}
        className={`graph-viewport ${mode}`}
        ref={viewport}
        tabIndex={0}
        aria-label="Scrollable history. Use arrow keys on a version to inspect history."
      >
        {mode === "graph" ? (
          <div className="graph-stage" style={{ width, height }}>
              <svg
                width={width}
                height={height}
                aria-hidden="true"
                className="graph-lines"
              >
                <defs>
                  {edgeColors.map((color, index) => (
                    <marker
                      key={color}
                      id={`${markerPrefix}-parent-${index}`}
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="9"
                      markerHeight="9"
                      orient="auto"
                      markerUnits="userSpaceOnUse"
                    >
                      <path d="M 0 0 L 10 5 L 0 10 Z" fill={color} />
                    </marker>
                  ))}
                  <marker
                    id={`${markerPrefix}-copy`}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="8"
                    markerHeight="8"
                    orient="auto"
                    markerUnits="userSpaceOnUse"
                  >
                    <path d="M 1 1 L 9 5 L 1 9" className="graph-copy-arrow" />
                  </marker>
                </defs>
                {graph.copies.map((copy) => {
                  const from = positions.get(copy.child);
                  const to = positions.get(copy.source);
                  if (!from || !to) return null;
                  // Leave the copy's dot on its right side, run down the gutter
                  // between lanes (clear of parent lines, dots and labels) and
                  // arrive at the right side of the source's dot.
                  const dir = to.y > from.y ? 1 : -1;
                  const runX = Math.max(from.x, to.x) + 38;
                  const startX = from.x + NODE_RADIUS + 2;
                  const endX = to.x + NODE_RADIUS + 8;
                  const corner = 14;
                  return (
                    <path
                      key={`${copy.child}:${copy.source}`}
                      className="graph-copy-line"
                      data-copy-child={copy.child}
                      data-copy-source={copy.source}
                      data-copy-mode={copy.mode}
                      d={`M ${startX} ${from.y} Q ${runX} ${from.y} ${runX} ${from.y + dir * corner} V ${to.y - dir * corner} Q ${runX} ${to.y} ${endX} ${to.y}`}
                      fill="none"
                      strokeDasharray="5 5"
                      markerEnd={`url(#${markerPrefix}-copy)`}
                    />
                  );
                })}
                {graph.edges.map((edge) => {
                  const child = positions.get(edge.child)!;
                  const parent = positions.get(edge.parent)!;
                  // Child sits above its parent: leave the child's bottom, arrive at the parent's top.
                  const startY = child.y + NODE_RADIUS + 2;
                  const endY = parent.y - NODE_RADIUS - 7;
                  return (
                    <path
                      key={edge.child}
                      data-child={edge.child}
                      data-parent={edge.parent}
                      d={
                        child.x === parent.x
                          ? `M ${child.x} ${startY} L ${parent.x} ${endY}`
                          : `M ${child.x} ${startY} V ${endY - 48} C ${child.x} ${endY - 16}, ${parent.x} ${endY - 28}, ${parent.x} ${endY}`
                      }
                      stroke={edge.color}
                      opacity={
                        hiddenNode.has(edge.child)
                          ? 0.3
                          : ancestry?.has(edge.child)
                            ? 0.95
                            : 0.7
                      }
                      strokeWidth={ancestry?.has(edge.child) ? 3 : 2.25}
                      fill="none"
                      markerEnd={`url(#${markerPrefix}-parent-${edgeColors.indexOf(edge.color)})`}
                    />
                  );
                })}
              </svg>
              {visualNodes.map((node, index) => {
                const position = positions.get(node.id)!;
                const selected = node.id === selectedId;
                const heads = graph.branches.filter((branch) =>
                  branch.headIds.includes(node.id),
                );
                return (
                  <div
                    key={node.id}
                    data-file-history-kind={fileRecords?.get(node.id)?.kind}
                    className={`graph-row ${selected ? "selected" : ""} ${ancestry?.has(node.id) ? "in-case" : ""}${node.hidden ? " hidden-case" : ""}`}
                    style={
                      {
                        top: position.y - 42,
                        height: fileRecords ? 114 : 84,
                        "--branch-color": node.color,
                      } as React.CSSProperties
                    }
                  >
                    <button
                      ref={(element) => register(node.id, element)}
                      className="graph-hit"
                      aria-pressed={selected}
                      aria-label={`${formatRevisionNumber(node.revision.manifest.displayNumber)}: ${node.revision.manifest.summary}${fileRecords ? `, ${fileRecords.get(node.id)?.status}` : ""}${node.latest ? (fileRecords ? ", current branch file state" : ", latest on current branch") : ""}${node.warnings.length ? ", needs attention" : ""}${copyNotes(graph, node.id).map((note) => `, ${note}`).join("")}`}
                      title={copyNotes(graph, node.id).join(" · ") || undefined}
                      onClick={() => onSelect(node.id)}
                      onKeyDown={(event) => keyboard(event, index)}
                      tabIndex={
                        selected || (!selectedId && index === 0) ? 0 : -1
                      }
                    >
                      <span
                        className={`graph-dot ${fileRecords?.get(node.id)?.kind === "context" ? "context-dot" : ""} ${node.latest ? "latest" : ""} ${node.warnings.length ? "damaged" : ""}`}
                        style={{ left: position.x - NODE_RADIUS - 12 }}
                      >
                        <span aria-hidden="true">{formatRevisionNumber(node.revision.manifest.displayNumber)}</span>
                      </span>
                      <span className="graph-label" style={{ left: labelX }}>
                        <span className="revision-eyebrow">
                          {node.branchName}{" "}
                          {node.latest ? (
                            <span className="latest-label">
                              {fileRecords ? "Current file state" : "Latest"}
                            </span>
                          ) : null}{" "}
                          {node.warnings.length ? (
                            <span className="attention-label">
                              Needs attention
                            </span>
                          ) : null}
                        </span>
                        {fileRecords ? (
                          <span className="file-history-event">
                            {fileRecords.get(node.id)?.status}
                            {fileRecords.get(node.id)?.file ? ` · ${fileRecords.get(node.id)!.file!.path}` : ''}
                            {fileRecords.get(node.id)?.origins.length
                              ? ` · Origin of ${fileRecords.get(node.id)!.origins.join(", ")}`
                              : ""}
                          </span>
                        ) : null}
                        <strong title={node.revision.manifest.summary}>
                          {node.revision.manifest.summary}
                        </strong>
                        <time
                          dateTime={node.revision.manifest.captureCompletedAt}
                        >
                          {formatTimestamp(
                            node.revision.manifest.captureCompletedAt,
                          )}
                        </time>
                      </span>
                    </button>
                    {heads.length ? (
                      <div
                        className="graph-branches"
                        style={{
                          left: position.x + NODE_RADIUS,
                          top: fileRecords ? 104 : 72,
                          maxWidth: width - position.x - 54,
                        }}
                      >
                        {heads.map((branch) => (
                          <button
                            key={branch.id}
                            className={`branch-chip ${branch.current ? "current-head" : ""}`}
                            style={
                              {
                                "--branch-color": branch.color,
                              } as React.CSSProperties
                            }
                            aria-label={`${branch.name} ${fileRecords ? "file state" : "head"} at ${formatRevisionNumber(node.revision.manifest.displayNumber)}`}
                            aria-pressed={highlightBranchId === branch.id}
                            onClick={() => toggleBranch(branch.id)}
                            title={
                              fileRecords
                                ? `Filter to ${branch.name} ancestry; does not switch the working branch`
                                : `Show ${branch.name} versions${branch.current ? " · active working branch" : ""}`
                            }
                          >
                            <GitBranch size={11} />
                            {branch.name}
                            {branch.current ? (
                              <span
                                className="current-branch-marker"
                                aria-hidden="true"
                              >
                                ●
                              </span>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
          </div>
        ) : (
          <div className="revision-list">
            {visualNodes.map((node, index) => (
              <button
                key={node.id}
                ref={(element) => register(node.id, element)}
                data-file-history-kind={fileRecords?.get(node.id)?.kind}
                className={`revision-list-row ${selectedId === node.id ? "selected" : ""} ${ancestry?.has(node.id) ? "in-case" : ""}${node.hidden ? " hidden-case" : ""}`}
                aria-pressed={selectedId === node.id}
                onClick={() => onSelect(node.id)}
                onKeyDown={(event) => keyboard(event, index)}
                tabIndex={
                  selectedId === node.id || (!selectedId && index === 0)
                    ? 0
                    : -1
                }
              >
                <span className="revision-eyebrow">
                  {formatRevisionNumber(node.revision.manifest.displayNumber)}{" "}
                  <span className="branch-chip">
                    {fileRecords
                      ? node.branchName
                      : node.heads.join(", ") || node.branchName}
                  </span>
                  {node.latest ? (
                    <span className="latest-label">
                      {fileRecords ? "Current file state" : "Latest"}
                    </span>
                  ) : null}
                </span>
                {fileRecords ? (
                  <span className="file-history-event">
                    {fileRecords.get(node.id)?.status}
                    {fileRecords.get(node.id)?.file ? ` · ${fileRecords.get(node.id)!.file!.path}` : ''}
                    {fileRecords.get(node.id)?.origins.length
                      ? ` · Origin of ${fileRecords.get(node.id)!.origins.join(", ")}`
                      : ""}
                  </span>
                ) : null}
                <strong>{node.revision.manifest.summary}</strong>
                <time dateTime={node.revision.manifest.captureCompletedAt}>
                  {formatTimestamp(node.revision.manifest.captureCompletedAt)}
                </time>
                {copyNotes(graph, node.id).map((note) => (
                  <span key={note} className="copy-note muted small">
                    {note}
                  </span>
                ))}
                {node.warnings.length ? (
                  <span className="attention-label">
                    {node.warnings.join(" · ")}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="canvas-footer">
        <span className="muted">
          {highlightedBranch ? (
            <button
              className="text-button"
              onClick={() => onHighlightBranch(null)}
            >
              {fileRecords ? "Show all branches" : "Clear highlight"}
            </button>
          ) : (
            "Select a version to inspect · ↑ ↓ to navigate"
          )}
        </span>
        {mode === "graph" ? (
          <span className="graph-direction">
            ↓ Arrows point to parents
            {graph.copies.length ? " · Dashed lines point to where files were copied or brought back from" : ""}
          </span>
        ) : null}
      </div>
    </section>
  );
}
