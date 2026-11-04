import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Copy, MoreHorizontal } from "lucide-react";
import {
  composeFilePaths,
  type ResolveFilePath,
} from "../utils/folder-path";
import { getWorkspacePath } from "../engine/idb-store";
import type { WorkspaceState } from "../engine/workspace-service";
import type { HomeState } from "../engine/home-service";
import { RealFileSystemAdapter } from "../engine/fs-adapter";
import { Modal, Notice } from "./ui";

import {
  FolderAddressDialog,
  rememberFolderAddress,
  type HomeAddress,
} from "./FolderAddressDialog";

type CopyRequest = { resolve: ResolveFilePath; containingFolder: boolean };
interface ShortcutContext {
  copy: (request: CopyRequest) => void;
  configure: () => void;
  folderPath: string;
  home: boolean;
}
const Shortcuts = createContext<ShortcutContext | null>(null);

export function FilePathShortcutsProvider({
  workspace,
  home,
  contextKey,
  convenienceEpoch,
  homeAddress,
  onHomeAddressChange,
  children,
}: {
  workspace: WorkspaceState | null;
  home?: HomeState | null;
  contextKey?: string;
  convenienceEpoch: number;
  homeAddress?: HomeAddress | null;
  onHomeAddressChange?: (address: HomeAddress) => void;
  children: ReactNode;
}) {
  const workspaceId = home?.identity.homeId ?? workspace?.identity.workspaceId;
  const accessRoot = home?.root ?? workspace?.root;
  const accessHandle =
    accessRoot instanceof RealFileSystemAdapter ? accessRoot.handle : undefined;
  const [setting, setSetting] = useState<{ workspaceId: string; path: string; root?: typeof accessRoot }>({ workspaceId: "", path: "" });
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<CopyRequest | null>(null);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [feedback, setFeedback] = useState("");
  const [manualPath, setManualPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const copying = useRef(false);
  const version = useRef(0);
  const folderPath = homeAddress && homeAddress.homeId === workspaceId && homeAddress.root === accessRoot
    ? homeAddress.path
    : setting.workspaceId === workspaceId && setting.root === accessRoot ? setting.path : "";
  useEffect(() => {
    const currentVersion = ++version.current;
    copying.current = false;
    setBusy(false);
    setEditing(false);
    setPending(null);
    setManualPath(null);
    setFeedback("");
    setError("");
    setWarning("");
    setSetting({ workspaceId: workspaceId ?? "", path: "" });
    if (!workspaceId) return;
    if (
      homeAddress?.homeId === workspaceId &&
      homeAddress.root === accessRoot
    ) {
      setSetting({ workspaceId, path: homeAddress.path, root: accessRoot });
      return;
    }
    let cancelled = false;
    void getWorkspacePath(workspaceId, accessHandle)
      .then((path) => {
        if (cancelled || version.current !== currentVersion) return;
        setSetting({ workspaceId, path, root: accessRoot });
      })
      .catch(() => {
        /* Path setup is offered only on request. */
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, accessRoot, convenienceEpoch, contextKey]);
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(""), 3000);
    return () => clearTimeout(timer);
  }, [feedback]);

  const execute = async (request: CopyRequest, root: string) => {
    const currentVersion = version.current;
    const location = await request.resolve();
    if (!workspaceId || location.workspaceId !== workspaceId)
      throw new Error(
        "File path unavailable. Open the relevant managed workspace first. Absolute locations for external project or recovery folders are not known to the browser.",
      );
    if (currentVersion !== version.current) return;
    // A click can arrive before the initial preference read finishes.
    if (!root) {
      try {
        root = await getWorkspacePath(workspaceId, accessHandle);
      } catch {
        /* Setup also works with session-only preferences. */
      }
      if (currentVersion !== version.current) return;
    }
    if (!root) {
      setInput("");
      setPending(request);
      setEditing(true);
      return;
    }
    const paths = composeFilePaths(root, location);
    const path = request.containingFolder ? paths.folder : paths.file;
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(path);
      if (currentVersion === version.current)
        setFeedback(
          request.containingFolder ? "Folder path copied" : "File path copied",
        );
    } catch {
      if (currentVersion === version.current) setManualPath(path);
    }
  };
  const copy = async (request: CopyRequest) => {
    if (copying.current) return;
    const currentVersion = version.current;
    copying.current = true;
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      await execute(request, folderPath);
    } catch (error) {
      if (currentVersion === version.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (currentVersion === version.current) {
        copying.current = false;
        setBusy(false);
      }
    }
  };
  const configure = async () => {
    const currentVersion = version.current;
    let path = folderPath;
    if (!path && workspaceId) {
      try {
        path = await getWorkspacePath(workspaceId, accessHandle);
      } catch {
        /* Session-only setup remains available. */
      }
    }
    if (currentVersion !== version.current) return;
    setPending(null);
    setInput(path);
    setError("");
    setEditing(true);
  };
  return (
    <Shortcuts.Provider
      value={{
        copy: (request) => {
          void copy(request);
        },
        configure,
        folderPath,
        home: Boolean(home),
      }}
    >
      {children}
      {feedback ? (
        <div className="path-feedback" role="status">
          {feedback}
        </div>
      ) : null}
      {error && !editing ? (
        <Modal title="File path unavailable" onClose={() => setError("")}>
          <Notice type="error">{error}</Notice>
          <button className="button secondary" onClick={() => setError("")}>
            Close
          </button>
        </Modal>
      ) : null}
      {editing && (workspace || home) ? (
        <FolderAddressDialog
          home={Boolean(home)}
          folderName={accessRoot!.name}
          initialValue={input}
          required={Boolean(home || pending)}
          title={home && !pending ? "Edit home folder address" : undefined}
          submitLabel={pending ? "Save and copy" : "Save"}
          onCancel={() => {
            setEditing(false);
            setPending(null);
            setError("");
          }}
          onSave={async (path) => {
            if (copying.current) return;
            const currentVersion = version.current;
            copying.current = true;
            setBusy(true);
            setError("");
            try {
              const cacheWarning = await rememberFolderAddress(
                workspaceId!,
                path,
                accessHandle,
              );
              if (currentVersion !== version.current) return;
              setSetting({ workspaceId: workspaceId!, path, root: accessRoot });
              if (home)
                onHomeAddressChange?.({
                  homeId: home.identity.homeId,
                  root: home.root,
                  path,
                });
              setWarning(cacheWarning);
              const request = pending;
              setPending(null);
              setEditing(false);
              if (request) await execute(request, path);
            } catch (error) {
              if (currentVersion === version.current)
                setError(
                  error instanceof Error ? error.message : String(error),
                );
            } finally {
              if (currentVersion === version.current) {
                copying.current = false;
                setBusy(false);
              }
            }
          }}
        />
      ) : null}
      {manualPath !== null ? (
        <Modal title="Copy path manually" onClose={() => setManualPath(null)}>
          <p>
            Clipboard access was denied or is unavailable. Select the plain path
            below and press Ctrl+C (Windows/Linux) or Command+C (macOS). No clipboard success has been confirmed.
          </p>
          <label className="field">
            <span>Path to copy</span>
            <textarea
              autoFocus
              readOnly
              rows={4}
              value={manualPath}
              onFocus={(event) => event.target.select()}
              onClick={(event) => event.currentTarget.select()}
              spellCheck={false}
            />
          </label>
          <button
            className="button secondary"
            onClick={() => setManualPath(null)}
          >
            Close
          </button>
        </Modal>
      ) : null}
      {warning && !editing ? (
        <div className="path-storage-warning">
          <Notice onDismiss={() => setWarning("")}>{warning}</Notice>
        </div>
      ) : null}
    </Shortcuts.Provider>
  );
}

