import React, { useState } from 'react';
import {
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  FolderSync,
  Save,
  XCircle,
  FlaskConical,
  Link2,
} from 'lucide-react';
import {
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
  adapterMode: 'real' | 'memory';
  scanResult: ScanResult | null;
  isScanStale: boolean;
  isScanning: boolean;
  isCapturing: boolean;
  progress: ProgressUpdate | null;
  statusBanner: { type: 'success' | 'error' | 'info'; message: string } | null;
  onScan: () => Promise<void>;
  onCapture: (summary: string, notes: { problem: string; modification: string; observations: string }) => Promise<void>;
  onCancelOperation: () => void;
  onReattachWorkingFolder: () => Promise<void>;
  // Fixture lab mutation helpers (only shown when adapterMode === 'memory')
  onApplyFixtureBMutations?: () => Promise<void>;
  onSimulateUnreadableFile?: () => Promise<void>;
}

type ChangeFilter = 'all' | 'added' | 'modified' | 'deleted' | 'unchanged';

export const ChangesCaptureView: React.FC<ChangesCaptureViewProps> = ({
  vaultState,
  activeBranchId,
  workingFolderName,
  vaultFolderName,
  adapterMode,
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
  onApplyFixtureBMutations,
  onSimulateUnreadableFile,
}) => {
  const [summary, setSummary] = useState('');
  const [problem, setProblem] = useState('');
  const [modification, setModification] = useState('');
  const [observations, setObservations] = useState('');
  const [filter, setFilter] = useState<ChangeFilter>('all');
  const [formError, setFormError] = useState<string | null>(null);

  const activeBranch =
    vaultState.branches.find((b) => b.branchId === activeBranchId) ?? vaultState.branches[0];
  const latestHeadRevId = vaultState.branchHeads[activeBranch.branchId] ?? null;
  const latestHeadRev = latestHeadRevId
    ? vaultState.revisions.find((r) => r.manifest.revisionId === latestHeadRevId) ?? null
    : null;

  const handleCaptureSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!summary.trim()) {
      setFormError('A short revision summary is required before saving a snapshot.');
      return;
    }
    if (!workingFolderName) {
      setFormError('Attach a working folder before capturing a revision.');
      return;
    }
    try {
      await onCapture(summary.trim(), {
        problem,
        modification,
        observations,
      });
      setSummary('');
      setProblem('');
      setModification('');
      setObservations('');
    } catch {
      // Error is surfaced by parent statusBanner
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
                : 'None (Initial Capture)'}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Mode: {adapterMode === 'real' ? 'Local File System Access API' : 'Fixture Lab (In-Memory)'}
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
              {adapterMode === 'real' && (
                <button
                  type="button"
                  onClick={onReattachWorkingFolder}
                  disabled={isScanning || isCapturing}
                  className="px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-md transition-colors whitespace-nowrap"
                >
                  Change Working Folder
                </button>
              )}
            </>
          )}
        </div>
      </section>

      {/* Fixture Lab Quick Controls (only shown in In-Memory Fixture Lab mode) */}
      {adapterMode === 'memory' && (
        <section
          aria-label="Fixture Lab Simulation Controls"
          className="bg-slate-900 text-slate-100 rounded-lg p-4 flex flex-col md:flex-row md:items-center justify-between gap-4"
        >
          <div className="space-y-0.5">
            <div className="flex items-center gap-2 text-xs font-mono text-emerald-400">
              <FlaskConical className="w-3.5 h-3.5" />
              <span>FIXTURE LAB WORKSPACE SIMULATION</span>
            </div>
            <p className="text-xs text-slate-300">
              Simulate external SolidWorks edits in the working folder (Fixture B: 1 added part, 2
              modified parts including 1 same-size binary edit, 1 deleted lock file, 1 added empty
              folder) or inject an unreadable locked file error.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {onApplyFixtureBMutations && (
              <button
                type="button"
                onClick={onApplyFixtureBMutations}
                disabled={isScanning || isCapturing}
                className="px-3.5 py-2 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap"
              >
                Simulate External CAD Edits (Apply Fixture B)
              </button>
            )}
            {onSimulateUnreadableFile && (
              <button
                type="button"
                onClick={onSimulateUnreadableFile}
                disabled={isScanning || isCapturing}
                className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md transition-colors whitespace-nowrap"
              >
                Toggle Simulated File Lock Error
              </button>
            )}
          </div>
        </section>
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
                ? 'Operation Failed'
                : statusBanner.type === 'success'
                ? 'Verification Confirmed'
                : 'Workspace Notice'}
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
                  <p className="text-slate-500">Directories</p>
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
                      ['all', `All (${scanResult.added.length + scanResult.modified.length + scanResult.deleted.length + scanResult.unchanged.length})`],
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
                            ) : row.status === 'modified' &&
                              row.previousSize === row.size ? (
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
                  Tracked Directories ({scanResult.directories.length} total, empty folders
                  preserved):
                </p>
                <p className="font-mono text-slate-500 break-words">
                  {scanResult.directories.length > 0
                    ? scanResult.directories.join(' · ')
                    : 'Root directory only'}
                </p>
              </div>
            </>
          )}
        </section>

        {/* Right 5 columns: Save Revision Snapshot Form */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-6 space-y-5">
          <div className="space-y-1 border-b border-slate-100 pb-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                <Save className="w-4 h-4 text-slate-700" />
                <span>Save Revision Snapshot</span>
              </h2>
              <span className="text-xs font-mono text-slate-500 tabular-nums">
                Next:{' '}
                {formatRevisionNumber(
                  vaultState.revisions.reduce(
                    (max, r) => Math.max(max, r.manifest.displayNumber),
                    0
                  ) + 1
                )}
              </span>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              Captures a complete project snapshot on <strong>{activeBranch.name}</strong>. Saving
              re-validates source stability and verifies every stored binary object before
              publishing the revision completion record.
            </p>
          </div>

          {formError && (
            <div role="alert" className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-800">
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

          <form onSubmit={handleCaptureSubmit} className="space-y-4">
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
                placeholder="e.g. Added 4mm housing stiffening ribs and shaft keyway"
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="revision-problem"
                className="block text-xs font-medium text-slate-700"
              >
                Engineering Problem / Context (Optional)
              </label>
              <textarea
                id="revision-problem"
                rows={2}
                value={problem}
                onChange={(e) => setProblem(e.target.value)}
                placeholder="What failure mode, interference, or requirement prompted this change?"
                className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="revision-modification"
                className="block text-xs font-medium text-slate-700"
              >
                Modification / Design Solution (Optional)
              </label>
              <textarea
                id="revision-modification"
                rows={2}
                value={modification}
                onChange={(e) => setModification(e.target.value)}
                placeholder="Dimensions, mates, features, or tolerances updated in SolidWorks..."
                className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="revision-observations"
                className="block text-xs font-medium text-slate-700"
              >
                Observations / FEA / Test Results (Optional)
              </label>
              <textarea
                id="revision-observations"
                rows={2}
                value={observations}
                onChange={(e) => setObservations(e.target.value)}
                placeholder="Mass delta, interference check results, or prototype notes..."
                className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>

            <button
              type="submit"
              disabled={
                isCapturing ||
                isScanning ||
                !workingFolderName ||
                (scanResult !== null && !scanResult.canCapture)
              }
              className="w-full py-2.5 px-4 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap"
            >
              {isCapturing
                ? 'Validating & Publishing Snapshot...'
                : `Save Complete Snapshot as ${formatRevisionNumber(
                    vaultState.revisions.reduce(
                      (max, r) => Math.max(max, r.manifest.displayNumber),
                      0
                    ) + 1
                  )}`}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
};
