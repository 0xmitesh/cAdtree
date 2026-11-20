import { useId } from "react";
import { FolderOpen, GitBranch } from "lucide-react";
import type { CSSProperties } from "react";

const main = "#087f80",
  alternative = "#7060b8";
const milestones = [
  {
    code: "V1",
    x: 56,
    y: 54,
    branch: "Main",
    title: "The first idea",
    note: "A starting point worth keeping",
    color: main,
  },
  {
    code: "V2",
    x: 56,
    y: 154,
    branch: "Main",
    title: "A better fit",
    note: "The change, and the reason behind it",
    color: main,
  },
  {
    code: "V3",
    x: 132,
    y: 252,
    branch: "Design case",
    title: "A different direction",
    note: "",
    color: alternative,
  },
  {
    code: "V4",
    x: 56,
    y: 354,
    branch: "Main",
    title: "Your next breakthrough",
    note: "Room to explore. A way back.",
    color: main,
  },
];

/** Static artwork using the History graph's canvas, legends and visual grammar.
 * These labels are not manifests, saved records or interactive revision controls. */
export function WelcomeGraphPreview() {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <div
      className="history-canvas welcome-graph-preview"
      role="img"
      aria-label="Design history preview: Main develops through saved milestones while a separate design case starts from A better fit."
    >
      <div className="canvas-bar welcome-preview-heading">
        <span>
          <FolderOpen size={16} /> A design in motion
        </span>
      </div>
      <div className="graph-toolbar">
        <div className="branch-legend">
          {[
            { name: "Main", color: main },
            { name: "Design case", color: alternative },
          ].map((branch) => (
            <span
              key={branch.name}
              className="branch-filter"
              style={{ "--branch-color": branch.color } as CSSProperties}
            >
              <GitBranch size={13} />
              {branch.name}
            </span>
          ))}
        </div>
      </div>
      <div className="graph-viewport welcome-preview-plot">
        <svg viewBox="0 0 440 430" aria-hidden="true">
          <defs>
            {[main, alternative].map((color, index) => (
              <marker
                key={color}
                id={`${id}-parent-${index}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto"
                markerUnits="userSpaceOnUse"
              >
                <path d="M 0 0 L 10 5 L 0 10 Z" fill={color} />
              </marker>
            ))}
          </defs>
          <g fill="none" strokeWidth="2.25" opacity="0.7">
            <path
              d="M56 130 V84"
              stroke={main}
              markerEnd={`url(#${id}-parent-0)`}
            />
            <path
              d="M56 330 V184"
              stroke={main}
              markerEnd={`url(#${id}-parent-0)`}
            />
            <path
              d="M132 228 V218 C132 196 56 202 56 184"
              stroke={alternative}
              markerEnd={`url(#${id}-parent-1)`}
            />
          </g>
          <rect
            x="172"
            y="321"
            width="250"
            height="76"
            rx="7"
            fill="#e8f3ec"
            stroke="#d2e6d9"
          />
          {milestones.map((node) => (
            <g key={node.code}>
              {node.code === "V4" ? (
                <circle
                  cx={node.x}
                  cy={node.y}
                  r="28"
                  fill="none"
                  stroke={main}
                  strokeDasharray="3 3"
                  opacity="0.7"
                />
              ) : null}
              <circle
                cx={node.x}
                cy={node.y}
                r="22"
                fill={node.code === "V4" ? main : "#fcfdfb"}
                stroke={node.color}
                strokeWidth="2"
              />
              <text
                x={node.x}
                y={node.y + 4}
                textAnchor="middle"
                className="welcome-preview-code"
                fill={node.code === "V4" ? "white" : node.color}
              >
                {node.code}
              </text>
              <text x="184" y={node.y - 18} className="welcome-preview-branch">
                {node.branch}
              </text>
              <text x="184" y={node.y + 3} className="welcome-preview-title">
                {node.title}
              </text>
              <text x="184" y={node.y + 24} className="welcome-preview-caption">
                {node.note}
              </text>
            </g>
          ))}
          <g fill={main}>
            <rect
              x="27"
              y="391"
              width="58"
              height="22"
              rx="4"
              fill="#fcfdfb"
              stroke={main}
            />
            <text
              x="56"
              y="406"
              textAnchor="middle"
              className="welcome-preview-chip"
            >
              Main
            </text>
          </g>
          <g fill={alternative}>
            <rect
              x="92"
              y="290"
              width="98"
              height="22"
              rx="4"
              fill="#fcfdfb"
              stroke={alternative}
            />
            <text
              x="141"
              y="305"
              textAnchor="middle"
              className="welcome-preview-chip"
            >
              Design case
            </text>
          </g>
        </svg>
      </div>
      <div className="welcome-preview-foot">
        A clear history. A fresh possibility.
      </div>
    </div>
  );
}
