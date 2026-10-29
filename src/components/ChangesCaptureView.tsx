import React, { useEffect, useMemo, useState } from 'react';
import {
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  FolderSync,
  Save,
  XCircle,
  Link2,
  FileText,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  FileSpecificNote,
  ProgressUpdate,
  ScanResult,
  VaultState,
} from '../engine/types';
import { formatRevisionNumber } from '../engine/vault-service';
import {
  formatBytes,
  formatTimestamp,
  getCadFileTypeLabel,
  shortHash,
} from '../utils/format';

export interface ChangesCaptureViewProps {
  vaultState: VaultState;
  activeBranchId: string;
  workingFolderName: string | null;
  vaultFolderName: string;
  scanResult: ScanResult | null;
  isScanStale: boolean;
  isScanning: boolean;
  isCapturing: boolean;
  progress: ProgressUpdate | null;
  statusBanner: { type: 'success' | 'error' | 'info'; message: string } | null;
  onScan: () => Promise<void>;
  onCapture: (params: {
    summary: string;
    notes: { problem: string; modification: string; observations: string };
    fileNotes: FileSpecificNote[];
    reviewedChangesSignature: string;
  }) => Promise<void>;
  onCancelOperation: () => void;
  onReattachWorkingFolder: () => Promise<void>;
}

type ChangeFilter = 'all' | 'added' | 'modified' | 'deleted' | 'unchanged';

