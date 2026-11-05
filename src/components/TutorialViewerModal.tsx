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
  const [visualIndex, setVisualIndex] = useState(0);
  const [viewedThrough, setViewedThrough] = useState<Record<string, number>>({});
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
  const visuals = step.visuals ?? [];
  const visual = visuals[visualIndex];
  const stepKey = `${tutorial.id}:${step.id}`;
  const canAdvance =
    visuals.length < 2 || (viewedThrough[stepKey] ?? 0) >= visuals.length - 1;
  const changeStep = (direction: number) => {
    if (direction > 0 && !canAdvance) return;
    setStepIndex((current) => clampTutorialStep(current + direction, total));
    setVisualIndex(0);
  };
  const nextVisual = () => {
    const nextIndex = Math.min(visuals.length - 1, visualIndex + 1);
    setVisualIndex(nextIndex);
    setViewedThrough((current) => ({
      ...current,
      [stepKey]: Math.max(current[stepKey] ?? 0, nextIndex),
    }));
  };
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

        {step.points.length ? <ul className="tutorial-points">
          {step.points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul> : null}

        {visual ? (
          <div className="tutorial-visual-carousel" role="group" aria-label="Step visuals">
              <figure
                className="panel tutorial-visual-card"
                data-visual-kind={visual.kind}
              >
                <figcaption className="tutorial-visual-caption">
                  <span>{visual.caption}</span>
                  <span className="tutorial-visual-source">
                    {visual.kind === "os" ? "Windows" : visual.kind === "concept" ? "Concept" : "cAdtree"}
                  </span>
                </figcaption>
                <div className="tutorial-visual-frame">
                  <img
                    key={visual.src}
                    src={visual.src}
                    alt={visual.alt}
                    loading="eager"
                  />
                </div>
              </figure>
            {visuals.length > 1 ? (
              <div className="tutorial-visual-nav" role="group" aria-label="Visual navigation">
                <button type="button" className="button secondary" aria-label="Previous visual" disabled={visualIndex === 0}
                  onClick={() => setVisualIndex((current) => Math.max(0, current - 1))}>
                  <ArrowLeft size={17} aria-hidden="true" />
                </button>
                <span className="tutorial-visual-position" aria-live="polite" aria-atomic="true" aria-label={`Visual ${visualIndex + 1} of ${visuals.length}`}>
                  {visualIndex + 1} / {visuals.length}
                </span>
                <button type="button" className="button primary" aria-label="Next visual" disabled={visualIndex === visuals.length - 1}
                  onClick={nextVisual}>
                  Next visual
                  <ArrowRight size={17} aria-hidden="true" />
                </button>
              </div>
            ) : null}
            {!canAdvance ? <p className="tutorial-visual-hint">View every image in this step to enable Next.</p> : null}
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
              onClick={() => changeStep(-1)}
            >
              <ArrowLeft size={15} aria-hidden="true" />
              Back
            </button>
            {isLast ? (
              <button
                type="button"
                className="button primary"
                disabled={!canAdvance}
                onClick={onClose}
              >
                <Check size={15} aria-hidden="true" />
                Finish
              </button>
            ) : (
              <button
                type="button"
                className="button primary"
                disabled={!canAdvance}
                onClick={() => changeStep(1)}
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
