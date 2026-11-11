import { useEffect, useId, useRef, useState } from "react";
import { normalizeFolderPath } from "../utils/folder-path";
import { saveWorkspacePath } from "../engine/idb-store";
import { Modal, Notice } from "./ui";
import { BLOCK_PATH_CHARS, homeSetupWorstCase } from "../engine/path-budget";
import { shortHomeExample } from "../utils/path-budget-message";
import type { HomeState } from "../engine/home-service";

export interface HomeAddress {
  homeId: string;
  root: HomeState["root"];
  path: string;
}

export async function rememberFolderAddress(
  id: string,
  path: string,
  handle?: FileSystemDirectoryHandle,
) {
  try {
    await saveWorkspacePath(id, path, handle);
    return "";
  } catch {
    return "Your folder address could not be remembered. It is available for this session only; enter it again next time.";
  }
}

/** Address text is a local shortcut preference, never an access credential. */
export function FolderAddressDialog({
  home = false,
  folderName,
  initialValue = "",
  required = true,
  title,
  submitLabel,
  intro,
  note,
  onSave,
  onCancel,
  onBack,
}: {
  home?: boolean;
  folderName: string;
  initialValue?: string;
  required?: boolean;
  title?: string;
  submitLabel?: string;
  /** Replaces the default explanation paragraph. */
  intro?: string;
  /** Extra line under the explanation, e.g. a reminder when editing an existing address. */
  note?: string;
  onSave: (normalizedPath: string) => Promise<void>;
  onCancel: () => void;
  onBack?: () => void;
}) {
  const [input, setInput] = useState(initialValue);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const id = useId();
  // Non-blocking: saving still works. Measured from the normalized form of what is typed.
  const longHome = (() => {
    if (!home) return null;
    let typed = "";
    try {
      typed = normalizeFolderPath(input);
    } catch {
      return null;
    }
    if (!typed) return null;
    // Warn only when even the default workspace and project name allowances would not fit.
    const worst = homeSetupWorstCase(typed);
    return worst.requiredLength > BLOCK_PATH_CHARS
      ? { length: worst.requiredLength, example: shortHomeExample(typed) }
      : null;
  })();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <Modal
      title={
        title ?? (home ? "Complete home setup" : "Set up folder-path copying")
      }
      busy={busy}
      onClose={onCancel}
    >
      <p>
        Selected folder: <strong>{folderName}</strong>
      </p>
      <p>
        {intro ??
          "The browser grants folder access but does not share its full absolute address. The address you enter is used for copying locations and to keep paths within Windows' limit; cAdtree cannot compare it with the selected folder."}
      </p>
      {note ? <p>{note}</p> : null}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            const path = normalizeFolderPath(input);
            if (required && !path)
              throw new Error(
                "Enter the selected folder's full absolute address to continue.",
              );
            setBusy(true);
            await onSave(path);
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy}>
          <label className="field folder-path-field">
            <span id={`${id}-label`}>
              {home ? "Cadtree home folder address" : "Workspace folder path"}
            </span>
            <input
              ref={inputRef}
              autoFocus
              required={required}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={"D:\\Cadtree or /Users/mitesh/Documents/Cadtree"}
              aria-labelledby={`${id}-label`}
              aria-describedby={id}
              autoComplete="off"
              spellCheck={false}
            />
            <span className="field-help" id={id}>
              Paste the full address of the selected folder. Use an absolute address; ~ and environment variables are not expanded.
            </span>
          </label>
          <details className="disclosure">
            <summary>How to copy and use a folder address</summary>
            <p><strong>Windows:</strong> In File Explorer, select the folder address bar (Ctrl+L), then copy. Paste a copied folder path into that bar and press Enter.</p>
            <p><strong>macOS:</strong> In Finder, select the folder and press Option+Command+C to copy its pathname. To use a copied folder path, press Shift+Command+G, paste and press Return.</p>
            <p><strong>Linux:</strong> In your file manager, open the folder, select the location bar (usually Ctrl+L) and copy. Paste a copied folder path into the location bar to open it.</p>
            <p>Examples: {"D:\\Cadtree, \\\\server\\share\\Cadtree, /Users/mitesh/Documents/Cadtree, /home/mitesh/Documents/Cadtree"}. Moving this folder may require updating this local address.</p>
          </details>
          {longHome ? (
            <Notice type="info">
              This address is long: with typical workspace and project names, projects here would need {longHome.length} characters (limit {BLOCK_PATH_CHARS}). A shorter home such as {longHome.example} leaves more room.
            </Notice>
          ) : null}
          {error ? <Notice type="error">{error}</Notice> : null}
          <div className="modal-actions">
            {onBack ? (
              <button
                type="button"
                className="button secondary"
                onClick={onBack}
              >
                Back
              </button>
            ) : null}
            <button
              type="button"
              className="button secondary"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button className="button primary">
              {submitLabel ?? (home ? "Complete setup" : "Save")}
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
