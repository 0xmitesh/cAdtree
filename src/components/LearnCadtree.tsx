import { useState } from "react";
import { ArrowRight, File, Folder, FolderOpen, House } from "lucide-react";
import { START_TUTORIAL, type TutorialDefinition } from "../tutorials/start-tutorial";
import { SAVE_FIRST_REVISION_TUTORIAL } from "../tutorials/save-first-revision";
import { BRING_EXISTING_WORK_TUTORIAL } from "../tutorials/bring-existing-work";
import { EXPLORE_DESIGN_ALTERNATIVES_TUTORIAL } from "../tutorials/explore-design-alternatives";
import { COMPARE_APPLY_RECOVER_TUTORIAL } from "../tutorials/compare-apply-recover";
import { TutorialViewerModal } from "./TutorialViewerModal";

type Preview = "home" | "revision" | "existing" | "alternatives" | "compare";
type TutorialCard = {
  id: string;
  title: string;
  description: string;
  preview: Preview;
  category: "primary" | "secondary";
} & (
  | { status: "available"; tutorial: TutorialDefinition }
  | { status: "coming-soon" }
);

const TUTORIAL_CARDS: TutorialCard[] = [
  {
    id: "start-with-cadtree",
    title: START_TUTORIAL.title,
    description: "Set up Cadtree Home, create a workspace and create your first project.",
    preview: "home",
    category: "primary",
    status: "available",
    tutorial: START_TUTORIAL,
  },
  {
    id: "first-revision",
    title: "Save your first revision",
    description: "Capture a meaningful design state and find your CAD files again.",
    preview: "revision",
    category: "primary",
    status: "available",
    tutorial: SAVE_FIRST_REVISION_TUTORIAL,
  },
  {
    id: "existing-work",
    title: "Bring existing work into cAdtree",
    description: "Connect an existing workspace or CAD project.",
    preview: "existing",
    category: "secondary",
    status: "available",
    tutorial: BRING_EXISTING_WORK_TUTORIAL,
  },
  {
    id: "design-alternatives",
    title: "Explore design alternatives",
    description: "Create a separate design direction from a saved revision.",
    preview: "alternatives",
    category: "secondary",
    status: "available",
    tutorial: EXPLORE_DESIGN_ALTERNATIVES_TUTORIAL,
  },
  {
    id: "compare-recover",
    title: COMPARE_APPLY_RECOVER_TUTORIAL.title,
    description: "Compare saved designs, review changes and return to earlier work.",
    preview: "compare",
    category: "secondary",
    status: "available",
    tutorial: COMPARE_APPLY_RECOVER_TUTORIAL,
  },
];

/** Small concept diagrams only; these are not screenshots or project data. */
function TutorialPreview({ kind }: { kind: Preview }) {
  if (kind === "home" || kind === "existing") {
    const nodes = kind === "home"
      ? ["Cadtree Home", "Workspace", "Project"]
      : ["Existing workspace", "CAD project"];
    return (
      <div className="learn-folder-preview">
        {nodes.map((label, index) => (
          <div key={label} style={{ marginLeft: index * 22 }}>
            {kind === "home" && index === 0 ? <House size={18} /> : index === nodes.length - 1 ? <Folder size={18} /> : <FolderOpen size={18} />}
            <span>{label}</span>
          </div>
        ))}
      </div>
    );
  }
  if (kind === "revision") {
    return (
      <div className="learn-revision-preview">
        <div className="learn-revision-flow"><span>R01</span><ArrowRight size={22} /><span>R02</span></div>
        <p><File size={15} /> Design files <span className="learn-change-dot" /> Changes saved</p>
      </div>
    );
  }
  if (kind === "alternatives") {
    return (
      <svg className="learn-graph-preview" viewBox="0 0 280 96" fill="none">
        <path d="M24 27H256M94 27C129 27 122 71 157 71H225" />
        <circle cx="24" cy="27" r="5" /><circle cx="94" cy="27" r="5" /><circle cx="256" cy="27" r="5" /><circle cx="225" cy="71" r="5" />
        <text x="171" y="17">Main</text><text x="152" y="94">Design case</text>
      </svg>
    );
  }
  return (
    <svg className="learn-graph-preview" viewBox="0 0 280 96" fill="none">
      <rect x="22" y="15" width="70" height="38" rx="6" /><rect x="188" y="15" width="70" height="38" rx="6" />
      <path d="M105 28H175L169 22M175 40H105L111 46" />
      <text x="42" y="39">R01</text><text x="208" y="39">R03</text>
      <text x="66" y="85">Compare · Bring back</text>
    </svg>
  );
}

export function LearnCadtree({ busy, onStartTutorial, showHeading = true }: {
  busy: boolean;
  onStartTutorial?: (tutorial: TutorialDefinition) => void;
  showHeading?: boolean;
}) {
  const [activeTutorial, setActiveTutorial] = useState<TutorialDefinition | null>(null);
  return (
    <section className="welcome-learn" aria-labelledby={showHeading ? "learn-cadtree-title" : undefined} aria-label={showHeading ? undefined : "Learn cAdtree"}>
      <header className="learn-heading">
        {showHeading ? <h2 id="learn-cadtree-title">Learn cAdtree</h2> : null}
        <p>Short guides for learning the cAdtree workflow.</p>
      </header>
      {(["primary", "secondary"] as const).map((category) => (
        <div key={category} className={`learn-card-row learn-card-row-${category}`}>
          {TUTORIAL_CARDS.filter((card) => card.category === category).map((card) => (
            <article key={card.id} className={`learn-card${card.status === "available" ? " learn-card-available" : ""}`} aria-labelledby={`learn-${card.id}`}>
              <div className="learn-card-preview" aria-hidden="true"><TutorialPreview kind={card.preview} /></div>
              <div className="learn-card-content">
                <h3 id={`learn-${card.id}`}>{card.title}</h3>
                <p id={`learn-${card.id}-description`}>{card.description}</p>
                <div className="learn-card-action">
                  {card.status === "available" ? (
                    <>
                      <span className="learn-card-meta">{card.tutorial.steps.length} steps</span>
                      <button type="button" className="text-button learn-start" disabled={busy}
                        aria-describedby={`learn-${card.id} learn-${card.id}-description`}
                        onClick={() => (onStartTutorial ?? setActiveTutorial)(card.tutorial)}>
                        Start tutorial <ArrowRight size={16} aria-hidden="true" />
                      </button>
                    </>
                  ) : <span className="learn-card-meta">Coming soon</span>}
                </div>
              </div>
            </article>
          ))}
        </div>
      ))}
      {activeTutorial ? <TutorialViewerModal tutorial={activeTutorial} onClose={() => setActiveTutorial(null)} /> : null}
    </section>
  );
}
