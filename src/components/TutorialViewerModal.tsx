import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Folder, FolderOpen, House } from "lucide-react";
import { Modal, Notice } from "./ui";
import {
  START_TUTORIAL,
  clampTutorialStep,
  type TutorialDefinition,
} from "../tutorials/start-tutorial";

export function TutorialViewerModal({
  tutorial = START_TUTORIAL,
  initialStep = 0,
  onClose,
}: {
  tutorial?: TutorialDefinition;
  initialStep?: number;
  onClose: () => void;
}) {
  const total = tutorial.steps.length;
  const [stepIndex, setStepIndex] = useState(() =>
    clampTutorialStep(initialStep, total),
  );
  useEffect(() => {
    if (typeof Image === "undefined") return;
    for (const s of tutorial.steps) {
      for (const v of s.visuals ?? []) {
        const img = new Image();
        img.src = v.src;
      }
    }
  }, [tutorial]);
  const step = tutorial.steps[clampTutorialStep(stepIndex, total)];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === total - 1;

  return (
    <Modal title={tutorial.title} onClose={onClose}>
      <div className="tutorial-viewer" data-tutorial-id={tutorial.id}>
        <div className="tutorial-step-header">
          <p className="eyebrow" aria-live="polite">
            Step {stepIndex + 1} of {total}
          </p>
          <h3>{step.title}</h3>
        </div>

        <p className="tutorial-summary">{step.summary}</p>

        {step.hierarchy ? (
          <div
            className="panel tutorial-hierarchy"
            role="group"
            aria-label={`${step.title} folder hierarchy`}
          >
            {step.hierarchy.map((node) => (
              <div
                key={`${node.depth}:${node.label}`}
                className={`tutorial-hierarchy-row${node.highlight ? " active" : ""}`}
                style={{ paddingLeft: `${12 + node.depth * 20}px` }}
              >
                <span className="tutorial-hierarchy-branch" aria-hidden="true">
                  {node.depth === 0 ? (
                    <House size={15} />
                  ) : node.depth === 1 ? (
                    <FolderOpen size={15} />
                  ) : (
                    <Folder size={15} />
                  )}
                </span>
                <div className="tutorial-hierarchy-copy">
                  <code>{node.depth > 0 ? `└── ${node.label}` : node.label}</code>
                  <span>{node.detail}</span>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <ul className="tutorial-points">
          {step.points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>

        {step.visuals?.length ? (
          <div
            className={`tutorial-visual-list${step.visuals.length === 3 ? " three-up" : ""}`}
            data-visual-count={step.visuals.length}
          >
            {step.visuals.map((visual) => (
              <figure
                className="panel tutorial-visual-card"
                data-visual-kind={visual.kind}
                key={visual.src}
              >
                <figcaption className="tutorial-visual-caption">
                  <span>{visual.caption}</span>
                  <span className="tutorial-visual-source">
                    {visual.kind === "os" ? "Windows" : "cAdtree"}
                  </span>
                </figcaption>
                <div className="tutorial-visual-frame">
                  <img
                    src={visual.src}
                    alt={visual.alt}
                    loading="eager"
                  />
                </div>
              </figure>
            ))}
          </div>
        ) : null}

        {step.note ? <Notice>{step.note}</Notice> : null}

        {step.nextHint ? (
          <p className="tutorial-next-hint">
            <strong>{step.nextHint}</strong>
          </p>
        ) : null}

        <div className="modal-actions tutorial-modal-actions">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
          >
            Close
          </button>
          <div className="tutorial-step-nav">
            <button
              type="button"
              className="button secondary"
              disabled={isFirst}
              onClick={() =>
                setStepIndex((current) => clampTutorialStep(current - 1, total))
              }
            >
              <ArrowLeft size={15} aria-hidden="true" />
              Back
            </button>
            {isLast ? (
              <button
                type="button"
                className="button primary"
                onClick={onClose}
              >
                <Check size={15} aria-hidden="true" />
                Finish
              </button>
            ) : (
              <button
                type="button"
                className="button primary"
                onClick={() =>
                  setStepIndex((current) =>
                    clampTutorialStep(current + 1, total),
                  )
                }
              >
                Next
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
