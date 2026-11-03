import type { ReactNode } from "react";
import { useEffect, useState } from "react";
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
import { NotesFields, Notice, OperationProgress, StatusBadge } from "./ui";
import { FilePathActions } from "./FilePathShortcuts";
import type { FilePathLocation } from "../utils/windows-path";
import type { IdentityReview } from '../engine/component-identity';
import { ComponentIdentityControls } from './ComponentIdentityControls';

export interface ChangesCaptureViewProps {
  onEnableComponentTracking?: () => Promise<void>;
  branchControl?: ReactNode;
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
  }) => Promise<void>;
  onCancelOperation: () => void;
  onReattachWorkingFolder: () => Promise<void>;
  operationBlockReason?: string;
  resolveFilePath?: (path: string) => Promise<FilePathLocation>;
}
export interface CaptureDraft {
  identityReview?: IdentityReview;
  summary: string;
  notes: RevisionNotes;
  fileNotes: Record<string, FileSpecificNote>;
  notePath: string | null;
  showOverall: boolean;
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
  branchControl,
  onEnableComponentTracking,
}: ChangesCaptureViewProps) {
  const savedDraft = draftKey ? draftCache?.get(draftKey) : undefined;
  const [summary, setSummary] = useState(savedDraft?.summary ?? "");
  const [identityReview, setIdentityReview] = useState<IdentityReview | undefined>(savedDraft?.identityReview);
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
      });
  }, [draftCache, draftKey, summary, notes, fileNotes, notePath, showOverall, identityReview]);
  const [showUnchanged, setShowUnchanged] = useState(false);
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
      });
      setSummary("");
      setNotes(emptyNotes);
      setFileNotes({});
      setNotePath(null);
      setReviewedSignature(null);
      setIdentityReview(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="page changes-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{vaultState.project.name}</p>
          <h1>
            Changes<span className="heading-dot">.</span>
          </h1>
          <p>What changed, and why it matters.</p>
        </div>
        <div className="project-heading-controls">
          {branchControl}
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
          Settings → Storage and verification.
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
      {busy ? (
        <OperationProgress progress={progress} onCancel={onCancelOperation} />
      ) : null}
      {error ? <Notice type="error">{error}</Notice> : null}
      <ComponentIdentityControls state={vaultState} scan={scan} value={identityReview} onChange={setIdentityReview} onEnable={onEnableComponentTracking} busy={busy} />
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
      {scan && !scan.hasChanges ? (
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
      <div className={scan?.hasChanges || hasDraft ? "changes-layout" : ""}>
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
                      {resolveFilePath ? (
                        <FilePathActions
                          filePath={file.path}
                          resolve={() => resolveFilePath(file.path)}
                        />
                      ) : null}
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
        {scan?.hasChanges || hasDraft ? (
          <form className="capture-form panel" onSubmit={submit}>
            <div className="panel-heading">
              <h2>Save revision</h2>
              <Save size={17} />
            </div>
            <div className="form-body">
              <p className="muted small">
                Saves the complete project state. File selections apply only to
                notes.
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
                <NotesFields
                  value={notes}
                  onChange={setNotes}
                  disabled={busy}
                  scope="Overall"
                />
              ) : null}
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
                  <NotesFields
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
                  (!scan.hasChanges && !identityReview?.replacements.length) ||
                  Boolean(damaged) ||
                  Boolean(operationBlockReason) ||
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
    </div>
  );
}
