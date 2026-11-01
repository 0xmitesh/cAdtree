import { useEffect, useId, useRef, useState } from "react";
import { normalizeWindowsWorkspacePath } from "../utils/windows-path";
import { saveWorkspaceWindowsPath } from "../engine/idb-store";
import { Modal, Notice } from "./ui";
import type { HomeState } from "../engine/home-service";

export interface HomeAddress {
  homeId: string;
  root: HomeState["root"];
  path: string;
}

export async function rememberWindowsAddress(
  id: string,
  path: string,
  handle?: FileSystemDirectoryHandle,
) {
  try {
    await saveWorkspaceWindowsPath(id, path, handle);
    return "";
  } catch {
    return "Your folder address could not be remembered. It is available for this session only; enter it again next time.";
  }
}

/** Address text is a local shortcut preference, never an access credential. */
export function WindowsFolderAddressDialog({
  home = false,
  folderName,
  initialValue = "",
  required = true,
  title,
  submitLabel,
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
  onSave: (normalizedPath: string) => Promise<void>;
  onCancel: () => void;
  onBack?: () => void;
}) {
  const [input, setInput] = useState(initialValue);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const id = useId();
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
        The browser grants folder access but does not share its full Windows
        address. The address you enter is used for copying locations; cAdtree
        cannot compare it with the selected folder.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            const path = normalizeWindowsWorkspacePath(input);
            if (required && !path)
              throw new Error(
                "Enter the selected folder’s full Windows address to continue.",
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
          <label className="field windows-path-field">
            <span id={`${id}-label`}>
              {home ? "Cadtree home folder address" : "Workspace folder path"}
            </span>
            <input
              ref={inputRef}
              autoFocus
              required={required}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={home ? "D:\\Cadtree" : "D:\\CAD Workspace"}
              aria-labelledby={`${id}-label`}
              aria-describedby={id}
              autoComplete="off"
              spellCheck={false}
            />
            <span className="field-help" id={id}>
              {home
                ? "Paste the selected folder’s full address from File Explorer’s address bar. This lets cAdtree copy file and folder locations for you."
                : "Copy this workspace folder’s full location from Explorer’s address bar."}
            </span>
          </label>
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
