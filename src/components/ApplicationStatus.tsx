import { useState } from "react";
import type { VaultState, ProgressUpdate } from "../engine/types";
import {
  branchApplications,
  changedActions,
  type ApplicationOperation,
} from "../engine/application-records";
import { formatRevisionNumber } from "../engine/vault-service";
import { applySaveSummary } from "../engine/application-service";
import { caseLabel } from "../engine/case-lifecycle";
import { Modal, Notice, OperationProgress } from "./ui";

export function ApplicationStatus({
  state,
  branchId,
  busy,
  progress,
  notSavedReasons = {},
  onCancel,
  onRecover,
  onSaveNow,
  onDontSave,
}: {
  state: VaultState;
  branchId: string;
  busy: boolean;
  progress: ProgressUpdate | null;
  /** Why the automatic save failed, per operation, when known in this session. */
  notSavedReasons?: Record<string, string>;
  onCancel: () => void;
  onRecover: (id: string) => Promise<void>;
  /** Opens the normal Save with the summary and Why prefilled. */
  onSaveNow: (op: ApplicationOperation) => void;
  /** Stops waiting to save a written Bring back or Copy (engine `abandonApplication`);
   * the working files stay as they are. */
  onDontSave: (id: string) => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState<{
    op: ApplicationOperation;
    kind: "undo" | "dont-save";
  } | null>(null);
  const [error, setError] = useState("");
  const [closed, setClosed] = useState(false);
  const pending = branchApplications(state, branchId).filter((op) =>
    ["applied", "unresolved", "unavailable"].includes(op.status),
  );
  const what = (op: ApplicationOperation) =>
    op.record?.plan.mode === "revert"
      ? "Bring back"
      : op.record?.plan.mode === "discard"
        ? "Discard"
        : op.record?.plan.mode === "restore-file"
          ? "Get this version"
          : "Copy";
  const confirm = async () => {
    if (!confirmation || busy) return;
    setError("");
    try {
      await (confirmation.kind === "undo"
        ? onRecover(confirmation.op.operationId)
        : onDontSave(confirmation.op.operationId));
      setConfirmation(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <>
      {pending.map((op) => {
        const reason = notSavedReasons[op.operationId];
        return (
          <section
            className="application-status"
            key={op.operationId}
            aria-label="Bring back, Copy or Discard status"
          >
            <Notice type={op.status === "applied" ? "info" : "error"}>
              <strong>
                {op.status === "applied"
                  ? `${op.record ? applySaveSummary(state, op.record) : "Files were copied"}, but it wasn't saved${reason ? `: ${reason}` : ""}. Your working files are fine.`
                  : op.status === "unresolved"
                    ? `A ${what(op)} was interrupted. Saving and another Bring back, Copy or Discard are blocked until it is undone.`
                    : "The record of a Bring back, Copy or Discard can't be read. Saving and another Bring back, Copy or Discard are blocked."}
              </strong>
              {op.status === "applied" ? null : (
                <p>
                  {op.status === "unresolved"
                    ? "Undoing puts back the files it changed, from the copies it kept. Files edited since then are left as they are for you to check. Don't delete its record."
                    : "Inspect the record below; it is kept on disk. Don't delete it."}
                </p>
              )}
              {op.error ? <p>{op.error}</p> : null}
              {op.status === "applied" ? null : (
                <details className="disclosure">
                  <summary>Details</summary>
                  <p className="file-path">Record: vault/{op.relativePath}</p>
                  {op.record ? (
                    <>
                      {op.record.plan.reason ? <p>{op.record.plan.reason}</p> : null}
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
                                Copy of the earlier file: vault/{op.relativePath}/before/
                                {String(index).padStart(6, "0")}.bin (once staged)
                              </p>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                      <p className="small">
                        Copies of unexpected files, when readable, are kept under
                        this record's unexpected/&lt;recovery ID&gt;/ folder with
                        the same number. A partial file is never overwritten.
                        After putting affected files back by hand, try again.
                        New empty folders are kept.
                      </p>
                    </>
                  ) : null}
                </details>
              )}
              <div className="application-status-actions">
                {op.status === "applied" ? (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => onSaveNow(op)}
                  >
                    Save now
                  </button>
                ) : null}
                {op.status === "applied" ? (
                  <details className="disclosure">
                    <summary>Details</summary>
                    <p className="small">
                      If you don't want to save this {what(op)} (for example,
                      you already put the files back), choose Don't save it.
                    </p>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        setConfirmation({ op, kind: "dont-save" });
                        setError("");
                      }}
                    >
                      Don't save it
                    </button>
                  </details>
                ) : null}
                {op.status === "unresolved" ? (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => {
                      setConfirmation({ op, kind: "undo" });
                      setError("");
                      setClosed(false);
                    }}
                  >
                    Undo the unfinished {what(op)}
                  </button>
                ) : null}
              </div>
            </Notice>
          </section>
        );
      })}
      {confirmation?.kind === "dont-save" ? (
        <Modal
          title={`Don't save this ${what(confirmation.op)}`}
          busy={busy}
          onClose={() => setConfirmation(null)}
        >
          {error ? <Notice type="error">{error}</Notice> : null}
          <p>
            Your working files stay as they are; cAdtree just stops waiting to
            save this {what(confirmation.op)}. Any changes show as unsaved
            changes, and you can save them yourself.
          </p>
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
              disabled={busy}
              onClick={() => void confirm()}
            >
              Don't save it
            </button>
          </div>
        </Modal>
      ) : confirmation ? (
        <Modal
          title={`Undo the unfinished ${what(confirmation.op)}`}
          busy={busy}
          onClose={() => setConfirmation(null)}
        >
          {error ? <Notice type="error">{error}</Notice> : null}
          <p>
            Save and close these files in your CAD program first. Only files that
            still hold what the {what(confirmation.op)} wrote are put back
            automatically. Anything else is left as it is and, when readable,
            copied into the record. Other files and folders are not touched.
          </p>
          <OperationProgress progress={progress} onCancel={onCancel} />
          <label className="file-choice">
            <input
              type="checkbox"
              checked={closed}
              disabled={busy}
              onChange={(e) => setClosed(e.target.checked)}
            />
            I have saved and closed these files in my CAD program.
          </label>
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
              disabled={busy || !closed}
              onClick={() => void confirm()}
            >
              Undo the unfinished {what(confirmation.op)}
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
function capturedOperations(state: VaultState, revisionId: string) {
  return (state.applicationOperations ?? []).filter(
    (op) =>
      op.status === "captured" &&
      op.capturedRevisionId === revisionId &&
      op.record,
  );
}
function sourceNumber(state: VaultState, sourceRevisionId: string) {
  const source = state.revisions.find(
    (r) => r.manifest.revisionId === sourceRevisionId,
  );
  return source
    ? formatRevisionNumber(source.manifest.displayNumber)
    : sourceRevisionId;
}
const REASON_INLINE_MAX = 60;
/** One plain line saying where a revision's files were copied from. */
export function AppliedFrom({
  state,
  revisionId,
}: {
  state: VaultState;
  revisionId: string;
}) {
  return (
    <>
      {capturedOperations(state, revisionId).map((op) => {
        const record = op.record!;
        const number = sourceNumber(state, record.plan.sourceRevisionId);
        return (
          <p className="applied-from" key={op.operationId}>
            {record.plan.mode === "revert"
              ? `Brought back ${number}`
              : `Copied from ${number} on ${caseLabel(state, record.sourceBranchId)}`}
            {!record.plan.reason ? null : record.plan.reason.length <= REASON_INLINE_MAX ? (
              <> — {record.plan.reason}</>
            ) : (
              <span className="applied-from-reason muted small">
                {record.plan.reason}
              </span>
            )}
          </p>
        );
      })}
    </>
  );
}
/** The reason, file decisions, bytes and record identities behind that line.
 * Shown inside the revision's Troubleshooting disclosure. */
export function AppliedFromDetails({
  state,
  revisionId,
}: {
  state: VaultState;
  revisionId: string;
}) {
  const operations = capturedOperations(state, revisionId);
  if (!operations.length) return null;
  return (
    <>
      <h3>Copied files</h3>
      {operations.map((op) => {
        const record = op.record!;
        const reverted = record.plan.mode === "revert";
        const capture = op.events.find(
          (e) => e.kind === "capture" && e.revisionId === revisionId,
        )!;
        return (
          <div className="applied-from-details" key={op.operationId}>
            <p>
              <strong>
                {reverted ? "Brought back" : "Copied from"}{" "}
                {sourceNumber(state, record.plan.sourceRevisionId)}
              </strong>
              {reverted ? null : <> · {caseLabel(state, record.sourceBranchId)}</>}
            </p>
            <p className="small">
              {reverted
                ? "Files were brought back from the earlier version before this normal version was saved."
                : "Selected file states were applied before this normal version was saved."} CAD reference and rebuild checks remain the engineer's
              responsibility. The version keeps its ordinary destination
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
                  Selected file changes do not imply that the source case was
                  merged.
                </p>
              )}
            </details>
          </div>
        );
      })}
    </>
  );
}
