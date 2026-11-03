import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Focus, Minus, Plus, CornerUpLeft, GitBranch } from "lucide-react";
import { ancestryOf, type RevisionGraph as Graph } from "../history/layout";
import { formatRevisionNumber } from "../engine/vault-service";
import type { FileHistoryRecord } from "../history/file-history";
import { formatTimestamp } from "../utils/format";

const NODE_RADIUS = 22;

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
  const [zoom, setZoom] = useState(1);
  const rowHeight = fileRecords ? 140 : 104;
  const viewport = useRef<HTMLDivElement>(null);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const centeredStructure = useRef<string | null>(null);
  const markerPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const highlightedBranch = graph.branches.find(
    (branch) => branch.id === highlightBranchId,
  );
  const ancestry = useMemo(() => {
    if (!highlightedBranch) return null;
    return new Set(
      highlightedBranch.headIds.flatMap((id) => [...ancestryOf(graph, id)]),
    );
  }, [graph, highlightedBranch]);
  // Graph reads from its earliest ancestor downward, with arrows back toward parents.
  // List retains newest-first reading order. Both use the same revision identities.
  const visualNodes = useMemo(
    () => (mode === "graph" ? [...graph.nodes].reverse() : graph.nodes),
    [graph.nodes, mode],
  );
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
        top: Math.max(0, position.y * zoom - viewport.current.clientHeight / 2),
        left: Math.max(0, position.x * zoom - viewport.current.clientWidth / 3),
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
      const index = [...graph.nodes]
        .reverse()
        .findIndex((node) => node.id === selectedId);
      if (index >= 0)
        container.scrollTop = Math.max(
          0,
          (62 + index * rowHeight) * zoom - container.clientHeight / 2,
        );
    }
  }, [mode, graph.nodes, selectedId, zoom, rowHeight]);
  const jump = () => {
    if (!graph.latestId) return;
    onSelect(graph.latestId);
    reveal(graph.latestId, true);
  };
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
  const toggleBranch = (id: string) =>
    onHighlightBranch(highlightBranchId === id ? null : id);
  return (
    <section
      className="history-canvas"
      aria-label={mode === "graph" ? "Revision graph" : "Revision list"}
    >
      <div className="canvas-bar">
        <span>
          {fileRecords
            ? `${graph.nodes.filter((n) => fileRecords.get(n.id)?.kind === "change").length} file change events`
            : `${graph.nodes.length} revisions`}{" "}
          <span className="muted">
            {fileRecords
              ? `· ${graph.nodes.filter((n) => fileRecords.get(n.id)?.kind === "context").length} context markers · ${graph.nodes.filter((n) => fileRecords.get(n.id)?.kind === "unavailable").length} unavailable comparisons`
              : "· complete project states"}
          </span>
        </span>
        <button
          className="text-button"
          disabled={!graph.latestId}
          onClick={jump}
        >
          <CornerUpLeft size={14} />{" "}
          {fileRecords ? "Current branch file state" : "Latest"}
        </button>
      </div>
      <div className="graph-toolbar">
        <div
          className="branch-legend"
          aria-label={
            fileRecords
              ? "Filter file history by branch ancestry"
              : "Highlight branch ancestry"
          }
        >
          {graph.branches.map((branch) => (
            <button
              key={branch.id}
              className="branch-filter"
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
                    ? `Highlight ${branch.name} ancestry · current branch`
                    : `Highlight ${branch.name} ancestry`
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
        {mode === "graph" ? (
          <div className="zoom-controls" aria-label="Graph zoom">
            <button
              className="icon-button"
              aria-label="Zoom out"
              disabled={zoom <= 0.8}
              onClick={() =>
                setZoom((z) => Math.max(0.8, +(z - 0.1).toFixed(1)))
              }
            >
              <Minus size={15} />
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              className="icon-button"
              aria-label="Zoom in"
              disabled={zoom >= 1.5}
              onClick={() =>
                setZoom((z) => Math.min(1.5, +(z + 0.1).toFixed(1)))
              }
            >
              <Plus size={15} />
            </button>
            <button
              className="icon-button"
              aria-label="Fit graph width and reset scroll"
              onClick={() => {
                setZoom(
                  Math.max(
                    0.8,
                    Math.min(
                      1,
                      (viewport.current?.clientWidth ?? width) / width,
                    ),
                  ),
                );
                viewport.current?.scrollTo({ top: 0, left: 0 });
              }}
            >
              <Focus size={16} />
            </button>
          </div>
        ) : null}
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
        aria-label="Scrollable history. Use arrow keys on a revision to inspect history."
      >
        {mode === "graph" ? (
          <div
            className="graph-scaled"
            style={{ width: width * zoom, height: height * zoom }}
          >
            <div
              className="graph-stage"
              style={{ width, height, transform: `scale(${zoom})` }}
            >
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
                </defs>
                {graph.edges.map((edge) => {
                  const child = positions.get(edge.child)!;
                  const parent = positions.get(edge.parent)!;
                  const startY = child.y - NODE_RADIUS - 2;
                  const endY = parent.y + NODE_RADIUS + 7;
                  return (
                    <path
                      key={edge.child}
                      data-child={edge.child}
                      data-parent={edge.parent}
                      d={
                        child.x === parent.x
                          ? `M ${child.x} ${startY} L ${parent.x} ${endY}`
                          : `M ${child.x} ${startY} V ${endY + 48} C ${child.x} ${endY + 16}, ${parent.x} ${endY + 28}, ${parent.x} ${endY}`
                      }
                      stroke={edge.color}
                      opacity={
                        ancestry && !ancestry.has(edge.child) ? 0.12 : 0.7
                      }
                      strokeWidth={2.25}
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
                    className={`graph-row ${selected ? "selected" : ""} ${ancestry && !ancestry.has(node.id) && !selected ? "dimmed" : ""}`}
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
                      aria-label={`${formatRevisionNumber(node.revision.manifest.displayNumber)}: ${node.revision.manifest.summary}${fileRecords ? `, ${fileRecords.get(node.id)?.status}` : ""}${node.latest ? (fileRecords ? ", current branch file state" : ", latest on current branch") : ""}${node.warnings.length ? ", needs attention" : ""}`}
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
                        <span aria-hidden="true">{`R${String(node.revision.manifest.displayNumber).padStart(3, "0")}`}</span>
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
                                : `Highlight ${branch.name} ancestry${branch.current ? " · active working branch" : ""}`
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
          </div>
        ) : (
          <div className="revision-list">
            {visualNodes.map((node, index) => (
              <button
                key={node.id}
                ref={(element) => register(node.id, element)}
                data-file-history-kind={fileRecords?.get(node.id)?.kind}
                className={`revision-list-row ${selectedId === node.id ? "selected" : ""} ${ancestry && !ancestry.has(node.id) && selectedId !== node.id ? "dimmed" : ""}`}
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
              {fileRecords ? "Show all branches" : "Clear ancestry highlight"}
            </button>
          ) : (
            "Select a revision to inspect · ↑ ↓ to navigate"
          )}
        </span>
        {mode === "graph" ? (
          <span className="graph-direction">↑ Arrows point to parents</span>
        ) : null}
      </div>
    </section>
  );
}
