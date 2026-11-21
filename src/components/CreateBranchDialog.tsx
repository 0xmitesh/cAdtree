import { useState } from "react";
import type { ProgressUpdate, RevisionManifest } from "../engine/types";
import { branchNameKey } from "../engine/branch-state";
import { formatRevisionNumber } from "../engine/vault-service";
import { MessageLines, Modal, Notice, OperationProgress } from "./ui";
import { caseNameHint, pathBudgetBlockSentence } from "../utils/path-budget-message";

export interface CreateBranchParams {
  sourceRevisionId: string;
  name: string;
  reason: string;
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
  projectAddress,
}: {
  source: RevisionManifest;
  sourceBranchName: string;
  branchNames: string[];
  busy: boolean;
  progress: ProgressUpdate | null;
  onCreate: (params: CreateBranchParams) => Promise<void>;
  onClose: () => void;
  onCancel: () => void;
  /** Managed-project working folder shown as the destination; design cases are only created inside a managed project. */
  managedDestination: string;
  /** Absolute address of the managed project folder, when known (drives the name hint). */
  projectAddress?: string;
}) {
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const nameHint = caseNameHint(projectAddress, name, source);
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
        and {source.directories.length} folders, including empty folders. The
        saved version itself is shared and is not copied again.
      </p>
      {error ? <Notice type="error"><MessageLines text={error} /></Notice> : null}
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
          try {
            await onCreate({
              sourceRevisionId: source.revisionId,
              name,
              reason,
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
          {nameHint?.block ? (
            <p className="field-help" role="alert">{pathBudgetBlockSentence(nameHint.block)}</p>
          ) : nameHint?.text ? (
            <p className="field-help">{nameHint.text}</p>
          ) : null}
          <label className="field">
            <span>Why</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Optional: why are you trying this?"
            />
          </label>
          <p className="managed-destination">
            Destination: {managedDestination}/&lt;new case&gt;
            <br />A fresh working folder is created and verified
            automatically.
          </p>
          <p className="muted small">
            After creation, open the new design case folder in the app you use.
            cAdtree does not change which files are open.
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="button secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button className="button primary" disabled={Boolean(nameHint?.block)}>Create design case</button>
          </div>
        </fieldset>
      </form>
      {busy ? (
        <OperationProgress progress={progress} onCancel={onCancel} />
      ) : null}
    </Modal>
  );
}
