import React, { useEffect, useMemo, useState } from 'react';
import {
  History,
  FolderOutput,
  CheckCircle2,
  AlertTriangle,
  ShieldCheck,
  XCircle,
  ChevronDown,
  ChevronRight,
  ArrowUpRight,
  FileCheck,
} from 'lucide-react';
import {
  FileSpecificNote,
  ProgressUpdate,
  ReconstructedRevision,
  RestoreResult,
  VaultState,
} from '../engine/types';
import {
  computeRevisionDiff,
  formatRevisionNumber,
} from '../engine/vault-service';
import {
  formatBytes,
  formatTimestamp,
  getCadFileTypeLabel,
  shortHash,
} from '../utils/format';

export interface HistoryRecoveryViewProps {
  vaultState: VaultState;
  activeBranchId: string;
  isRestoring: boolean;
  progress: ProgressUpdate | null;
  lastRestoreReport: {
    result: RestoreResult;
  } | null;
  statusBanner: { type: 'success' | 'error' | 'info'; message: string } | null;
  onRestoreFullProject: (revisionId: string) => Promise<void>;
  onRestoreSelectedFiles: (revisionId: string, selectedPaths: string[]) => Promise<void>;
  onVerifySingleRevisionObjects: (revisionId: string) => Promise<void>;
  onCancelOperation: () => void;
}

