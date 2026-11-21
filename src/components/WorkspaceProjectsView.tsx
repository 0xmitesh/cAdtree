import { DUPLICATE_PROJECT_REASON } from "../engine/workspace-service";
import { pickDirectory } from "../utils/folder-access";
import { useRef, useState } from "react";
import { FolderOpen, Plus } from "lucide-react";
import {
  RealFileSystemAdapter,
  type FileSystemDirectoryAdapter,
} from "../engine/fs-adapter";
import type {
  WorkspaceState,
  WorkspaceProjectEntry,
} from "../engine/workspace-service";
import { MessageLines, Modal, Notice, OperationProgress } from "./ui";
import { pathBudgetBlockSentence, projectNameHint } from "../utils/path-budget-message";
import type { ProgressUpdate } from "../engine/types";

export interface WorkspaceProjectsViewProps {
  onAllWorkspaces: () => void;
  workspace: WorkspaceState;
  /** Absolute address of the workspace folder, when known (drives the name hint). */
  workspaceAddress?: string;
  busy: boolean;
  progress: ProgressUpdate | null;
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
  const nameHint = projectNameHint(props.workspaceAddress, name);
  const [pickerMessage, setPickerMessage] = useState("");
  const run = async (action: () => Promise<void>) => {
    setError("");
    setPickerMessage("");
    try {
      await action();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setPickerMessage("Folder selection was cancelled. Choose a project folder when you are ready.");
        return;
      }
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  const pickSource = async () => {
    if (picking.current) return;
    picking.current = true;
    setChoosingFolder(true);
    try {
      const chosen = new RealFileSystemAdapter(await pickDirectory("read"));
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
        className="text-button workspace-return"
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
      {error ? <Notice type="error"><MessageLines text={error} /></Notice> : null}
      <section className="recent-projects">
        <div className="section-heading">
          <h2>Workspace projects</h2>
        </div>
        {!groups.size ? (
          <div className="panel projects-empty">
            <h2>Add your first project</h2>
            <p>
              Create an empty project, or import a checked copy of an existing
              folder of files. Your original stays untouched.
            </p>
          </div>
        ) : (
          [...groups].map(([id, locations]) => (
            <div className="panel workspace-project" key={id}>
              <div className="project-row">
                <div className="project-copy">
                  <h3>{locations[0].name}</h3>
                  {locations.length > 1 ? <p>{locations.length} locations for the same project</p> : null}
                  <p className="small">
                    {locations.length === 1 && locations[0].status === "ready"
                      ? "Ready"
                      : "Needs attention"}
                  </p>
                  {locations.length > 1 || locations[0].status !== "ready" ? (
                    <p className="small">
                      {locations.length > 1
                        ? `${locations.length === 2 ? "Two" : locations.length} folders in this workspace are copies of the same project, so cAdtree opens ${locations.length === 2 ? "neither" : "none of them"} to keep them from getting mixed up. Keep the one you want here and move the other ${locations.length === 2 ? "copy" : "copies"} out of the workspace folder; cAdtree checks again automatically.`
                        : locations[0].status === "incomplete"
                          ? "Unfinished copy · it was kept for inspection; a retry uses a fresh folder"
                          : "Connections or records need attention · Read-only inspection available"}
                    </p>
                  ) : null}
                  {locations.length > 1
                    ? locations.map((entry) => (
                        <p className="file-path small" key={entry.containerPath}>
                          Folder in this workspace: {entry.containerPath}
                        </p>
                      ))
                    : null}
                </div>
                {locations.length > 1 ? null : locations[0].project ? (
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
              {locations.length > 1 || locations[0].status !== "ready" ? (
                <details className="disclosure project-location-details">
                  <summary>Location details</summary>
                  {locations[0].projectId ? (
                    <p className="file-path">
                      Project ID: {locations[0].projectId}
                    </p>
                  ) : null}
                  {locations.length === 1
                    ? locations.map((entry) => (
                        <p className="file-path" key={entry.containerPath}>
                          Folder in this workspace: {entry.containerPath}
                        </p>
                      ))
                    : null}
                </details>
              ) : null}
              {locations.flatMap((entry) => entry.issues).filter((issue) => issue !== DUPLICATE_PROJECT_REASON).length ? (
                <div className="workspace-issues">
                  {[
                    ...new Set(locations.flatMap((entry) => entry.issues)),
                  ]
                    .filter((issue) => issue !== DUPLICATE_PROJECT_REASON)
                    .map((issue) => (
                      <p key={issue}>{issue}</p>
                    ))}
                </div>
              ) : null}
            </div>
          ))
        )}
      </section>

      <p className="local-note">
        Your files stay on your storage. Save and close your files in the app
        you use before importing or saving a version.
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
              {nameHint?.block ? (
                <p className="field-help" role="alert">{pathBudgetBlockSentence(nameHint.block)}</p>
              ) : nameHint?.text ? (
                <p className="field-help">{nameHint.text}</p>
              ) : null}
              <p>
                A new project folder will be created inside{" "}
                {props.workspace.identity.name} automatically.
              </p>
              {error ? <Notice type="error"><MessageLines text={error} /></Notice> : null}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setFlow(null)}
                >
                  Cancel
                </button>
                <button className="button primary" disabled={Boolean(nameHint?.block)}>Create project</button>
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
            Import a checked copy inside {props.workspace.identity.name}.
            An ordinary folder of files becomes a new project named after the folder.
            A complete cAdtree project keeps its name, file identities and saved history.
            The original folder and its files remain untouched.
          </p>
          <p>
            Save and close your files in the app you use before selecting the folder. Continue
            working in the new copy after import and check that its links to other files still work.
          </p>
          {pickerMessage ? <Notice>{pickerMessage}</Notice> : null}
          {error ? <Notice type="error"><MessageLines text={error} /></Notice> : null}
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
