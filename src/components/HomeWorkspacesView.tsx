import { useRef, useState } from "react";
import { FolderOpen, Plus, RefreshCw } from "lucide-react";
import {
  homeWorkspaceGroups,
  type HomeState,
  type HomeWorkspaceEntry,
} from "../engine/home-service";
import type { RememberedHome } from "../engine/idb-store";
import type { ProgressUpdate } from "../engine/types";
import { MessageLines, Modal, Notice, OperationProgress } from "./ui";
import { pathBudgetBlockSentence, workspaceNameHint } from "../utils/path-budget-message";
import { HomeFolderAddressSetting } from "./FilePathShortcuts";
import { HomeWelcome } from "./HomeWelcome";

export function HomeWorkspacesView(props: {
  home: HomeState | null;
  /** Absolute address of the Cadtree home, when known (drives the name hint). */
  homeAddress?: string;
  intro?: boolean;
  remembered: RememberedHome | null;
  busy: boolean;
  progress: ProgressUpdate | null;
  onConnect: (create: boolean) => Promise<void>;
  onReconnect: () => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onBring: () => Promise<void>;
  onOpen: (entry: HomeWorkspaceEntry) => Promise<void>;
  onRefresh: () => Promise<void>;
  onCancel: () => void;
}) {
  const options = useRef<HTMLDetailsElement>(null);
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const nameHint = workspaceNameHint(props.homeAddress, name);
  const run = async (action: () => Promise<void>) => {
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div
      className={`page projects-page${props.home && !props.intro ? "" : " home-welcome"}`}
    >
      {props.home && !props.intro ? (
        <div className="page-heading">
          <div>
            <p className="eyebrow">CADTREE HOME</p>
            <h1>
              My workspaces<span className="heading-dot">.</span>
            </h1>
            <p>
              {props.home
                ? props.home.identity.name
                : "Your designs. Your versions. Your storage."}
            </p>
          </div>
          <div className="home-heading-actions">
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
            <details className="workspace-menu home-options" ref={options}>
              <summary
                onClick={(event) => {
                  if (props.busy) event.preventDefault();
                }}
                aria-disabled={props.busy || undefined}
              >
                Home options
              </summary>
              <div
                className="workspace-menu-content"
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest("button")) {
                    options.current?.removeAttribute("open");
                    options.current
                      ?.querySelector<HTMLElement>("summary")
                      ?.focus();
                  }
                }}
              >
                {props.home ? (
                  <>
                    <HomeFolderAddressSetting />
                    <button
                      className="text-button"
                      disabled={props.busy}
                      onClick={() => {
                        setError("");
                        setImporting(true);
                      }}
                    >
                      Import existing workspace
                    </button>
                  </>
                ) : null}
                <button
                  className="text-button"
                  disabled={props.busy}
                  onClick={() => void run(() => props.onConnect(false))}
                >
                  Switch Cadtree home
                </button>
              </div>
            </details>
          </div>
        </div>
      ) : null}
      {error ? <Notice type="error"><MessageLines text={error} /></Notice> : null}
      {!props.home || props.intro ? (
        <HomeWelcome
          remembered={props.remembered}
          busy={props.busy}
          onStart={() => void run(() => props.onConnect(true))}
          onOpen={() => void run(() => props.onConnect(false))}
          onReturn={() => void run(props.onReconnect)}
        />
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
                    {entry.status !== "ready" ||
                    entries.length > 1 ||
                    entries.some(
                      (e) =>
                        e.recordedDirectory && e.recordedDirectory !== e.directory,
                    ) ? (
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
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}
      <OperationProgress progress={props.progress} onCancel={props.onCancel} />
      {importing ? (
        <Modal
          title="Import existing workspace"
          busy={props.busy}
          onClose={() => setImporting(false)}
        >
          <p>
            Create a verified managed copy inside {props.home?.root.name},
            including working edits not yet captured in history. The original
            workspace and its files remain untouched.
          </p>
          <p>
            Choose the existing workspace folder using the native folder picker.
            Workspace groups do not grant collaboration permissions.
          </p>
          {error ? <Notice type="error"><MessageLines text={error} /></Notice> : null}
          <div className="modal-actions">
            <button
              className="button secondary"
              disabled={props.busy}
              onClick={() => setImporting(false)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              disabled={props.busy}
              onClick={() =>
                void run(async () => {
                  await props.onBring();
                  setImporting(false);
                })
              }
            >
              Choose workspace folder
            </button>
          </div>
        </Modal>
      ) : null}
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
              {nameHint?.block ? (
                <p className="field-help" role="alert">{pathBudgetBlockSentence(nameHint.block)}</p>
              ) : nameHint?.text ? (
                <p className="field-help">{nameHint.text}</p>
              ) : null}
              <p>
                A new folder will be allocated inside {props.home?.root.name}{" "}
                automatically.
              </p>
              {error ? <Notice type="error"><MessageLines text={error} /></Notice> : null}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setCreating(false)}
                >
                  Cancel
                </button>
                <button className="button primary" disabled={Boolean(nameHint?.block)}>Create workspace</button>
              </div>
            </fieldset>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
