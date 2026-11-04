import type { ScanResult, VaultState } from '../engine/types';
import { createReferenceReview, prepareReferenceContext, type ReferenceReview, type ReferenceLinkInput } from '../engine/references';
import { prepareComponentRecord, type IdentityReview } from '../engine/component-identity';
import { Notice } from './ui';

export function ReferenceSelector({ state, scan, identityReview, value, onChange, busy }: {
  state: VaultState; scan: ScanResult; identityReview?: IdentityReview; value: ReferenceReview;
  onChange: (value: ReferenceReview) => void; busy: boolean;
}) {
  const library = state.references?.library ?? [];
  let conflict = '';
  let files: { path: string; componentId: string }[] = [];
  let mappingAvailable = true;
  try { files = prepareComponentRecord(state, scan, identityReview)?.files ?? []; }
  catch { mappingAvailable = false; /* Changes already displays the identity conflict. */ }
  if (mappingAvailable) {
    try { prepareReferenceContext(state, scan, files, value); }
    catch (e) { conflict = e instanceof Error ? e.message : String(e); }
  }
  const baselineFiles = scan.baselineRevisionId ? state.components?.revisions[scan.baselineRevisionId]?.files ?? [] : [];
  const knownIds = new Set(baselineFiles.map(f => f.componentId));
  const update = (index: number, changes: Partial<ReferenceLinkInput>) => onChange({ ...value, explicit: value.explicit.map((l, i) => i === index ? { ...l, ...changes } : l) });
  const defaults = library.filter(r => !r.removed && r.projectVersionId);
  return <section className="panel reference-selector">
    <div className="panel-heading"><h2>Revision references</h2><button className="button" disabled={busy || !library.some(r => !r.removed)} onClick={() => {
      const ref = library.find(r => !r.removed)!;
      onChange({ ...value, explicit: [...value.explicit, { referenceId: ref.referenceId, versionId: ref.versions.at(-1)!.versionId, locator: '', explanation: '' }] });
    }}>Add revision reference</button></div>
    {defaults.length ? <ul>{defaults.map(r => <li key={r.referenceId}>Inherited project reference: {r.title} — {r.versions.find(v => v.versionId === r.projectVersionId)?.originalFilename} ({r.projectVersionId})</li>)}</ul> : <p className="muted small">No inherited project references. Manage defaults in References.</p>}
    {value.explicit.map((link, index) => {
      const ref = library.find(r => r.referenceId === link.referenceId);
      const selection = link.component;
      const componentValue = selection?.kind === 'existing' ? `id:${selection.componentId}` : selection?.kind === 'pending' ? `path:${selection.path}` : '';
      const options = files.map(f => ({ value: knownIds.has(f.componentId) ? `id:${f.componentId}` : `path:${f.path}`, label: `${f.path} (${knownIds.has(f.componentId) ? f.componentId : 'identity resolved when saved'})` }));
      return <fieldset className="reference-card" key={index} disabled={busy}><legend>Selected reference {index + 1}</legend>
        <label className="field"><span>Reference</span><select value={link.referenceId} onChange={e => { const r = library.find(r => r.referenceId === e.target.value)!; update(index, { referenceId: r.referenceId, versionId: r.versions.at(-1)!.versionId }); }}>
          {!ref ? <option value={link.referenceId}>Unavailable reference</option> : null}
          {library.filter(r => !r.removed || r.referenceId === link.referenceId).map(r => <option key={r.referenceId} value={r.referenceId}>{r.title}{r.removed ? ' (removed)' : ''}</option>)}</select></label>
        <label className="field"><span>Exact version</span><select value={link.versionId} onChange={e => update(index, { versionId: e.target.value })}>{ref?.versions.map((v, i) => <option key={v.versionId} value={v.versionId}>Version {i + 1}: {v.originalFilename} ({v.versionId})</option>)}</select></label>
        <label className="field"><span>Locator (optional)</span><input value={link.locator} maxLength={2000} placeholder="page 4, section 2.1 or 00:12:30–00:13:10" onChange={e => update(index, { locator: e.target.value })} /></label>
        <label className="field"><span>Explanation (optional)</span><input value={link.explanation} maxLength={8000} onChange={e => update(index, { explanation: e.target.value })} /></label>
        <label className="field"><span>Component (optional)</span><select value={componentValue} onChange={e => update(index, { component: !e.target.value ? undefined : e.target.value.startsWith('id:') ? { kind: 'existing', componentId: e.target.value.slice(3) } : { kind: 'pending', path: e.target.value.slice(5) } })}>
          <option value="">Whole revision</option>{componentValue && !options.some(o => o.value === componentValue) ? <option value={componentValue}>Previous selection — review required</option> : null}
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
        <button className="button" type="button" onClick={() => onChange({ ...value, explicit: value.explicit.filter((_, i) => i !== index) })}>Remove revision link</button>
      </fieldset>;
    })}
    {conflict ? <Notice type="error">{conflict} <button className="text-button" disabled={busy} onClick={() => onChange(createReferenceReview(state, scan, value.explicit))}>Review current references</button></Notice> : null}
    <p className="muted small">Locators are user-entered pointers, not verified quotations or proof a requirement is satisfied. New component selections resolve to their committed identities when saved.</p>
  </section>;
}
