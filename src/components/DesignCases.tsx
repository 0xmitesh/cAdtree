import { useEffect, useRef, useState } from "react";
import type { ProgressUpdate, VaultState } from "../engine/types";
import { caseLifecycle } from "../engine/case-lifecycle";
import { Modal, Notice, OperationProgress } from "./ui";

export function DesignCases({
  state,
  activeBranchId,
  busy,
  progress,
  onChange,
  onCancel,
}: {
  state: VaultState;
  activeBranchId: string;
  busy: boolean;
  progress: ProgressUpdate | null;
  onChange: (
    branchId: string,
    status: "active" | "archived",
    expectedVersion: string | null,
  ) => Promise<void>;
  onCancel: () => void;
}) {
  const [action, setAction] = useState<{
    branchId: string;
    status: "active" | "archived";
    version: string | null;
  } | null>(null);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState<{
    branchId: string;
    status: "active" | "archived";
  } | null>(null);
  const archivedSummary = useRef<HTMLElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const errorFocus = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!action && completed) {
      (completed.status === "archived"
        ? archivedSummary.current
        : buttons.current.get(completed.branchId)
      )?.focus();
      setCompleted(null);
    }
  }, [action, completed, state]);
  useEffect(() => {
    if (error) errorFocus.current?.focus();
  }, [error]);
  const cases = state.branches.filter((branch) => !branch.isMain);
  const archived = cases.filter(
    (branch) => caseLifecycle(state, branch.branchId).status === "archived",
  );
  const unavailable = cases.filter(
    (branch) => caseLifecycle(state, branch.branchId).status === "unavailable",
  ).length;
  const confirm = async () => {
    if (!action || busy) return;
    setError("");
    try {
      await onChange(action.branchId, action.status, action.version);
      setCompleted({ branchId: action.branchId, status: action.status });
      setAction(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  const row = (branch: (typeof cases)[number]) => {
    const lifecycle = caseLifecycle(state, branch.branchId);
    const isCurrent = branch.branchId === activeBranchId;
    return (
      <div className="settings-row case-row" key={branch.branchId}>
        <div>
          <strong>{branch.name}</strong>
          <p>
            {lifecycle.status === "archived"
              ? "Archived"
              : lifecycle.status === "unavailable"
                ? "Lifecycle unavailable"
                : "Active"}
            {isCurrent ? " · Current working branch" : ""}
          </p>
          {lifecycle.status === "unavailable" ? (
            <p className="case-lifecycle-error">
              {lifecycle.error} Inspect the retained lifecycle evidence; this
              case is not assumed Active.
            </p>
          ) : isCurrent && lifecycle.status === "active" ? (
            <p className="small">
              Switch to another active branch before archiving.
            </p>
          ) : null}
        </div>
        {lifecycle.status !== "unavailable" ? (
          <button
            className="button secondary"
            ref={(element) => {
              if (element) buttons.current.set(branch.branchId, element);
              else buttons.current.delete(branch.branchId);
            }}
            aria-label={`${lifecycle.status === "archived" ? "Reopen" : "Archive"} case ${branch.name}`}
            disabled={busy || (isCurrent && lifecycle.status === "active")}
            onClick={() => {
              setError("");
              setAction({
                branchId: branch.branchId,
                status: lifecycle.status === "archived" ? "active" : "archived",
                version: lifecycle.version,
              });
            }}
          >
            {lifecycle.status === "archived" ? "Reopen case" : "Archive case"}
          </button>
        ) : null}
      </div>
    );
  };
  return (
    <section className="panel design-cases" aria-label="Design cases">
      <div className="panel-heading">
        <h2>Design cases</h2>
        <span className="muted small">
          {cases.length - archived.length - unavailable} active ·{" "}
          {archived.length} archived
          {unavailable ? ` · ${unavailable} unavailable` : ""}
        </span>
      </div>
      <p className="case-lifecycle-help small">
        Main stays active. Archiving preserves the working folder and all saved
        history. Archived revisions remain available in History, Compare and
        recovery.
      </p>
      {cases
        .filter(
          (branch) =>
            caseLifecycle(state, branch.branchId).status !== "archived",
        )
        .map(row)}
      {!cases.length ? (
        <p className="case-lifecycle-help">No design cases yet.</p>
      ) : null}
      <details className="case-archive-disclosure">
        <summary ref={archivedSummary}>
          Archived cases ({archived.length})
        </summary>
        {archived.map(row)}
      </details>
      {action ? (
        <Modal
          title={
            action.status === "archived"
              ? "Archive design case"
              : "Reopen design case"
          }
          busy={busy}
          onClose={() => setAction(null)}
        >
          <p>
            <strong>
              {
                state.branches.find(
                  (branch) => branch.branchId === action.branchId,
                )?.name
              }
            </strong>
          </p>
          <p>
            {action.status === "archived"
              ? "The connected working folder will be checked against this case's saved baseline, including empty folders. Uncaptured changes, unreadable evidence or pending applications block archiving. In-app drafts remain intact."
              : "Reopen this same case for future work. Its identity, history, baseline and working folder are retained. Normal connection checks apply when work resumes."}
          </p>
          <p>
            {action.status === "archived"
              ? "Only lifecycle metadata changes. Working files and saved revisions stay in place; this does not label the case merged."
              : "No files are restored and the working branch is not switched automatically."}
          </p>
          {error ? (
            <div ref={errorFocus} tabIndex={-1}>
              <Notice type="error">{error}</Notice>
            </div>
          ) : null}
          <OperationProgress progress={progress} onCancel={onCancel} />
          <div className="modal-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setAction(null)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void confirm()}
            >
              {action.status === "archived" ? "Archive case" : "Reopen case"}
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
