import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Copy, MoreHorizontal } from "lucide-react";
import {
  composeWindowsFilePaths,
  normalizeWindowsWorkspacePath,
  type ResolveFilePath,
} from "../utils/windows-path";
import {
  getWorkspaceWindowsPath,
  saveWorkspaceWindowsPath,
} from "../engine/idb-store";
import type { WorkspaceState } from "../engine/workspace-service";
import type { HomeState } from "../engine/home-service";
import { RealFileSystemAdapter } from "../engine/fs-adapter";
import { Modal, Notice } from "./ui";

export function WindowsWorkspacePathField({
  value,
  onChange,
  home = false,
}: {
  value: string;
  onChange: (value: string) => void;
  home?: boolean;
}) {
  const id = useId();
  return (
    <label className="field windows-path-field">
      <span id={`${id}-label`}>
        {home ? "Cadtree home folder path" : "Workspace folder path"}
      </span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={home ? "D:\\Cadtree" : "D:\\CAD Workspace"}
        aria-labelledby={`${id}-label`}
        aria-describedby={id}
        autoComplete="off"
        spellCheck={false}
      />
      <span className="field-help" id={id}>
        Copy this {home ? "Cadtree home" : "workspace"} folder’s full location
        from Explorer’s address bar.
      </span>
    </label>
  );
}

type CopyRequest = { resolve: ResolveFilePath; containingFolder: boolean };
interface ShortcutContext {
  copy: (request: CopyRequest) => void;
  configure: () => void;
  windowsPath: string;
}
const Shortcuts = createContext<ShortcutContext | null>(null);

export function FilePathShortcutsProvider({
  workspace,
  home,
  contextKey,
  convenienceEpoch,
  children,
}: {
  workspace: WorkspaceState | null;
  home?: HomeState | null;
  contextKey?: string;
  convenienceEpoch: number;
  children: ReactNode;
}) {
  const workspaceId = home?.identity.homeId ?? workspace?.identity.workspaceId;
  const accessRoot = home?.root ?? workspace?.root;
  const accessHandle =
    accessRoot instanceof RealFileSystemAdapter ? accessRoot.handle : undefined;
  const [setting, setSetting] = useState({ workspaceId: "", path: "" });
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
  const windowsPath = setting.workspaceId === workspaceId ? setting.path : "";
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
    let cancelled = false;
    void getWorkspaceWindowsPath(workspaceId, accessHandle)
      .then((path) => {
        if (cancelled || version.current !== currentVersion) return;
        setSetting({ workspaceId, path });
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
        root = await getWorkspaceWindowsPath(workspaceId, accessHandle);
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
    const paths = composeWindowsFilePaths(root, location);
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
      await execute(request, windowsPath);
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
    let path = windowsPath;
    if (!path && workspaceId) {
      try {
        path = await getWorkspaceWindowsPath(workspaceId, accessHandle);
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
        windowsPath,
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
        <Modal
          title="Set up folder-path copying"
          busy={busy}
          onClose={() => {
            setEditing(false);
            setPending(null);
            setError("");
          }}
        >
          <p>
            Paste this {home ? "Cadtree home" : "workspace"} folder’s full
            Windows path once so cAdtree can copy locations you can paste into
            File Explorer.
          </p>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (copying.current) return;
              const currentVersion = version.current;
              copying.current = true;
              setBusy(true);
              setError("");
              try {
                const path = normalizeWindowsWorkspacePath(input);
                if (pending && !path)
                  throw new Error(
                    "Enter the workspace folder path to complete this copy, or cancel.",
                  );
                let cacheWarning = "";
                try {
                  await saveWorkspaceWindowsPath(
                    workspaceId!,
                    path,
                    accessHandle,
                  );
                } catch {
                  cacheWarning =
                    "Your path could not be remembered. It is available for this session only; set it again next time.";
                }
                if (currentVersion !== version.current) return;
                setSetting({
                  workspaceId: workspaceId!,
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
          >
            <fieldset disabled={busy}>
              <WindowsWorkspacePathField
                home={Boolean(home)}
                value={input}
                onChange={setInput}
              />
              {error ? <Notice type="error">{error}</Notice> : null}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    setPending(null);
                    setEditing(false);
                    setError("");
                  }}
                >
                  Cancel
                </button>
                <button className="button primary">
                  {pending ? "Save and copy" : "Save"}
                </button>
              </div>
            </fieldset>
          </form>
        </Modal>
      ) : null}
      {manualPath !== null ? (
        <Modal title="Copy path manually" onClose={() => setManualPath(null)}>
          <p>
            Clipboard access was denied or is unavailable. Select the plain path
            below and press Ctrl+C. No clipboard success has been confirmed.
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
  if (!context) return null;
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
          <strong>Windows workspace location</strong>
          <p className="file-path">
            {context.windowsPath || "Not set — path shortcuts are optional"}
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
