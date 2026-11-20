import { useEffect, useMemo, useRef, useState } from "react";
import type { ProgressUpdate, VaultState } from "../engine/types";
import { caseLifecycle } from "../engine/case-lifecycle";
import { UnsavedCaseChangesError } from "../engine/case-lifecycle-service";
import { Modal, Notice, OperationProgress } from "./ui";
import { designCaseActivities } from "../engine/case-activity";
import { CompareRevisionsDialog } from "./CompareRevisionsDialog";

export function DesignCases({
  state,
  activeBranchId,
  busy,
  progress,
  showHidden = false,
  onChange,
  onCancel,
}: {
  state: VaultState;
  activeBranchId: string;
  busy: boolean;
  progress: ProgressUpdate | null;
  /** Show hidden cases (faded, with Unhide). History's "Show hidden cases" switch. */
  showHidden?: boolean;
  /** "archived" hides the case, "active" unhides it. */
  onChange: (
    branchId: string,
    status: "active" | "archived",
    expectedVersion: string | null,
    acknowledgedChangesSignature?: string,
  ) => Promise<void>;
  onCancel: () => void;
}) {
  const activities = useMemo(() => designCaseActivities(state), [state]);
  const [comparison, setComparison] = useState<{
    fromId: string;
    toId: string;
  } | null>(null);
  const [action, setAction] = useState<{
    branchId: string;
    status: "active" | "archived";
    version: string | null;
    /** Unsaved changes the user was warned about (from the engine's fresh scan). */
    unsaved?: { message: string; signature: string };
  } | null>(null);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState<{
    branchId: string;
    status: "active" | "archived";
  } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const errorFocus = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!action && completed) {
      (buttons.current.get(completed.branchId) ?? heading.current)?.focus();
      setCompleted(null);
    }
  }, [action, completed, state]);
  useEffect(() => {
    if (error) errorFocus.current?.focus();
  }, [error]);
  const cases = state.branches.filter((branch) => !branch.isMain);
  const hidden = cases.filter(
    (branch) => caseLifecycle(state, branch.branchId).status === "archived",
  );
  const unavailable = cases.filter(
    (branch) => caseLifecycle(state, branch.branchId).status === "unavailable",
  ).length;
  const confirm = async () => {
    if (!action || busy) return;
    setError("");
    try {
      await onChange(
        action.branchId,
        action.status,
        action.version,
        action.unsaved?.signature,
      );
      setCompleted({ branchId: action.branchId, status: action.status });
      setAction(null);
    } catch (error) {
      if (error instanceof UnsavedCaseChangesError)
        setAction({
          ...action,
          unsaved: { message: error.message, signature: error.changesSignature },
        });
      else setError(error instanceof Error ? error.message : String(error));
    }
  };
  const row = (branch: (typeof cases)[number]) => {
    const lifecycle = caseLifecycle(state, branch.branchId);
    const isHidden = lifecycle.status === "archived";
    const isCurrent = branch.branchId === activeBranchId;
    const activity = activities.get(branch.branchId)!;
    const unsaved = isHidden ? (lifecycle.unsavedAtHide ?? 0) : 0;
    return (
      <div
        className={`settings-row case-row${isHidden ? " hidden-case" : ""}`}
        key={branch.branchId}
      >
        <div>
          <strong>{branch.name}</strong>
          <p>
            {isHidden
              ? "Hidden"
              : lifecycle.status === "unavailable"
                ? "Hidden or visible state unavailable"
                : "Active"}
            {isCurrent ? " · Current working case" : ""}
            {unsaved ? (
              <span className="case-unsaved-badge">
                {unsaved} unsaved {unsaved === 1 ? "change" : "changes"}
              </span>
            ) : null}
          </p>
          {lifecycle.status === "unavailable" ? (
            <p className="case-lifecycle-error">
              {lifecycle.error} cAdtree could not tell whether this case is hidden, so it is not treated as visible.
            </p>
          ) : null}
          {activity.baseline.status === "unavailable" ||
          activity.main.status === "unavailable" ? (
            <p className="muted small">
              Compare with Main is unavailable:{" "}
              {activity.baseline.status === "unavailable"
                ? activity.baseline.reason
                : activity.main.status === "unavailable"
                  ? activity.main.reason
                  : ""}
            </p>
          ) : null}
        </div>
        <button
          className="button secondary"
          disabled={
            busy ||
            activity.baseline.status !== "available" ||
            activity.main.status !== "available"
          }
          aria-label={`Compare ${branch.name} with Main`}
          title="Compares this case's latest saved version with Main's latest saved version. Unsaved changes are not included."
          onClick={() => {
            if (
              activity.baseline.status === "available" &&
              activity.main.status === "available"
            )
              setComparison({
                fromId: activity.baseline.revision.manifest.revisionId,
                toId: activity.main.revision.manifest.revisionId,
              });
          }}
        >
          Compare with Main
        </button>
        {lifecycle.status !== "unavailable" ? (
          <button
            className="button secondary"
            ref={(element) => {
              if (element) buttons.current.set(branch.branchId, element);
              else buttons.current.delete(branch.branchId);
            }}
            aria-label={`${isHidden ? "Unhide case" : "Hide case"} ${branch.name}`}
            disabled={busy}
            onClick={() => {
              setError("");
              setAction({
                branchId: branch.branchId,
                status: isHidden ? "active" : "archived",
                version: lifecycle.version,
              });
            }}
          >
            {isHidden ? "Unhide" : "Hide case"}
          </button>
        ) : null}
      </div>
    );
  };
  const hiding = action?.status === "archived";
  return (
    <section className="panel design-cases" aria-label="Design cases">
      <div className="panel-heading">
        <h2 ref={heading} tabIndex={-1}>
          Design cases
        </h2>
        <span className="muted small">
          {cases.length - hidden.length - unavailable} shown · {hidden.length}{" "}
          hidden
          {unavailable ? ` · ${unavailable} unavailable` : ""}
        </span>
      </div>
      <p className="case-lifecycle-help small">
        Hiding a case keeps its folder and saved history. Main can't be hidden.
      </p>
      {cases
        .filter(
          (branch) =>
            showHidden ||
            caseLifecycle(state, branch.branchId).status !== "archived",
        )
        .map(row)}
      {!cases.length ? (
        <p className="case-lifecycle-help">No design cases yet.</p>
      ) : hidden.length && !showHidden ? (
        <p className="case-lifecycle-help small muted">
          {hidden.length} hidden {hidden.length === 1 ? "case" : "cases"}. Turn
          on Show hidden cases to see {hidden.length === 1 ? "it" : "them"}.
        </p>
      ) : null}
      {comparison ? (
        <CompareRevisionsDialog
          state={state}
          inspectedId={comparison.toId}
          initialFromId={comparison.fromId}
          initialPath=""
          onClose={() => setComparison(null)}
        />
      ) : null}
      {action ? (
        <Modal
          title={hiding ? "Hide design case" : "Unhide design case"}
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
            {hiding
              ? "The case leaves History and the Explorer. Its folder and saved versions stay in place; turn on Show hidden cases to see it again."
              : "The case shows again in History and the Explorer. No files change, and you stay on the case you are working on."}
          </p>
          {hiding && action.branchId === activeBranchId ? (
            <p>You are working on this case. cAdtree switches you to Main after hiding it.</p>
          ) : null}
          {action.unsaved ? (
            <Notice type="info">{action.unsaved.message}</Notice>
          ) : null}
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
              {hiding ? "Hide case" : "Unhide"}
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
