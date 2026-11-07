import { useState } from "react";
import type { TutorialDefinition } from "../tutorials/start-tutorial";
import { LearnCadtree } from "./LearnCadtree";
import { TutorialViewerModal } from "./TutorialViewerModal";
import { Modal } from "./ui";

/** Keep project views and the chooser mounted while learning in a separate dialog. */
export function ProjectLearningModal({ busy, onClose }: { busy: boolean; onClose: () => void }) {
  const [tutorial, setTutorial] = useState<TutorialDefinition | null>(null);
  return (
    <>
      <Modal title="Learn cAdtree" onClose={onClose}>
        <div className="project-learning">
          <LearnCadtree busy={busy} showHeading={false} onStartTutorial={setTutorial} />
          <div className="modal-actions">
            <button className="button secondary" onClick={onClose}>Close</button>
          </div>
        </div>
      </Modal>
      {tutorial ? <TutorialViewerModal tutorial={tutorial} onClose={() => setTutorial(null)} /> : null}
    </>
  );
}
