import { useState } from "react";
import type { VaultState, ProgressUpdate } from "../engine/types";
import {
  branchApplications,
  changedActions,
  type ApplicationOperation,
} from "../engine/application-records";
import { formatRevisionNumber } from "../engine/vault-service";
import { caseLabel } from "../engine/case-lifecycle";
import { Modal, Notice, OperationProgress } from "./ui";

export function ApplicationStatus({
  state,
  branchId,
  busy,
  progress,
  onCancel,
  onRecover,
  onAbandon,
  onRefresh,
  onChanges,
}: {
  state: VaultState;
  branchId: string;
  busy: boolean;
  progress: ProgressUpdate | null;
  onCancel: () => void;
  onRecover: (id: string) => Promise<void>;
  onAbandon: (id: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onChanges: () => void;
}) {
  const [confirmation, setConfirmation] = useState<{
    op: ApplicationOperation;
    kind: "recover" | "abandon";
  } | null>(null);
  const [error, setError] = useState("");
  const [closed, setClosed] = useState(false);
  const pending = branchApplications(state, branchId).filter((op) =>
    ["applied", "unresolved", "unavailable"].includes(op.status),
  );
  const confirm = async () => {
    if (!confirmation || busy) return;
    setError("");
    try {
      await (confirmation.kind === "recover"
        ? onRecover(confirmation.op.operationId)
        : onAbandon(confirmation.op.operationId));
      setConfirmation(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <>
      {pending.map((op) => (
        <section
          className="application-status"
          key={op.operationId}
          aria-label="Destination application status"
        >
          <Notice type={op.status === "applied" ? "info" : "error"}>
            <strong>
              {op.status === "applied"
                ? op.record?.plan.mode === "revert"
                  ? "Brought back into working files — revision not yet saved."
                  : "Applied to working files — revision not yet saved."
                : op.status === "unresolved"
                  ? "Interrupted application — saving and another apply are blocked."
                  : "Application evidence unavailable — saving and another apply are blocked."}
            </strong>
            <p>
              {op.status === "applied"
                ? "Check references and rebuild in CAD, then review and save a normal complete revision. Application provenance will be retained."
                : "Recover recognized applied bytes from the retained before-state. Unexpected later edits are preserved and require manual review. Do not delete operation evidence."}
            </p>
            {op.error ? <p>{op.error}</p> : null}
            <p className="file-path">Evidence: vault/{op.relativePath}</p>
            {op.record ? (
              <details className="disclosure">
                <summary>
                  Application reason, actions and recovery evidence
                </summary>
                <p>{op.record.plan.reason}</p>
                <p>Operation: {op.operationId}</p>
                <ul className="application-actions">
                  {changedActions(op.record).map((a, index) => (
                    <li key={a.path}>
                      <strong className="file-path">{a.path}</strong> ·{" "}
                      {a.operation}
                      <p className="small file-path">
                        Before: {a.before?.sha256 ?? "absent"} · Applied:{" "}
                        {a.after?.sha256 ?? "absent"}
                      </p>
                      {a.before ? (
                        <p className="small file-path">
                          Before-state copy: vault/{op.relativePath}/before/
                          {String(index).padStart(6, "0")}.bin (available after
                          successful staging)
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <p className="small">
                  Unexpected byte copies, when readable, are kept under this
                  operation's unexpected/&lt;recovery ID&gt;/ folder using the same
                  action index. A partial or truncated file is never blindly
                  overwritten. After manually restoring affected paths to their
                  recorded before-state, retry recovery. Newly created empty
                  folders are retained.
                </p>
              </details>
            ) : null}
            <div className="application-status-actions">
              {op.status === "applied" ? (
                <>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={onChanges}
                  >
                    Review and save revision
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      setConfirmation({ op, kind: "abandon" });
                      setError("");
                      setClosed(false);
                    }}
                  >
                    Abandon pending provenance
                  </button>
                </>
              ) : null}
              {op.status === "unresolved" ? (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => {
                    setConfirmation({ op, kind: "recover" });
                    setError("");
                    setClosed(false);
                  }}
                >
                  Recover interrupted application
                </button>
              ) : null}
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void onRefresh()}
              >
                Refresh application status
              </button>
            </div>
          </Notice>
        </section>
      ))}
      {confirmation ? (
        <Modal
          title={
            confirmation.kind === "recover"
              ? "Recover interrupted application"
              : "Abandon pending provenance"
          }
          busy={busy}
          onClose={() => setConfirmation(null)}
        >
          {error ? <Notice type="error">{error}</Notice> : null}
          <p>
            {confirmation.kind === "recover"
              ? "Save and close relevant CAD documents. Only affected paths still matching the recorded applied bytes can be restored automatically. Unexpected bytes remain untouched and are copied to operation evidence when readable. Retained directories and all unrelated files remain."
              : "This records an abandoned outcome without deleting or reverting any working edits. A later normal revision will not claim this application as its provenance. The operation and recovery evidence remain on disk."}
          </p>
          <p>Operation: {confirmation.op.operationId}</p>
          <OperationProgress progress={progress} onCancel={onCancel} />
          {confirmation.kind === "recover" ? (
            <label className="file-choice">
              <input
                type="checkbox"
                checked={closed}
                disabled={busy}
                onChange={(e) => setClosed(e.target.checked)}
              />
              I have saved and closed relevant CAD documents.
            </label>
          ) : null}
          <div className="modal-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              disabled={busy || (confirmation.kind === "recover" && !closed)}
              onClick={() => void confirm()}
            >
              {confirmation.kind === "recover"
                ? "Recover recognized applied files"
                : "Abandon record, keep working edits"}
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
export function AppliedFrom({
  state,
  revisionId,
}: {
  state: VaultState;
  revisionId: string;
}) {
  const operations = (state.applicationOperations ?? []).filter(
    (op) => op.status === "captured" && op.capturedRevisionId === revisionId,
  );
  return (
    <>
      {operations.map((op) => {
        const record = op.record!;
        const source = state.revisions.find(
          (r) => r.manifest.revisionId === record.plan.sourceRevisionId,
        );
        const sourceName = caseLabel(state, record.sourceBranchId);
        const reverted = record.plan.mode === "revert";
        const capture = op.events.find(
          (e) => e.kind === "capture" && e.revisionId === revisionId,
        )!;
        return (
          <details className="disclosure applied-from" key={op.operationId}>
            <summary>
              {reverted ? "Brought back from" : "Applied from"}{" "}
              {source
                ? formatRevisionNumber(source.manifest.displayNumber)
                : record.plan.sourceRevisionId}{" "}
              {reverted ? null : <>· {sourceName}</>}
            </summary>
            <p>
              <strong>Engineering reason:</strong> {record.plan.reason}
            </p>
            <p className="small">
              {reverted
                ? "Files were brought back from the earlier revision before this normal revision was saved."
                : "Selected file states were applied before this normal revision was saved."} CAD reference and rebuild checks remain the engineer's
              responsibility. The revision keeps its ordinary destination
              parent.
            </p>
            <ul className="application-actions">
              {record.plan.actions.map((action) => {
                const final = capture.finalFiles!.find(
                  (f) => f.path === action.path,
                )!.file;
                const adjusted =
                  (action.after?.sha256 ?? null) !== (final?.sha256 ?? null);
                return (
                  <li key={action.path}>
                    <strong className="file-path">{action.path}</strong> ·{" "}
                    {
                      {
                        add: "Added Source file",
                        replace: "Replaced with Source file",
                        delete: "Deleted destination file",
                        keep: "Kept Destination",
                        unresolved: "Unresolved",
                      }[action.operation]
                    }
                    <p>
                      {adjusted
                        ? "Adjusted after application before saving"
                        : "Captured state matches the application decision"}
                    </p>
                    <details className="comparison-hash">
                      <summary>Before, applied and captured bytes</summary>
                      <p className="small file-path">
                        Before: {action.before?.sha256 ?? "absent"}
                        <br />
                        Originally applied: {action.after?.sha256 ?? "absent"}
                        <br />
                        Final captured: {final?.sha256 ?? "absent"}
                      </p>
                    </details>
                  </li>
                );
              })}
            </ul>
            <details className="comparison-hash">
              <summary>Application record identities</summary>
              <p className="small file-path">
                Operation: {op.operationId}
                {reverted ? null : <> · Base: {record.plan.baseRevisionId}</>}{" "}
                · Destination baseline: {record.plan.destinationRevisionId}
              </p>
              {reverted ? null : (
                <p className="small">
                  Selected file changes do not imply that the source branch was
                  merged.
                </p>
              )}
            </details>
          </details>
        );
      })}
    </>
  );
}