export const HistoryRecoveryView: React.FC<HistoryRecoveryViewProps> = ({
  vaultState,
  activeBranchId,
  isRestoring,
  progress,
  lastRestoreReport,
  statusBanner,
  onRestoreFullProject,
  onRestoreSelectedFiles,
  onVerifySingleRevisionObjects,
  onCancelOperation,
}) => {
  const branchRevisions = useMemo(
    () =>
      [...vaultState.revisions]
        .filter((r) => r.manifest.branchId === activeBranchId)
        .sort((a, b) => b.manifest.displayNumber - a.manifest.displayNumber),
    [vaultState.revisions, activeBranchId]
  );

  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(
    branchRevisions[0]?.manifest.revisionId ?? null
  );
  const [selectedFilePaths, setSelectedFilePaths] = useState<Set<string>>(new Set());
  const [showUnchangedFiles, setShowUnchangedFiles] = useState<boolean>(false);
  const [pendingPreselectPath, setPendingPreselectPath] = useState<string | null>(null);

  const selectedRevision: ReconstructedRevision | null =
    branchRevisions.find((r) => r.manifest.revisionId === selectedRevisionId) ??
    branchRevisions[0] ??
    null;

  // Reset or apply pending preselection when switching selected revision
  useEffect(() => {
    if (!selectedRevision) {
      setSelectedFilePaths(new Set());
      return;
    }
    if (pendingPreselectPath) {
      const existsInRev = selectedRevision.manifest.files.some(
        (f) => f.path === pendingPreselectPath
      );
      if (existsInRev) {
        setSelectedFilePaths(new Set([pendingPreselectPath]));
        setShowUnchangedFiles(true);
      } else {
        setSelectedFilePaths(new Set());
      }
      setPendingPreselectPath(null);
    } else {
      setSelectedFilePaths(new Set());
      setShowUnchangedFiles(false);
    }
  }, [selectedRevision?.manifest.revisionId]);

  const selectedDiff = useMemo(() => {
    if (!selectedRevision) return null;
    return computeRevisionDiff(selectedRevision, vaultState);
  }, [selectedRevision, vaultState]);

  const parentRev = selectedRevision?.manifest.parentRevisionId
    ? vaultState.revisions.find(
        (r) => r.manifest.revisionId === selectedRevision.manifest.parentRevisionId
      ) ?? null
    : null;

  const fileNotesByPath = useMemo(() => {
    const map = new Map<string, FileSpecificNote>();
    if (selectedRevision?.manifest.fileNotes) {
      for (const fn of selectedRevision.manifest.fileNotes) {
        map.set(fn.path, fn);
      }
    }
    return map;
  }, [selectedRevision]);

  const toggleFileSelection = (filePath: string) => {
    setSelectedFilePaths((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  };

  const selectAllPresentChangedFiles = () => {
    if (!selectedDiff) return;
    const paths: string[] = [
      ...selectedDiff.added.map((f) => f.path),
      ...selectedDiff.modified.map((m) => m.current.path),
    ];
    setSelectedFilePaths(new Set(paths));
  };

  const selectAllSnapshotFiles = () => {
    if (!selectedRevision) return;
    setSelectedFilePaths(new Set(selectedRevision.manifest.files.map((f) => f.path)));
  };

  const clearSelection = () => {
    setSelectedFilePaths(new Set());
  };

  const handleNavigateToParentForDeletedFile = (parentRevisionId: string, deletedPath: string) => {
    setPendingPreselectPath(deletedPath);
    setSelectedRevisionId(parentRevisionId);
  };

  const formatTimelineChangeSummary = (rev: ReconstructedRevision): string => {
    const diff = computeRevisionDiff(rev, vaultState);
    if (diff.status === 'unavailable') {
      return 'Comparison unavailable';
    }
    if (diff.status === 'baseline') {
      return `Baseline: ${diff.added.length} captured file${diff.added.length === 1 ? '' : 's'}`;
    }
    const parts: string[] = [];
    if (diff.added.length > 0) {
      parts.push(`${diff.added.length} added`);
    }
    if (diff.modified.length > 0) {
      parts.push(`${diff.modified.length} modified`);
    }
    if (diff.deleted.length > 0) {
      parts.push(`${diff.deleted.length} deleted`);
    }
    parts.push(`${diff.unchanged.length} unchanged`);
    return parts.join(' · ');
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-8">
      {/* Header Context */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 font-mono tabular-nums">
            <span>Project: {vaultState.project.name}</span>
            <span aria-hidden="true">·</span>
            <span className="font-semibold text-slate-900">Branch: Main</span>
            <span aria-hidden="true">·</span>
            <span>Committed Revisions: {branchRevisions.length}</span>
          </div>
          <h1 className="text-xl font-bold text-slate-900">
            Revision History &amp; Verified Recovery
          </h1>
          <p className="text-xs text-slate-600">
            Inspect parent-relative file changes, file-specific and overall engineering notes, and
            restore either a full project snapshot or selected files as a verified copy into a fresh
            destination folder.
          </p>
        </div>
      </section>

      {/* Status Banner */}
      {statusBanner && (
        <div
          role="status"
          className={`rounded-lg p-4 border text-xs flex items-start gap-3 ${
            statusBanner.type === 'error'
              ? 'bg-red-50 border-red-200 text-red-900'
              : statusBanner.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-slate-100 border-slate-200 text-slate-800'
          }`}
        >
          {statusBanner.type === 'error' ? (
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
          )}
          <div className="space-y-1">
            <p className="font-semibold">
              {statusBanner.type === 'error'
                ? 'Recovery / Verification Error'
                : 'Recovery / Verification Update'}
            </p>
            <p className="leading-relaxed">{statusBanner.message}</p>
          </div>
        </div>
      )}

      {/* Restore Progress */}
      {isRestoring && progress && (
        <section className="bg-white border border-slate-300 rounded-lg p-5 flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <p className="text-xs font-semibold text-slate-900">{progress.message}</p>
            <p className="text-xs text-slate-500 font-mono tabular-nums">
              Phase: {progress.phase} · Files: {progress.processedFiles}/{progress.totalFiles} ·
              Bytes: {formatBytes(progress.processedBytes)} / {formatBytes(progress.totalBytes)}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancelOperation}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <XCircle className="w-3.5 h-3.5" />
            <span>Cancel Recovery</span>
          </button>
        </section>
      )}

      {/* Last Restore Verification Report */}
      {lastRestoreReport && (
        <section
          aria-label="Recovery verification report"
          className="bg-emerald-50/70 border border-emerald-200 rounded-lg p-5 space-y-2"
        >
          <div className="flex items-center gap-2 text-xs font-semibold text-emerald-950">
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
            <span>
              {lastRestoreReport.result.kind === 'selected_files'
                ? `Partial Project Recovery (Selected Files Copy) — ${formatRevisionNumber(
                    lastRestoreReport.result.displayNumber
                  )} restored to "${lastRestoreReport.result.destinationName}"`
                : `Verified Full Project Recovery — ${formatRevisionNumber(
                    lastRestoreReport.result.displayNumber
                  )} restored to "${lastRestoreReport.result.destinationName}"`}
            </span>
          </div>
          <p className="text-xs text-emerald-900 font-mono tabular-nums">
            Restored Files: {lastRestoreReport.result.restoredFilesCount} · Necessary Directories
            Created: {lastRestoreReport.result.restoredDirectoriesCount} · Verified Bytes:{' '}
            {formatBytes(lastRestoreReport.result.verifiedBytes)} · Completed:{' '}
            {formatTimestamp(lastRestoreReport.result.completedAt)}
          </p>
          {lastRestoreReport.result.kind === 'selected_files' &&
            lastRestoreReport.result.selectedPaths && (
              <div className="space-y-1 pt-1 text-xs text-emerald-950">
                <p className="font-semibold">
                  Recovered Selected File Paths ({lastRestoreReport.result.selectedPaths.length}):
                </p>
                <p className="font-mono text-emerald-900 break-all">
                  {lastRestoreReport.result.selectedPaths.join(' · ')}
                </p>
                <p className="text-emerald-800">
                  Note: This destination contains only the selected file(s), not a complete project
                  snapshot or dependency-complete CAD assembly. Your active working folder was not
                  modified.
                </p>
              </div>
            )}
        </section>
      )}

      {branchRevisions.length === 0 ? (
        <section className="bg-white border border-slate-200 rounded-lg p-10 text-center space-y-2">
          <History className="w-6 h-6 text-slate-400 mx-auto" />
          <h2 className="text-base font-semibold text-slate-900">No Committed Revisions Yet</h2>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            Switch to the Changes &amp; Capture view, scan your working folder, and save your first
            project snapshot (Rev 001).
          </p>
        </section>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Left 4 columns: Revision Timeline List */}
          <section
            aria-label="Revision timeline"
            className="lg:col-span-4 bg-white border border-slate-200 rounded-lg divide-y divide-slate-100"
          >
            <div className="p-4">
              <h2 className="text-sm font-semibold text-slate-900">
                Main Branch Timeline ({branchRevisions.length})
              </h2>
              <p className="text-xs text-slate-500">
                Each revision is compared with its recorded parent revision
              </p>
            </div>

            {branchRevisions.map((rev) => {
              const isSelected =
                selectedRevision?.manifest.revisionId === rev.manifest.revisionId;
              const totalBytes = rev.manifest.files.reduce((sum, f) => sum + f.size, 0);
              const changeSummaryText = formatTimelineChangeSummary(rev);

              return (
                <button
                  key={rev.manifest.revisionId}
                  type="button"
                  onClick={() => setSelectedRevisionId(rev.manifest.revisionId)}
                  className={`w-full text-left p-4 transition-colors space-y-1.5 ${
                    isSelected ? 'bg-slate-900 text-white' : 'hover:bg-slate-50 text-slate-900'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 font-mono text-xs tabular-nums">
                    <span className="font-bold">
                      {formatRevisionNumber(rev.manifest.displayNumber)}
                    </span>
                    <span className={isSelected ? 'text-slate-300' : 'text-slate-500'}>
                      {formatTimestamp(rev.manifest.captureCompletedAt)}
                    </span>
                  </div>
                  <p
                    className={`text-xs font-semibold line-clamp-2 ${
                      isSelected ? 'text-white' : 'text-slate-900'
                    }`}
                  >
                    {rev.manifest.summary}
                  </p>
                  <p
                    className={`text-xs font-mono tabular-nums ${
                      isSelected ? 'text-emerald-300' : 'text-slate-700'
                    }`}
                  >
                    {changeSummaryText}
                  </p>
                  <p
                    className={`text-xs font-mono tabular-nums ${
                      isSelected ? 'text-slate-300' : 'text-slate-500'
                    }`}
                  >
                    Snapshot: {rev.manifest.files.length} files · {rev.manifest.directories.length}{' '}
                    subdirs · {formatBytes(totalBytes)} ·{' '}
                    {rev.integrityStatus === 'corrupted'
                      ? 'DAMAGED'
                      : rev.integrityStatus === 'objects_verified'
                      ? 'Objects Verified'
                      : 'Manifest Verified'}
                  </p>
                </button>
              );
            })}
          </section>

          {/* Right 8 columns: Selected Revision Details, Parent Diff, File Notes & Recovery */}
          {selectedRevision && selectedDiff && (
            <section className="lg:col-span-8 bg-white border border-slate-200 rounded-lg p-6 space-y-6">
              {/* Top Revision Metadata Header */}
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 border-b border-slate-100 pb-5">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-slate-500 tabular-nums">
                    <span className="font-bold text-slate-900">
                      {formatRevisionNumber(selectedRevision.manifest.displayNumber)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>ID: {selectedRevision.manifest.revisionId}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Parent:{' '}
                      {parentRev ? (
                        <button
                          type="button"
                          onClick={() => setSelectedRevisionId(parentRev.manifest.revisionId)}
                          className="underline hover:text-slate-900 font-semibold"
                        >
                          {formatRevisionNumber(parentRev.manifest.displayNumber)}
                        </button>
                      ) : selectedRevision.manifest.parentRevisionId ? (
                        selectedRevision.manifest.parentRevisionId
                      ) : (
                        'None (Initial Baseline)'
                      )}
                    </span>
                  </div>
                  <h2 className="text-lg font-bold text-slate-900 text-balance">
                    {selectedRevision.manifest.summary}
                  </h2>
                  <p className="text-xs text-slate-500 font-mono tabular-nums">
                    Captured: {formatTimestamp(selectedRevision.manifest.captureCompletedAt)} ·
                    Manifest SHA-256: {shortHash(selectedRevision.completion.manifestSha256, 16)} ·
                    Integrity:{' '}
                    {selectedRevision.integrityStatus === 'corrupted'
                      ? 'Corrupted / Blocked'
                      : selectedRevision.integrityStatus === 'objects_verified'
                      ? 'All Stored Objects Byte-Verified'
                      : 'Manifest Checksum Verified (Objects verified on demand/restore)'}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() =>
                      onVerifySingleRevisionObjects(selectedRevision.manifest.revisionId)
                    }
                    disabled={isRestoring}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap"
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>Verify Objects in Vault</span>
                  </button>
                </div>
              </div>

              {/* Damaged Revision Alert */}
              {selectedRevision.integrityStatus === 'corrupted' && (
                <div
                  role="alert"
                  className="bg-red-50 border border-red-200 rounded-md p-4 space-y-1 text-xs text-red-900"
                >
                  <p className="font-semibold">
                    Damaged Revision — Restoration Blocked for Safety
                  </p>
                  <ul className="list-disc pl-4 space-y-0.5 font-mono">
                    {selectedRevision.integrityErrors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Parent-Relative Change Counts Strip */}
              <div className="border-b border-slate-100 pb-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-slate-900">
                    {selectedDiff.status === 'baseline'
                      ? 'Initial Baseline Snapshot Summary'
                      : selectedDiff.status === 'compared'
                      ? `Changes Compared with Parent (${
                          selectedDiff.parentDisplayNumber
                            ? formatRevisionNumber(selectedDiff.parentDisplayNumber)
                            : selectedDiff.parentRevisionId
                        })`
                      : 'Parent Comparison Status'}
                  </h3>
                  <span className="text-xs font-mono text-slate-500 tabular-nums">
                    Snapshot Total: {selectedRevision.manifest.files.length} files ·{' '}
                    {selectedRevision.manifest.directories.length} subdirectories (root excluded)
                  </span>
                </div>

                {selectedDiff.status === 'unavailable' ? (
                  <div
                    role="alert"
                    className="p-3.5 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-900"
                  >
                    {selectedDiff.unavailableReason}
                  </div>
                ) : selectedDiff.status === 'baseline' ? (
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 text-xs">
                    <div>
                      <p className="text-slate-500">Baseline Files</p>
                      <p className="text-base font-bold font-mono tabular-nums text-emerald-700">
                        {selectedDiff.added.length}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500">Modified Files</p>
                      <p className="text-base font-bold font-mono tabular-nums text-slate-400">
                        0
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500">Deleted Files</p>
                      <p className="text-base font-bold font-mono tabular-nums text-slate-400">
                        0
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500">Unchanged Files</p>
                      <p className="text-base font-bold font-mono tabular-nums text-slate-400">
                        0
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500">Subdirectories</p>
                      <p className="text-base font-bold font-mono tabular-nums text-slate-700">
                        {selectedRevision.manifest.directories.length}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 text-xs">
                    <div>
                      <p className="text-slate-500">Added Files</p>
                      <p className="text-base font-bold font-mono tabular-nums text-emerald-700">
                        +{selectedDiff.added.length}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500">Modified Files</p>
                      <p className="text-base font-bold font-mono tabular-nums text-amber-700">
                        ~{selectedDiff.modified.length}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500">Deleted Files</p>
                      <p className="text-base font-bold font-mono tabular-nums text-red-700">
                        -{selectedDiff.deleted.length}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500">Unchanged Files</p>
                      <p className="text-base font-bold font-mono tabular-nums text-slate-700">
                        {selectedDiff.unchanged.length}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500">Subdirectories</p>
                      <p className="text-base font-bold font-mono tabular-nums text-slate-700">
                        {selectedRevision.manifest.directories.length}
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Recovery Actions Section (Full Project vs Selected Files Copy) */}
              <div className="border-b border-slate-100 pb-5 space-y-3">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <h3 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5 whitespace-nowrap">
                      <FolderOutput className="w-4 h-4 text-slate-700 shrink-0" />
                      <span>
                        Recover from {formatRevisionNumber(selectedRevision.manifest.displayNumber)}{' '}
                        Into a Fresh Folder
                      </span>
                    </h3>
                    <p className="text-xs text-slate-600 max-w-xl">
                      Recover either the complete project snapshot or only the files checked below
                      into an empty destination folder. Neither action modifies your active working
                      folder or creates a new revision.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={
                        isRestoring ||
                        selectedRevision.integrityStatus === 'corrupted' ||
                        selectedFilePaths.size === 0
                      }
                      onClick={() =>
                        onRestoreSelectedFiles(
                          selectedRevision.manifest.revisionId,
                          Array.from(selectedFilePaths)
                        )
                      }
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-900 bg-white border border-slate-900 hover:bg-slate-50 disabled:opacity-40 rounded-md transition-colors whitespace-nowrap"
                    >
                      <FileCheck className="w-3.5 h-3.5" />
                      <span>
                        Restore selected files as a copy ({selectedFilePaths.size})
                      </span>
                    </button>

                    <button
                      type="button"
                      disabled={
                        isRestoring || selectedRevision.integrityStatus === 'corrupted'
                      }
                      onClick={() =>
                        onRestoreFullProject(selectedRevision.manifest.revisionId)
                      }
                      className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap"
                    >
                      {isRestoring ? 'Restoring & Verifying...' : 'Restore Full Project Copy'}
                    </button>
                  </div>
                </div>
              </div>

              {/* Overall Revision-Wide Engineering Notes */}
              <div className="border-b border-slate-100 pb-5 space-y-3 text-xs">
                <h3 className="font-semibold text-slate-900">
                  Overall Revision Notes
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <p className="font-semibold text-slate-700">Engineering Problem</p>
                    <p className="text-slate-600 leading-relaxed whitespace-pre-wrap">
                      {selectedRevision.manifest.notes.problem || 'None recorded'}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="font-semibold text-slate-700">Modification / Solution</p>
                    <p className="text-slate-600 leading-relaxed whitespace-pre-wrap">
                      {selectedRevision.manifest.notes.modification || 'None recorded'}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="font-semibold text-slate-700">Observations / Test Results</p>
                    <p className="text-slate-600 leading-relaxed whitespace-pre-wrap">
                      {selectedRevision.manifest.notes.observations || 'None recorded'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Explicitly Recorded File-Specific Notes (if any) */}
              {selectedRevision.manifest.fileNotes &&
                selectedRevision.manifest.fileNotes.length > 0 && (
                  <div className="border-b border-slate-100 pb-5 space-y-3 text-xs">
                    <h3 className="font-semibold text-slate-900">
                      File-Specific Engineering Notes ({selectedRevision.manifest.fileNotes.length})
                    </h3>
                    <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
                      {selectedRevision.manifest.fileNotes.map((fn) => (
                        <div key={fn.path} className="p-3.5 space-y-2">
                          <p className="font-mono font-semibold text-slate-900 break-all">
                            Affected File: {fn.path}
                          </p>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                            <div>
                              <p className="font-medium text-slate-700">Reason / Problem</p>
                              <p className="text-slate-600 whitespace-pre-wrap">
                                {fn.problem || '—'}
                              </p>
                            </div>
                            <div>
                              <p className="font-medium text-slate-700">Modification / Solution</p>
                              <p className="text-slate-600 whitespace-pre-wrap">
                                {fn.modification || '—'}
                              </p>
                            </div>
                            <div>
                              <p className="font-medium text-slate-700">
                                Observations / Test Results
                              </p>
                              <p className="text-slate-600 whitespace-pre-wrap">
                                {fn.observations || '—'}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              {/* Changed Files & Complete Snapshot Inventory with Selection Controls */}
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <h3 className="text-xs font-semibold text-slate-900">
                      {selectedDiff.status === 'baseline'
                        ? `Baseline Captured Files (${selectedDiff.added.length})`
                        : selectedDiff.status === 'compared'
                        ? `Changed Files in ${formatRevisionNumber(
                            selectedRevision.manifest.displayNumber
                          )} (${
                            selectedDiff.added.length +
                            selectedDiff.modified.length +
                            selectedDiff.deleted.length
                          })`
                        : `Snapshot File Inventory (${selectedRevision.manifest.files.length})`}
                    </h3>
                    <p className="text-xs text-slate-500">
                      Select one or more files below to use &ldquo;Restore selected files as a
                      copy&rdquo;.
                    </p>
                  </div>

                  {/* Quick Selection Controls */}
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {selectedDiff.status !== 'unavailable' &&
                      selectedDiff.added.length + selectedDiff.modified.length > 0 && (
                        <button
                          type="button"
                          onClick={selectAllPresentChangedFiles}
                          className="px-2.5 py-1 font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded transition-colors whitespace-nowrap"
                        >
                          Select Changed Files (
                          {selectedDiff.added.length + selectedDiff.modified.length})
                        </button>
                      )}
                    <button
                      type="button"
                      onClick={selectAllSnapshotFiles}
                      className="px-2.5 py-1 font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded transition-colors whitespace-nowrap"
                    >
                      Select All in Snapshot ({selectedRevision.manifest.files.length})
                    </button>
                    {selectedFilePaths.size > 0 && (
                      <button
                        type="button"
                        onClick={clearSelection}
                        className="px-2.5 py-1 font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded transition-colors whitespace-nowrap"
                      >
                        Clear Selection ({selectedFilePaths.size})
                      </button>
                    )}
                  </div>
                </div>

                {/* Prominent Changed / Baseline Files Table */}
                {selectedDiff.status !== 'unavailable' && (
                  <div className="overflow-x-auto border border-slate-200 rounded-md">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                          <th className="py-2 px-3 w-8">Select</th>
                          <th className="py-2 px-3 font-semibold">Change Status</th>
                          <th className="py-2 px-3 font-semibold">
                            Relative Path, Type &amp; File Note
                          </th>
                          <th className="py-2 px-3 font-semibold text-right">Size</th>
                          <th className="py-2 px-3 font-semibold">SHA-256 Digest</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {/* Added / Baseline Files */}
                        {selectedDiff.added.map((file) => {
                          const isChecked = selectedFilePaths.has(file.path);
                          const fNote = fileNotesByPath.get(file.path);
                          return (
                            <tr key={`added-${file.path}`} className="hover:bg-slate-50/80">
                              <td className="py-2.5 px-3">
                                <input
                                  type="checkbox"
                                  aria-label={`Select ${file.path} for recovery`}
                                  checked={isChecked}
                                  onChange={() => toggleFileSelection(file.path)}
                                  className="rounded border-slate-300"
                                />
                              </td>
                              <td className="py-2.5 px-3 font-mono font-semibold text-emerald-700 whitespace-nowrap">
                                {selectedDiff.status === 'baseline' ? 'Baseline' : '+ Added'}
                              </td>
                              <td className="py-2.5 px-3 space-y-1">
                                <p className="font-mono font-semibold text-slate-900 break-all">
                                  {file.path}
                                </p>
                                <p className="text-slate-500">{getCadFileTypeLabel(file.path)}</p>
                                {fNote && (
                                  <div className="pt-1 text-slate-700 space-y-0.5 border-t border-slate-100">
                                    {fNote.problem && (
                                      <p>
                                        <span className="font-semibold">Reason:</span>{' '}
                                        {fNote.problem}
                                      </p>
                                    )}
                                    {fNote.modification && (
                                      <p>
                                        <span className="font-semibold">Modification:</span>{' '}
                                        {fNote.modification}
                                      </p>
                                    )}
                                    {fNote.observations && (
                                      <p>
                                        <span className="font-semibold">Observations:</span>{' '}
                                        {fNote.observations}
                                      </p>
                                    )}
                                  </div>
                                )}
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                                {formatBytes(file.size)}
                              </td>
                              <td className="py-2.5 px-3 font-mono tabular-nums text-slate-600 whitespace-nowrap">
                                {shortHash(file.sha256, 14)}
                              </td>
                            </tr>
                          );
                        })}

                        {/* Modified Files */}
                        {selectedDiff.modified.map((mod) => {
                          const isChecked = selectedFilePaths.has(mod.current.path);
                          const fNote = fileNotesByPath.get(mod.current.path);
                          return (
                            <tr key={`mod-${mod.current.path}`} className="hover:bg-slate-50/80">
                              <td className="py-2.5 px-3">
                                <input
                                  type="checkbox"
                                  aria-label={`Select ${mod.current.path} for recovery`}
                                  checked={isChecked}
                                  onChange={() => toggleFileSelection(mod.current.path)}
                                  className="rounded border-slate-300"
                                />
                              </td>
                              <td className="py-2.5 px-3 font-mono font-semibold text-amber-700 whitespace-nowrap">
                                ~ Modified
                              </td>
                              <td className="py-2.5 px-3 space-y-1">
                                <p className="font-mono font-semibold text-slate-900 break-all">
                                  {mod.current.path}
                                </p>
                                <p className="text-slate-500">
                                  {getCadFileTypeLabel(mod.current.path)}
                                </p>
                                {fNote && (
                                  <div className="pt-1 text-slate-700 space-y-0.5 border-t border-slate-100">
                                    {fNote.problem && (
                                      <p>
                                        <span className="font-semibold">Reason:</span>{' '}
                                        {fNote.problem}
                                      </p>
                                    )}
                                    {fNote.modification && (
                                      <p>
                                        <span className="font-semibold">Modification:</span>{' '}
                                        {fNote.modification}
                                      </p>
                                    )}
                                    {fNote.observations && (
                                      <p>
                                        <span className="font-semibold">Observations:</span>{' '}
                                        {fNote.observations}
                                      </p>
                                    )}
                                  </div>
                                )}
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                                {mod.previous.size !== mod.current.size
                                  ? `${formatBytes(mod.previous.size)} → ${formatBytes(
                                      mod.current.size
                                    )}`
                                  : `${formatBytes(mod.current.size)} (same size)`}
                              </td>
                              <td className="py-2.5 px-3 font-mono tabular-nums text-slate-600 whitespace-nowrap">
                                {shortHash(mod.previous.sha256, 8)} →{' '}
                                {shortHash(mod.current.sha256, 8)}
                              </td>
                            </tr>
                          );
                        })}

                        {/* Deleted Files (From Parent Manifest — offer direct navigation to Parent to recover) */}
                        {selectedDiff.deleted.map((del) => {
                          const fNote = fileNotesByPath.get(del.path);
                          return (
                            <tr
                              key={`del-${del.path}`}
                              className="bg-red-50/30 hover:bg-red-50/60"
                            >
                              <td className="py-2.5 px-3 text-center text-slate-400 font-mono">
                                —
                              </td>
                              <td className="py-2.5 px-3 font-mono font-semibold text-red-700 whitespace-nowrap">
                                - Deleted
                              </td>
                              <td className="py-2.5 px-3 space-y-1.5">
                                <p className="font-mono font-semibold text-slate-900 break-all">
                                  {del.path}
                                </p>
                                <p className="text-slate-500">
                                  Removed in this revision (was {formatBytes(del.size)} in parent)
                                </p>
                                {fNote && (
                                  <div className="pt-1 text-slate-700 space-y-0.5 border-t border-red-100">
                                    {fNote.problem && (
                                      <p>
                                        <span className="font-semibold">Reason:</span>{' '}
                                        {fNote.problem}
                                      </p>
                                    )}
                                    {fNote.modification && (
                                      <p>
                                        <span className="font-semibold">Modification:</span>{' '}
                                        {fNote.modification}
                                      </p>
                                    )}
                                    {fNote.observations && (
                                      <p>
                                        <span className="font-semibold">Observations:</span>{' '}
                                        {fNote.observations}
                                      </p>
                                    )}
                                  </div>
                                )}
                                {selectedDiff.parentRevisionId && (
                                  <div>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleNavigateToParentForDeletedFile(
                                          selectedDiff.parentRevisionId!,
                                          del.path
                                        )
                                      }
                                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-slate-900 bg-white border border-slate-300 hover:bg-slate-100 rounded transition-colors whitespace-nowrap"
                                    >
                                      <span>
                                        Open Parent (
                                        {selectedDiff.parentDisplayNumber
                                          ? formatRevisionNumber(selectedDiff.parentDisplayNumber)
                                          : 'Parent'}
                                        ) &amp; Select to Recover
                                      </span>
                                      <ArrowUpRight className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                )}
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-500 whitespace-nowrap">
                                {formatBytes(del.size)}
                              </td>
                              <td className="py-2.5 px-3 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                                {shortHash(del.sha256, 14)}
                              </td>
                            </tr>
                          );
                        })}

                        {selectedDiff.added.length === 0 &&
                          selectedDiff.modified.length === 0 &&
                          selectedDiff.deleted.length === 0 && (
                            <tr>
                              <td colSpan={5} className="py-4 px-3 text-center text-slate-500">
                                Only directory structure changed in this revision (0 file content
                                changes).
                              </td>
                            </tr>
                          )}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Collapsible Unchanged Files Section (or Full Inventory when parent comparison is unavailable) */}
                {(selectedDiff.status === 'unavailable' ||
                  selectedDiff.unchanged.length > 0) && (
                  <div className="space-y-2 pt-2">
                    {selectedDiff.status !== 'unavailable' && (
                      <button
                        type="button"
                        aria-expanded={showUnchangedFiles}
                        onClick={() => setShowUnchangedFiles((prev) => !prev)}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 hover:text-slate-900 py-1"
                      >
                        {showUnchangedFiles ? (
                          <ChevronDown className="w-4 h-4" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                        <span>
                          {showUnchangedFiles
                            ? `Hide ${selectedDiff.unchanged.length} Unchanged File${
                                selectedDiff.unchanged.length === 1 ? '' : 's'
                              } in Complete Snapshot`
                            : `Show ${selectedDiff.unchanged.length} Unchanged File${
                                selectedDiff.unchanged.length === 1 ? '' : 's'
                              } in Complete Snapshot (Available for Selection & Recovery)`}
                        </span>
                      </button>
                    )}

                    {(showUnchangedFiles || selectedDiff.status === 'unavailable') && (
                      <div className="overflow-x-auto border border-slate-200 rounded-md">
                        <table className="w-full text-left border-collapse text-xs">
                          <thead>
                            <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                              <th className="py-2 px-3 w-8">Select</th>
                              <th className="py-2 px-3 font-semibold">State</th>
                              <th className="py-2 px-3 font-semibold">Relative Path &amp; Type</th>
                              <th className="py-2 px-3 font-semibold text-right">Size</th>
                              <th className="py-2 px-3 font-semibold">SHA-256 Digest</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {(selectedDiff.status === 'unavailable'
                              ? selectedRevision.manifest.files
                              : selectedDiff.unchanged
                            ).map((file) => {
                              const isChecked = selectedFilePaths.has(file.path);
                              return (
                                <tr key={`unchanged-${file.path}`} className="hover:bg-slate-50/80">
                                  <td className="py-2 px-3">
                                    <input
                                      type="checkbox"
                                      aria-label={`Select ${file.path} for recovery`}
                                      checked={isChecked}
                                      onChange={() => toggleFileSelection(file.path)}
                                      className="rounded border-slate-300"
                                    />
                                  </td>
                                  <td className="py-2 px-3 font-mono text-slate-500 whitespace-nowrap">
                                    {selectedDiff.status === 'unavailable'
                                      ? 'Snapshot'
                                      : '= Unchanged'}
                                  </td>
                                  <td className="py-2 px-3">
                                    <p className="font-mono font-medium text-slate-900 break-all">
                                      {file.path}
                                    </p>
                                    <p className="text-slate-500">
                                      {getCadFileTypeLabel(file.path)}
                                    </p>
                                  </td>
                                  <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                                    {formatBytes(file.size)}
                                  </td>
                                  <td className="py-2 px-3 font-mono tabular-nums text-slate-600 whitespace-nowrap">
                                    {shortHash(file.sha256, 14)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {/* Recorded Subdirectories Summary */}
                <div className="pt-2 text-xs text-slate-600 space-y-1 border-t border-slate-100">
                  <p className="font-semibold text-slate-800">
                    Recorded Subdirectories in Snapshot (
                    {selectedRevision.manifest.directories.length} total, excluding project root):
                  </p>
                  <p className="font-mono text-slate-500 break-words">
                    {selectedRevision.manifest.directories.length > 0
                      ? selectedRevision.manifest.directories.join(' · ')
                      : '0 subdirectories (all files reside directly in the project root folder)'}
                  </p>
                </div>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
};