export function WorkspaceLocationSetting({
  compact = false,
}: {
  compact?: boolean;
}) {
  const context = useContext(Shortcuts);
  if (!context || context.home) return null;
  return (
    <div
      className={
        compact
          ? "workspace-path-setting compact"
          : "settings-row workspace-path-setting"
      }
    >
      {!compact ? (
        <div>
          <strong>Local workspace location</strong>
          <p className="file-path">
            {context.folderPath || "Not set — path shortcuts are optional"}
          </p>
          <p>
            Used for copying paths only. Clear this field or browser data to
            remove this local setting.
          </p>
        </div>
      ) : null}
      <button
        type="button"
        className={compact ? "text-button" : "button secondary"}
        onClick={context.configure}
      >
        Configure path shortcuts
      </button>
    </div>
  );
}

export function HomeFolderAddressSetting() {
  const context = useContext(Shortcuts);
  if (!context?.home) return null;
  return (
    <button type="button" className="text-button" onClick={context.configure}>
      Edit home folder address
    </button>
  );
}

export function FilePathActions({
  filePath,
  resolve,
  historicalBranch,
  restored = false,
}: {
  filePath: string;
  resolve: ResolveFilePath;
  historicalBranch?: string;
  restored?: boolean;
}) {
  const context = useContext(Shortcuts);
  if (!context) return null;
  const label = "Copy folder path";
  const description = `${historicalBranch ? "Current file on " + historicalBranch + " · " : restored ? "Restored copy · " : ""}${filePath}`;
  return (
    <div
      className={`file-path-actions${historicalBranch ? " historical" : ""}`}
    >
      <button
        type="button"
        className={historicalBranch ? "text-button" : "icon-button"}
        aria-label={`${label} — ${description}`}
        title={`${label} — ${description}`}
        onClick={() => context.copy({ resolve, containingFolder: true })}
      >
        <Copy size={15} aria-hidden="true" />
        {historicalBranch ? (
          <span>
            {label} · Current file on {historicalBranch}
          </span>
        ) : null}
      </button>
      <details className="file-path-menu">
        <summary
          title={`More path actions — ${description}`}
          aria-label={`More path actions — ${description}`}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </summary>
        <button
          type="button"
          className="text-button"
          aria-label={`Copy full file path — ${description}`}
          onClick={(event) => {
            const disclosure = event.currentTarget.closest("details");
            disclosure?.removeAttribute("open");
            disclosure?.querySelector<HTMLElement>("summary")?.focus();
            context.copy({ resolve, containingFolder: false });
          }}
        >
          Copy full file path
          {historicalBranch ? ` · Current file on ${historicalBranch}` : ""}
        </button>
      </details>
    </div>
  );
}
