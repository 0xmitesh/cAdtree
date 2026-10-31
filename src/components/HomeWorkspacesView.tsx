import { useState } from "react";
import { FolderOpen, Plus, RefreshCw } from "lucide-react";
import {
  homeWorkspaceGroups,
  type HomeState,
  type HomeWorkspaceEntry,
} from "../engine/home-service";
import type { RememberedHome } from "../engine/idb-store";
import type { ProgressUpdate } from "../engine/types";
import { Modal, Notice, OperationProgress } from "./ui";
import { WorkspaceLocationSetting } from "./FilePathShortcuts";

export function HomeWorkspacesView(props: {
  home: HomeState | null;
  remembered: RememberedHome | null;
  busy: boolean;
  progress: ProgressUpdate | null;
  onConnect: (create: boolean) => Promise<void>;
  onReconnect: () => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onBring: () => Promise<void>;
  onOpen: (entry: HomeWorkspaceEntry) => Promise<void>;
  onRefresh: () => Promise<void>;
  onExternal: () => void;
  onCancel: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const run = async (action: () => Promise<void>) => {
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="page projects-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">CADTREE HOME</p>
          <h1>
            All workspaces<span className="heading-dot">.</span>
          </h1>
          <p>
            {props.home
              ? props.home.identity.name
              : "Your designs. Your versions. Your storage."}
          </p>
        </div>
        {props.home ? (
          <button
            className="button primary"
            disabled={props.busy}
            onClick={() => {
              setName("");
              setError("");
              setCreating(true);
            }}
          >
            <Plus size={16} />
            Create workspace
          </button>
        ) : null}
      </div>
      {error ? <Notice type="error">{error}</Notice> : null}
      {!props.home ? (
        <section className="panel form-body">
          <h2>Choose your Cadtree home</h2>
          <p>
            Create a dedicated empty folder named Cadtree in the folder picker,
            or open an existing Cadtree home. Workspaces will be created inside
            it.
          </p>
          <div className="home-actions">
            <button
              className="button primary"
              disabled={props.busy}
              onClick={() => void run(() => props.onConnect(true))}
            >
              Create Cadtree home
            </button>
            <button
              className="button secondary"
              disabled={props.busy}
              onClick={() => void run(() => props.onConnect(false))}
            >
              Open Cadtree home
            </button>
            {props.remembered ? (
              <button
                className="button secondary"
                disabled={props.busy}
                onClick={() => void run(props.onReconnect)}
              >
                Reconnect {props.remembered.name}
              </button>
            ) : null}
          </div>
        </section>
      ) : (
        <>
          <div className="section-heading">
            <p>
              {homeWorkspaceGroups(props.home.workspaces).length} workspaces
            </p>
            <button
              className="text-button"
              disabled={props.busy}
              onClick={() => void run(props.onRefresh)}
            >
              <RefreshCw size={14} />
              Refresh home
            </button>
          </div>
          {!props.home.workspaces.length ? (
            <div className="panel projects-empty">
              <h2>Create your first workspace</h2>
              <p>
                Group projects by client, CAD tool, or any name that works for
                you.
              </p>
            </div>
          ) : (
            <div className="home-workspaces">
              {homeWorkspaceGroups(props.home.workspaces).map((entries) => {
                const entry = entries.find((e) => e.workspace) ?? entries[0];
                return (
                  <article
                    className="panel workspace-project"
                    key={entry.workspaceId ?? entry.key}
                  >
                    <div className="project-row">
                      <div className="project-copy">
                        <h3>{entry.name}</h3>
                        <p>
                          {entry.workspace
                            ? `${entry.workspace.projects.length} project${entry.workspace.projects.length === 1 ? "" : "s"} · ${entry.status === "ready" ? "Connected" : "Needs attention"}`
                            : entry.status === "incomplete"
                              ? "Incomplete · Destination retained"
                              : "Unavailable · Needs attention"}
                        </p>
                      </div>
                      {entry.workspace ? (
                        <button
                          className="button secondary"
                          disabled={props.busy}
                          onClick={() => void run(() => props.onOpen(entry))}
                        >
                          <FolderOpen size={16} />
                          Open workspace
                        </button>
                      ) : null}
                    </div>
                    {entry.issues.length ? (
                      <Notice type="error">{entry.issues.join(" ")}</Notice>
                    ) : null}
                    <details className="disclosure">
                      <summary>
                        Location details
                        {entries.length > 1
                          ? ` · ${entries.length} retained locations`
                          : ""}
                      </summary>
                      {entries.map((e) => (
                        <div key={e.key}>
                          <p className="file-path">
                            {props.home!.root.name}/
                            {e.directory ?? "Registration needs repair"} ·{" "}
                            {e.status}
                          </p>
                          {e !== entry && e.issues.length ? (
                            <p>{e.issues.join(" ")}</p>
                          ) : null}
                        </div>
                      ))}
                    </details>
                  </article>
                );
              })}
            </div>
          )}
          <div className="home-actions">
            <button
              className="button secondary"
              disabled={props.busy}
              onClick={() => void run(props.onBring)}
            >
              Bring existing workspace into Cadtree
            </button>
            <WorkspaceLocationSetting compact />
          </div>
          <p className="muted small">
            Bringing a workspace creates a verified managed copy, including
            unsaved-to-history working edits. Originals stay untouched.
            Workspace groups do not grant collaboration permissions.
          </p>
        </>
      )}
      <details className="disclosure">
        <summary>Other locations</summary>
        <div className="home-actions">
          <button
            className="button secondary"
            disabled={props.busy}
            onClick={props.onExternal}
          >
            Inspect external workspaces
          </button>
          <button
            className="text-button"
            disabled={props.busy}
            onClick={() => void run(() => props.onConnect(false))}
          >
            Choose another Cadtree home
          </button>
        </div>
      </details>
      <OperationProgress progress={props.progress} onCancel={props.onCancel} />
      {creating ? (
        <Modal
          title="Create workspace"
          busy={props.busy}
          onClose={() => setCreating(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await props.onCreate(name);
                setCreating(false);
              });
            }}
          >
            <fieldset disabled={props.busy}>
              <label className="field">
                <span>Workspace name</span>
                <input
                  autoFocus
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <p>
                A new folder will be allocated inside {props.home?.root.name}{" "}
                automatically.
              </p>
              {error ? <Notice type="error">{error}</Notice> : null}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setCreating(false)}
                >
                  Cancel
                </button>
                <button className="button primary">Create workspace</button>
              </div>
            </fieldset>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
