import { useState } from "react";
import {
  ArrowUpRight,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Plus,
} from "lucide-react";
import {
  type FileSystemDirectoryAdapter,
  RealFileSystemAdapter,
} from "../engine/fs-adapter";
import type { RememberedProjectBinding } from "../engine/idb-store";
import {
  formatTimestamp,
  isEmbeddedIframe,
  supportsFileSystemAccessApi,
} from "../utils/format";
import { Modal, Notice } from "./ui";

export interface ProjectConnectViewProps {
  rememberedBindings: RememberedProjectBinding[];
  onCreateRealProject: (
    name: string,
    working: FileSystemDirectoryAdapter,
    vault: FileSystemDirectoryAdapter,
  ) => Promise<void>;
  onOpenRealVault: (
    vault: FileSystemDirectoryAdapter,
    working: FileSystemDirectoryAdapter | null,
  ) => Promise<void>;
  onReconnectRemembered: (binding: RememberedProjectBinding) => Promise<void>;
  onRemoveRemembered: (id: string) => Promise<void>;
  onClearAllConvenienceMetadata: () => Promise<void>;
}
export function ProjectConnectView({
  rememberedBindings,
  onCreateRealProject,
  onOpenRealVault,
  onReconnectRemembered,
  onRemoveRemembered,
}: ProjectConnectViewProps) {
  const [flow, setFlow] = useState<"create" | "open" | null>(null);
  const [name, setName] = useState("");
  const [working, setWorking] = useState<RealFileSystemAdapter | null>(null);
  const [vault, setVault] = useState<RealFileSystemAdapter | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [forget, setForget] = useState<RememberedProjectBinding | null>(null);
  const start = (kind: "create" | "open") => {
    setFlow(kind);
    setName("");
    setWorking(null);
    setVault(null);
    setError("");
  };
  const pick = async (mode: "read" | "readwrite") => {
    try {
      if (!supportsFileSystemAccessApi())
        throw new Error(
          "Use Chrome or Edge in a standalone tab to connect local folders.",
        );
      const handle = await (
        window as unknown as {
          showDirectoryPicker: (o: {
            mode: string;
          }) => Promise<FileSystemDirectoryHandle>;
        }
      ).showDirectoryPicker({ mode });
      return new RealFileSystemAdapter(handle);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return null;
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page projects-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR LOCAL WORKSPACE</p>
          <h1>
            Projects<span className="heading-dot">.</span>
          </h1>
          <p>Good engineering deserves a clear history.</p>
        </div>
        <button className="button primary" onClick={() => start("create")}>
          <Plus size={17} />
          New project
        </button>
      </div>
      {isEmbeddedIframe() || !supportsFileSystemAccessApi() ? (
        <Notice>
          Local folder connections need a standalone Chrome or Edge tab.{" "}
          <a
            href={window.location.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open standalone ↗
          </a>
        </Notice>
      ) : null}
      {error && !flow ? <Notice type="error">{error}</Notice> : null}
      <section className="recent-projects">
        <div className="section-heading">
          <h2>Recent projects</h2>
          <span className="muted">
            {rememberedBindings.length
              ? "Saved on this browser"
              : "All your work stays local"}
          </span>
        </div>
        {rememberedBindings.length ? (
          <div className="project-list">
            {[...rememberedBindings]
              .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
              .map((item) => (
                <article className="project-row" key={item.projectId}>
                  <div className="project-icon">
                    <FolderOpen size={24} />
                  </div>
                  <div className="project-copy">
                    <h3>{item.projectName}</h3>
                    <p>Last opened {formatTimestamp(item.lastOpenedAt)}</p>
                    <span className="small muted">
                      {item.vaultFolderName
                        ? "Vault: " + item.vaultFolderName + " · "
                        : ""}
                      Folder access checked when opened
                    </span>
                  </div>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => run(() => onReconnectRemembered(item))}
                  >
                    Open
                    <ArrowUpRight size={15} />
                  </button>
                  <button
                    className="text-button forget"
                    disabled={busy}
                    onClick={() => setForget(item)}
                  >
                    Forget
                  </button>
                </article>
              ))}
          </div>
        ) : (
          <div className="projects-empty">
            <div className="empty-project-art" aria-hidden="true">
              <span />
              <span />
              <span />
              <i />
            </div>
            <h2>A home for every design decision</h2>
            <p>
              Connect a CAD working folder, save milestones, and recover a
              separate copy whenever you need it.
            </p>
            <button className="button primary" onClick={() => start("create")}>
              <Plus size={16} />
              Create your first project
            </button>
          </div>
        )}
      </section>
      <div className="project-entry-points">
        <button onClick={() => start("create")}>
          <FolderPlus size={22} />
          <span>
            <strong>Start a new project</strong>
            <small>
              Connect a working folder and a separate revision vault.
            </small>
          </span>
          <Plus size={17} />
        </button>
        <button onClick={() => start("open")}>
          <HardDrive size={22} />
          <span>
            <strong>Open existing vault</strong>
            <small>Pick up from history saved on your own storage.</small>
          </span>
          <ArrowUpRight size={17} />
        </button>
      </div>
      <p className="local-note">
        <HardDrive size={15} />
        Your project files and revision vault stay on your computer.
      </p>
      {flow ? (
        <Modal
          title={flow === "create" ? "New project" : "Open existing vault"}
          onClose={() => setFlow(null)}
          busy={busy}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!vault || (flow === "create" && (!working || !name.trim()))) {
                setError(
                  "Choose the required folders and enter a project name.",
                );
                return;
              }
              run(async () => {
                if (flow === "create")
                  await onCreateRealProject(name.trim(), working!, vault);
                else await onOpenRealVault(vault, working);
                setFlow(null);
              });
            }}
          >
            <fieldset disabled={busy}>
              <p className="muted">
                {flow === "create"
                  ? "Your working folder holds your CAD files. A separate vault stores complete saved revisions."
                  : "Open the folder you previously chose as a revision vault. You can connect a working folder now or later."}
              </p>
              {error ? <Notice type="error">{error}</Notice> : null}
              {flow === "create" ? (
                <label className="field">
                  <span>Project name</span>
                  <input
                    autoFocus
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Linear actuator"
                  />
                </label>
              ) : null}
              {flow === "create" ? (
                <div className="folder-field">
                  <div>
                    <strong>CAD working folder</strong>
                    <p>
                      {working?.name ?? "Read access to your saved CAD files"}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={async () => {
                      const dir = await pick("read");
                      if (dir) {
                        setWorking(dir);
                        if (!name) setName(dir.name);
                      }
                    }}
                  >
                    {working ? "Change" : "Choose folder"}
                  </button>
                </div>
              ) : null}
              <div className="folder-field">
                <div>
                  <strong>
                    {flow === "create"
                      ? "Separate empty vault"
                      : "Revision vault"}
                  </strong>
                  <p>
                    {vault?.name ??
                      (flow === "create"
                        ? "An empty folder outside your working folder. We need permission to save revisions here."
                        : "Permission is checked before opening your history.")}
                  </p>
                </div>
                <button
                  type="button"
                  className="button secondary"
                  onClick={async () => {
                    const dir = await pick("readwrite");
                    if (dir) setVault(dir);
                  }}
                >
                  {vault ? "Change" : "Choose vault"}
                </button>
              </div>
              {flow === "open" ? (
                <div className="folder-field">
                  <div>
                    <strong>
                      Main working folder <span className="muted">(optional)</span>
                    </strong>
                    <p>
                      {working?.name ??
                        "Connect Main here, or connect each branch later from the project header."}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={async () => {
                      const dir = await pick("read");
                      if (dir) setWorking(dir);
                    }}
                  >
                    {working ? "Change" : "Connect"}
                  </button>
                </div>
              ) : null}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setFlow(null)}
                >
                  Cancel
                </button>
                <button className="button primary">
                  {busy
                    ? "Opening…"
                    : flow === "create"
                      ? "Create project"
                      : "Open project"}
                </button>
              </div>
            </fieldset>
          </form>
        </Modal>
      ) : null}
      {forget ? (
        <Modal
          title="Forget this project?"
          onClose={() => setForget(null)}
          busy={busy}
        >
          <p>
            Remove “{forget.projectName}” from this browser’s recent projects.
            Your CAD files and saved revisions stay in their folders.
          </p>
          {error ? <Notice type="error">{error}</Notice> : null}
          <div className="modal-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setForget(null)}
            >
              Keep project
            </button>
            <button
              className="button secondary danger"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await onRemoveRemembered(forget.projectId);
                  setForget(null);
                })
              }
            >
              Forget project
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
