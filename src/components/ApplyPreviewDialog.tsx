import { useMemo, useRef, useState } from "react";
import type { VaultState, ProgressUpdate } from "../engine/types";
import {
  applicationReview,
  type ApplyAndSaveResult,
} from "../engine/application-service";
import type { ApplicationReview } from "../engine/application-records";
import { caseLabel } from "../engine/case-lifecycle";
import {
  buildApplyPreview,
  prepareApplyPreview,
  type ApplyMode,
  FOLDER_KEPT_MESSAGE,
  type ApplyPreviewContext,
  type PreviewChoice,
  type PreviewFileRow,
} from "../engine/apply-preview";
import { formatRevisionNumber } from "../engine/vault-service";
import { Modal, Notice, StatusBadge, OperationProgress } from "./ui";

export interface ApplicationController {
  /** Writes the reviewed plan and saves it as a revision (engine `applyAndSave`). */
  applyAndSave: (review: ApplicationReview) => Promise<ApplyAndSaveResult | undefined>;
  progress: ProgressUpdate | null;
  cancel: () => void;
  blockedReason?: string;
  /** Unsaved changes in the destination's working folder, when known from the last check. */
  unsavedChanges?: number;
  /** Takes the user to Changes to save their own edits first. */
  onSaveFirst?: () => void;
  // TODO(Phase 4, Discard): add `onDiscardFirst` ("Discard them", keeps a copy in Discarded/).
}

/** What the user decided: files unticked (Copy only) and, for each file
 * changed on both sides, Keep mine or Take theirs. */
export type CopyDecision = "keep-destination" | "use-source";
const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;
const isFolder = (row: PreviewFileRow) => row.entry === "folder";
const isSelectable = (row: PreviewFileRow) =>
  (row.kind === "available" || row.kind === "conflict") && !row.identityBlock;
const inside = (folder: string, path: string) => path.startsWith(`${folder}/`);

/**
 * The engine choices for one dialog state. Bring back takes every change
 * (all-or-nothing). Copy files takes every ticked file; a file changed on both
 * sides carries the user's Keep mine / Take theirs, or stays unresolved (the plan
 * is then not ready). Folder rows follow their files: an added folder is created
 * unless all the files the case added inside it were unticked; a removed folder
 * is removed only if every file and subfolder inside it is removed too.
 */
export function deriveChoices(
  rows: PreviewFileRow[],
  revert: boolean,
  unticked: ReadonlySet<string>,
  decisions: Readonly<Record<string, CopyDecision>>,
): Record<string, PreviewChoice> {
  const choices: Record<string, PreviewChoice> = {};
  const files = rows.filter((row) => !isFolder(row) && isSelectable(row));
  for (const row of files) {
    if (row.kind === "conflict")
      choices[row.path] = {
        selected: true,
        decision: decisions[row.path] ?? "unresolved",
      };
    else if (revert || !unticked.has(row.path))
      choices[row.path] = { selected: true, decision: "use-source" };
  }
  const folders = rows.filter((row) => isFolder(row) && isSelectable(row));
  if (revert) {
    for (const row of folders)
      choices[row.path] = { selected: true, decision: "use-source" };
    return choices;
  }
  const takes = (path: string) => choices[path]?.decision === "use-source";
  const depth = (path: string) => path.split("/").length;
  const added = folders.filter((row) => row.sourceChange === "added");
  const create = new Set(
    added
      .filter((row) => {
        const under = files.filter((file) => inside(row.path, file.path));
        return !under.length || under.some((file) => takes(file.path));
      })
      .map((row) => row.path),
  );
  // A created folder needs its added parents.
  for (const row of added)
    if ([...create].some((path) => inside(row.path, path))) create.add(row.path);
  const removed = folders
    .filter((row) => row.sourceChange === "deleted")
    .sort((a, b) => depth(b.path) - depth(a.path));
  const remove = new Set<string>();
  for (const row of removed) {
    const filesGo = files
      .filter((file) => inside(row.path, file.path))
      .every((file) => takes(file.path));
    const foldersGo = removed
      .filter((other) => inside(row.path, other.path))
      .every((other) => remove.has(other.path));
    if (filesGo && foldersGo) remove.add(row.path);
  }
  for (const path of [...create, ...remove])
    choices[path] = { selected: true, decision: "use-source" };
  return choices;
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
  if (preparation.status === "unavailable") {
    const source = state.revisions.find((r) => r.manifest.revisionId === sourceId);
    return (
      <Modal
        title={
          mode === "revert"
            ? "Bring back an earlier revision"
            : `Copy files from ${source ? caseLabel(state, source.manifest.branchId) : "a case"}`
        }
        onClose={onClose}
      >
        <Notice type="error">This can't be done right now. {preparation.reason}</Notice>
        <p>No files were changed.</p>
        <div className="modal-actions">
          <button className="button secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>
    );
  }
  const context = preparation.context;
  return (
    <ApplyBody
      key={`${context.projectId}:${context.source.manifest.revisionId}:${context.destination.manifest.revisionId}:${context.base.manifest.revisionId}:${destinationBranchId}`}
      context={context}
      state={state}
      onClose={onClose}
      application={application}
    />
  );
}

