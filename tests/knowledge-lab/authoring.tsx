import { useMemo, useState, type FormEvent } from 'react';
import type { VaultState } from '../../src/engine/types';
import type { CreateKnowledgeRecordInput } from '../../src/knowledge/records';
import { authoringTargets, newDraft, payloadFromDraft, selectedRelationships, type RecordDraft, type TargetOption } from './authoring-model';

type EditorInput = Omit<CreateKnowledgeRecordInput, 'projectId' | 'recordId'>;

function Choices({ label, value, options, disabled, onChange }: { label: string; value: string; options: TargetOption[]; disabled?: boolean; onChange: (value: string) => void }) {
  return <label>{label}<select value={value} onChange={e => onChange(e.target.value)} disabled={disabled}>
    <option value="">No link</option>{options.filter(o => !o.unavailable).map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
  </select></label>;
}

export function KnowledgeAuthoring({ state, enabled, busy, onCreate }: { state: VaultState; enabled: boolean; busy: boolean; onCreate: (input: EditorInput) => Promise<void> }) {
  const [draft, setDraft] = useState(newDraft);
  const [revisionKey, setRevision] = useState(''), [componentKey, setComponent] = useState('');
  const [referenceKey, setReference] = useState(''), [recordKey, setRecord] = useState('');
  const [referenceRelation, setReferenceRelation] = useState<'context' | 'evidence'>('context');
  const [error, setError] = useState('');
  const revisionId = useMemo(() => {
    const selected = authoringTargets(state, '').revisions.find(o => o.key === revisionKey);
    return selected?.target.kind === 'revision' ? selected.target.revisionId : '';
  }, [state, revisionKey]);
  const targets = useMemo(() => authoringTargets(state, revisionId), [state, revisionId]);
  const update = <K extends keyof RecordDraft>(key: K, value: RecordDraft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    if (!enabled || busy) { setError('Authoring is read-only until writes are explicitly enabled.'); return; }
    try {
      const payload = payloadFromDraft(draft);
      const relationships = selectedRelationships(state, revisionKey, componentKey, referenceKey, recordKey, referenceRelation);
      await onCreate({ recordType: draft.schema, schemaVersion: 1, payload, relationships, provenance: { kind: 'user-entered' } });
      setDraft(newDraft()); setRevision(''); setComponent(''); setReference(''); setRecord(''); setReferenceRelation('context');
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  return <section className="kl-panel kl-author" aria-label="Knowledge authoring">
    <h2>Create knowledge record</h2><p>New records only. Published records cannot be edited or deleted here. Author identity is omitted; provenance is user-entered.</p>
    {!enabled && <p className="kl-warning">Read-only. Confirm the disposable destination and enable writes above to use this form.</p>}
    {error && <p role="alert" className="kl-warning">{error}</p>}
    <form onSubmit={submit} aria-label="New knowledge record">
      <fieldset disabled={!enabled || busy}><legend>Schema-specific content</legend>
        <label>Knowledge schema<select value={draft.schema} onChange={e => update('schema', e.target.value as RecordDraft['schema'])}><option value="cad.design-change">CAD design change · v1</option><option value="generic.observation">Generic observation · v1</option></select></label>
        {draft.schema === 'cad.design-change' ? <>
          <label>Problem statement<textarea required value={draft.problem} onChange={e => update('problem', e.target.value)} /></label>
          <label>Change description<textarea required value={draft.change} onChange={e => update('change', e.target.value)} /></label>
          <label>Change status<select value={draft.status} onChange={e => update('status', e.target.value as RecordDraft['status'])}><option value="proposed">Proposed</option><option value="implemented">Implemented</option></select></label>
          <label>Engineering rationale<textarea required value={draft.rationale} onChange={e => update('rationale', e.target.value)} /></label>
          <h3>Structured property changes (optional)</h3><p className="muted">Before/after values use JSON: 6, "steel", null or a structured object. Numbers and units are stored separately.</p>
          {draft.properties.map((property, i) => <div className="kl-property" key={i}>
            {(['property', 'before', 'after', 'unit'] as const).map(key => <label key={key}>{`Property ${i + 1} ${key}`}<input required={key !== 'unit'} value={property[key]} onChange={e => update('properties', draft.properties.map((p, j) => j === i ? { ...p, [key]: e.target.value } : p))} /></label>)}
            <button type="button" onClick={() => update('properties', draft.properties.filter((_, j) => j !== i))}>Remove property {i + 1}</button>
          </div>)}
          <button type="button" onClick={() => update('properties', [...draft.properties, { property: '', before: '', after: '', unit: '' }])}>Add property change</button>
          <label>Assumptions (optional)<textarea value={draft.assumptions} onChange={e => update('assumptions', e.target.value)} /></label>
          <label>Observations (optional)<textarea value={draft.observations} onChange={e => update('observations', e.target.value)} /></label>
        </> : <>
          <label>Observation description<textarea required value={draft.description} onChange={e => update('description', e.target.value)} /></label>
          <label>Attributes (JSON object, optional)<textarea value={draft.attributes} onChange={e => update('attributes', e.target.value)} placeholder={'{"sampleCount":12}'} /></label>
        </>}
        <h3>Verified relationship targets (optional)</h3>
        <Choices label="Relationship revision" value={revisionKey} options={targets.revisions} onChange={key => { setRevision(key); setComponent(''); setReference(''); }} />
        <Choices label="Historical component" value={componentKey} options={targets.components} disabled={!revisionId} onChange={setComponent} />
        {targets.componentReason && <p className="muted">{targets.componentReason}</p>}
        <Choices label="Captured reference association" value={referenceKey} options={targets.references} disabled={!revisionId} onChange={setReference} />
        {targets.referenceReason && <p className="muted">{targets.referenceReason}</p>}
        <label>Reference relationship<select value={referenceRelation} onChange={e => setReferenceRelation(e.target.value as 'context' | 'evidence')}><option value="context">Context</option><option value="evidence">Evidence assertion</option></select></label>
        <p className="muted">A reference link records relevance, not proof. Document bytes are not checked and engineering claims are not independently validated.</p>
        <Choices label="Accepted knowledge record" value={recordKey} options={targets.records} onChange={setRecord} />
        {[...targets.revisions, ...targets.components, ...targets.references, ...targets.records].filter(o => o.unavailable).map(o => <p key={o.key} className="muted">Unavailable target: {o.label}. {o.unavailable}</p>)}
        {!targets.records.length && <p className="muted">No previously accepted knowledge records are available to link.</p>}
        {targets.diagnostics.map((d, i) => <p className="muted" key={i}>Unavailable knowledge target: {d.recordId ?? d.recordPath} · {d.status}. {d.reason}</p>)}
        <button type="submit">{busy ? 'Saving…' : 'Create immutable record'}</button>
      </fieldset>
    </form>
  </section>;
}
