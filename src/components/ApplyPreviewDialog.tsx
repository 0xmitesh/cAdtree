import { useMemo, useState } from "react";
import type { ReconstructedRevision, VaultState } from "../engine/types";
import {
  buildApplyPreview,
  prepareApplyPreview,
  type ApplyPreviewContext,
  type ConflictDecision,
  type PreviewChoice,
  type PreviewFileRow,
} from "../engine/apply-preview";
import { formatRevisionNumber } from "../engine/vault-service";
import { formatBytes } from "../utils/format";
import { Modal, Notice, NotesText, StatusBadge } from "./ui";

export function ApplyPreviewDialog({
  state,
  sourceId,
  destinationBranchId,
  onClose,
}: {
  state: VaultState;
  sourceId: string;
  destinationBranchId: string;
  onClose: () => void;
}) {
  const preparation = useMemo(
    () => prepareApplyPreview(state, sourceId, destinationBranchId),
    [state, sourceId, destinationBranchId],
  );
  if (preparation.status === "unavailable")
    return (
      <Modal title="Review changes to apply — preview" onClose={onClose}>
        <Notice type="error">Preview unavailable. {preparation.reason}</Notice>
        <p>
          Ordinary Compare remains available for healthy saved endpoints under
          its existing rules. This preview has not changed any files.
        </p>
        <div className="modal-actions">
          <button className="button secondary" onClick={onClose}>
            Close preview
          </button>
        </div>
      </Modal>
    );
  const context = preparation.context;
  return (
    <ApplyPreviewBody
      key={`${context.projectId}:${context.source.manifest.revisionId}:${context.destination.manifest.revisionId}:${context.base.manifest.revisionId}:${destinationBranchId}`}
      context={context}
      state={state}
      onClose={onClose}
    />
  );
}
function ApplyPreviewBody({
  context,
  state,
  onClose,
}: {
  context: ApplyPreviewContext;
  state: VaultState;
  onClose: () => void;
}) {
  const [choices, setChoices] = useState<Record<string, PreviewChoice>>({});
  const [reason, setReason] = useState("");
  const plan = useMemo(
    () => buildApplyPreview(context, choices, reason),
    [context, choices, reason],
  );
  const branchName = (revision: ReconstructedRevision) =>
    state.branches.find(
      (branch) => branch.branchId === revision.manifest.branchId,
    )?.name ?? "Unknown branch";
  const endpoints = [
    { side: "Base", revision: context.base },
    { side: "Source", revision: context.source },
    { side: "Destination", revision: context.destination },
  ];
  const candidates = context.rows.filter(
    (row) => row.kind === "available" || row.kind === "conflict",
  );
  const matching = context.rows.filter((row) => row.kind === "already-matches");
  const retained = context.rows.filter(
    (row) => row.kind === "no-source-change",
  );
  const sourceWord = (row: PreviewFileRow) =>
    row.sourceChange === "deleted"
      ? "deletion"
      : row.sourceChange === "added"
        ? "addition"
        : "modification";
  const setSelection = (row: PreviewFileRow, selected: boolean) =>
    setChoices((previous) => ({
      ...previous,
      [row.path]: {
        selected,
        decision: row.kind === "available" ? "use-source" : "unresolved",
      },
    }));
  const stateAndNotes = (row: PreviewFileRow) => (
    <details className="disclosure preview-file-evidence">
      <summary>Saved file states and notes</summary>
      <div className="comparison-file-endpoints preview-three-columns">
        {endpoints.map(({ side, revision }) => {
          const file =
            side === "Base"
              ? row.base
              : side === "Source"
                ? row.source
                : row.destination;
          const notes =
            revision.manifest.fileNotes?.filter(
              (note) => note.path === row.path,
            ) ?? [];
          return (
            <section
              key={side}
              aria-label={`${side} file notes at ${formatRevisionNumber(revision.manifest.displayNumber)}: ${row.path}`}
            >
              <h4>
                {side} · {formatRevisionNumber(revision.manifest.displayNumber)}
              </h4>
              <p className="small">
                {file
                  ? `${formatBytes(file.size)} · present`
                  : "Absent in this saved revision"}
              </p>
              {file ? (
                <details className="comparison-hash">
                  <summary>Content hash</summary>
                  <code>{file.sha256}</code>
                </details>
              ) : null}
              {notes.length ? (
                notes.map((note) => <NotesText key={note.path} notes={note} />)
              ) : (
                <p className="muted small">
                  No per-file notes recorded at this revision.
                </p>
              )}
            </section>
          );
        })}
      </div>
    </details>
  );
  const operations = plan.actions.filter((action) =>
    ["add", "replace", "delete"].includes(action.operation),
  );
  return (
    <Modal title="Review changes to apply — preview" onClose={onClose}>
      <div className="apply-preview">
        <Notice>
          Preview only — no files will be applied. This uses saved states.
          Current uncaptured working edits are not included and are not
          authorized for replacement.
        </Notice>
        <div className="preview-endpoints preview-three-columns">
          {endpoints.map(({ side, revision }) => (
            <section key={side} aria-label={`${side} saved revision`}>
              <h3>
                {side}
                {side === "Destination"
                  ? ` · active branch ${state.branches.find((branch) => branch.branchId === context.destinationBranchId)?.name}`
                  : ""}
              </h3>
              <strong>
                {formatRevisionNumber(revision.manifest.displayNumber)} ·{" "}
                {branchName(revision)}
              </strong>
              <p>{revision.manifest.summary}</p>
              <span className="muted small">
                {revision.manifest.files.length} files ·{" "}
                {revision.integrityStatus === "objects_verified"
                  ? "Metadata and file contents previously verified"
                  : "Metadata verified · contents not checked"}
              </span>
            </section>
          ))}
        </div>
        <p className="muted small">
          Base is the nearest shared ancestor established from validated parent
          relationships. This preview compares byte hashes; it does not merge
          geometry or verify CAD compatibility.
        </p>
        <div
          className="comparison-scope"
          role="status"
          aria-label="Proposed result summary"
        >
          <strong>Proposed result: {plan.resultFiles.length} files</strong>
          <span>
            {operations.filter((action) => action.operation === "add").length}{" "}
            additions ·{" "}
            {
              operations.filter((action) => action.operation === "replace")
                .length
            }{" "}
            replacements ·{" "}
            {
              operations.filter((action) => action.operation === "delete")
                .length
            }{" "}
            deletions
          </span>
        </div>
        <div
          className="preview-readiness"
          role="status"
          aria-label="Preview readiness"
        >
          <strong>
            {plan.ready
              ? "Ready as a saved-state preview"
              : "Preview not ready"}
          </strong>
          {plan.blockers.length ? (
            <ul>
              {plan.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          ) : (
            <p>
              Nothing has been written. Working edits and actual application
              require a later, separate step.
            </p>
          )}
        </div>
        {plan.collisions.length ? (
          <Notice type="error">
            <strong>File/directory path collisions</strong>
            <ul>
              {plan.collisions.map((collision) => (
                <li key={collision}>{collision}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        <label className="field preview-reason">
          <span>Engineering reason for proposed application</span>
          <textarea
            aria-label="Engineering reason for proposed application"
            aria-required="true"
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Explain which design changes you want to reuse and why."
          />
        </label>
        <details className="disclosure">
          <summary>
            Overall engineering notes · Base, Source and Destination
          </summary>
          <p className="muted small">
            Notes describe these saved revisions only, not every intervening
            change.
          </p>
          <div className="comparison-file-endpoints preview-three-columns">
            {endpoints.map(({ side, revision }) => (
              <section
                key={side}
                aria-label={`${side} overall notes at ${formatRevisionNumber(revision.manifest.displayNumber)}`}
              >
                <h4>
                  {side} ·{" "}
                  {formatRevisionNumber(revision.manifest.displayNumber)}
                </h4>
                {Object.values(revision.manifest.notes).some((value) =>
                  value.trim(),
                ) ? (
                  <NotesText notes={revision.manifest.notes} />
                ) : (
                  <p className="muted small">
                    No overall engineering notes recorded at this revision.
                  </p>
                )}
              </section>
            ))}
          </div>
        </details>
        <section
          aria-label="Source changes to review"
          className="preview-candidates"
        >
          <h3>Source changes to review ({candidates.length})</h3>
          <p className="muted small">
            Start with nothing selected. Destination-only files and
            source-unchanged files are retained, not offered as deletions.
          </p>
          {!candidates.length ? (
            <Notice>
              No source changes need application against this destination.
            </Notice>
          ) : null}
          {candidates.map((row) => {
            const selected = choices[row.path]?.selected ?? false;
            return (
              <article
                className="comparison-file"
                key={row.path}
                aria-label={`${row.kind === "conflict" ? "Conflict" : "Source change"}: ${row.path}`}
              >
                <div className="comparison-file-heading">
                  <label className="file-choice">
                    <input
                      type="checkbox"
                      aria-label={`Select source ${sourceWord(row)}: ${row.path}`}
                      checked={selected}
                      onChange={(event) =>
                        setSelection(row, event.target.checked)
                      }
                    />
                    <strong className="file-path">{row.path}</strong>
                  </label>
                  <StatusBadge
                    status={
                      row.kind === "conflict"
                        ? "Conflict"
                        : `Source ${sourceWord(row)}`
                    }
                  />
                </div>
                {row.source === null ? (
                  <p className="preview-deletion">
                    Source deletes this file. Choosing source state would DELETE
                    it from the proposed destination.
                  </p>
                ) : null}
                {row.kind === "conflict" ? (
                  <>
                    <p className="small">
                      Source and Destination differ from Base and from each
                      other. Choose a decision explicitly.
                    </p>
                    <label className="preview-decision">
                      <span>Conflict decision</span>
                      <select
                        aria-label={`Conflict decision: ${row.path}`}
                        disabled={!selected}
                        value={choices[row.path]?.decision ?? "unresolved"}
                        onChange={(event) =>
                          setChoices((previous) => ({
                            ...previous,
                            [row.path]: {
                              selected: true,
                              decision: event.target.value as ConflictDecision,
                            },
                          }))
                        }
                      >
                        <option value="unresolved">Leave unresolved</option>
                        <option value="keep-destination">
                          Keep destination
                          {row.destination
                            ? " — retain saved file"
                            : " — file stays absent"}
                        </option>
                        <option value="use-source">
                          Use source state
                          {row.source
                            ? row.destination
                              ? " — replace destination file"
                              : " — add file"
                            : " — DELETE destination file"}
                        </option>
                      </select>
                    </label>
                  </>
                ) : (
                  <p className="muted small">
                    Destination matches Base. Select to include this source{" "}
                    {sourceWord(row)}.
                  </p>
                )}
                {stateAndNotes(row)}
              </article>
            );
          })}
        </section>
        <details className="disclosure">
          <summary>
            No application needed ({retained.length + matching.length})
          </summary>
          {retained.map((row) => (
            <div key={row.path} className="preview-retained">
              <strong className="file-path">{row.path}</strong>
              <span>
                Source unchanged from Base — preserve Destination
                {row.destination ? " file" : " absence"}.
              </span>
              {stateAndNotes(row)}
            </div>
          ))}
          {matching.map((row) => (
            <div key={row.path} className="preview-retained">
              <strong className="file-path">{row.path}</strong>
              <span>Already matches Source — no application needed.</span>
              {stateAndNotes(row)}
            </div>
          ))}
        </details>
        <details className="disclosure">
          <summary>Selected actions ({plan.actions.length})</summary>
          {!plan.actions.length ? (
            <p>No changes selected.</p>
          ) : (
            <ul>
              {plan.actions.map((action) => (
                <li key={action.path}>
                  <strong className="file-path">{action.path}</strong> ·{" "}
                  {action.operation === "delete"
                    ? "DELETE destination file"
                    : action.operation === "unresolved"
                      ? "Unresolved — Destination retained provisionally"
                      : action.operation === "keep"
                        ? "Keep Destination"
                        : action.operation === "add"
                          ? "Add Source file"
                          : "Replace with Source file"}
                </li>
              ))}
            </ul>
          )}
        </details>
        <details className="disclosure">
          <summary>Proposed files ({plan.resultFiles.length})</summary>
          <p className="muted small">
            Unselected and unresolved paths retain Destination. Existing
            destination directories, including empty folders, are retained; only
            required parent folders are added. Empty-folder-only changes are not
            selected in this file preview.
          </p>
          <ul className="preview-result-files">
            {plan.resultFiles.map((file) => (
              <li key={file.path}>
                <strong className="file-path">{file.path}</strong>
                <span>
                  {operations.some((action) => action.path === file.path)
                    ? "Source state selected"
                    : "Destination retained"}
                </span>
                <details className="comparison-hash">
                  <summary>Proposed content hash</summary>
                  <code>{file.sha256}</code>
                </details>
              </li>
            ))}
          </ul>
        </details>
        <div className="modal-actions">
          <button className="button secondary" onClick={onClose}>
            Close preview
          </button>
          <button className="button primary" disabled>
            Apply — unavailable in preview
          </button>
        </div>
      </div>
    </Modal>
  );
}
