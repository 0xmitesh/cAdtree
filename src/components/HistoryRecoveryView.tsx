import React, { useState } from 'react';
import {
  History,
  FolderOutput,
  CheckCircle2,
  AlertTriangle,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import {
  ProgressUpdate,
  ReconstructedRevision,
  RestoreResult,
  VaultState,
} from '../engine/types';
import { formatRevisionNumber } from '../engine/vault-service';
import {
  formatBytes,
  formatTimestamp,
  getCadFileTypeLabel,
  shortHash,
} from '../utils/format';

export interface HistoryRecoveryViewProps {
  vaultState: VaultState;
  activeBranchId: string;
  adapterMode: 'real' | 'memory';
  isRestoring: boolean;
  progress: ProgressUpdate | null;
  lastRestoreReport: {
    result: RestoreResult;
    fixtureComparison?: { matches: boolean; mismatches: string[] };
  } | null;
  statusBanner: { type: 'success' | 'error' | 'info'; message: string } | null;
  onRestoreRevision: (revisionId: string, customMemoryFolderName?: string) => Promise<void>;
  onVerifySingleRevisionObjects: (revisionId: string) => Promise<void>;
  onCancelOperation: () => void;
}

export const HistoryRecoveryView: React.FC<HistoryRecoveryViewProps> = ({
  vaultState,
  activeBranchId,
  adapterMode,
  isRestoring,
  progress,
  lastRestoreReport,
  statusBanner,
  onRestoreRevision,
  onVerifySingleRevisionObjects,
  onCancelOperation,
}) => {
  const branchRevisions = [...vaultState.revisions]
    .filter((r) => r.manifest.branchId === activeBranchId)
    .sort((a, b) => b.manifest.displayNumber - a.manifest.displayNumber);

  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(
    branchRevisions[0]?.manifest.revisionId ?? null
  );
  const [memoryDestName, setMemoryDestName] = useState('Recovered_Snapshot_Copy');

  const selectedRevision: ReconstructedRevision | null =
    branchRevisions.find((r) => r.manifest.revisionId === selectedRevisionId) ??
    branchRevisions[0] ??
    null;

  const parentRev = selectedRevision?.manifest.parentRevisionId
    ? vaultState.revisions.find(
        (r) => r.manifest.revisionId === selectedRevision.manifest.parentRevisionId
      ) ?? null
    : null;

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
            Select any committed revision to inspect its immutable engineering notes, manifest
            checksums, and restore a verified copy into a fresh destination folder without altering
            your active working folder.
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
              Verified Recovery Complete —{' '}
              {formatRevisionNumber(lastRestoreReport.result.displayNumber)} restored to &ldquo;
              {lastRestoreReport.result.destinationName}&rdquo;
            </span>
          </div>
          <p className="text-xs text-emerald-900 font-mono tabular-nums">
            Restored Files: {lastRestoreReport.result.restoredFilesCount} · Restored Directories:{' '}
            {lastRestoreReport.result.restoredDirectoriesCount} · Verified Bytes:{' '}
            {formatBytes(lastRestoreReport.result.verifiedBytes)} · Completed:{' '}
            {formatTimestamp(lastRestoreReport.result.completedAt)}
          </p>
          {lastRestoreReport.fixtureComparison && (
            <p className="text-xs text-emerald-950 font-medium">
              Fixture Byte-by-Byte Comparison:{' '}
              {lastRestoreReport.fixtureComparison.matches
                ? '100% Exact Match with Expected Fixture A Bytes & Directory Tree (Active working folder left untouched)'
                : `Mismatches found: ${lastRestoreReport.fixtureComparison.mismatches.join('; ')}`}
            </p>
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
                Ordered newest to oldest by global revision number
              </p>
            </div>

            {branchRevisions.map((rev) => {
              const isSelected =
                selectedRevision?.manifest.revisionId === rev.manifest.revisionId;
              const totalBytes = rev.manifest.files.reduce((sum, f) => sum + f.size, 0);

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
                      isSelected ? 'text-slate-300' : 'text-slate-500'
                    }`}
                  >
                    {rev.manifest.files.length} files · {rev.manifest.directories.length} dirs ·{' '}
                    {formatBytes(totalBytes)} ·{' '}
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

          {/* Right 8 columns: Selected Revision Details & Restore Action */}
          {selectedRevision && (
            <section className="lg:col-span-8 bg-white border border-slate-200 rounded-lg p-6 space-y-6">
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

              {/* Restore a Copy Action Section (Single-elevation, separated by hairline divider) */}
              <div className="border-b border-slate-100 pb-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="space-y-1">
                  <h3 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5 whitespace-nowrap">
                    <FolderOutput className="w-4 h-4 text-slate-700 shrink-0" />
                    <span>
                      Restore a Copy of {formatRevisionNumber(selectedRevision.manifest.displayNumber)}
                    </span>
                  </h3>
                  <p className="text-xs text-slate-600 max-w-xl">
                    Recovers all {selectedRevision.manifest.files.length} files and{' '}
                    {selectedRevision.manifest.directories.length} directories into a fresh, empty
                    folder and verifies every recovered byte against its SHA-256 digest.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {adapterMode === 'memory' && (
                    <input
                      type="text"
                      aria-label="Recovery folder name"
                      value={memoryDestName}
                      onChange={(e) => setMemoryDestName(e.target.value)}
                      placeholder="Fresh folder name"
                      className="px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded-md w-48"
                    />
                  )}
                  <button
                    type="button"
                    disabled={
                      isRestoring || selectedRevision.integrityStatus === 'corrupted'
                    }
                    onClick={() =>
                      onRestoreRevision(
                        selectedRevision.manifest.revisionId,
                        adapterMode === 'memory'
                          ? `${memoryDestName.trim() || 'Recovered'}_Rev00${
                              selectedRevision.manifest.displayNumber
                            }_${Date.now().toString().slice(-4)}`
                          : undefined
                      )
                    }
                    className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap"
                  >
                    {isRestoring
                      ? 'Restoring & Verifying...'
                      : adapterMode === 'real'
                      ? 'Select Fresh Folder & Restore Copy'
                      : `Restore Copy & Verify Bytes (${formatRevisionNumber(
                          selectedRevision.manifest.displayNumber
                        )})`}
                  </button>
                </div>
              </div>

              {/* Engineering Notes (Immutable) */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border-b border-slate-100 pb-5 text-xs">
                <div className="space-y-1">
                  <p className="font-semibold text-slate-800">Engineering Problem</p>
                  <p className="text-slate-600 leading-relaxed whitespace-pre-wrap">
                    {selectedRevision.manifest.notes.problem || 'None recorded'}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="font-semibold text-slate-800">Modification / Solution</p>
                  <p className="text-slate-600 leading-relaxed whitespace-pre-wrap">
                    {selectedRevision.manifest.notes.modification || 'None recorded'}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="font-semibold text-slate-800">Observations / Test Results</p>
                  <p className="text-slate-600 leading-relaxed whitespace-pre-wrap">
                    {selectedRevision.manifest.notes.observations || 'None recorded'}
                  </p>
                </div>
              </div>

              {/* Snapshot Manifest File Table */}
              <div className="space-y-3">
                <h3 className="text-xs font-semibold text-slate-900">
                  Snapshot File Inventory ({selectedRevision.manifest.files.length} files,{' '}
                  {selectedRevision.manifest.directories.length} directories)
                </h3>
                <div className="overflow-x-auto border border-slate-200 rounded-md">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                        <th className="py-2 px-3 font-semibold">Relative Path</th>
                        <th className="py-2 px-3 font-semibold">Type</th>
                        <th className="py-2 px-3 font-semibold text-right">Size</th>
                        <th className="py-2 px-3 font-semibold">SHA-256 Digest</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedRevision.manifest.files.map((file) => (
                        <tr key={file.path} className="hover:bg-slate-50/80">
                          <td className="py-2 px-3 font-mono font-medium text-slate-900 break-all">
                            {file.path}
                          </td>
                          <td className="py-2 px-3 text-slate-600 whitespace-nowrap">
                            {getCadFileTypeLabel(file.path)}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                            {formatBytes(file.size)}
                          </td>
                          <td className="py-2 px-3 font-mono tabular-nums text-slate-600 whitespace-nowrap">
                            {shortHash(file.sha256, 16)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
};
