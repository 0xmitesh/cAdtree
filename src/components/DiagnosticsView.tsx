import React from 'react';
import {
  ShieldCheck,
  AlertTriangle,
  Database,
  Trash2,
} from 'lucide-react';
import { VaultState } from '../engine/types';
import { formatRevisionNumber } from '../engine/vault-service';
import { formatTimestamp, shortHash } from '../utils/format';

export interface DiagnosticsViewProps {
  vaultState: VaultState;
  isVerifyingAll: boolean;
  onVerifyAllObjects: () => Promise<void>;
  onSimulateClearMetadataAndReopenVault: () => Promise<void>;
}

export const DiagnosticsView: React.FC<DiagnosticsViewProps> = ({
  vaultState,
  isVerifyingAll,
  onVerifyAllObjects,
  onSimulateClearMetadataAndReopenVault,
}) => {
  const damagedBranchesCount = Object.keys(vaultState.damagedBranchHeads).length;
  const competingBranchesCount = Object.keys(vaultState.competingHeads).length;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-8">
      {/* Header */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <p className="text-xs font-mono text-slate-500 tabular-nums">
            Schema Version: v{vaultState.project.schemaVersion} · Project ID:{' '}
            {vaultState.project.projectId} · Checksum:{' '}
            {shortHash(vaultState.project.payloadSha256, 16)}
          </p>
          <h1 className="text-xl font-bold text-slate-900">
            Vault Integrity &amp; Repository Diagnostics
          </h1>
          <p className="text-xs text-slate-600 max-w-3xl">
            Verify stored binary objects against their SHA-256 digests, inspect uncommitted staging
            artifacts, and verify that vault history reopens cleanly without browser storage.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onVerifyAllObjects}
            disabled={isVerifyingAll}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap"
          >
            <ShieldCheck className="w-4 h-4" />
            <span>
              {isVerifyingAll ? 'Verifying Stored Objects...' : 'Verify All Vault Content Objects'}
            </span>
          </button>
        </div>
      </section>

      {/* Metadata Independence Proof: Clear Browser Metadata & Reopen from Vault Files Alone */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1 max-w-3xl">
            <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2 text-balance">
              <Database className="w-4 h-4 text-slate-700 shrink-0" />
              <span>Reload Vault Without Browser Convenience Metadata</span>
            </h2>
            <p className="text-xs text-slate-600 leading-relaxed">
              Project identity, branches, revision history, and engineering notes live inside the
              vault files (<code className="font-mono">project.json</code>,{' '}
              <code className="font-mono">branches/</code>,{' '}
              <code className="font-mono">revisions/</code>,{' '}
              <code className="font-mono">completed/</code>). This action clears remembered handles
              in IndexedDB and reloads the project purely from the vault directory. Working folder
              connection is detached until explicitly reattached.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onSimulateClearMetadataAndReopenVault}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear Browser Handles &amp; Reload Vault</span>
            </button>
          </div>
        </div>
      </section>

      {/* Competing Heads / Corrupted Records / Incomplete Attempts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
          <h2 className="text-base font-semibold text-slate-900">
            Incomplete or Interrupted Attempts ({vaultState.incompleteAttempts.length})
          </h2>
          <p className="text-xs text-slate-500">
            Manifests without valid completion records or leftover staging files are isolated from
            committed history and never appear as valid revisions.
          </p>
          {vaultState.incompleteAttempts.length === 0 ? (
            <p className="text-xs text-slate-600 font-mono py-2">
              No uncommitted manifests or staging artifacts found in vault.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 text-xs">
              {vaultState.incompleteAttempts.map((item) => (
                <li key={item.path} className="py-2.5 space-y-0.5">
                  <p className="font-mono font-semibold text-amber-800">
                    {item.kind} · {item.path}
                  </p>
                  <p className="text-slate-600">{item.detail}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
          <h2 className="text-base font-semibold text-slate-900">
            Corrupted Records &amp; Branch Head Safety (
            {vaultState.corruptedRecords.length + damagedBranchesCount + competingBranchesCount})
          </h2>
          <p className="text-xs text-slate-500">
            Committed revisions with missing or damaged manifests/objects remain visible as damaged
            and block new captures on affected branches until resolved.
          </p>
          {vaultState.corruptedRecords.length === 0 &&
          damagedBranchesCount === 0 &&
          competingBranchesCount === 0 ? (
            <p className="text-xs text-emerald-700 font-mono py-2">
              Zero corrupted records, damaged heads, or competing branch heads detected.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 text-xs">
              {Object.entries(vaultState.damagedBranchHeads).map(([branchId, msg]) => (
                <li key={`damaged-${branchId}`} className="py-2.5 text-red-800">
                  <AlertTriangle className="w-3.5 h-3.5 inline mr-1" />
                  {msg}
                </li>
              ))}
              {Object.entries(vaultState.competingHeads).map(([branchId, heads]) => (
                <li key={`competing-${branchId}`} className="py-2.5 text-red-800">
                  <AlertTriangle className="w-3.5 h-3.5 inline mr-1" />
                  Competing heads on branch {branchId}: {heads.join(', ')} (New writes blocked)
                </li>
              ))}
              {vaultState.corruptedRecords.map((rec, idx) => (
                <li key={idx} className="py-2.5 space-y-0.5">
                  <p className="font-mono font-semibold text-red-800">{rec.recordPath}</p>
                  <p className="text-red-700">{rec.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Revision Verification Matrix */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
        <h2 className="text-base font-semibold text-slate-900">
          Committed Revision Verification Ledger
        </h2>
        <div className="overflow-x-auto border border-slate-200 rounded-md">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <th className="py-2.5 px-3 font-semibold">Revision</th>
                <th className="py-2.5 px-3 font-semibold">Branch</th>
                <th className="py-2.5 px-3 font-semibold">Parent Revision ID</th>
                <th className="py-2.5 px-3 font-semibold">Manifest SHA-256</th>
                <th className="py-2.5 px-3 font-semibold">Verification State</th>
                <th className="py-2.5 px-3 font-semibold">Completed At</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
              {vaultState.revisions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-500 font-sans">
                    No committed revisions in vault yet.
                  </td>
                </tr>
              ) : (
                vaultState.revisions.map((rev) => (
                  <tr key={rev.manifest.revisionId}>
                    <td className="py-2.5 px-3 font-bold text-slate-900">
                      {formatRevisionNumber(rev.manifest.displayNumber)}
                    </td>
                    <td className="py-2.5 px-3 text-slate-700">{rev.manifest.branchId}</td>
                    <td className="py-2.5 px-3 text-slate-600">
                      {rev.manifest.parentRevisionId
                        ? shortHash(rev.manifest.parentRevisionId, 14)
                        : rev.integrityStatus === 'corrupted'
                        ? 'UNKNOWN (Damaged)'
                        : 'ROOT (null)'}
                    </td>
                    <td className="py-2.5 px-3 text-slate-600">
                      {shortHash(rev.completion.manifestSha256, 16)}
                    </td>
                    <td className="py-2.5 px-3">
                      {rev.integrityStatus === 'objects_verified' && (
                        <span className="text-emerald-700 font-semibold">
                          Objects &amp; Manifest Verified
                        </span>
                      )}
                      {rev.integrityStatus === 'manifest_verified' && (
                        <span className="text-slate-700">Manifest Checksum Verified</span>
                      )}
                      {rev.integrityStatus === 'corrupted' && (
                        <span className="text-red-700 font-semibold">Corrupted / Damaged</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-slate-500">
                      {formatTimestamp(rev.completion.completedAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
