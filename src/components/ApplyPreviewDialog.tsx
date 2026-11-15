import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ReconstructedRevision,
  VaultState,
  ProgressUpdate,
} from "../engine/types";
import {
  applicationReview,
  type PreparedApplication,
} from "../engine/application-service";
import type { ApplicationReview } from "../engine/application-records";
import { caseLabel } from "../engine/case-lifecycle";
import {
  buildApplyPreview,
  prepareApplyPreview,
  type ApplyMode,
  FOLDER_KEPT_MESSAGE,
  type ApplyPreviewContext,
  type ConflictDecision,
  type PreviewChoice,
  type PreviewFileRow,
} from "../engine/apply-preview";
import { formatRevisionNumber } from "../engine/vault-service";
import { formatBytes } from "../utils/format";
import { Modal, Notice, NotesText, StatusBadge, OperationProgress } from "./ui";

export interface ApplicationController {
  prepare: (review: ApplicationReview) => Promise<PreparedApplication>;
  apply: (prepared: PreparedApplication) => Promise<void>;
  progress: ProgressUpdate | null;
  cancel: () => void;
  blockedReason?: string;
  destinationLocation?: string;
  refresh?: () => Promise<void>;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;
function countsLine(
  add: number,
  replace: number,
  remove: number,
  revert: boolean,
  foldersCreated = 0,
  foldersRemoved = 0,
): string {
  const folders = [
    foldersCreated ? plural(foldersCreated, "folder created", "folders created") : "",
    foldersRemoved ? plural(foldersRemoved, "folder removed", "folders removed") : "",
  ];
  if (revert)
    return [
      add ? `${plural(add, "file", "files")} brought back` : "",
      replace ? `${replace} replaced` : "",
      remove ? `${remove} removed` : "",
      ...folders,
    ]
      .filter(Boolean)
      .join(" · ");
  return [
    plural(add, "addition", "additions"),
    plural(replace, "replacement", "replacements"),
    plural(remove, "deletion", "deletions"),
    ...folders,
  ]
    .filter(Boolean)
    .join(" · ");
}
const isFolder = (row: PreviewFileRow) => row.entry === "folder";
/** Folders read with a trailing slash; files keep their path. */
const rowLabel = (row: PreviewFileRow) =>
  isFolder(row) ? `${row.path}/` : row.path;
const folderChange = (row: PreviewFileRow) =>
  row.sourceChange === "added" ? "Create folder" : "Remove folder";
const isSelectable = (row: PreviewFileRow) =>
  (row.kind === "available" || row.kind === "conflict") &&
  !row.identityBlock;

/** Carries the user's choices across a refresh of the saved states. A choice
 * survives only while its row still exists, with the same kind, and can still
 * be selected. In revert mode a newly selectable row is pre-selected, as on
 * first open; so is a row whose choice was dropped while it was blocked, once
 * it becomes selectable again. Returns `previous` itself when nothing changed. */
export function reconcileChoices(
  previous: Record<string, PreviewChoice>,
  previousRows: PreviewFileRow[],
  rows: PreviewFileRow[],
  revert: boolean,
): Record<string, PreviewChoice> {
  const before = new Map(
    previousRows.map((row) => [row.path, `${row.entry}:${row.kind}`]),
  );
  const next: Record<string, PreviewChoice> = {};
  for (const row of rows) {
    if (!isSelectable(row)) continue;
    const kept =
      before.get(row.path) === `${row.entry}:${row.kind}`
        ? previous[row.path]
        : undefined;
    if (kept) next[row.path] = kept;
    else if (revert && row.kind === "available")
      next[row.path] = { selected: true, decision: "use-source" };
  }
  const keys = Object.keys(next);
  return keys.length === Object.keys(previous).length &&
    keys.every((key) => next[key] === previous[key])
    ? previous
    : next;
}

export function ApplyPreviewDialog({
  state,
  sourceId,
  destinationBranchId,
  mode = "merge",
  onClose,
  application,
}: {
  state: VaultState;
  sourceId: string;
  destinationBranchId: string;
  mode?: ApplyMode;
  onClose: () => void;
  application?: ApplicationController;
}) {
  const preparation = useMemo(
    () => prepareApplyPreview(state, sourceId, destinationBranchId, mode),
    [state, sourceId, destinationBranchId, mode],
  );
  if (preparation.status === "unavailable")
    return (
      <Modal
        title={
          mode === "revert"
            ? "Bring back an earlier revision — preview"
            : "Review changes to apply — preview"
        }
        onClose={onClose}
      >
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
      application={application}
    />
  );
}
function ApplyPreviewBody({
  context,
  state,
  onClose,
  application,
}: {
  context: ApplyPreviewContext;
  state: VaultState;
  onClose: () => void;
  application?: ApplicationController;
}) {
  const revert = context.mode === "revert";
  const initialChoices = (): Record<string, PreviewChoice> =>
    revert
      ? Object.fromEntries(
          context.rows
            .filter((row) => row.kind === "available" && isSelectable(row))
            .map((row) => [
              row.path,
              { selected: true, decision: "use-source" as ConflictDecision },
            ]),
        )
      : {};
  const [choices, setChoices] = useState<Record<string, PreviewChoice>>(
    initialChoices,
  );
  const [reason, setReason] = useState("");
  const previousRows = useRef(context.rows);
  useEffect(() => {
    const before = previousRows.current;
    if (before === context.rows) return;
    previousRows.current = context.rows;
    setChoices((previous) =>
      reconcileChoices(previous, before, context.rows, revert),
    );
  }, [context.rows, revert]);
  const [prepared, setPrepared] = useState<PreparedApplication | null>(null);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [applied, setApplied] = useState(false);
  const [applicationError, setApplicationError] = useState("");
  const [cadClosed, setCadClosed] = useState(false);
  const destinationFocus = useRef<HTMLParagraphElement>(null);
  const completionFocus = useRef<HTMLButtonElement>(null);
  const reasonFocus = useRef<HTMLTextAreaElement>(null);
  const errorFocus = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (prepared) destinationFocus.current?.focus();
    else if (applied) completionFocus.current?.focus();
    else if (applicationError) errorFocus.current?.focus();
    else reasonFocus.current?.focus();
  }, [prepared, applied, applicationError]);
  const plan = useMemo(
    () => buildApplyPreview(context, choices, reason),
    [context, choices, reason],
  );
  const branchName = (revision: ReconstructedRevision) =>
    caseLabel(state, revision.manifest.branchId);
  const endpointCards = revert
    ? [
        { key: "now", title: `Latest saved · ${caseLabel(state, context.destinationBranchId)}`, revision: context.destination },
        { key: "back", title: `Bring back · ${formatRevisionNumber(context.source.manifest.displayNumber)}`, revision: context.source },
      ]
    : null;
  const endpoints = revert
    ? [
        { side: "Latest saved", revision: context.destination },
        { side: "Bring back", revision: context.source },
      ]
    : [
        { side: "Base", revision: context.base },
        { side: "Source", revision: context.source },
        { side: "Destination", revision: context.destination },
      ];
  const candidates = context.rows.filter(
    (row) => row.kind === "available" || row.kind === "conflict",
  );
  const keptFolders = context.rows.filter(
    (row) => row.kind === "kept-holds-files",
  );
  const matching = context.rows.filter((row) => row.kind === "already-matches");
  const retained = context.rows.filter(
    (row) => row.kind === "no-source-change",
  );
  const foldersCreated = plan.folderActions.filter((a) => a.operation === "create");
  const foldersRemoved = plan.folderActions.filter((a) => a.operation === "remove");
  const reasonLabel = revert
    ? "Engineering reason for bringing this back"
    : "Engineering reason for proposed application";
  const sourceLabel = formatRevisionNumber(
    context.source.manifest.displayNumber,
  );
  const destinationName = caseLabel(state, context.destinationBranchId);
  const revertChange = (row: PreviewFileRow) =>
    row.sourceChange === "deleted"
      ? `Remove (not in ${sourceLabel})`
      : row.sourceChange === "added"
        ? "Bring back"
        : `Replace with ${sourceLabel}'s version`;
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
      <div className={revert ? "comparison-file-endpoints" : "comparison-file-endpoints preview-three-columns"}>
        {endpoints.map(({ side, revision }) => {
          const file =
            side === "Base"
              ? row.base
              : side === "Source" || side === "Bring back"
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
  const prepare = async () => {
    if (!application || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setApplicationError("");
    setCadClosed(false);
    try {
      setPrepared(await application.prepare(applicationReview(plan, choices)));
    } catch (error) {
      setApplicationError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };
  const apply = async () => {
    if (!application || !prepared || runningRef.current || !cadClosed) return;
    runningRef.current = true;
    setRunning(true);
    setApplicationError("");
    try {
      await application.apply(prepared);
      setApplied(true);
      setPrepared(null);
    } catch (error) {
      setApplicationError(
        error instanceof Error ? error.message : String(error),
      );
      setPrepared(null);
      setCadClosed(false);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };
  if (applied)
    return (
      <Modal
        title={revert ? "Bring back completed" : "Application completed"}
        onClose={onClose}
      >
        <Notice type="success">
          {revert
            ? "Brought back into working files — revision not yet saved."
            : "Applied to working files — revision not yet saved."}
        </Notice>
        <p>
          Open the destination in CAD, check references and rebuild, and make
          any necessary adjustments. Use the normal Changes → Save revision flow
          to preserve the final complete snapshot and{" "}
          {revert
            ? "keep this bring-back in the revision's history."
            : "application provenance."}
        </p>
        <p>
          {revert
            ? `${sourceLabel} and ${destinationName}'s latest saved revision both stay in history.`
            : "The source Design Case and its saved history remain available."}
        </p>
        <div className="modal-actions">
          <button
            ref={completionFocus}
            className="button primary"
            onClick={onClose}
          >
            Return to History
          </button>
        </div>
      </Modal>
    );
  if (prepared)
    return (
      <Modal
        title={
          revert
            ? "Confirm bringing back into working files"
            : "Confirm working-file application"
        }
        onClose={onClose}
        busy={running}
      >
        <Notice>
          This will write to the active destination branch's connected working
          folder. Save and close relevant CAD documents before proceeding. Other
          applications and cloud sync are not locked; the multi-file operation
          is not atomic.
        </Notice>
        <p ref={destinationFocus} tabIndex={-1}>
          <strong>
            Project: {state.project.name} · Destination: {prepared.branchName}
          </strong>{" "}
          · Working folder: {prepared.destinationName}
        </p>
        {application?.destinationLocation ? (
          <p className="file-path">
            Connected location: {application.destinationLocation}
          </p>
        ) : null}
        <p>
          Saved baseline:{" "}
          {formatRevisionNumber(context.destination.manifest.displayNumber)} ·
          Source: {formatRevisionNumber(context.source.manifest.displayNumber)}{" "}
          on {branchName(context.source)}.
        </p>
        <p>
          The destination matched its saved baseline during preparation. It will
          be rechecked under the project writer lock before application.
        </p>
        <h3>{revert ? "Confirmed changes" : "Confirmed additions, replacements and deletions"}</h3>
        {revert ? (
          <p>
            <strong>
              {countsLine(
                prepared.plan.actions.filter((a) => a.operation === "add").length,
                prepared.plan.actions.filter((a) => a.operation === "replace").length,
                prepared.plan.actions.filter((a) => a.operation === "delete").length,
                true,
                prepared.plan.folderActions.filter((a) => a.operation === "create").length,
                prepared.plan.folderActions.filter((a) => a.operation === "remove").length,
              )}
            </strong>
          </p>
        ) : null}
        <ul className="application-actions">
          {prepared.plan.actions.map((action) => (
            <li key={action.path}>
              <strong>
                {action.operation === "delete"
                  ? revert
                    ? `Remove (not in ${sourceLabel})`
                    : "DELETE destination file"
                  : action.operation === "replace"
                    ? revert
                      ? `Replace with ${sourceLabel}'s version`
                      : "Replace with Source"
                    : action.operation === "add"
                      ? revert
                        ? `Bring back from ${sourceLabel}`
                        : "Add Source file"
                      : "Keep Destination"}
              </strong>{" "}
              · <span className="file-path">{action.path}</span>
            </li>
          ))}
          {prepared.plan.folderActions.map((action) => (
            <li key={`folder:${action.path}`}>
              <strong>
                {action.operation === "create" ? "Create folder" : "Remove folder"}
              </strong>{" "}
              · <span className="file-path">{action.path}/</span>
            </li>
          ))}
        </ul>
        <p>
          <strong>Engineering reason:</strong> {prepared.plan.reason}
        </p>
        <label className="file-choice">
          <input
            type="checkbox"
            checked={cadClosed}
            disabled={running}
            onChange={(event) => setCadClosed(event.target.checked)}
          />
          I have saved and closed relevant CAD documents and confirm this
          destination.
        </label>
        <OperationProgress
          progress={application?.progress ?? null}
          onCancel={() => application?.cancel()}
        />
        <div className="modal-actions">
          <button
            className="button secondary"
            disabled={running}
            onClick={() => setPrepared(null)}
          >
            Back to review
          </button>
          <button
            className="button primary"
            disabled={running || !cadClosed}
            onClick={() => void apply()}
          >
            {revert ? "Bring back confirmed changes" : "Apply confirmed changes"}
          </button>
        </div>
      </Modal>
    );
  return (
    <Modal
      title={
        revert
          ? `Make ${destinationName} match ${sourceLabel}`
          : "Review changes to apply — preview"
      }
      onClose={onClose}
      busy={running}
    >
      <div className="apply-preview">
        {applicationError ? (
          <div ref={errorFocus} tabIndex={-1}>
            <Notice type="error">{applicationError}</Notice>
          </div>
        ) : null}
        {application?.blockedReason ? (
          <Notice type="error">{application.blockedReason}</Notice>
        ) : null}
        {context.rows.some(row => row.identityBlock) ? <Notice>Some saved paths have different or unavailable component identities. Affected actions are blocked. Review their identity messages; unaffected file actions remain available.</Notice> : null}
        <Notice>
          {application
            ? "Saved-state review — no files change until preparation and final confirmation. Preparation rejects uncaptured destination edits."
            : "Preview only — no files will be applied. This uses saved states."}{" "}
          Current uncaptured working edits are not included and are not
          authorized for replacement.
        </Notice>
        <div className={revert ? "preview-endpoints" : "preview-endpoints preview-three-columns"}>
          {endpointCards ? endpointCards.map(({ key, title, revision }) => (
            <section key={key} aria-label={title}>
              <h3>{title}</h3>
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
          )) : endpoints.map(({ side, revision }) => (
            <section key={side} aria-label={`${side} saved revision`}>
              <h3>
                {side}
                {side === "Destination"
                  ? ` · working case ${state.branches.find((branch) => branch.branchId === context.destinationBranchId)?.name}`
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
          {revert
            ? "Compares saved byte hashes of the two revisions; it does not merge geometry or verify CAD compatibility."
            : "Base is the nearest shared ancestor established from validated parent relationships. This preview compares byte hashes; it does not merge geometry or verify CAD compatibility."}
        </p>
        <div
          className="comparison-scope"
          role="status"
          aria-label="Proposed result summary"
        >
          <strong>Proposed result: {plan.resultFiles.length} files</strong>
          <span>
            {countsLine(
              operations.filter((action) => action.operation === "add").length,
              operations.filter((action) => action.operation === "replace").length,
              operations.filter((action) => action.operation === "delete").length,
              revert,
              foldersCreated.length,
              foldersRemoved.length,
            )}
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
              Nothing has been written.{" "}
              {application
                ? revert
                  ? "Prepare bring-back to check the working folder, then review and confirm the working-file changes."
                  : "Prepare application to check the destination, then review and confirm the working-file changes."
                : "Working edits and actual application require a later, separate step."}
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
          <span>{reasonLabel}</span>
          <textarea
            ref={reasonFocus}
            aria-label={reasonLabel}
            aria-required="true"
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={
              revert
                ? "Explain why you are bringing this earlier version back."
                : "Explain which design changes you want to reuse and why."
            }
            disabled={running}
          />
        </label>
        <details className="disclosure">
          <summary>
            {revert
              ? "Overall engineering notes · Latest saved and Bring back"
              : "Overall engineering notes · Base, Source and Destination"}
          </summary>
          <p className="muted small">
            Notes describe these saved revisions only, not every intervening
            change.
          </p>
          <div className={revert ? "comparison-file-endpoints" : "comparison-file-endpoints preview-three-columns"}>
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
          aria-label={revert ? "Changes to review" : "Source changes to review"}
          className="preview-candidates"
        >
          <h3>{revert ? "Changes to review" : "Source changes to review"} ({candidates.length})</h3>
          <p className="muted small">
            {revert
              ? `All changes are selected. Nothing is lost: ${destinationName}'s latest saved revision stays in history, and the files you replace are kept with this operation. Save a revision afterwards.`
              : "Start with nothing selected. Destination-only files and source-unchanged files are retained, not offered as deletions."}
          </p>
          {!candidates.length ? (
            <Notice>
              {keptFolders.length
                ? "No source changes can be applied against this destination."
                : "No source changes need application against this destination."}
            </Notice>
          ) : null}
          {candidates.map((row) => {
            const selected = choices[row.path]?.selected ?? false;
            return (
              <article
                className="comparison-file"
                key={row.path}
                aria-label={`${row.kind === "conflict" ? "Conflict" : "Source change"}: ${rowLabel(row)}`}
              >
                <div className="comparison-file-heading">
                  <label className="file-choice">
                    <input
                      type="checkbox"
                      aria-label={
                        isFolder(row)
                          ? `Select ${folderChange(row)}: ${rowLabel(row)}`
                          : revert
                            ? `Select ${revertChange(row)}: ${row.path}`
                            : `Select source ${sourceWord(row)}: ${row.path}`
                      }
                      checked={selected}
                      disabled={running || Boolean(row.identityBlock)}
                      onChange={(event) =>
                        setSelection(row, event.target.checked)
                      }
                    />
                    <strong className="file-path">{rowLabel(row)}</strong>
                    {isFolder(row) ? <StatusBadge status="Folder" /> : null}
                  </label>
                  <StatusBadge
                    status={
                      isFolder(row)
                        ? folderChange(row)
                        : row.kind === "conflict"
                          ? "Conflict"
                          : revert
                            ? revertChange(row)
                            : `Source ${sourceWord(row)}`
                    }
                  />
                </div>
                {row.identityBlock ? <Notice type="error">{row.identityBlock}</Notice> : null}
                {isFolder(row) ? (
                  <p className="muted small">
                    {row.sourceChange === "added"
                      ? revert
                        ? `This folder is in ${sourceLabel}. Selected to create it again in the working files.`
                        : "Source adds this folder (empty folders included). Select to create it."
                      : revert
                        ? `This folder is not in ${sourceLabel}. It can be removed only if it is empty after the selected deletions; otherwise untick it. It stays in saved history.`
                        : "Source removes this folder. Select to remove it; it can be removed only if it is empty after the selected deletions, otherwise untick it."}
                  </p>
                ) : null}
                {!isFolder(row) && row.source === null ? (
                  <p className="preview-deletion">
                    {revert
                      ? `This file is not in ${sourceLabel}. It would be removed from the working files; it stays in saved history.`
                      : "Source deletes this file. Choosing source state would DELETE it from the proposed destination."}
                  </p>
                ) : null}
                {isFolder(row) ? null : row.kind === "conflict" ? (
                  <>
                    <p className="small">
                      Source and Destination differ from Base and from each
                      other. Choose a decision explicitly.
                    </p>
                    <label className="preview-decision">
                      <span>Conflict decision</span>
                      <select
                        aria-label={`Conflict decision: ${row.path}`}
                        disabled={!selected || running}
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
                    {revert
                      ? `Selected to make this file match ${sourceLabel}.`
                      : `Destination matches Base. Select to include this source ${sourceWord(row)}.`}
                  </p>
                )}
                {isFolder(row) ? null : stateAndNotes(row)}
              </article>
            );
          })}
          {keptFolders.map((row) => (
            <article
              className="comparison-file"
              key={row.path}
              aria-label={`Kept folder: ${rowLabel(row)}`}
            >
              <div className="comparison-file-heading">
                <strong className="file-path">{rowLabel(row)}</strong>
                <StatusBadge status="Folder" />
              </div>
              <p className="muted small">{FOLDER_KEPT_MESSAGE}</p>
            </article>
          ))}
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
              <strong className="file-path">{rowLabel(row)}</strong>
              {isFolder(row) ? <StatusBadge status="Folder" /> : null}
              <span>Already matches Source — no application needed.</span>
              {isFolder(row) ? null : stateAndNotes(row)}
            </div>
          ))}
        </details>
        <details className="disclosure">
          <summary>
            Selected actions ({plan.actions.length + plan.folderActions.length})
          </summary>
          {!plan.actions.length && !plan.folderActions.length ? (
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
              {plan.folderActions.map((action) => (
                <li key={`folder:${action.path}`}>
                  <strong className="file-path">{action.path}/</strong>{" "}
                  <StatusBadge status="Folder" /> ·{" "}
                  {action.operation === "create" ? "Create folder" : "Remove folder"}
                </li>
              ))}
            </ul>
          )}
        </details>
        <details className="disclosure">
          <summary>Proposed files ({plan.resultFiles.length})</summary>
          <p className="muted small">
            Unselected and unresolved paths retain Destination.
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
            {foldersCreated.map((action) => (
              <li key={`folder:${action.path}`}>
                <strong className="file-path">{action.path}/</strong>
                <StatusBadge status="Folder" />
                <span>Folder to be created</span>
              </li>
            ))}
          </ul>
        </details>
        <OperationProgress
          progress={application?.progress ?? null}
          onCancel={() => application?.cancel()}
        />
        <div className="modal-actions">
          <button
            className="button secondary"
            onClick={onClose}
            disabled={running}
          >
            Close preview
          </button>
          {application?.refresh ? (
            <button
              className="button secondary"
              disabled={running}
              onClick={async () => {
                if (runningRef.current) return;
                runningRef.current = true;
                setRunning(true);
                setApplicationError("");
                try {
                  await application.refresh!();
                } catch (error) {
                  setApplicationError(
                    error instanceof Error ? error.message : String(error),
                  );
                } finally {
                  runningRef.current = false;
                  setRunning(false);
                }
              }}
            >
              Refresh saved states
            </button>
          ) : null}
          <button
            className="button primary"
            disabled={
              !application ||
              !plan.ready ||
              running ||
              Boolean(application.blockedReason)
            }
            onClick={() => void prepare()}
          >
            {application
              ? revert
                ? "Prepare bring-back"
                : "Prepare application"
              : "Apply — unavailable in preview"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
