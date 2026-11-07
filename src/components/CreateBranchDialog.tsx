import { useState } from "react";
import {
  RealFileSystemAdapter,
  type FileSystemDirectoryAdapter,
} from "../engine/fs-adapter";
import type { ProgressUpdate, RevisionManifest } from "../engine/types";
import { branchNameKey } from "../engine/branch-state";
import { formatRevisionNumber } from "../engine/vault-service";
import { pickDirectory } from "../utils/folder-access";
import { Modal, Notice, OperationProgress } from "./ui";

export interface CreateBranchParams {
  sourceRevisionId: string;
  name: string;
  reason: string;
  destinationParent?: FileSystemDirectoryAdapter;
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
  managedDestination,
}: {
  source: RevisionManifest;
  sourceBranchName: string;
  branchNames: string[];
  busy: boolean;
  progress: ProgressUpdate | null;
  onCreate: (params: CreateBranchParams) => Promise<void>;
  onClose: () => void;
  onCancel: () => void;
  managedDestination?: string;
}) {
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [parent, setParent] = useState<FileSystemDirectoryAdapter | null>(null);
  const [error, setError] = useState("");
  return (
    <Modal title="Create design case" onClose={onClose} busy={busy}>
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
            setError("Case name is required.");
            return;
          }
          if (
            branchNames.some(
              (existing) => branchNameKey(existing) === branchNameKey(name),
            )
          ) {
            setError("A design case with that name already exists.");
            return;
          }
          if (!reason.trim()) {
            setError("Add a short engineering reason.");
            return;
          }
          if (!parent && !managedDestination) {
            setError("Choose a destination parent folder.");
            return;
          }
          try {
            await onCreate({
              sourceRevisionId: source.revisionId,
              name,
              reason,
              destinationParent: parent ?? undefined,
            });
            onClose();
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
          }
        }}
      >
        <fieldset disabled={busy}>
          <label className="field">
            <span>Case name</span>
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
          {managedDestination ? (
            <p className="managed-destination">
              Destination: {managedDestination}/&lt;new case&gt;
              <br />A fresh working folder is created and verified
              automatically.
            </p>
          ) : (
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
                    setParent(
                      new RealFileSystemAdapter(
                        await pickDirectory("readwrite"),
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
                    else setError('Folder selection was cancelled. Choose a parent folder when you are ready.');
                  }
                }}
              >
                {parent ? "Change parent folder" : "Choose parent folder"}
              </button>
            </div>
          )}
          <p className="muted small">
            After creation, open the new Design Case folder manually in SolidWorks.
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
            <button className="button primary">Create design case</button>
          </div>
        </fieldset>
      </form>
      {busy ? (
        <OperationProgress progress={progress} onCancel={onCancel} />
      ) : null}
    </Modal>
  );
}
