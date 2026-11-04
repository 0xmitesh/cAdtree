import {
  ArrowRight,
  FolderOpen,
  FolderTree,
  GitBranch,
  History,
  House,
  Plus,
} from "lucide-react";
import type { RememberedHome } from "../engine/idb-store";
import { LearnCadtree } from "./LearnCadtree";
import { WelcomeGraphPreview } from "./WelcomeGraphPreview";

/** Introduction only. The illustration is not a project or a saved revision. */
export function HomeWelcome({
  remembered,
  busy,
  onStart,
  onOpen,
  onReturn,
}: {
  remembered: RememberedHome | null;
  busy: boolean;
  onStart: () => void;
  onOpen: () => void;
  onReturn: () => void;
}) {
  return (
    <>
      <h1 id="welcome-title" className="sr-only">Welcome to cAdtree</h1>
      <section className="welcome-paths" aria-label="Choose your beginning">
        {["new", "return"].map((path) =>
          path === "new" ? (
            <article key="new" className="welcome-path welcome-new">
              <div className="welcome-path-heading">
                <span className="welcome-path-icon">
                  <Plus size={21} aria-hidden="true" />
                </span>
                <p className="eyebrow">YOUR FIRST CHAPTER</p>
              </div>
              <h2>Start something worth keeping.</h2>
              <p>
                Create your Cadtree home: one place for your workspaces,
                projects and saved design history.
              </p>
              <button
                className="button primary welcome-action"
                disabled={busy}
                onClick={onStart}
              >
                Start my Cadtree home{" "}
                <ArrowRight size={16} aria-hidden="true" />
              </button>
              <p className="welcome-path-hint">
                Choose a dedicated empty folder. Your first workspace comes
                next.
              </p>
            </article>
          ) : (
            <article key="return" className="welcome-path welcome-return">
              <div className="welcome-path-heading">
                <span className="welcome-path-icon">
                  <House size={21} aria-hidden="true" />
                </span>
                <p className="eyebrow">
                  {remembered
                    ? "RIGHT WHERE YOU LEFT OFF"
                    : "ALREADY PART OF YOUR PROCESS?"}
                </p>
              </div>
              <h2>Welcome home.</h2>
              <p>
                Your projects. Your decisions. The versions that got you here.
                Pick up where you left off.
              </p>
              {remembered ? (
                <>
                  <button
                    className="button secondary welcome-action welcome-return-action"
                    disabled={busy}
                    onClick={onReturn}
                    title={remembered.name}
                  >
                    Return to {remembered.name}
                    <ArrowRight size={16} aria-hidden="true" />
                  </button>
                  <button
                    className="text-button welcome-open-another"
                    disabled={busy}
                    onClick={onOpen}
                    title="Choose a Cadtree home folder"
                  >
                    Open my Cadtree home
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="button secondary welcome-action"
                    disabled={busy}
                    onClick={onOpen}
                  >
                    Open my Cadtree home{" "}
                    <FolderOpen size={16} aria-hidden="true" />
                  </button>
                  <p className="welcome-path-hint">
                    Choose your existing Cadtree home folder to continue.
                  </p>
                </>
              )}
            </article>
          ),
        )}
      </section>

      <section className="welcome-hero" aria-labelledby="welcome-title">
        <div className="welcome-introduction">
          <figure className="welcome-quote">
            <blockquote>
              “Great ideas rarely arrive in one take. Give your projects,
              alternatives and all those ‘final_final’ files a place to belong.”
            </blockquote>
          </figure>
        </div>
        <div className="welcome-showcase">
          <WelcomeGraphPreview />
        </div>
      </section>

      <LearnCadtree busy={busy} />
      <footer className="welcome-footer">
        <section
          className="welcome-benefits"
          aria-label="Make space for better work"
        >
          <div>
            <FolderTree size={20} aria-hidden="true" />
            <h3>A place for every project</h3>
            <p>Organize workspaces around your tools, clients or ideas.</p>
          </div>
          <div>
            <GitBranch size={20} aria-hidden="true" />
            <h3>Freedom to try “what if”</h3>
            <p>Explore a separate design case from a saved revision.</p>
          </div>
          <div>
            <History size={20} aria-hidden="true" />
            <h3>A way back, whenever you need it</h3>
            <p>Compare saved versions and recover a copy of the one you need.</p>
          </div>
        </section>
      </footer>
    </>
  );
}
