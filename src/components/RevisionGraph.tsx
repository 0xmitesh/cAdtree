import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Focus, Minus, Plus, CornerUpLeft, GitBranch } from "lucide-react";
import { ancestryOf, type RevisionGraph as Graph } from "../history/layout";
import { formatRevisionNumber } from "../engine/vault-service";
import { formatTimestamp } from "../utils/format";

const NODE_RADIUS = 22;
const ROW_HEIGHT = 104;

export function RevisionGraph({
  graph,
  selectedId,
  onSelect,
  mode,
}: {
  graph: Graph;
  selectedId: string | null;
  onSelect: (id: string) => void;
  mode: "graph" | "list";
}) {
  const [zoom, setZoom] = useState(1);
  const [highlightBranchId, setHighlightBranchId] = useState<string | null>(
    null,
  );
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
      { x: 60 + node.lane * 76, y: 62 + index * ROW_HEIGHT },
    ]),
  );
  const labelX = 104 + (graph.lanes - 1) * 76;
  const width = Math.max(490, labelX + 350);
  const height = Math.max(300, graph.nodes.length * ROW_HEIGHT + 28);
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
    const structure = `${mode}:${graph.nodes.length}`;
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
          (62 + index * ROW_HEIGHT) * zoom - container.clientHeight / 2,
        );
    }
  }, [mode, graph.nodes, selectedId, zoom]);
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
    setHighlightBranchId((previous) => (previous === id ? null : id));
  return (
    <section
      className="history-canvas"
      aria-label={mode === "graph" ? "Revision graph" : "Revision list"}
    >
      <div className="canvas-bar">
        <span>
          {graph.nodes.length} revisions{" "}
          <span className="muted">· complete project states</span>
        </span>
        <button
          className="text-button"
          disabled={!graph.latestId}
          onClick={jump}
        >
          <CornerUpLeft size={14} /> Latest
        </button>
      </div>
      <div className="graph-toolbar">
        <div className="branch-legend" aria-label="Highlight branch ancestry">
          {graph.branches.map((branch) => (
            <button
              key={branch.id}
              className="branch-filter"
              style={{ "--branch-color": branch.color } as React.CSSProperties}
              aria-pressed={highlightBranchId === branch.id}
              disabled={!branch.headIds.length}
              title={
                branch.current
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
      <div
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
                    className={`graph-row ${selected ? "selected" : ""} ${ancestry && !ancestry.has(node.id) ? "dimmed" : ""}`}
                    style={
                      {
                        top: position.y - 42,
                        height: 84,
                        "--branch-color": node.color,
                      } as React.CSSProperties
                    }
                  >
                    <button
                      ref={(element) => register(node.id, element)}
                      className="graph-hit"
                      aria-pressed={selected}
                      aria-label={`${formatRevisionNumber(node.revision.manifest.displayNumber)}: ${node.revision.manifest.summary}${node.latest ? ", latest on current branch" : ""}${node.warnings.length ? ", needs attention" : ""}`}
                      onClick={() => onSelect(node.id)}
                      onKeyDown={(event) => keyboard(event, index)}
                      tabIndex={
                        selected || (!selectedId && index === 0) ? 0 : -1
                      }
                    >
                      <span
                        className={`graph-dot ${node.latest ? "latest" : ""} ${node.warnings.length ? "damaged" : ""}`}
                        style={{ left: position.x - NODE_RADIUS - 12 }}
                      >
                        <span aria-hidden="true">{`R${String(node.revision.manifest.displayNumber).padStart(3, "0")}`}</span>
                      </span>
                      <span className="graph-label" style={{ left: labelX }}>
                        <span className="revision-eyebrow">
                          {node.branchName}{" "}
                          {node.latest ? (
                            <span className="latest-label">Latest</span>
                          ) : null}{" "}
                          {node.warnings.length ? (
                            <span className="attention-label">
                              Needs attention
                            </span>
                          ) : null}
                        </span>
                        <strong title={node.revision.manifest.summary}>
                          {node.revision.manifest.summary}
                        </strong>
                        <time dateTime={node.revision.manifest.captureCompletedAt}>
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
                          top: 72,
                          maxWidth: width - position.x - 54,
                        }}
                      >
                        {heads.map((branch) => (
                          <button
                            key={branch.id}
                            className="branch-chip"
                            style={
                              {
                                "--branch-color": branch.color,
                              } as React.CSSProperties
                            }
                            aria-label={`${branch.name} head at ${formatRevisionNumber(node.revision.manifest.displayNumber)}`}
                            aria-pressed={highlightBranchId === branch.id}
                            onClick={() => toggleBranch(branch.id)}
                            title={`Highlight ${branch.name} ancestry`}
                          >
                            <GitBranch size={11} />
                            {branch.name}
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
                className={`revision-list-row ${selectedId === node.id ? "selected" : ""} ${ancestry && !ancestry.has(node.id) ? "dimmed" : ""}`}
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
                    {node.heads.join(", ") || node.branchName}
                  </span>
                  {node.latest ? (
                    <span className="latest-label">Latest</span>
                  ) : null}
                </span>
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
              onClick={() => setHighlightBranchId(null)}
            >
              Clear ancestry highlight
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
