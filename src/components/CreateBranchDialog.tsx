import { useState } from "react";
import {
  RealFileSystemAdapter,
  type FileSystemDirectoryAdapter,
} from "../engine/fs-adapter";
import type { ProgressUpdate, RevisionManifest } from "../engine/types";
import { branchNameKey } from "../engine/branch-state";
import { formatRevisionNumber } from "../engine/vault-service";
import { supportsFileSystemAccessApi } from "../utils/format";
import { Modal, Notice, OperationProgress } from "./ui";

export interface CreateBranchParams {
  sourceRevisionId: string;
  name: string;
  reason: string;
  destinationParent: FileSystemDirectoryAdapter;
}
export function CreateBranchDialog({
  source,
  sourceBranchName,
  branchNames,
  busy,
  progress,
  onCreate,
  onClose,
  onCancel,
}: {
  source: RevisionManifest;
  sourceBranchName: string;
  branchNames: string[];
  busy: boolean;
  progress: ProgressUpdate | null;
  onCreate: (params: CreateBranchParams) => Promise<void>;
  onClose: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [parent, setParent] = useState<FileSystemDirectoryAdapter | null>(null);
  const [error, setError] = useState("");
  return (
    <Modal title="Create design branch" onClose={onClose} busy={busy}>
      <p>
        <strong>
          {formatRevisionNumber(source.displayNumber)} on {sourceBranchName} ·{" "}
          {source.summary}
        </strong>
      </p>
      <p className="muted">
        Creates an independent working copy of all {source.files.length} files
        and {source.directories.length} directories, including empty folders.
        The vault and saved revision are shared.
      </p>
      {error ? <Notice type="error">{error}</Notice> : null}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          if (!branchNameKey(name)) {
            setError("Branch name is required.");
            return;
          }
          if (
            branchNames.some(
              (existing) => branchNameKey(existing) === branchNameKey(name),
            )
          ) {
            setError("A branch with that name already exists.");
            return;
          }
          if (!reason.trim()) {
            setError("Add a short engineering reason.");
            return;
          }
          if (!parent) {
            setError("Choose a destination parent folder.");
            return;
          }
          try {
            await onCreate({
              sourceRevisionId: source.revisionId,
              name,
              reason,
              destinationParent: parent,
            });
            onClose();
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
          }
        }}
      >
        <fieldset disabled={busy}>
          <label className="field">
            <span>Branch name</span>
            <input
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Case A — wider housing"
            />
          </label>
          <label className="field">
            <span>Engineering reason</span>
            <textarea
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="What design question will this case explore?"
            />
          </label>
          <div className="folder-field">
            <div>
              <strong>Destination parent folder</strong>
              <p>
                {parent?.name ??
                  "A fresh, uniquely named subfolder will be created here."}
              </p>
            </div>
            <button
              type="button"
              className="button secondary"
              onClick={async () => {
                setError("");
                try {
                  if (!supportsFileSystemAccessApi())
                    throw new Error(
                      "Folder selection is unavailable here. Open cAdtree in Edge or Chrome.",
                    );
                  const picker = (
                    window as unknown as {
                      showDirectoryPicker: (options: {
                        mode: string;
                      }) => Promise<FileSystemDirectoryHandle>;
                    }
                  ).showDirectoryPicker;
                  setParent(
                    new RealFileSystemAdapter(
                      await picker({ mode: "readwrite" }),
                    ),
                  );
                } catch (error) {
                  if (
                    !(
                      error instanceof DOMException &&
                      error.name === "AbortError"
                    )
                  )
                    setError(
                      error instanceof Error ? error.message : String(error),
                    );
                }
              }}
            >
              {parent ? "Change parent folder" : "Choose parent folder"}
            </button>
          </div>
          <p className="muted small">
            After creation, open the new branch folder manually in SolidWorks.
            cAdtree does not change which CAD documents are open.
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="button secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button className="button primary">Create branch</button>
          </div>
        </fieldset>
      </form>
      {busy ? (
        <OperationProgress progress={progress} onCancel={onCancel} />
      ) : null}
    </Modal>
  );
}
