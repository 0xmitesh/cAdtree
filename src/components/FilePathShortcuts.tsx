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
import { Modal, Notice } from "./ui";

export function WindowsWorkspacePathField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <label className="field windows-path-field">
      <span id={`${id}-label`}>Windows workspace-root path (optional)</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={"D:\\CAD Workspace"}
        aria-labelledby={`${id}-label`}
        aria-describedby={id}
        autoComplete="off"
        spellCheck={false}
      />
      <span className="field-help" id={id}>
        Copy this workspace folder’s full location from Explorer’s address bar.
        Used only for path shortcuts; it cannot be checked against the chosen
        folder. Folder access and file operations still use your authorized
        browser handle. Stored only in this browser, separately for each
        workspace.
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
  convenienceEpoch,
  setupVersion,
  children,
}: {
  workspace: WorkspaceState | null;
  convenienceEpoch: number;
  setupVersion: number;
  children: ReactNode;
}) {
  const workspaceId = workspace?.identity.workspaceId;
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
  const seenSetup = useRef(0);
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
    const shouldPrompt = setupVersion > seenSetup.current;
    seenSetup.current = setupVersion;
    void getWorkspaceWindowsPath(workspaceId)
      .then((path) => {
        if (cancelled || version.current !== currentVersion) return;
        setSetting({ workspaceId, path });
        if (shouldPrompt) {
          setInput(path);
          setEditing(true);
        }
      })
      .catch(() => {
        if (cancelled || version.current !== currentVersion) return;
        setWarning(
          "Browser location preferences could not be read. You can enter a location for this session.",
        );
        if (shouldPrompt) {
          setInput("");
          setEditing(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, convenienceEpoch, setupVersion]);
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
        root = await getWorkspaceWindowsPath(workspaceId);
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
          request.containingFolder
            ? "Containing folder path copied"
            : "File path copied",
        );
    } catch {
      if (currentVersion === version.current) setManualPath(path);
    }
  };
  const copy = async (request: CopyRequest) => {
    if (copying.current) return;
    copying.current = true;
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      await execute(request, windowsPath);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      copying.current = false;
      setBusy(false);
    }
  };
  const configure = () => {
    setPending(null);
    setInput(windowsPath);
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
      {editing && workspace ? (
        <Modal
          title="Windows workspace location"
          busy={busy}
          onClose={() => {
            setEditing(false);
            setPending(null);
            setError("");
          }}
        >
          <p>
            <strong>{workspace.identity.name}</strong> · This optional setting
            enables complete file paths. Leaving it blank does not block
            importing, capturing, branching, or recovery. It does not open
            Explorer or SolidWorks. UNC syntax is accepted for copying;
            network-share behavior is not qualified.
          </p>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (copying.current) return;
              copying.current = true;
              setBusy(true);
              setError("");
              try {
                const path = normalizeWindowsWorkspacePath(input);
                if (pending && !path)
                  throw new Error(
                    "Enter the Windows workspace-root path to complete this copy, or cancel.",
                  );
                let cacheWarning = "";
                try {
                  await saveWorkspaceWindowsPath(
                    workspace.identity.workspaceId,
                    path,
                  );
                } catch {
                  cacheWarning =
                    "The Windows location is available for this session only. Browser convenience storage could not save it; enter it again after reopening.";
                }
                setSetting({
                  workspaceId: workspace.identity.workspaceId,
                  path,
                });
                setWarning(cacheWarning);
                const request = pending;
                setPending(null);
                setEditing(false);
                if (request) await execute(request, path);
              } catch (error) {
                setError(
                  error instanceof Error ? error.message : String(error),
                );
              } finally {
                copying.current = false;
                setBusy(false);
              }
            }}
          >
            <fieldset disabled={busy}>
              <WindowsWorkspacePathField value={input} onChange={setInput} />
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
                  {pending ? "Cancel" : "Not now"}
                </button>
                <button className="button primary">
                  {pending ? "Save and copy path" : "Save location"}
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
        {compact ? "Windows workspace location" : "Edit Windows location"}
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
  const label = historicalBranch
    ? "Copy current working file path"
    : "Copy file path";
  const description = `${historicalBranch ? historicalBranch + " · " : restored ? "Restored copy · " : ""}${filePath}`;
  return (
    <div
      className={`file-path-actions${historicalBranch ? " historical" : ""}`}
    >
      <button
        type="button"
        className={historicalBranch ? "text-button" : "icon-button"}
        aria-label={`${label} — ${description}`}
        title={`${label} — ${description}`}
        onClick={() => context.copy({ resolve, containingFolder: false })}
      >
        <Copy size={15} aria-hidden="true" />
        {historicalBranch ? (
          <span>
            {label} · {historicalBranch}
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
          onClick={(event) => {
            const disclosure = event.currentTarget.closest("details");
            disclosure?.removeAttribute("open");
            disclosure?.querySelector<HTMLElement>("summary")?.focus();
            context.copy({ resolve, containingFolder: true });
          }}
        >
          Copy containing folder path
          {historicalBranch ? ` · Current file on ${historicalBranch}` : ""}
        </button>
      </details>
    </div>
  );
}
