import { useMemo } from 'react';
import type { VaultState } from '../../src/engine/types';
import type { KnowledgeIndex } from '../../src/knowledge';
import { getComponentKnowledgeTimeline, retrieveKnowledge, type RetrievedKnowledgeRecord, type RetrievedReference } from '../../src/knowledge/retrieval';
import { emptyRetrievalFilters, noteKinds, recordedTitle, retrievalChoices, retrievalQuery, type RetrievalFilters } from './retrieval-model';

type Labels = Pick<ReturnType<typeof retrievalChoices>, 'branchName' | 'revisionLabel'>;
function JsonDetails({ title, value }: { title: string; value: unknown }) {
  return <details><summary>{title}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}

function Citation({ reference: r, labels }: { reference: RetrievedReference; labels: Labels }) {
  const a = r.attachment;
  return <details className="kl-attachment kl-citation" aria-label={`Citation ${r.id}`}>
    <summary>{a.originalFilename} · {a.locator || 'No recorded locator'} · {r.relation} · source: {labels.revisionLabel(r.revisionId)} / {labels.branchName(r.branchId)}</summary>
    <p>{r.origin === 'revision-context' ? 'Independent revision context' : 'Explicit record citation'} · original scope: {a.scope}. Association is not proof of a claim.</p>
    <dl><dt>Reference ID</dt><dd><code>{a.referenceId}</code></dd><dt>Exact version</dt><dd><code>{a.versionId}</code></dd>
      <dt>Source revision / branch</dt><dd><code>{r.revisionId} / {r.branchId}</code></dd>
      <dt>Recorded explanation</dt><dd className="kl-text">{a.explanation || 'Not recorded'}</dd>
      <dt>Original component scope</dt><dd><code>{a.componentId ?? 'No component association'} {a.componentPath}</code></dd>
      <dt>Attachment bytes</dt><dd>Not checked. {a.content.reason}</dd></dl>
    <JsonDetails title="Exact citation source, IDs and hashes" value={r} />
  </details>;
}

function RecordCard({ record: r, labels, synthetic }: { record: RetrievedKnowledgeRecord; labels: Labels; synthetic: boolean }) {
  const derived = r.sourceType === 'm1a-derived';
  const title = derived ? r.content.kind : r.recordType === 'cad.design-change' ? 'CAD design change' : r.recordType === 'generic.observation' ? 'Generic observation' : r.recordType;
  const text = derived ? r.content.text : recordedTitle(r.content);
  const change = !derived ? r.content.payload.change : null;
  const changeFields = change !== null && typeof change === 'object' && !Array.isArray(change) ? change : null;
  return <article className="kl-record" aria-label={`Retrieved record ${r.id}`}>
    <h4>{title}</h4><p className="eyebrow">{derived ? 'M1A-derived' : 'M1B-persisted'} · {r.recordType}{!derived && ` · schema v${r.content.schemaVersion}`}</p>
    <p className="kl-text">{derived && r.content.status === 'empty' ? '(Empty recorded field)' : text}</p>
    {!derived && r.recordType === 'cad.design-change' && <dl>
      <dt>Recorded change</dt><dd className="kl-text">{String(changeFields?.description ?? '')}</dd>
      <dt>Recorded status</dt><dd>{String(changeFields?.status ?? '')}</dd>
      <dt>Recorded rationale</dt><dd className="kl-text">{String(r.content.payload.rationale ?? '')}</dd></dl>}
    <p className="muted">{r.contexts.length ? r.contexts.map(c => `${labels.revisionLabel(c.revisionId)} / ${labels.branchName(c.branchId)}${c.component ? ` · ${c.component.historicalPath}` : ''}`).join('; ') : 'Project-level record; no historical ownership context recorded.'}</p>
    <p className="muted">Recorded: <time dateTime={r.recordedAt}>{r.recordedAt}</time> · {synthetic ? 'Simulated metadata integrity' : 'Checksum-verified metadata'} · claims not independently validated.</p>
    {derived && <JsonDetails title="Complete original note" value={r.content} />}
    {!derived && <><JsonDetails title="Complete original payload" value={r.content.payload} /><JsonDetails title="Recorded relationships and provenance" value={{ relationships: r.content.relationships, provenance: r.content.provenance, ...(r.content.author ? { author: r.content.author } : {}) }} /></>}
    <JsonDetails title="Original source and integrity" value={{ id: r.id, source: r.source, contexts: r.contexts, verification: r.verification, ...(!derived ? { integrity: r.content.integrity } : {}) }} />
    <p>{r.references.length} applicable {derived ? 'context associations' : 'explicit citations'}</p>
    {r.references.map(reference => <Citation key={reference.id} reference={reference} labels={labels} />)}
  </article>;
}

