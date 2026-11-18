import { useState } from 'react';
import type { ScanResult, VaultState } from '../engine/types';
import { createIdentityReview, possibleRenames, type IdentityReview } from '../engine/component-identity';
import { Modal, Notice } from './ui';

/** True when saved identity decisions no longer match the current scan or component boundary. */
export function identityReviewStale(state: VaultState, scan: ScanResult | null, value?: IdentityReview): boolean {
  return Boolean(value && scan && (value.branchId !== scan.branchId || value.baselineRevisionId !== scan.baselineRevisionId || value.changesSignature !== scan.changesSignature || value.boundarySha256 !== state.components?.boundary?.payloadSha256));
}

/** A modified or unchanged file can be given a new component ID only when its baseline has component records. */
export function canTreatAsNew(state: VaultState, scan: ScanResult | null): boolean {
  return Boolean(scan && state.components?.status === 'available' && state.components.revisions[scan.baselineRevisionId ?? '']);
}

/**
 * Shown only when there is something to decide: a possible rename in the scan or a
 * pending (or stale) identity decision. Otherwise it renders nothing.
 */
export function ComponentIdentityControls({ state, scan, value, onChange, busy }: {
  state: VaultState; scan: ScanResult | null; value?: IdentityReview;
  onChange: (value?: IdentityReview) => void; busy: boolean;
}) {
  const [targets, setTargets] = useState<Record<string, string>>({});
  const evidence = state.components;
  if (!scan || evidence?.status !== 'available') return null;
  const stale = identityReviewStale(state, scan, value);
  const update = (renames = value?.renames ?? [], replacements = value?.replacements ?? []) => onChange(createIdentityReview(state, scan, renames, replacements));
  const hasBaseline = Boolean(evidence.revisions[scan.baselineRevisionId ?? '']);
  const free = scan.added.filter(f => !value?.renames.some(r => r.to === f.path));
  const missing = hasBaseline && scan.added.length ? possibleRenames(scan).filter(s => !value?.renames.some(r => r.from === s.from)) : [];
  // Only pairs with identical bytes are suggested; other missing files stay available for a manual match.
  const suggested = missing.filter(s => s.candidates.length);
  const manual = missing.filter(s => !s.candidates.length);
  if (!stale && !value?.renames.length && !value?.replacements.length && !missing.length) return null;
  const targetFor = (s: { from: string; candidates: string[] }) => targets[s.from] ?? (s.candidates.length === 1 && free.some(f => f.path === s.candidates[0]) ? s.candidates[0] : '');
  const row = (suggestion: { from: string; candidates: string[] }) => {
    const target = targetFor(suggestion);
    return <div className="identity-association" key={suggestion.from}>
      <p className="file-path">Missing: {suggestion.from}</p>
      <p className="small">{suggestion.candidates.length > 1 ? `Ambiguous: ${suggestion.candidates.length} identical-content candidates. Choose explicitly.` : suggestion.candidates.length ? `Possible rename: ${suggestion.candidates[0]} (identical bytes).` : 'Name and bytes may both have changed. Choose only if you know this is the same document.'}</p>
      <label className="field"><span>New path for {suggestion.from}</span><select disabled={busy || stale} value={target} onChange={e => setTargets({ ...targets, [suggestion.from]: e.target.value })}>
        <option value="">Keep deletion and addition</option>
        {free.map(f => <option key={f.path} value={f.path}>{f.path}{suggestion.candidates.includes(f.path) ? ' — identical bytes' : ' — different bytes'}</option>)}
      </select></label>
      <button className="button secondary" disabled={busy || stale || !target || Boolean(value?.renames.some(r => r.to === target))} onClick={() => { update([...(value?.renames ?? []), { from: suggestion.from, to: target }]); }}>Confirm rename</button>
    </div>;
  };
  return <section className="component-identity panel" aria-label="Component identity">
    <div className="panel-heading"><h2>Component identity</h2></div>
    <div className="form-body">
      {stale ? <Notice type="error">Component decisions are stale. Clear them, scan and confirm again. <button className="text-button" onClick={() => onChange(undefined)}>Clear identity decisions</button></Notice> : null}
      {value?.renames.map(rename => <div className="identity-decision" key={rename.from}>
        <span className="file-path">Confirmed rename: {rename.from} → {rename.to}</span>
        <button className="text-button" disabled={busy || stale} onClick={() => update(value.renames.filter(r => r.from !== rename.from))}>Cancel association</button>
      </div>)}
      {value?.replacements.map(path => <div className="identity-decision" key={path}><span className="file-path">New component at {path}</span><button className="text-button" disabled={busy || stale} onClick={() => update(value.renames, value.replacements.filter(p => p !== path))}>Cancel replacement</button></div>)}
      {suggested.length ? <>
        <p className="small">Confirm continuity only if this is the same document. This does not rename files or repair CAD references. Leave unassociated to record deletion/addition.</p>
        {suggested.map(row)}
      </> : null}
      {manual.length ? <details className="disclosure">
        <summary>Match other missing files manually ({manual.length})</summary>
        {manual.map(row)}
      </details> : null}
    </div>
  </section>;
}

/** Confirmation for "Treat as new component", opened from a file row's menu. */
export function TreatAsNewDialog({ path, busy, onCancel, onConfirm }: { path: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <Modal title="Treat as new component" busy={busy} onClose={onCancel}>
    <p>{`At the next successful save, ${path} will receive a new document ID. Its previous component history remains available. Use this for an unrelated replacement, not an ordinary edit.`}</p>
    <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={onCancel}>Cancel</button><button className="button primary" disabled={busy} onClick={onConfirm}>Confirm new component</button></div>
  </Modal>;
}