export const ChangesCaptureView: React.FC<ChangesCaptureViewProps> = ({
  vaultState,
  activeBranchId,
  workingFolderName,
  vaultFolderName,
  scanResult,
  isScanStale,
  isScanning,
  isCapturing,
  progress,
  statusBanner,
  onScan,
  onCapture,
  onCancelOperation,
  onReattachWorkingFolder,
}) => {
  const [summary, setSummary] = useState('');
  const [problem, setProblem] = useState('');
  const [modification, setModification] = useState('');
  const [observations, setObservations] = useState('');

  // File-specific notes keyed by relative file path
  const [fileNotesMap, setFileNotesMap] = useState<Record<string, FileSpecificNote>>({});
  const [selectedNoteFilePath, setSelectedNoteFilePath] = useState<string>('');
  const [autoPreselectedSingleFile, setAutoPreselectedSingleFile] = useState<string | null>(null);

  const [filter, setFilter] = useState<ChangeFilter>('all');
  const [formError, setFormError] = useState<string | null>(null);

  const activeBranch =
    vaultState.branches.find((b) => b.branchId === activeBranchId) ?? vaultState.branches[0];
  const latestHeadRevId = vaultState.branchHeads[activeBranch.branchId] ?? null;
  const latestHeadRev = latestHeadRevId
    ? vaultState.revisions.find((r) => r.manifest.revisionId === latestHeadRevId) ?? null
    : null;
  const branchHeadDamagedMsg = vaultState.damagedBranchHeads[activeBranch.branchId] ?? null;

  // Compute all changed file entries from scanResult
  const changedFilesList = useMemo(() => {
    if (!scanResult) return [];
    const list: Array<{ path: string; changeType: 'Added' | 'Modified' | 'Deleted' }> = [];
    for (const f of scanResult.added) {
      list.push({ path: f.path, changeType: 'Added' });
    }
    for (const m of scanResult.modified) {
      list.push({ path: m.current.path, changeType: 'Modified' });
    }
    for (const d of scanResult.deleted) {
      list.push({ path: d.path, changeType: 'Deleted' });
    }
    list.sort((a, b) => a.path.localeCompare(b.path));
    return list;
  }, [scanResult]);

  // Preselect when exactly one file changed in the current scan
  useEffect(() => {
    if (!scanResult) {
      setAutoPreselectedSingleFile(null);
      setSelectedNoteFilePath('');
      return;
    }

    if (changedFilesList.length === 1) {
      const onlyFile = changedFilesList[0].path;
      setAutoPreselectedSingleFile(onlyFile);
      setSelectedNoteFilePath(onlyFile);
      setFileNotesMap((prev) => {
        if (prev[onlyFile]) return prev;
        return {
          ...prev,
          [onlyFile]: {
            path: onlyFile,
            problem: '',
            modification: '',
            observations: '',
          },
        };
      });
    } else {
      setAutoPreselectedSingleFile(null);
      if (
        selectedNoteFilePath &&
        !changedFilesList.some((c) => c.path === selectedNoteFilePath)
      ) {
        setSelectedNoteFilePath(changedFilesList[0]?.path ?? '');
      } else if (!selectedNoteFilePath && changedFilesList.length > 0) {
        setSelectedNoteFilePath(changedFilesList[0].path);
      }
    }
  }, [scanResult?.changesSignature, changedFilesList, selectedNoteFilePath]);

  const handleAddFileNoteSlot = (pathToAdd: string) => {
    if (!pathToAdd) return;
    setFileNotesMap((prev) => {
      if (prev[pathToAdd]) return prev;
      return {
        ...prev,
        [pathToAdd]: {
          path: pathToAdd,
          problem: '',
          modification: '',
          observations: '',
        },
      };
    });
  };

  const handleUpdateFileNote = (
    filePath: string,
    field: 'problem' | 'modification' | 'observations',
    value: string
  ) => {
    setFileNotesMap((prev) => ({
      ...prev,
      [filePath]: {
        path: filePath,
        problem: prev[filePath]?.problem ?? '',
        modification: prev[filePath]?.modification ?? '',
        observations: prev[filePath]?.observations ?? '',
        [field]: value,
      },
    }));
  };

  const handleRemoveFileNoteSlot = (filePath: string) => {
    setFileNotesMap((prev) => {
      const next = { ...prev };
      delete next[filePath];
      return next;
    });
    if (autoPreselectedSingleFile === filePath) {
      setAutoPreselectedSingleFile(null);
    }
  };

  const handleCaptureSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!summary.trim()) {
      setFormError('A short revision summary is required before saving a snapshot.');
      return;
    }
    if (!workingFolderName || !scanResult) {
      setFormError('Attach and scan a working folder before capturing a revision.');
      return;
    }

    const activeFileNotes = Object.values(fileNotesMap).filter(
      (n) =>
        n.path.trim() &&
        (n.problem.trim() || n.modification.trim() || n.observations.trim())
    );

    try {
      await onCapture({
        summary: summary.trim(),
        notes: {
          problem,
          modification,
          observations,
        },
        fileNotes: activeFileNotes,
        reviewedChangesSignature: scanResult.changesSignature,
      });
      setSummary('');
      setProblem('');
      setModification('');
      setObservations('');
      setFileNotesMap({});
    } catch {
      // Error surfaced via statusBanner
    }
  };

  // Build unified rows for the file table based on active filter
  const rows: Array<{
    status: 'added' | 'modified' | 'deleted' | 'unchanged';
    path: string;
    size: number;
    previousSize?: number;
    sha256: string;
    previousSha256?: string;
  }> = [];

  if (scanResult) {
    if (filter === 'all' || filter === 'added') {
      for (const f of scanResult.added) {
        rows.push({ status: 'added', path: f.path, size: f.size, sha256: f.sha256 });
      }
    }
    if (filter === 'all' || filter === 'modified') {
      for (const m of scanResult.modified) {
        rows.push({
          status: 'modified',
          path: m.current.path,
          size: m.current.size,
          previousSize: m.previous.size,
          sha256: m.current.sha256,
          previousSha256: m.previous.sha256,
        });
      }
    }
    if (filter === 'all' || filter === 'deleted') {
      for (const f of scanResult.deleted) {
        rows.push({ status: 'deleted', path: f.path, size: f.size, sha256: f.sha256 });
      }
    }
    if (filter === 'all' || filter === 'unchanged') {
      for (const f of scanResult.unchanged) {
        rows.push({ status: 'unchanged', path: f.path, size: f.size, sha256: f.sha256 });
      }
    }
  }

  const nextRevisionDisplayNumber =
    vaultState.revisions.reduce(
      (max, r) => Math.max(max, r.manifest.displayNumber, r.completion.displayNumber),
      0
    ) + 1;

  const activeFileNoteEntries = Object.values(fileNotesMap);

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-8">
      {/* Branch & Connected Folder Context Strip */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 font-mono tabular-nums">
            <span>Project: {vaultState.project.name}</span>
            <span aria-hidden="true">·</span>
            <span className="font-semibold text-slate-900">Branch: {activeBranch.name}</span>
            <span aria-hidden="true">·</span>
            <span>
              Latest Baseline:{' '}
              {latestHeadRev
                ? `${formatRevisionNumber(latestHeadRev.manifest.displayNumber)} (${shortHash(
                    latestHeadRev.manifest.revisionId,
                    10
                  )})`
                : 'None (Initial Baseline Capture)'}
            </span>
          </div>
          <h1 className="text-xl font-bold text-slate-900">
            Working Folder: {workingFolderName ?? 'Not Connected (Reattachment Required)'}
          </h1>
          <p className="text-xs text-slate-600">
            Vault: <span className="font-mono text-slate-800">{vaultFolderName}</span> · Save and
            close active CAD documents in SolidWorks before scanning or capturing a revision.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          {!workingFolderName ? (
            <button
              type="button"
              onClick={onReattachWorkingFolder}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap"
            >
              <Link2 className="w-4 h-4" />
              <span>Reattach Working Folder</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onScan}
                disabled={isScanning || isCapturing}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-900 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`} />
                <span>{isScanning ? 'Scanning SHA-256...' : 'Scan Working Folder'}</span>
              </button>
              <button
                type="button"
                onClick={onReattachWorkingFolder}
                disabled={isScanning || isCapturing}
                className="px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-md transition-colors whitespace-nowrap"
              >
                Change Working Folder
              </button>
            </>
          )}
        </div>
      </section>

      {/* Damaged Branch Head Warning */}
      {branchHeadDamagedMsg && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 rounded-lg p-4 text-xs text-red-900 flex items-start gap-3"
        >
          <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-semibold">Branch Head Integrity Blocked</p>
            <p className="leading-relaxed">{branchHeadDamagedMsg}</p>
          </div>
        </div>
      )}

      {/* Status / Error Banner */}
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
                ? 'Operation Blocked / Review Required'
                : statusBanner.type === 'success'
                ? 'Snapshot Published'
                : 'Workspace Status'}
            </p>
            <p className="leading-relaxed">{statusBanner.message}</p>
          </div>
        </div>
      )}

      {/* Active Operation Progress & Cancel Action */}
      {(isScanning || isCapturing) && progress && (
        <section
          aria-label="Operation progress"
          className="bg-white border border-slate-300 rounded-lg p-5 space-y-3"
        >
          <div className="flex items-center justify-between gap-4">
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
              <span>Cancel Operation</span>
            </button>
          </div>
        </section>
      )}

      {/* Main Split: Left = Scan Results Table, Right = Revision Capture Form */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left 7 columns: Scan Results & File Inventory */}
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                <FolderSync className="w-4 h-4 text-slate-700" />
                <span>Working Folder Comparison (SHA-256 Authoritative)</span>
              </h2>
              {scanResult ? (
                <p className="text-xs text-slate-500 font-mono tabular-nums">
                  Scanned: {formatTimestamp(scanResult.scannedAt)} ·{' '}
                  {isScanStale
                    ? 'Status: Potentially stale (re-validated automatically on save)'
                    : 'Status: Fresh scan completed (files remain mutable on disk)'}{' '}
                  · Total: {formatBytes(scanResult.totalBytes)}
                </p>
              ) : (
                <p className="text-xs text-slate-500">
                  Run a scan to compare the working folder with the latest saved revision on{' '}
                  {activeBranch.name}.
                </p>
              )}
            </div>
          </div>

          {scanResult && (
            <>
              {/* Unboxed Quantitative Summary Metrics */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 py-3 border-b border-slate-100 text-xs">
                <div>
                  <p className="text-slate-500">Added Files</p>
                  <p className="text-lg font-bold font-mono tabular-nums text-emerald-700">
                    +{scanResult.added.length}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">Modified Files</p>
                  <p className="text-lg font-bold font-mono tabular-nums text-amber-700">
                    ~{scanResult.modified.length}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">Deleted Files</p>
                  <p className="text-lg font-bold font-mono tabular-nums text-red-700">
                    -{scanResult.deleted.length}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">Unchanged Files</p>
                  <p className="text-lg font-bold font-mono tabular-nums text-slate-700">
                    {scanResult.unchanged.length}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500" title="Excludes the selected working folder root">
                    Subdirectories
                  </p>
                  <p className="text-lg font-bold font-mono tabular-nums text-slate-700">
                    {scanResult.directories.length}
                  </p>
                </div>
              </div>

              {/* Inaccessible / Unreadable File Errors */}
              {scanResult.errors.length > 0 && (
                <div
                  role="alert"
                  className="bg-red-50 border border-red-200 rounded-md p-4 space-y-2"
                >
                  <p className="text-xs font-semibold text-red-900">
                    Capture Blocked — {scanResult.errors.length} Inaccessible or Unsafe File(s)
                  </p>
                  <p className="text-xs text-red-800">
                    An unreadable file fails capture rather than disappearing from the snapshot.
                    Close open CAD files or resolve permissions and rescan:
                  </p>
                  <ul className="text-xs font-mono text-red-900 space-y-1">
                    {scanResult.errors.map((err, idx) => (
                      <li key={idx}>
                        {err.path}: {err.error}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Interactive Segmented Filter Controls */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div
                  role="group"
                  aria-label="Filter scanned files by change state"
                  className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
                >
                  {(
                    [
                      [
                        'all',
                        `All (${
                          scanResult.added.length +
                          scanResult.modified.length +
                          scanResult.deleted.length +
                          scanResult.unchanged.length
                        })`,
                      ],
                      ['added', `Added (${scanResult.added.length})`],
                      ['modified', `Modified (${scanResult.modified.length})`],
                      ['deleted', `Deleted (${scanResult.deleted.length})`],
                      ['unchanged', `Unchanged (${scanResult.unchanged.length})`],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setFilter(key)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        filter === key
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* High-Density Data Table */}
              <div className="overflow-x-auto border border-slate-200 rounded-md">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                      <th className="py-2.5 px-3 font-semibold">State</th>
                      <th className="py-2.5 px-3 font-semibold">Relative Path &amp; Type</th>
                      <th className="py-2.5 px-3 font-semibold text-right">Size</th>
                      <th className="py-2.5 px-3 font-semibold">SHA-256 Content Digest</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-6 text-center text-slate-500">
                          No files match the selected filter ({filter}).
                        </td>
                      </tr>
                    ) : (
                      rows.map((row) => (
                        <tr key={`${row.status}-${row.path}`} className="hover:bg-slate-50/80">
                          <td className="py-2.5 px-3 font-mono font-semibold whitespace-nowrap">
                            {row.status === 'added' && (
                              <span className="text-emerald-700">+ Added</span>
                            )}
                            {row.status === 'modified' && (
                              <span className="text-amber-700">~ Modified</span>
                            )}
                            {row.status === 'deleted' && (
                              <span className="text-red-700">- Deleted</span>
                            )}
                            {row.status === 'unchanged' && (
                              <span className="text-slate-500">= Unchanged</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3">
                            <p className="font-mono font-medium text-slate-900 break-all">
                              {row.path}
                            </p>
                            <p className="text-slate-500">{getCadFileTypeLabel(row.path)}</p>
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono tabular-nums whitespace-nowrap text-slate-700">
                            {row.status === 'modified' &&
                            row.previousSize !== undefined &&
                            row.previousSize !== row.size ? (
                              <span>
                                {formatBytes(row.previousSize)} → {formatBytes(row.size)}
                              </span>
                            ) : row.status === 'modified' && row.previousSize === row.size ? (
                              <span>{formatBytes(row.size)} (same size)</span>
                            ) : (
                              formatBytes(row.size)
                            )}
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums text-slate-600 whitespace-nowrap">
                            {row.status === 'modified' && row.previousSha256 ? (
                              <span>
                                {shortHash(row.previousSha256, 8)} → {shortHash(row.sha256, 8)}
                              </span>
                            ) : (
                              shortHash(row.sha256, 12)
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Preserved Directories Summary */}
              <div className="pt-2 text-xs text-slate-600 space-y-1">
                <p className="font-semibold text-slate-800">
                  Subdirectories in Snapshot ({scanResult.directories.length} total, excluding
                  project root; empty directories preserved):
                </p>
                <p className="font-mono text-slate-500 break-words">
                  {scanResult.directories.length > 0
                    ? scanResult.directories.join(' · ')
                    : '0 subdirectories (all files reside directly in the project root folder)'}
                </p>
              </div>
            </>
          )}
        </section>

        {/* Right 5 columns: Save Revision Snapshot Form (Overall + File-Specific Notes) */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-6 space-y-5">
          <div className="space-y-1 border-b border-slate-100 pb-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                <Save className="w-4 h-4 text-slate-700" />
                <span>Save Revision Snapshot</span>
              </h2>
              <span className="text-xs font-mono text-slate-500 tabular-nums">
                Next: {formatRevisionNumber(nextRevisionDisplayNumber)}
              </span>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              Captures a complete project snapshot on <strong>{activeBranch.name}</strong>. You can
              record overall project notes, file-specific notes for changed files, or both without
              repeating yourself.
            </p>
          </div>

          {formError && (
            <div
              role="alert"
              className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-800"
            >
              {formError}
            </div>
          )}

          {scanResult && !scanResult.hasChanges && scanResult.errors.length === 0 && (
            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md text-xs text-slate-700">
              No file or directory changes detected since{' '}
              {latestHeadRev
                ? formatRevisionNumber(latestHeadRev.manifest.displayNumber)
                : 'baseline'}
              . cAdtree treats no changes as a valid state and will not create an unnecessary
              revision.
            </div>
          )}

          <form onSubmit={handleCaptureSubmit} className="space-y-5">
            <div className="space-y-1.5">
              <label
                htmlFor="revision-summary"
                className="block text-xs font-semibold text-slate-800"
              >
                Milestone Summary (Required)
              </label>
              <input
                id="revision-summary"
                type="text"
                required
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="e.g. Added base extrusion to Part1"
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>

            {/* File-Specific Engineering Notes Section */}
            {scanResult && changedFilesList.length > 0 && (
              <div className="border-t border-b border-slate-100 py-4 space-y-4">
                <div className="space-y-1">
                  <h3 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-slate-700" />
                    <span>File-Specific Engineering Notes (Optional)</span>
                  </h3>
                  {changedFilesList.length === 1 ? (
                    <p className="text-xs text-slate-600">
                      Exactly one file changed (
                      <code className="font-mono font-semibold text-slate-900">
                        {changedFilesList[0].path}
                      </code>
                      ). Any file-specific notes entered below will be explicitly associated with
                      this file path.
                    </p>
                  ) : (
                    <p className="text-xs text-slate-600">
                      {changedFilesList.length} files changed in this scan. Choose which specific
                      file a note describes so explanations stay accurately linked to the right
                      part or drawing.
                    </p>
                  )}
                </div>

                {/* Selector to add a file note when multiple files changed (or if single file slot was removed) */}
                {(changedFilesList.length > 1 || activeFileNoteEntries.length === 0) && (
                  <div className="flex items-center gap-2">
                    <label htmlFor="select-affected-file" className="sr-only">
                      Select changed file for engineering note
                    </label>
                    <select
                      id="select-affected-file"
                      value={selectedNoteFilePath}
                      onChange={(e) => setSelectedNoteFilePath(e.target.value)}
                      className="flex-1 min-w-0 px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900"
                    >
                      {changedFilesList.map((cf) => (
                        <option key={cf.path} value={cf.path}>
                          [{cf.changeType}] {cf.path}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => handleAddFileNoteSlot(selectedNoteFilePath)}
                      disabled={!selectedNoteFilePath}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-slate-900 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Attach Note to File</span>
                    </button>
                  </div>
                )}

                {/* Active File Note Editors */}
                {activeFileNoteEntries.map((fn) => {
                  const changeMeta = changedFilesList.find((c) => c.path === fn.path);
                  return (
                    <div
                      key={fn.path}
                      className="pt-3 border-t border-slate-100 space-y-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-mono font-semibold text-slate-900 break-all">
                          File: {fn.path}{' '}
                          <span className="font-normal text-slate-500">
                            · {changeMeta ? changeMeta.changeType : 'Associated'}
                            {autoPreselectedSingleFile === fn.path ? ' · Preselected' : ''}
                          </span>
                        </p>
                        <button
                          type="button"
                          aria-label={`Remove file note for ${fn.path}`}
                          onClick={() => handleRemoveFileNoteSlot(fn.path)}
                          className="p-1 text-slate-400 hover:text-red-600 rounded transition-colors shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <div className="space-y-1">
                        <label
                          htmlFor={`file-problem-${fn.path}`}
                          className="block text-xs font-medium text-slate-700"
                        >
                          Reason / Problem for {fn.path}
                        </label>
                        <input
                          id={`file-problem-${fn.path}`}
                          type="text"
                          value={fn.problem}
                          onChange={(e) =>
                            handleUpdateFileNote(fn.path, 'problem', e.target.value)
                          }
                          placeholder="Why was this specific file modified, added, or removed?"
                          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900"
                        />
                      </div>

                      <div className="space-y-1">
                        <label
                          htmlFor={`file-modification-${fn.path}`}
                          className="block text-xs font-medium text-slate-700"
                        >
                          Modification / Solution for {fn.path}
                        </label>
                        <input
                          id={`file-modification-${fn.path}`}
                          type="text"
                          value={fn.modification}
                          onChange={(e) =>
                            handleUpdateFileNote(fn.path, 'modification', e.target.value)
                          }
                          placeholder="Feature, sketch, mate, or dimension changed in this file..."
                          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900"
                        />
                      </div>

                      <div className="space-y-1">
                        <label
                          htmlFor={`file-observations-${fn.path}`}
                          className="block text-xs font-medium text-slate-700"
                        >
                          Observations / Test Results for {fn.path}
                        </label>
                        <input
                          id={`file-observations-${fn.path}`}
                          type="text"
                          value={fn.observations}
                          onChange={(e) =>
                            handleUpdateFileNote(fn.path, 'observations', e.target.value)
                          }
                          placeholder="Fit check, mass change, or rebuild verification..."
                          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Overall Revision-Wide Engineering Notes */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-slate-800">
                Overall Revision Notes (Optional — applies across the whole snapshot)
              </p>

              <div className="space-y-1">
                <label
                  htmlFor="revision-problem"
                  className="block text-xs font-medium text-slate-700"
                >
                  Overall Engineering Problem / Context
                </label>
                <textarea
                  id="revision-problem"
                  rows={2}
                  value={problem}
                  onChange={(e) => setProblem(e.target.value)}
                  placeholder="Project-wide context or requirement (no need to repeat file-specific notes)"
                  className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="revision-modification"
                  className="block text-xs font-medium text-slate-700"
                >
                  Overall Modification / Solution
                </label>
                <textarea
                  id="revision-modification"
                  rows={2}
                  value={modification}
                  onChange={(e) => setModification(e.target.value)}
                  placeholder="Assembly-level changes or design summary..."
                  className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="revision-observations"
                  className="block text-xs font-medium text-slate-700"
                >
                  Overall Observations / Test Results
                </label>
                <textarea
                  id="revision-observations"
                  rows={2}
                  value={observations}
                  onChange={(e) => setObservations(e.target.value)}
                  placeholder="Overall prototype or simulation observations..."
                  className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={
                isCapturing ||
                isScanning ||
                !workingFolderName ||
                Boolean(branchHeadDamagedMsg) ||
                (scanResult !== null && !scanResult.canCapture)
              }
              className="w-full py-2.5 px-4 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap"
            >
              {isCapturing
                ? 'Validating & Publishing Snapshot...'
                : `Save Complete Snapshot as ${formatRevisionNumber(nextRevisionDisplayNumber)}`}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
};