/** Display only: query matching, ownership, ordering and citation unions are supplied by M2-1. */
export function RetrievalExplorer({ state, index, synthetic, ready, filters, onChange }: {
  state: VaultState; index: KnowledgeIndex; synthetic: boolean; ready: boolean;
  filters: RetrievalFilters; onChange: (filters: RetrievalFilters) => void;
}) {
  const choices = useMemo(() => retrievalChoices(state, index), [state, index]);
  const query = useMemo(() => retrievalQuery(state.project.projectId, filters), [state.project.projectId, filters]);
  const outcome = useMemo(() => {
    if (!ready) return null;
    try {
      if (query.componentId) { const timeline = getComponentKnowledgeTimeline(state, { ...query, componentId: query.componentId }); return { result: timeline, timeline }; }
      return { result: retrieveKnowledge(state, query), timeline: null };
    }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }, [state, query, ready]);
  const result = outcome && 'result' in outcome ? outcome.result : undefined;
  const timeline = outcome && 'timeline' in outcome ? outcome.timeline : undefined;
  const update = (key: keyof RetrievalFilters, value: string) => onChange({ ...filters, [key]: value });
  return <section className="kl-panel kl-retrieval" aria-label="Knowledge retrieval">
    <h2>Search recorded knowledge</h2>
    <p className="muted">{synthetic ? 'SYNTHETIC · all identities, checksums and evidence states are simulated.' : 'Read-only retrieval from this reconstructed project snapshot.'} Text search is literal and case-sensitive.</p>
    <fieldset className="kl-filters" disabled={!ready} aria-label="Retrieval controls">
      <label>Component<select value={filters.component} onChange={e => update('component', e.target.value)}><option value="">All components</option>{choices.components.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
      <label>Branch<select value={filters.branch} onChange={e => update('branch', e.target.value)}><option value="">All branches</option>{choices.branches.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
      <label>Revision<select value={filters.revision} onChange={e => update('revision', e.target.value)}><option value="">All revisions</option>{choices.revisions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
      <label>Record type<select value={filters.kind} onChange={e => update('kind', e.target.value)}><option value="">All record types</option>{noteKinds.map(kind => <option key={kind} value={kind}>M1A {kind}</option>)}{choices.recordTypes.map(kind => <option key={kind} value={kind}>{kind}</option>)}</select></label>
      <label>Record source<select value={filters.sourceType} onChange={e => update('sourceType', e.target.value)}><option value="">M1A and M1B</option><option value="m1a-derived">M1A-derived notes</option><option value="m1b-persisted">M1B-persisted records</option></select></label>
      <label>Literal text<input type="search" value={filters.text} onChange={e => update('text', e.target.value)} placeholder="Exact recorded text" /></label>
      <label>Direct link to record<select value={filters.relatedRecordId} onChange={e => update('relatedRecordId', e.target.value)}><option value="">Any direct record link</option>{choices.records.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
      <button onClick={() => onChange({ ...emptyRetrievalFilters })}>Reset filters</button>
    </fieldset>
    <p className="muted">Only verified historical component IDs and usable revision identities are selectable. Filenames are labels, never identity evidence.</p>
    {!choices.components.length && <p className="kl-warning">Verified component selection is unavailable: {state.components?.reason ?? 'No usable historical component identity is recorded in this snapshot.'}</p>}
    {!ready ? <p role="status">Retrieval results cleared. Complete or retry the vault operation to inspect a fresh snapshot.</p> : outcome && 'error' in outcome ? <p role="alert">Retrieval unavailable: {outcome.error}</p> : result && <>
      <p role="status" className={result.coverage !== 'readable' ? 'kl-warning' : ''}>Record outcome: <strong>{result.recordOutcome}</strong> · Coverage: <strong>{result.coverage}</strong> · {result.records.length} matching records · {result.references.length} reference associations/citations</p>
      {result.componentIdentity && <p>Component identity: <strong>{result.componentIdentity.status}</strong>{'reason' in result.componentIdentity && ` · ${result.componentIdentity.reason}`}</p>}
      {result.recordOutcome === 'empty' && <p>No matching recorded knowledge. This does not establish that no engineering problem or change occurred.</p>}
      {result.coverage !== 'readable' && <p>Some evidence is unavailable, unsupported or incomplete. Results may omit relevant recorded knowledge; inspect the issues below.</p>}
      <p className="muted">Metadata integrity does not verify attachment bytes or engineering claims. Document bytes have not been checked; claims are not independently validated.</p>
      <details><summary>Retrieval issues ({result.issues.length}) and limitations</summary>
        <ul>{result.issues.map((issue, i) => <li key={i}><strong>{issue.status}</strong>: {issue.reason}<JsonDetails title="Issue source metadata" value={issue} /></li>)}</ul>
        <ul>{result.limitations.map(l => <li key={l}>{l}</li>)}</ul><JsonDetails title="Exact structured query" value={result.query} />
      </details>
      {timeline ? <section aria-label="Component knowledge timeline">
        <h3>Component history · saved snapshots</h3><p className="muted">Snapshot presence and recorded decisions do not establish a verified CAD geometry change. Record creation dates are retained separately from historical revision dates.</p>
        {!timeline.events.length && <p>No verified component snapshots in this selection.</p>}
        {timeline.events.map(event => <article key={event.context.revisionId} className="kl-panel kl-snapshot" aria-label={`Snapshot ${event.context.revisionId}`}>
          <h3>{choices.revisionLabel(event.context.revisionId)} / {choices.branchName(event.context.branchId)}</h3>
          <p>Historical path: <code>{event.context.component?.historicalPath}</code></p>
          <p>Recorded snapshot time: <time dateTime={event.context.recordedAt}>{event.context.recordedAt}</time> · Ancestry: {event.context.ancestry.availability.status}</p>
          <JsonDetails title="Revision, branch, component and ancestry source" value={event.context} />
          <h4>Recorded notes and linked knowledge ({event.records.length})</h4>
          {!event.records.length && <p>No matching component records in this snapshot; independent reference context may still be available.</p>}
          {event.records.map(record => <RecordCard key={record.id} record={record} labels={choices} synthetic={synthetic} />)}
          <h4>Event reference context and citations ({event.references.length})</h4>
          <p className="muted">Independent snapshot context plus citations of the records above. Cross-branch citations keep their original source identities.</p>
          {event.references.map(reference => <Citation key={reference.id} reference={reference} labels={choices} />)}
        </article>)}
      </section> : <section aria-label="Retrieved records"><h3>Matching recorded knowledge</h3>{result.records.map(record => <RecordCard key={record.id} record={record} labels={choices} synthetic={synthetic} />)}</section>}
      <details><summary>All retrieved reference context and citations ({result.references.length})</summary>{result.references.map(reference => <Citation key={reference.id} reference={reference} labels={choices} />)}</details>
    </>}
  </section>;
}
