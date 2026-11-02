import {
  ArrowRight,
  FolderOpen,
  FolderTree,
  GitBranch,
  History,
  House,
  Plus,
  ShieldCheck,
} from "lucide-react";
import type { RememberedHome } from "../engine/idb-store";

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
      <section className="welcome-hero" aria-labelledby="welcome-title">
        <div className="welcome-introduction">
          <p className="eyebrow">A CLEARER SPACE TO CREATE</p>
          <h1 id="welcome-title">
            Your best work.
            <br />
            <span>Every version of it.</span>
          </h1>
          <p className="welcome-lead">
            Great ideas rarely arrive in one take. Give your projects,
            alternatives and all those “final_final” files a place to belong.
          </p>
          <p className="welcome-promise">
            cAdtree keeps your saved design story clear—so you can explore the
            next idea and find your way back.
          </p>
          <p className="welcome-trust">
            <ShieldCheck size={17} aria-hidden="true" /> Your files. Your
            storage.
          </p>
        </div>
        <div
          className="welcome-story"
          role="img"
          aria-label="Illustration: a project develops through saved milestones and a separate design alternative."
        >
          <div className="welcome-story-top">
            <span>
              <FolderOpen size={17} /> A design in motion
            </span>
          </div>
          <div className="welcome-story-body">
            <div className="welcome-story-step">
              <span className="welcome-revision">01</span>
              <div>
                <strong>The first idea</strong>
                <span>A starting point worth keeping</span>
              </div>
            </div>
            <div className="welcome-story-step">
              <span className="welcome-revision">02</span>
              <div>
                <strong>A better fit</strong>
                <span>The change, and the reason behind it</span>
              </div>
            </div>
            <div className="welcome-story-fork">
              <GitBranch size={17} />
              <span>A different direction</span>
            </div>
            <div className="welcome-story-step welcome-story-latest">
              <span className="welcome-revision">03</span>
              <div>
                <strong>Your next breakthrough</strong>
                <span>Room to explore. A way back.</span>
              </div>
            </div>
          </div>
          <div className="welcome-story-foot">
            <span className="welcome-saved-dot" /> A clear history. A fresh
            possibility.
          </div>
        </div>
      </section>

      <section
        className={`welcome-paths${remembered ? " welcome-has-home" : ""}`}
        aria-label="Choose your beginning"
      >
        {(remembered ? ["return", "new"] : ["new", "return"]).map((path) =>
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
                className={`button ${remembered ? "secondary" : "primary"} welcome-action`}
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
                    className="button primary welcome-action welcome-return-action"
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
    </>
  );
}
