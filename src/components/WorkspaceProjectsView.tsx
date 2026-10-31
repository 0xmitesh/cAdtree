import { useState } from "react";
import { FolderOpen, FolderPlus, Plus, RefreshCw } from "lucide-react";
import {
  RealFileSystemAdapter,
  type FileSystemDirectoryAdapter,
} from "../engine/fs-adapter";
import type {
  WorkspaceState,
  WorkspaceProjectEntry,
} from "../engine/workspace-service";
import type { RememberedWorkspace } from "../engine/idb-store";
import { Modal, Notice, OperationProgress } from "./ui";
import type { ProgressUpdate } from "../engine/types";
import { WorkspaceLocationSetting } from "./FilePathShortcuts";

export interface WorkspaceProjectsViewProps {
  workspace: WorkspaceState | null;
  remembered: RememberedWorkspace | null;
  busy: boolean;
  progress: ProgressUpdate | null;
  externalProjectName?: string;
  adoptionBlockedReason?: string;
  onCreate: (root: FileSystemDirectoryAdapter, name: string) => Promise<void>;
  onOpen: (root: FileSystemDirectoryAdapter) => Promise<void>;
  onReconnect: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onImport: (source: FileSystemDirectoryAdapter, name: string) => Promise<void>;
  onOpenProject: (entry: WorkspaceProjectEntry) => Promise<void>;
  onAdopt: () => Promise<void>;
  onExternal: () => void;
  onCancel: () => void;
}
export function WorkspaceProjectsView(props: WorkspaceProjectsViewProps) {
  const [flow, setFlow] = useState<"create" | "import" | "adopt" | null>(null);
  const [folder, setFolder] = useState<FileSystemDirectoryAdapter | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [choosingLocation, setChoosingLocation] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setError("");
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  const pick = async (mode: "read" | "readwrite") => {
    const picker = (
      window as unknown as {
        showDirectoryPicker?: (options: {
          mode: string;
        }) => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker;
    if (!picker)
      throw new Error("Local folders require a standalone Edge or Chrome tab.");
    return new RealFileSystemAdapter(await picker({ mode }));
  };
  const start = (kind: typeof flow) => {
    setFlow(kind);
    setFolder(null);
    setName("");
    setError("");
  };
  const groups = new Map<string, WorkspaceProjectEntry[]>();
  for (const entry of props.workspace?.projects ?? []) {
    const key = entry.projectId ?? entry.containerPath;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return (
    <div className="page projects-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR LOCAL WORKSPACE</p>
          <h1>
            {props.workspace?.identity.name ?? "Workspace"}
            <span className="heading-dot">.</span>
          </h1>
          <p>
            {props.workspace
              ? "Your projects, together in one workspace."
              : "Your designs. Your versions. Your storage."}
          </p>
        </div>
        {props.workspace ? (
          <div className="workspace-heading-actions">
            <button
              className="button primary"
              disabled={props.busy}
              onClick={() => start("import")}
            >
              <Plus size={16} /> Add project
            </button>
            <details className="workspace-menu">
              <summary>Workspace options</summary>
              <div className="workspace-menu-content">
                <button
                  type="button"
                  className="text-button"
                  disabled={props.busy}
                  onClick={(event) => {
                    const disclosure = event.currentTarget.closest("details");
                    disclosure?.removeAttribute("open");
                    disclosure?.querySelector<HTMLElement>("summary")?.focus();
                    start("create");
                  }}
                >
                  Create workspace
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={props.busy}
                  onClick={(event) => {
                    const disclosure = event.currentTarget.closest("details");
                    disclosure?.removeAttribute("open");
                    disclosure?.querySelector<HTMLElement>("summary")?.focus();
                    void run(async () => props.onOpen(await pick("readwrite")));
                  }}
                >
                  Open / switch workspace
                </button>
                <WorkspaceLocationSetting compact />
              </div>
            </details>
          </div>
        ) : null}
      </div>
      {error ? <Notice type="error">{error}</Notice> : null}
      {!props.workspace ? (
        <div className="project-entry-points">
          <button
            className="panel"
            disabled={props.busy}
            onClick={() => start("create")}
          >
            <FolderPlus size={21} />
            <span>
              <strong>Create workspace</strong>
              <small>Choose an empty folder for your managed projects.</small>
            </span>
          </button>
          <button
            className="panel"
            disabled={props.busy}
            onClick={() =>
              run(async () => props.onOpen(await pick("readwrite")))
            }
          >
            <FolderOpen size={21} />
            <span>
              <strong>Open workspace</strong>
              <small>
                One folder reconnects its projects and intact cases.
              </small>
            </span>
          </button>
        </div>
      ) : null}
      {props.remembered && !props.workspace ? (
        <button
          className="button secondary workspace-reconnect"
          disabled={props.busy}
          onClick={() => run(props.onReconnect)}
        >
          Reconnect {props.remembered.name}
        </button>
      ) : null}
      {props.workspace ? (
        <section className="recent-projects">
          <div className="section-heading">
            <h2>Workspace projects</h2>
            <button
              className="text-button"
              disabled={props.busy}
              onClick={() => run(props.onRefresh)}
            >
              <RefreshCw size={14} /> Refresh workspace
            </button>
          </div>
          {!groups.size ? (
            <div className="panel projects-empty">
              <h2>Add your first project</h2>
              <p>
                Import a verified copy of an existing CAD folder. Your original
                stays untouched.
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
                      disabled={props.busy}
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
                          disabled={props.busy || !entry.project}
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
      ) : null}
      {props.workspace && props.externalProjectName ? (
        <section className="panel form-body workspace-adopt">
          <h2>Bring {props.externalProjectName} into workspace</h2>
          <p>
            Copy its existing vault and all current working folders, including
            uncaptured edits. Original folders and historical record bytes are
            retained unchanged.
          </p>
          {props.adoptionBlockedReason ? (
            <Notice>{props.adoptionBlockedReason}</Notice>
          ) : null}
          <button
            className="button secondary"
            disabled={props.busy || Boolean(props.adoptionBlockedReason)}
            onClick={() => start("adopt")}
          >
            Bring into workspace
          </button>
        </section>
      ) : null}
      <details className="disclosure">
        <summary>Advanced: external projects</summary>
        <p className="muted small">
          Inspect an existing cAdtree vault outside the workspace. Connect its
          current branch folders once to bring it into managed storage.
        </p>
        <button
          className="button secondary"
          disabled={props.busy}
          onClick={props.onExternal}
        >
          Open external projects
        </button>
      </details>
      <p className="local-note">
        Your CAD files stay on your storage. Save and close CAD documents before
        importing or capturing.
      </p>
      {flow ? (
        <Modal
          title={
            flow === "create"
              ? "Create workspace"
              : flow === "import"
                ? "Import existing CAD project"
                : "Bring into workspace"
          }
          onClose={() => setFlow(null)}
          busy={props.busy}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                if (flow === "adopt") await props.onAdopt();
                else {
                  if (!folder || !name.trim())
                    throw new Error("Choose a folder and enter a name.");
                  if (flow === "create") await props.onCreate(folder, name);
                  else await props.onImport(folder, name);
                }
                setFlow(null);
              });
            }}
          >
            <fieldset disabled={props.busy}>
              {flow !== "adopt" ? (
                <>
                  <label className="field">
                    <span>
                      {flow === "create" ? "Workspace name" : "Project name"}
                    </span>
                    <input
                      autoFocus
                      required
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                  <div className="folder-field">
                    <div>
                      <strong>
                        {flow === "create"
                          ? "Empty workspace folder"
                          : "Original CAD source folder"}
                      </strong>
                      <p>
                        {folder?.name ??
                          (flow === "create"
                            ? "Choose an empty folder. Populated folders will not be adopted."
                            : "The source is read and copied; originals remain untouched.")}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() =>
                        run(async () => {
                          const chosen = await pick(
                            flow === "create" ? "readwrite" : "read",
                          );
                          setFolder(chosen);
                          if (!name) setName(chosen.name);
                        })
                      }
                    >
                      Choose folder
                    </button>
                  </div>
                </>
              ) : (
                <p>
                  A verified copy of the connected external vault and every
                  branch working folder will be created. Continue editing only
                  in the chosen managed location after completion.
                </p>
              )}
              {flow === "import" || flow === "adopt" ? (
                <>
                  <p className="managed-destination">
                    Destination: {props.workspace?.identity.name}
                    /projects/&lt;new project&gt;/working/main/
                  </p>
                  <p className="muted small">
                    Continue working in this copy after import. Open it manually
                    in SolidWorks and check its referenced-document paths. No
                    initial revision is created automatically.
                  </p>
                </>
              ) : null}
              {error ? <Notice type="error">{error}</Notice> : null}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setFlow(null)}
                >
                  Cancel
                </button>
                <button className="button primary">
                  {flow === "create"
                    ? "Create workspace"
                    : flow === "import"
                      ? "Import project"
                      : "Copy project into workspace"}
                </button>
              </div>
            </fieldset>
          </form>
          <OperationProgress
            progress={props.progress}
            onCancel={props.onCancel}
          />
        </Modal>
      ) : null}
    </div>
  );
}
