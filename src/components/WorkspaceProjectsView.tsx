import { useRef, useState } from "react";
import { FolderOpen, Plus, RefreshCw } from "lucide-react";
import {
  RealFileSystemAdapter,
  type FileSystemDirectoryAdapter,
} from "../engine/fs-adapter";
import type {
  WorkspaceState,
  WorkspaceProjectEntry,
} from "../engine/workspace-service";
import { Modal, Notice, OperationProgress } from "./ui";
import type { ProgressUpdate } from "../engine/types";

export interface WorkspaceProjectsViewProps {
  onAllWorkspaces: () => void;
  workspace: WorkspaceState;
  busy: boolean;
  progress: ProgressUpdate | null;
  onRefresh: () => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onImport: (source: FileSystemDirectoryAdapter) => Promise<void>;
  onOpenProject: (entry: WorkspaceProjectEntry) => Promise<void>;
  onCancel: () => void;
}

export function WorkspaceProjectsView(props: WorkspaceProjectsViewProps) {
  const [flow, setFlow] = useState<"create" | "import" | null>(null);
  const picking = useRef(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const busy = props.busy || choosingFolder;
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [choosingLocation, setChoosingLocation] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setError("");
    try {
      await action();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  const pickSource = async () => {
    if (picking.current) return;
    const picker = (
      window as unknown as {
        showDirectoryPicker?: (options: {
          mode: string;
        }) => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker;
    if (!picker)
      throw new Error("Local folders require a standalone Edge or Chrome tab.");
    picking.current = true;
    setChoosingFolder(true);
    try {
      const chosen = new RealFileSystemAdapter(await picker({ mode: "read" }));
      await props.onImport(chosen);
      setFlow(null);
    } finally {
      picking.current = false;
      setChoosingFolder(false);
    }
  };
  const groups = new Map<string, WorkspaceProjectEntry[]>();
  for (const entry of props.workspace.projects) {
    const key = entry.projectId ?? entry.containerPath;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return (
    <div className="page projects-page">
      <button
        className="text-button"
        disabled={busy}
        onClick={props.onAllWorkspaces}
      >
        Back to My workspaces
      </button>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR LOCAL WORKSPACE</p>
          <h1>
            {props.workspace.identity.name}
            <span className="heading-dot">.</span>
          </h1>
          <p>Your projects, together in one workspace.</p>
        </div>
        <div className="workspace-heading-actions">
          <button
            className="button primary"
            disabled={busy}
            onClick={() => {
              setName("");
              setError("");
              setFlow("create");
            }}
          >
            <Plus size={16} /> Create project
          </button>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => {
              setError("");
              setFlow("import");
            }}
          >
            <FolderOpen size={16} /> Import existing project
          </button>
        </div>
      </div>
      {error ? <Notice type="error">{error}</Notice> : null}
      <section className="recent-projects">
        <div className="section-heading">
          <h2>Workspace projects</h2>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => run(props.onRefresh)}
          >
            <RefreshCw size={14} /> Refresh workspace
          </button>
        </div>
        {!groups.size ? (
          <div className="panel projects-empty">
            <h2>Add your first project</h2>
            <p>
              Create an empty project, or import a verified copy of an existing
              CAD folder. Your original stays untouched.
            </p>
          </div>
        ) : (
          [...groups].map(([id, locations]) => (
            <div className="panel workspace-project" key={id}>
              <div className="project-row">
                <div className="project-copy">
                  <h3>{locations[0].name}</h3>
                  <p>
                    {locations.length > 1
                      ? `${locations.length} locations for the same project identity`
                      : "Managed project"}
                  </p>
                  <p className="small">
                    {locations.length > 1
                      ? "Choose one location explicitly. Histories are never combined."
                      : locations[0].status === "ready"
                        ? "Managed project · One shared vault, independent working folders"
                        : locations[0].status === "incomplete"
                          ? "Incomplete copy · Retained for inspection; retry uses a fresh folder"
                          : "Connections or records need attention · Read-only inspection available"}
                  </p>
                </div>
                {locations.length > 1 ? (
                  <button
                    className="button secondary"
                    onClick={() =>
                      setChoosingLocation(choosingLocation === id ? null : id)
                    }
                  >
                    Choose location
                  </button>
                ) : locations[0].project ? (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      run(() => props.onOpenProject(locations[0]))
                    }
                  >
                    {locations[0].status === "ready"
                      ? "Open project"
                      : "Inspect project"}
                  </button>
                ) : null}
              </div>
              <details className="disclosure project-location-details">
                <summary>Location details</summary>
                {locations[0].projectId ? (
                  <p className="file-path">
                    Project identity: {locations[0].projectId}
                  </p>
                ) : null}
                {locations.map((entry) => (
                  <p className="file-path" key={entry.containerPath}>
                    Workspace-relative location: {entry.containerPath}
                  </p>
                ))}
              </details>
              {locations.length > 1 && choosingLocation === id
                ? locations.map((entry) => (
                    <div
                      className="workspace-location"
                      key={entry.containerPath}
                    >
                      <p>
                        {entry.containerPath} ·{" "}
                        {entry.project?.ready
                          ? "Published"
                          : "Incomplete/damaged"}
                      </p>
                      <button
                        className="button secondary"
                        disabled={busy || !entry.project}
                        onClick={() => run(() => props.onOpenProject(entry))}
                      >
                        Use this location
                      </button>
                    </div>
                  ))
                : null}
              {locations.flatMap((entry) => entry.issues).length ? (
                <div className="workspace-issues">
                  {[
                    ...new Set(locations.flatMap((entry) => entry.issues)),
                  ].map((issue) => (
                    <p key={issue}>{issue}</p>
                  ))}
                </div>
              ) : null}
            </div>
          ))
        )}
      </section>

      <p className="local-note">
        Your CAD files stay on your storage. Save and close CAD documents before
        importing or capturing.
      </p>
      {flow === "create" ? (
        <Modal
          title="Create project"
          onClose={() => setFlow(null)}
          busy={busy}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                if (!name.trim()) throw new Error("Enter a project name.");
                await props.onCreate(name);
                setFlow(null);
              });
            }}
          >
            <fieldset disabled={busy}>
              <label className="field">
                <span>Project name</span>
                <input
                  autoFocus
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <p>
                A new project folder will be created inside{" "}
                {props.workspace.identity.name} automatically.
              </p>
              {error ? <Notice type="error">{error}</Notice> : null}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setFlow(null)}
                >
                  Cancel
                </button>
                <button className="button primary">Create project</button>
              </div>
            </fieldset>
          </form>
          <OperationProgress progress={props.progress} onCancel={props.onCancel} />
        </Modal>
      ) : null}
      {flow === "import" ? (
        <Modal
          title="Import existing project"
          onClose={() => setFlow(null)}
          busy={busy}
        >
          <p>
            Import a verified copy inside {props.workspace.identity.name}.
            An ordinary CAD folder becomes a new project named after the folder.
            A complete cAdtree project keeps its name, document IDs and saved history.
            The original folder and its files remain untouched.
          </p>
          <p>
            Save and close CAD documents before selecting the folder. Continue
            working in the new copy after import and check its CAD references.
          </p>
          {error ? <Notice type="error">{error}</Notice> : null}
          <div className="modal-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setFlow(null)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void run(pickSource)}
            >
              Choose project folder
            </button>
          </div>
          <OperationProgress progress={props.progress} onCancel={props.onCancel} />
        </Modal>
      ) : null}
    </div>
  );
}
