import { useState } from 'react';
import type { ScanResult, VaultState } from '../engine/types';
import { createIdentityReview, possibleRenames, type IdentityReview } from '../engine/component-identity';
import { Modal, Notice } from './ui';

export function ComponentIdentityControls({ state, scan, value, onChange, onEnable, busy }: {
  state: VaultState; scan: ScanResult | null; value?: IdentityReview;
  onChange: (value?: IdentityReview) => void; onEnable?: () => Promise<void>; busy: boolean;
}) {
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState('');
  const evidence = state.components;
  const legacy = !evidence || evidence.status === 'legacy';
  const unavailable = evidence && ['unavailable', 'unsupported'].includes(evidence.status);
  const stale = value && scan && (value.branchId !== scan.branchId || value.baselineRevisionId !== scan.baselineRevisionId || value.changesSignature !== scan.changesSignature || value.boundarySha256 !== evidence?.boundary?.payloadSha256);
  const update = (renames = value?.renames ?? [], replacements = value?.replacements ?? []) => {
    if (scan) onChange(createIdentityReview(state, scan, renames, replacements));
  };
  return <section className="component-identity panel" aria-label="Component identity">
    <div className="panel-heading"><h2>Component identity</h2></div>
    <div className="form-body">
      {error ? <Notice type="error">{error}</Notice> : null}
      {legacy ? <>
        <p>Older history is tracked by filename. Enable permanent document IDs to follow future confirmed renames.</p>
        {onEnable ? <button className="button secondary" disabled={busy} onClick={() => setConfirm('upgrade')}>Enable component tracking</button> : null}
      </> : unavailable ? <Notice type="error">{evidence.reason}{evidence.enrollmentIncomplete && onEnable ? <button className="button secondary" disabled={busy} onClick={() => setConfirm('upgrade')}>Retry component enrollment</button> : null}</Notice> : <>
        <p className="muted small">Filenames stay under your control. New files and Save As copies receive distinct IDs when a revision succeeds.</p>
        {scan && scan.baselineRevisionId && !evidence?.revisions[scan.baselineRevisionId] ? <Notice>This baseline predates component registration. The next revision establishes new identities; earlier history remains available by path.</Notice> : null}
        {stale ? <Notice type="error">Component decisions are stale. Clear them, scan and confirm again. <button className="text-button" onClick={() => onChange(undefined)}>Clear identity decisions</button></Notice> : null}
        {value?.renames.map(rename => <div className="identity-decision" key={rename.from}>
          <span className="file-path">Confirmed rename: {rename.from} → {rename.to}</span>
          <button className="text-button" disabled={busy || Boolean(stale)} onClick={() => update(value.renames.filter(r => r.from !== rename.from))}>Cancel association</button>
        </div>)}
        {scan && evidence?.revisions[scan.baselineRevisionId ?? ''] && scan.deleted.length && scan.added.length ? <details className="disclosure" open>
          <summary>Review possible renames</summary>
          <p className="small">Confirm continuity only if this is the same document. This does not rename files or repair CAD references. Leave unassociated to record deletion/addition.</p>
          {possibleRenames(scan).filter(s => !value?.renames.some(r => r.from === s.from)).map(suggestion => <div className="identity-association" key={suggestion.from}>
            <p className="file-path">Missing: {suggestion.from}</p>
            <p className="small">{suggestion.candidates.length > 1 ? `Ambiguous: ${suggestion.candidates.length} identical-content candidates. Choose explicitly.` : suggestion.candidates.length ? `Possible rename: ${suggestion.candidates[0]} (identical bytes).` : 'Name and bytes may both have changed. Choose only if you know this is the same document.'}</p>
            <label className="field"><span>New path for {suggestion.from}</span><select disabled={busy || Boolean(stale)} value={targets[suggestion.from] ?? ''} onChange={e => setTargets({ ...targets, [suggestion.from]: e.target.value })}>
              <option value="">Keep deletion and addition</option>
              {scan.added.filter(f => !value?.renames.some(r => r.to === f.path)).map(f => <option key={f.path} value={f.path}>{f.path}{suggestion.candidates.includes(f.path) ? ' — identical bytes' : ' — different bytes'}</option>)}
            </select></label>
            <button className="button secondary" disabled={busy || Boolean(stale) || !targets[suggestion.from] || Boolean(value?.renames.some(r => r.to === targets[suggestion.from]))} onClick={() => update([...(value?.renames ?? []), { from: suggestion.from, to: targets[suggestion.from] }])}>Confirm rename</button>
          </div>)}
        </details> : null}
        {value?.replacements.map(path => <div className="identity-decision" key={path}><span className="file-path">New component at {path}</span><button className="text-button" disabled={busy || Boolean(stale)} onClick={() => update(value.renames, value.replacements.filter(p => p !== path))}>Cancel replacement</button></div>)}
        {scan && evidence?.revisions[scan.baselineRevisionId ?? ''] ? <details className="disclosure">
          <summary>Replace a component identity</summary>
          <p className="small">Use only when an unrelated document replaced a tracked file at the same path. Ordinary edits keep the existing ID.</p>
          {[...scan.modified.map(m => m.current), ...scan.unchanged].map(file => <div className="identity-decision" key={file.path}><span className="file-path">{file.path}</span><button className="text-button" disabled={busy || Boolean(stale) || value?.replacements.includes(file.path)} onClick={() => setConfirm(file.path)}>Treat as new component</button></div>)}
        </details> : null}
      </>}
    </div>
    {confirm ? <Modal title={confirm === 'upgrade' ? 'Enable component tracking' : 'Treat as new component'} busy={busy} onClose={() => setConfirm(null)}>
      <p>{confirm === 'upgrade' ? 'Register the current saved baseline of each branch. Distinct older baselines receive independent IDs; past renames and cross-branch identity are not guessed. Older revisions remain available by filename. This adds portable metadata without rewriting saved manifests.' : `At the next successful save, ${confirm} will receive a new document ID. Its previous component history remains available. Use this for an unrelated replacement, not an ordinary edit.`}</p>
      <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button><button className="button primary" disabled={busy} onClick={async () => {
        setError('');
        try { if (confirm === 'upgrade') await onEnable?.(); else update(value?.renames ?? [], [...(value?.replacements ?? []), confirm]); setConfirm(null); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); setConfirm(null); }
      }}>{confirm === 'upgrade' ? 'Enable tracking' : 'Confirm new component'}</button></div>
    </Modal> : null}
  </section>;
}
