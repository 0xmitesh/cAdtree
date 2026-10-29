import { useMemo, useRef, useState } from "react";
import { Focus, Minus, Plus, CornerUpLeft } from "lucide-react";
import { ancestryOf, type RevisionGraph as Graph } from "../history/layout";
import { formatRevisionNumber } from "../engine/vault-service";
import { formatTimestamp } from "../utils/format";

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
  const [highlightHead, setHighlightHead] = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const ancestry = useMemo(
    () => (highlightHead ? ancestryOf(graph, highlightHead) : null),
    [graph, highlightHead],
  );
  const positions = new Map(
    graph.nodes.map((n) => [n.id, { x: 42 + n.lane * 42, y: 49 + n.row * 86 }]),
  );
  const labelX = 80 + (graph.lanes - 1) * 42;
  const width = Math.max(470, labelX + 350);
  const height = Math.max(300, graph.nodes.length * 86 + 20);
  const jump = () => {
    if (graph.latestId) {
      onSelect(graph.latestId);
      refs.current.get(graph.latestId)?.focus();
      refs.current
        .get(graph.latestId)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };
  const keyboard = (event: React.KeyboardEvent, index: number) => {
    let next: number;
    if (event.key === "ArrowDown" || event.key === "ArrowRight")
      next = Math.min(graph.nodes.length - 1, index + 1);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft")
      next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = graph.nodes.length - 1;
    else return;
    event.preventDefault();
    const id = graph.nodes[next].id;
    onSelect(id);
    refs.current.get(id)?.focus();
    refs.current
      .get(id)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
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
                {graph.edges.map((edge) => {
                  const c = positions.get(edge.child)!;
                  const p = positions.get(edge.parent)!;
                  return (
                    <path
                      key={edge.child}
                      d={`M ${c.x} ${c.y} C ${c.x} ${c.y + 40}, ${p.x} ${p.y - 40}, ${p.x} ${p.y}`}
                      stroke={edge.color}
                      opacity={
                        ancestry && !ancestry.has(edge.child) ? 0.16 : 0.65
                      }
                      strokeWidth={2.5}
                      fill="none"
                    />
                  );
                })}
              </svg>
              {graph.nodes.map((node, index) => {
                const pos = positions.get(node.id)!;
                const selected = node.id === selectedId;
                return (
                  <div
                    key={node.id}
                    className={`graph-row ${selected ? "selected" : ""} ${ancestry && !ancestry.has(node.id) ? "dimmed" : ""}`}
                    style={
                      {
                        top: pos.y - 35,
                        height: 70,
                        "--branch-color": node.color,
                      } as React.CSSProperties
                    }
                  >
                    <button
                      ref={(el) => {
                        if (el) refs.current.set(node.id, el);
                        else refs.current.delete(node.id);
                      }}
                      className="graph-hit"
                      aria-pressed={selected}
                      aria-label={`${formatRevisionNumber(node.revision.manifest.displayNumber)}: ${node.revision.manifest.summary}${node.latest ? ", latest on current branch" : ""}${node.warnings.length ? ", needs attention" : ""}`}
                      onClick={() => onSelect(node.id)}
                      onKeyDown={(e) => keyboard(e, index)}
                      tabIndex={
                        selected || (!selectedId && index === 0) ? 0 : -1
                      }
                    >
                      <span
                        className={`graph-dot ${node.latest ? "latest" : ""} ${node.warnings.length ? "damaged" : ""}`}
                        style={{ left: pos.x - 7 }}
                      />
                      <span className="graph-label" style={{ left: labelX }}>
                        <span className="revision-eyebrow">
                          {formatRevisionNumber(
                            node.revision.manifest.displayNumber,
                          )}{" "}
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
                        <time>
                          {formatTimestamp(
                            node.revision.manifest.captureCompletedAt,
                          )}
                        </time>
                      </span>
                    </button>
                    {node.heads.length ? (
                      <div
                        className="graph-branches"
                        style={{ left: labelX, top: 66 }}
                      >
                        {node.heads.map((name) => (
                          <button
                            key={name}
                            className="branch-chip"
                            aria-pressed={highlightHead === node.id}
                            onClick={() =>
                              setHighlightHead((prev) =>
                                prev === node.id ? null : node.id,
                              )
                            }
                            title={`Highlight ${name} ancestry`}
                          >
                            {name}
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
            {graph.nodes.map((node, index) => (
              <button
                key={node.id}
                ref={(el) => {
                  if (el) refs.current.set(node.id, el);
                  else refs.current.delete(node.id);
                }}
                className={`revision-list-row ${selectedId === node.id ? "selected" : ""}`}
                aria-pressed={selectedId === node.id}
                onClick={() => onSelect(node.id)}
                onKeyDown={(e) => keyboard(e, index)}
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
                <time>
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
          {highlightHead ? (
            <button
              className="text-button"
              onClick={() => setHighlightHead(null)}
            >
              Clear ancestry highlight
            </button>
          ) : (
            "Select a revision to inspect · ↑ ↓ to navigate"
          )}
        </span>
        {mode === "graph" ? (
          <div className="zoom-controls">
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
    </section>
  );
}