function ApplyBody({
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
  const [unticked, setUnticked] = useState<Set<string>>(() => new Set());
  const [decisions, setDecisions] = useState<Record<string, CopyDecision>>({});
  const [reason, setReason] = useState("");
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [error, setError] = useState("");
  const choices = useMemo(
    () => deriveChoices(context.rows, revert, unticked, decisions),
    [context.rows, revert, unticked, decisions],
  );
  const plan = useMemo(
    () => buildApplyPreview(context, choices, reason.trim()),
    [context, choices, reason],
  );
  const sourceLabel = formatRevisionNumber(context.source.manifest.displayNumber);
  const destinationName = caseLabel(state, context.destinationBranchId);
  const sourceCase = caseLabel(state, context.source.manifest.branchId);
  const fileRows = context.rows.filter(
    (row) => !isFolder(row) && (row.kind === "available" || row.kind === "conflict"),
  );
  const folderRows = context.rows.filter(
    (row) =>
      isFolder(row) &&
      (row.kind === "available" || row.kind === "conflict" || row.kind === "kept-holds-files"),
  );
  const conflicts = fileRows.filter((row) => row.kind === "conflict" && !row.identityBlock);
  const undecided = conflicts.filter((row) => !decisions[row.path]).length;
  const fileActions = plan.actions.filter((a) =>
    ["add", "replace", "delete"].includes(a.operation),
  );
  const unsaved = application?.unsavedChanges ?? 0;
  const nothingToDo = !fileActions.length && !plan.folderActions.length;
  // Blockers the dialog does not already explain by its own controls.
  const otherBlockers = plan.blockers.filter(
    (b) =>
      !b.startsWith("Select at least one") &&
      !b.startsWith("Resolve every selected conflict") &&
      !b.startsWith("Resolve file/directory path collisions"),
  );
  const ready =
    Boolean(application) &&
    plan.ready &&
    !running &&
    !unsaved &&
    !application?.blockedReason;
  const run = async () => {
    if (!application || runningRef.current || !ready) return;
    runningRef.current = true;
    setRunning(true);
    setError("");
    try {
      await application.applyAndSave(applicationReview(plan, choices));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };
  const fileChange = (row: PreviewFileRow) =>
    row.sourceChange === "added"
      ? "added"
      : row.sourceChange === "deleted"
        ? "removed"
        : "changed";
  const planned = (path: string) =>
    plan.folderActions.some((a) => a.path === path);
  const folderLine = (row: PreviewFileRow) => (
    <li key={`folder:${row.path}`} className="apply-row">
      <span className="file-path">{row.path}/</span> <StatusBadge status="Folder" />{" "}
      <span className="muted small">
        {row.kind === "kept-holds-files"
          ? FOLDER_KEPT_MESSAGE
          : planned(row.path)
            ? row.sourceChange === "added"
              ? "Will be created"
              : "Will be removed"
            : "Not copied"}
      </span>
    </li>
  );
  const blockedNote = (row: PreviewFileRow) =>
    revert ? row.identityBlock : "Renamed in one case; can't copy yet.";
  const saveFirst = unsaved ? (
    <Notice>
      {destinationName} has {plural(unsaved, "unsaved change", "unsaved changes")}.
      Save them first, so nothing is lost.
    </Notice>
  ) : null;
  const errors = (
    <>
      {error ? <Notice type="error">{error}</Notice> : null}
      {application?.blockedReason ? (
        <Notice type="error">{application.blockedReason}</Notice>
      ) : null}
      {plan.collisions.length ? (
        <Notice type="error">
          <strong>These paths clash</strong>
          <ul>
            {plan.collisions.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {otherBlockers.length ? (
        <Notice type="error">
          <ul>
            {otherBlockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </>
  );
  const whyField = (
    <label className="field preview-reason">
      <span>Why (optional)</span>
      <textarea
        aria-label="Why (optional)"
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={
          revert
            ? "Why are you bringing this version back?"
            : "Why are you copying these files?"
        }
        disabled={running}
      />
    </label>
  );
  const actions = (label: string) => (
    <>
      <OperationProgress
        progress={running ? (application?.progress ?? null) : null}
        onCancel={() => application?.cancel()}
      />
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose} disabled={running}>
          Cancel
        </button>
        {unsaved && application?.onSaveFirst ? (
          <button
            className="button primary"
            disabled={running}
            onClick={() => {
              application.onSaveFirst!();
              onClose();
            }}
          >
            Save my changes first
          </button>
        ) : (
          <button
            className="button primary"
            disabled={!ready}
            onClick={() => void run()}
          >
            {running ? "Saving…" : label}
          </button>
        )}
      </div>
    </>
  );

  if (revert) {
    const groups: [string, PreviewFileRow[]][] = [
      ["Brought back", fileRows.filter((r) => fileChange(r) === "added")],
      ["Replaced with the older version", fileRows.filter((r) => fileChange(r) === "changed")],
      [`Removed (not in ${sourceLabel})`, fileRows.filter((r) => fileChange(r) === "removed")],
    ];
    const blocked = fileRows.filter((r) => r.identityBlock);
    return (
      <Modal
        title={`Bring back ${sourceLabel} onto ${destinationName}`}
        onClose={onClose}
        busy={running}
      >
        <div className="apply-preview">
          {errors}
          {saveFirst}
          <p role="status" aria-label="What will change">
            <strong>
              {nothingToDo
                ? `${destinationName} already matches ${sourceLabel}.`
                : `${plural(fileActions.length, "file", "files")} will change`}
            </strong>
            {plan.folderActions.length
              ? ` · ${plural(plan.folderActions.length, "folder", "folders")}`
              : ""}
          </p>
          <p className="muted small">
            {destinationName}'s files will match {sourceLabel}, and the result
            is saved as a new revision. Nothing is lost: the current revision
            stays in history. Close these files in your CAD program first.
          </p>
          {blocked.length ? (
            <Notice>
              Some files were renamed since {sourceLabel} and are left as they are.
            </Notice>
          ) : null}
          {groups.map(([title, rows]) => {
            const shown = rows.filter((r) => !r.identityBlock);
            return shown.length ? (
              <section key={title} aria-label={title}>
                <h3>
                  {title} ({shown.length})
                </h3>
                <ul className="application-actions">
                  {shown.map((row) => (
                    <li key={row.path} className="file-path">
                      {row.path}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null;
          })}
          {folderRows.length ? (
            <section aria-label="Folders">
              <h3>Folders ({folderRows.length})</h3>
              <ul className="application-actions">{folderRows.map(folderLine)}</ul>
            </section>
          ) : null}
          {blocked.length ? (
            <section aria-label="Can't bring back">
              <h3>Can't bring back ({blocked.length})</h3>
              <ul className="application-actions">
                {blocked.map((row) => (
                  <li key={row.path} aria-label={`Blocked: ${row.path}`} className="muted">
                    <span className="file-path">{row.path}</span>
                    <p className="small">{blockedNote(row)}</p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {whyField}
          {actions("Bring back")}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Copy files from ${sourceCase}`} onClose={onClose} busy={running}>
      <div className="apply-preview">
        {errors}
        {saveFirst}
        <p className="muted small">
          These are the files {sourceCase} changed ({sourceLabel}). Ticked files
          are copied into {destinationName}, and the result is saved as a new
          revision. Close these files in your CAD program first.
        </p>
        {!fileRows.length && !folderRows.length ? (
          <Notice>
            Nothing to copy: {destinationName} already has every change from{" "}
            {sourceCase}.
          </Notice>
        ) : null}
        {conflicts.length ? (
          <p role="status" aria-label="Changed in both">
            {undecided
              ? `${plural(undecided, "file was", "files were")} changed in both. Choose Keep mine or Take theirs for each.`
              : "You chose a version for every file changed in both."}
          </p>
        ) : null}
        <ul className="application-actions copy-files-list">
          {fileRows.map((row) => {
            if (row.identityBlock)
              return (
                <li key={row.path} aria-label={`Can't copy: ${row.path}`} className="muted">
                  <span className="file-path">{row.path}</span>{" "}
                  <span className="small">{blockedNote(row)}</span>
                </li>
              );
            if (row.kind === "conflict") {
              const choice = decisions[row.path];
              const pick = (decision: CopyDecision) =>
                setDecisions((previous) => ({ ...previous, [row.path]: decision }));
              return (
                <li key={row.path} className="apply-row">
                  <fieldset aria-label={`Changed in both: ${row.path}`} disabled={running}>
                    <legend>
                      <span className="file-path">{row.path}</span>{" "}
                      <StatusBadge status="Changed in both" />
                    </legend>
                    <label className="file-choice">
                      <input
                        type="radio"
                        name={`decision:${row.path}`}
                        checked={choice === "keep-destination"}
                        onChange={() => pick("keep-destination")}
                      />
                      Keep mine
                    </label>
                    <label className="file-choice">
                      <input
                        type="radio"
                        name={`decision:${row.path}`}
                        checked={choice === "use-source"}
                        onChange={() => pick("use-source")}
                      />
                      {row.source ? "Take theirs" : "Take theirs (removes the file)"}
                    </label>
                  </fieldset>
                </li>
              );
            }
            const ticked = !unticked.has(row.path);
            return (
              <li key={row.path} className="apply-row">
                <label className="file-choice">
                  <input
                    type="checkbox"
                    aria-label={`Copy ${row.path}`}
                    checked={ticked}
                    disabled={running}
                    onChange={(e) =>
                      setUnticked((previous) => {
                        const next = new Set(previous);
                        if (e.target.checked) next.delete(row.path);
                        else next.add(row.path);
                        return next;
                      })
                    }
                  />
                  <span className="file-path">{row.path}</span>
                </label>{" "}
                <StatusBadge
                  status={
                    fileChange(row) === "removed"
                      ? `Removed in ${sourceCase}`
                      : fileChange(row) === "added"
                        ? "Added"
                        : "Changed"
                  }
                />
              </li>
            );
          })}
          {folderRows.map(folderLine)}
        </ul>
        {fileRows.length && nothingToDo && !undecided ? (
          <p className="muted small">Nothing will be copied with these choices.</p>
        ) : null}
        {whyField}
        {actions("Copy files")}
      </div>
    </Modal>
  );
}
