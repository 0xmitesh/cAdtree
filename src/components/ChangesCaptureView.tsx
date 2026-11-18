import { useEffect, useMemo, useState } from "react";
import { File, RefreshCw, Save, StickyNote } from "lucide-react";
import type {
  FileSpecificNote,
  ProgressUpdate,
  RevisionNotes,
  ScanResult,
  VaultState,
} from "../engine/types";
import { formatRevisionNumber } from "../engine/vault-service";
import { formatBytes, formatTimestamp } from "../utils/format";
import { Notice, OperationProgress, StatusBadge } from "./ui";
import { NoteEditor } from "./NoteEditor";
import { FilePathActions } from "./FilePathShortcuts";
import type { FilePathLocation } from "../utils/folder-path";
import { createIdentityReview, prepareComponentRecord, type IdentityReview } from '../engine/component-identity';
import { canTreatAsNew, ComponentIdentityControls, identityReviewStale, TreatAsNewDialog } from './ComponentIdentityControls';
import { createReferenceReview, prepareReferenceContext, referenceSelectionChanged, type ReferenceReview, type PendingReferenceAttachment } from '../engine/references';
import { RevisionAttachments, type DraftReferenceAttachment } from './RevisionAttachments';

export interface ChangesCaptureViewProps {
  onEnableComponentTracking?: () => Promise<void>;
  draftCache?: Map<string, CaptureDraft>;
  draftKey?: string;
  vaultState: VaultState;
  activeBranchId: string;
  workingFolderName: string | null;
  vaultFolderName: string;
  scanResult: ScanResult | null;
  isScanStale: boolean;
  isScanning: boolean;
  isCapturing: boolean;
  progress: ProgressUpdate | null;
  statusBanner: { type: "success" | "error" | "info"; message: string } | null;
  onScan: () => Promise<void>;
  onCapture: (params: {
    summary: string;
    notes: RevisionNotes;
    fileNotes: FileSpecificNote[];
    reviewedChangesSignature: string;
    identityReview?: IdentityReview;
    referenceReview?: ReferenceReview;
    referenceAttachments?: PendingReferenceAttachment[];
    onReferenceAttachmentsStored?: (review: ReferenceReview) => void;
  }) => Promise<void>;
  onCancelOperation: () => void;
  onReattachWorkingFolder: () => Promise<void>;
  operationBlockReason?: string;
  resolveFilePath?: (path: string) => Promise<FilePathLocation>;
}
export interface CaptureDraft {
  identityReview?: IdentityReview;
  referenceReview?: ReferenceReview;
  summary: string;
  notes: RevisionNotes;
  fileNotes: Record<string, FileSpecificNote>;
  notePath: string | null;
  showOverall: boolean;
  attachments?: DraftReferenceAttachment[];
  showAttachments?: boolean;
}
const emptyNotes: RevisionNotes = {
  problem: "",
  modification: "",
  observations: "",
};
export function ChangesCaptureView({
  vaultState,
  activeBranchId,
  workingFolderName,
  scanResult: scan,
  isScanStale,
  isScanning,
  isCapturing,
  progress,
  onScan,
  onCapture,
  onCancelOperation,
  onReattachWorkingFolder,
  operationBlockReason,
  resolveFilePath,
  draftCache,
  draftKey,
  onEnableComponentTracking,
}: ChangesCaptureViewProps) {
  const savedDraft = draftKey ? draftCache?.get(draftKey) : undefined;
  const [summary, setSummary] = useState(savedDraft?.summary ?? "");
  const [identityReview, setIdentityReview] = useState<IdentityReview | undefined>(savedDraft?.identityReview);
  const [referenceReview, setReferenceReview] = useState<ReferenceReview | undefined>(savedDraft?.referenceReview);
  const [attachments, setAttachments] = useState<DraftReferenceAttachment[]>(savedDraft?.attachments ?? []);
  const [showAttachments, setShowAttachments] = useState(savedDraft?.showAttachments ?? Boolean(savedDraft?.referenceReview?.explicit.length));
  const effectiveReferences = scan ? referenceReview ?? createReferenceReview(vaultState, scan) : undefined;
  const referenceChanged = Boolean(attachments.length || (scan && referenceSelectionChanged(vaultState, scan, effectiveReferences)));
  const [notes, setNotes] = useState<RevisionNotes>(
    savedDraft?.notes ?? emptyNotes,
  );
  const [fileNotes, setFileNotes] = useState<Record<string, FileSpecificNote>>(
    savedDraft?.fileNotes ?? {},
  );
  const [notePath, setNotePath] = useState<string | null>(
    savedDraft?.notePath ?? null,
  );
  const [showOverall, setShowOverall] = useState(
    savedDraft?.showOverall ?? false,
  );
  useEffect(() => {
    if (draftKey)
      draftCache?.set(draftKey, {
        summary,
        notes,
        fileNotes,
        notePath,
        showOverall,
        identityReview,
        referenceReview,
        attachments,
        showAttachments,
      });
  }, [draftCache, draftKey, summary, notes, fileNotes, notePath, showOverall, identityReview, referenceReview, attachments, showAttachments]);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [treatAsNewPath, setTreatAsNewPath] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [reviewedSignature, setReviewedSignature] = useState<string | null>(
    null,
  );
  const head = vaultState.revisions.find(
    (r) => r.manifest.revisionId === vaultState.branchHeads[activeBranchId],
  );
  const damaged =
    vaultState.damagedBranchHeads[activeBranchId] ||
    vaultState.competingHeads[activeBranchId]?.length ||
    vaultState.revisions.some(
      (r) =>
        r.manifest.branchId === activeBranchId &&
        r.integrityStatus === "corrupted",
    );
  const busy = isScanning || isCapturing;
  const identityConflict = useMemo(() => {
    if (!scan) return undefined;
    try {
      prepareComponentRecord(vaultState, scan, identityReview);
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [vaultState, scan, identityReview]);
  const referenceConflict = useMemo(() => {
    if (!scan || identityConflict) return undefined;
    try { prepareReferenceContext(vaultState, scan, prepareComponentRecord(vaultState, scan, identityReview)?.files ?? [], effectiveReferences); }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }, [vaultState, scan, identityReview, identityConflict, effectiveReferences]);
  const renames = identityReview?.changesSignature === scan?.changesSignature ? identityReview?.renames ?? [] : [];
  const changes = [
    ...(scan?.added ?? []).filter(file => !renames.some(r => r.to === file.path)).map((file) => ({ file, status: "Added", from: '' })),
    ...(scan?.modified ?? []).map((m) => ({
      file: m.current,
      status: "Modified",
      from: '',
    })),
    ...(scan?.deleted ?? []).filter(file => !renames.some(r => r.from === file.path)).map((file) => ({ file, status: "Deleted", from: '' })),
    ...renames.flatMap(rename => {
      const file = scan?.added.find(f => f.path === rename.to);
      return file ? [{ file, status: 'Renamed', from: rename.from }] : [];
    }),
  ].sort((a, b) => a.file.path.localeCompare(b.file.path));
  const rows = [
    ...changes,
    ...(showUnchanged
      ? (scan?.unchanged ?? []).map((file) => ({ file, status: "Unchanged", from: '' }))
      : []),
  ];
  const validPaths = new Set([...(scan?.added ?? []).map(f => f.path), ...(scan?.modified ?? []).map(m => m.current.path), ...(scan?.deleted ?? []).map(f => f.path)]);
  const hasDraft =
    referenceChanged || showAttachments ||
    Boolean(identityReview?.replacements.length) ||
    summary ||
    Object.values(notes).some((v) => v) ||
    Object.values(fileNotes).some(
      (n) => n.problem || n.modification || n.observations,
    );
  const staleNotes = Object.values(fileNotes).filter(
    (n) =>
      !validPaths.has(n.path) &&
      (n.problem.trim() || n.modification.trim() || n.observations.trim()),
  );
  const needsReview =
    reviewedSignature !== null && scan?.changesSignature !== reviewedSignature;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    if (identityConflict) return;
    if (operationBlockReason) {
      setError(operationBlockReason);
      return;
    }
    if (!scan || !summary.trim()) {
      setError("Add a short revision summary.");
      return;
    }
    if (staleNotes.length) {
      setError("Review notes for paths no longer changed before saving.");
      return;
    }
    if (needsReview) {
      setError(
        "The file set changed. Review the updated list and confirm below.",
      );
      return;
    }
    setReviewedSignature(scan.changesSignature);
    try {
      await onCapture({
        summary: summary.trim(),
        notes,
        fileNotes: Object.values(fileNotes).filter(
          (n) =>
            n.problem.trim() || n.modification.trim() || n.observations.trim(),
        ),
        reviewedChangesSignature: scan.changesSignature,
        identityReview,
        referenceReview: effectiveReferences,
        referenceAttachments: attachments,
        onReferenceAttachmentsStored: review => {
          setReferenceReview(review);
          setAttachments([]);
        },
      });
      setSummary("");
      setNotes(emptyNotes);
      setFileNotes({});
      setNotePath(null);
      setReviewedSignature(null);
      setIdentityReview(undefined);
      setReferenceReview(undefined);
      setAttachments([]);
      setShowAttachments(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="page changes-page">
      <div className="page-heading">
        <div>
          <h1>
            Changes<span className="heading-dot">.</span>
          </h1>
          <p>What changed, and why it matters.</p>
        </div>
        <div className="project-heading-controls">
          <button
            className="button secondary"
            disabled={busy || !workingFolderName}
            onClick={onScan}
          >
            <RefreshCw size={16} />
            {isScanning ? "Scanning…" : "Scan for changes"}
          </button>
        </div>
      </div>
      <div className="scan-strip">
        <span>
          <strong>{workingFolderName ?? "No working folder connected"}</strong>
          {head
            ? " · Since " + formatRevisionNumber(head.manifest.displayNumber)
            : " · First revision"}
        </span>
        <span>
          {scan
            ? "Scanned " +
              formatTimestamp(scan.scannedAt) +
              (isScanStale
                ? " · May have changed since scan"
                : " · Latest scan")
            : "Scan needed"}
        </span>
      </div>
      {operationBlockReason ? <Notice>{operationBlockReason}</Notice> : null}
      {!workingFolderName ? (
        <Notice>
          Connect a working folder to scan and save revisions.{" "}
          <button className="text-button" onClick={onReattachWorkingFolder}>
            Connect folder
          </button>
        </Notice>
      ) : null}
      {damaged ? (
        <Notice type="error">
          Saving is blocked because the branch history needs attention. Open
          Settings → Troubleshooting.
        </Notice>
      ) : null}
      {scan?.errors.length ? (
        <Notice type="error">
          <strong>Some files could not be read. Saving is blocked.</strong>
          {scan.errors.map((e) => (
            <p key={e.path} className="file-path">
              {e.path}: {e.error}
            </p>
          ))}
          <button className="text-button" onClick={onScan}>
            Retry scan
          </button>
        </Notice>
      ) : null}
      {scan?.skippedSystemFiles?.length ? (
        <p className="muted small" data-testid="skipped-system-files">
          Skipped {scan.skippedSystemFiles.length} system{" "}
          {scan.skippedSystemFiles.length === 1 ? "file" : "files"}:{" "}
          {scan.skippedSystemFiles.slice(0, 3).join(", ")}
          {scan.skippedSystemFiles.length > 3
            ? ` +${scan.skippedSystemFiles.length - 3} more`
            : ""}
        </p>
      ) : null}
      {busy ? (
        <OperationProgress progress={progress} onCancel={onCancelOperation} />
      ) : null}
      {error ? <Notice type="error">{error}</Notice> : null}
      <ComponentIdentityControls state={vaultState} scan={scan} value={identityReview} onChange={setIdentityReview} busy={busy} />
      {identityConflict ? <Notice type="error">{identityConflict}{vaultState.components?.status === 'unavailable' && vaultState.components.enrollmentIncomplete && onEnableComponentTracking ? <> <button className="button secondary" type="button" disabled={busy} onClick={() => { setError(''); onEnableComponentTracking().catch(e => setError(e instanceof Error ? e.message : String(e))); }}>Retry component enrollment</button></> : null}</Notice> : null}
      {scan && !scan.hasChanges && referenceChanged ? <Notice>This revision saves updated references with the current project files.</Notice> : null}
      {referenceConflict ? <Notice type="error">{referenceConflict} <button className="text-button" type="button" disabled={busy} onClick={() => { if (scan && effectiveReferences) setReferenceReview(createReferenceReview(vaultState, scan, effectiveReferences.explicit)); setShowAttachments(true); }}>Review current references</button></Notice> : null}
      {needsReview ? (
        <Notice type="error">
          The latest scan differs from the file set you reviewed. Review the
          updated changes, then{" "}
          <button
            className="text-button"
            onClick={() => {
              setReviewedSignature(scan?.changesSignature ?? null);
              setError("");
            }}
          >
            confirm this file set
          </button>
          .
        </Notice>
      ) : null}
      {scan && !scan.hasChanges && !referenceChanged ? (
        <div className="calm-state">
          <span className="calm-check">✓</span>
          <div>
            <h2>
              No changes since{" "}
              {head
                ? formatRevisionNumber(head.manifest.displayNumber)
                : "the last scan"}
            </h2>
            <p>
              Your working folder matches the saved project state.
              {hasDraft ? " Your draft is kept below." : ""}
            </p>
          </div>
        </div>
      ) : null}
      <div className={scan || hasDraft ? "changes-layout" : ""}>
        <section className="changes-files panel">
          <div className="panel-heading">
            <h2>
              {scan
                ? `${changes.length} changed file${changes.length === 1 ? "" : "s"}`
                : "Ready when you are"}
            </h2>
            {scan ? (
              <div className="change-counts">
                <StatusBadge status={`Added ${scan.added.length - renames.length}`} />
                <StatusBadge status={`Modified ${scan.modified.length}`} />
                <StatusBadge status={`Deleted ${scan.deleted.length - renames.length}`} />
                {renames.length ? <StatusBadge status={`Renamed ${renames.length}`} /> : null}
              </div>
            ) : null}
          </div>
          {!scan ? (
            <div className="empty-state compact">
              <RefreshCw size={25} />
              <p>
                Save and close your CAD documents, then scan your working
                folder.
              </p>
            </div>
          ) : (
            <>
              <div className="change-table">
                {rows.map(({ file, status, from }) => (
                  <div className="change-row" key={file.path}>
                    <File size={18} />
                    <div className="change-path">
                      <strong className="file-path">{file.path}</strong>
                      {from ? <span className="file-path">Previously {from}</span> : null}
                      <span>
                        <StatusBadge status={status} /> {formatBytes(file.size)}
                      </span>
                    </div>
                    <div className="change-file-actions">
                      <FilePathActions
                        filePath={file.path}
                        resolve={resolveFilePath ? () => resolveFilePath(file.path) : undefined}
                        extraItems={
                          (status === "Modified" || status === "Unchanged") && canTreatAsNew(vaultState, scan) && !identityReview?.replacements.includes(file.path)
                            ? [{
                                label: "Treat as new component",
                                ariaLabel: `Treat as new component — ${file.path}`,
                                disabled: busy || identityReviewStale(vaultState, scan, identityReview),
                                onSelect: () => setTreatAsNewPath(file.path),
                              }]
                            : undefined
                        }
                      />
                      {status !== "Unchanged" ? (
                        <button
                          className="text-button note-action"
                          aria-label={`Add note for ${file.path}`}
                          onClick={() => {
                            setNotePath(file.path);
                            setFileNotes((prev) => ({
                              ...prev,
                              [file.path]: prev[file.path] ?? {
                                ...emptyNotes,
                                path: file.path,
                              },
                            }));
                          }}
                        >
                          <StickyNote size={15} />
                          {fileNotes[file.path] &&
                          [
                            fileNotes[file.path].problem,
                            fileNotes[file.path].modification,
                            fileNotes[file.path].observations,
                          ].some((v) => v.trim())
                            ? "Edit note"
                            : "Add note"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
              {scan.unchanged.length ? (
                <button
                  className="text-button unchanged-toggle"
                  aria-expanded={showUnchanged}
                  onClick={() => setShowUnchanged((v) => !v)}
                >
                  {showUnchanged ? "Hide" : "Show"} {scan.unchanged.length}{" "}
                  unchanged files
                </button>
              ) : null}
              {scan.addedDirectories.length + scan.deletedDirectories.length >
              0 ? (
                <details className="disclosure">
                  <summary>
                    Directory changes (
                    {scan.addedDirectories.length +
                      scan.deletedDirectories.length}
                    )
                  </summary>
                  {scan.addedDirectories.map((p) => (
                    <p key={"a" + p}>Added · {p}/</p>
                  ))}
                  {scan.deletedDirectories.map((p) => (
                    <p key={"d" + p}>Deleted · {p}/</p>
                  ))}
                </details>
              ) : null}
            </>
          )}
        </section>
        {scan || hasDraft ? (
          <form className="capture-form panel" onSubmit={submit}>
            <div className="panel-heading">
              <h2>Save revision</h2>
              <Save size={17} />
            </div>
            <div className="form-body">
              <p className="muted small">
                Saves the complete project state, with your notes and reference files.
              </p>
              <label className="field">
                <span>
                  Revision summary <span className="required">*</span>
                </span>
                <input
                  required
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  disabled={busy}
                  placeholder="e.g. Refine housing clearance"
                />
              </label>
              <button
                className="text-button"
                type="button"
                aria-expanded={showOverall}
                onClick={() => setShowOverall((v) => !v)}
              >
                {showOverall ? "− Hide" : "+ Add"} overall engineering notes
              </button>
              {showOverall ? (
                <NoteEditor
                  label="Description"
                  value={notes}
                  onChange={setNotes}
                  disabled={busy}
                  scope="Overall"
                />
              ) : null}
              <button className="text-button" type="button" disabled={busy} aria-expanded={showAttachments} onClick={() => { setShowAttachments(value => !value); if (!referenceReview && effectiveReferences) setReferenceReview(effectiveReferences); }}>
                {showAttachments ? '− Hide reference files' : '+ Attach reference files'}{attachments.length ? ` (${attachments.length})` : ''}
              </button>
              {showAttachments && scan && effectiveReferences ? <RevisionAttachments state={vaultState} scan={scan} identityReview={identityReview} review={effectiveReferences} onReview={setReferenceReview} attachments={attachments} onAttachments={setAttachments} busy={busy} needsAttention={Boolean(referenceConflict)} /> : null}
              {Object.keys(fileNotes).length ? (
                <div className="draft-file-notes">
                  <h3>File notes</h3>
                  {Object.keys(fileNotes).map((path) => (
                    <button
                      type="button"
                      className={
                        notePath === path ? "draft-note active" : "draft-note"
                      }
                      key={path}
                      onClick={() => setNotePath(path)}
                    >
                      <StickyNote size={14} />
                      <span className="file-path">{path}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {notePath && fileNotes[notePath] ? (
                <div className="file-note-editor">
                  <div className="section-heading">
                    <h3>Note applies to</h3>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => setNotePath(null)}
                    >
                      Close
                    </button>
                  </div>
                  <strong className="file-path">{notePath}</strong>
                  <NoteEditor
                    key={notePath}
                    label="Note"
                    value={fileNotes[notePath]}
                    onChange={(n) =>
                      setFileNotes((prev) => ({
                        ...prev,
                        [notePath]: { ...n, path: notePath },
                      }))
                    }
                    scope={notePath}
                    disabled={busy}
                  />
                  <button
                    className="text-button danger"
                    type="button"
                    onClick={() => {
                      setFileNotes((prev) => {
                        const next = { ...prev };
                        delete next[notePath];
                        return next;
                      });
                      setNotePath(null);
                    }}
                  >
                    Remove this draft note
                  </button>
                </div>
              ) : null}
              {staleNotes.length ? (
                <Notice type="error">
                  Draft notes refer to paths no longer in the changed file set.
                  Remove or revise these notes before saving.{" "}
                  {staleNotes.map((n) => (
                    <p className="file-path" key={n.path}>
                      {n.path}
                    </p>
                  ))}
                </Notice>
              ) : null}
              <p className="save-reminder">
                Save and close CAD documents before saving a revision. We scan
                again to verify the reviewed changes.
              </p>
              <button
                className="button primary save-button"
                disabled={
                  busy ||
                  !scan || Boolean(scan.errors.length) ||
                  (!scan.hasChanges && !identityReview?.replacements.length && !referenceChanged) ||
                  Boolean(damaged) ||
                  Boolean(operationBlockReason) ||
                  Boolean(identityConflict) ||
                  Boolean(referenceConflict) ||
                  needsReview ||
                  Boolean(staleNotes.length)
                }
              >
                <Save size={16} />
                {isCapturing ? "Saving revision…" : "Save revision"}
              </button>
            </div>
          </form>
        ) : null}
      </div>
      {treatAsNewPath && scan ? (
        <TreatAsNewDialog
          path={treatAsNewPath}
          busy={busy}
          onCancel={() => setTreatAsNewPath(null)}
          onConfirm={() => {
            try {
              setIdentityReview(createIdentityReview(vaultState, scan, identityReview?.renames ?? [], [...(identityReview?.replacements ?? []), treatAsNewPath]));
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
            setTreatAsNewPath(null);
          }}
        />
      ) : null}
    </div>
  );
}
