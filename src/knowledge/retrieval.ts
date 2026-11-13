import type { VaultState } from '../engine/types';
import { assertRevisionAncestry } from '../engine/branch-state';
import { buildKnowledgeIndex } from './index';
import type { KnowledgeAttachment, KnowledgeAvailability } from './types';
import { canonicalJson, nonblank, shape } from './records/json';
import { createRelationshipResolver } from './records/relationships';
import type { JsonValue, KnowledgeTarget, PublishedKnowledgeRecord } from './records/types';
import type { ComponentKnowledgeTimeline, KnowledgeQuery, KnowledgeRetrieval, RetrievalContext, RetrievedKnowledgeRecord, RetrievedReference, RetrievalIssue } from './retrieval-types';
export type * from './retrieval-types';

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const stable = <T>(items: T[]) => [...items].sort((a, b) => compare(canonicalJson(a), canonicalJson(b)));
const verification = (): PublishedKnowledgeRecord['verification'] => ({ metadata: 'checksum_verified', attachmentBytes: 'not_checked', claims: 'not_verified' });
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
const availability = (message: string): KnowledgeAvailability => ({ status: 'unavailable', reason: message });
const chronological = (a: { chronologicalTime: number | null }, b: { chronologicalTime: number | null }) =>
  a.chronologicalTime === b.chronologicalTime ? 0 : a.chronologicalTime === null ? 1 : b.chronologicalTime === null ? -1 : a.chronologicalTime - b.chronologicalTime;
const contextOrder = (a: RetrievalContext, b: RetrievalContext) => chronological(a, b) || compare(a.branchId, b.branchId) || compare(a.revisionId, b.revisionId) || compare(a.component?.componentId ?? '', b.component?.componentId ?? '');

function containsText(value: JsonValue, text: string): boolean {
  if (typeof value === 'string') return value.includes(text);
  if (Array.isArray(value)) return value.some(v => containsText(v, text));
  return value !== null && typeof value === 'object' && Object.keys(value).sort(compare).some(key => containsText(value[key], text));
}

/** Pure retrieval of reconstructed evidence. No disk access, network, identities or claims generated. */
export function retrieveKnowledge(original: VaultState, query: KnowledgeQuery): KnowledgeRetrieval {
  if (!shape(query, ['projectId'], ['sourceType', 'recordType', 'recordId', 'revisionId', 'branchId', 'componentId', 'text', 'relatedRecordId']) ||
    !nonblank(query.projectId) || Object.entries(query).some(([key, value]) => key === 'text' ? typeof value !== 'string' : !nonblank(value)) ||
    (query.sourceType !== undefined && query.sourceType !== 'm1a-derived' && query.sourceType !== 'm1b-persisted')) throw new Error('Invalid structured knowledge query.');
  // Only unordered reconstructed collections are sorted. Committed arrays (file notes,
  // files, reference links and relationships) retain their exact JSON pointer semantics.
  const state: VaultState = { ...original, branches: stable(original.branches), revisions: stable(original.revisions),
    ...(query.sourceType === 'm1a-derived' ? { knowledge: undefined } : {}),
  };
  const index = buildKnowledgeIndex(state);
  const issues: RetrievalIssue[] = [];
  const add = (code: string, status: RetrievalIssue['status'], source: string, message: string, revisionId?: string, recordId?: string, relevance: RetrievalIssue['relevance'] = 'scope') => {
    issues.push({ code, status, source, reason: message, ...(revisionId ? { revisionId } : {}), ...(recordId ? { recordId } : {}), relevance });
  };
  const result: KnowledgeRetrieval = { query: structuredClone(query), recordOutcome: 'empty', coverage: 'readable', records: [], contexts: [], references: [], issues: [], limitations: [
    'Recorded assertions and source context do not establish engineering correctness, CAD geometry changes, document contents or a complete design history.',
    'Ordering uses recorded timestamps, not independently verified event dates. No dates or explanations are inferred.',
    'Record filters apply to ownership, not citation scope. References include selected revision context and explicit citations of matching records, with their original scopes.',
    'Availability describes the supplied reconstructed snapshot. Retrieval does not reread current files or verify attachment bytes.',
  ] };
  let inaccessible = false;
  const finish = () => {
    result.issues = [...new Map(issues.map(i => [canonicalJson(i), i])).values()].sort((a, b) => compare(canonicalJson(a), canonicalJson(b)));
    result.coverage = inaccessible ? 'unavailable' : issues.some(i => i.status !== 'not_recorded') ? 'incomplete' : 'readable';
    result.records.sort((a, b) => chronological(a, b) || compare(a.sourceType, b.sourceType) || compare(a.id, b.id));
    result.contexts.sort(contextOrder);
    result.references = [...new Map(result.references.map(r => [r.id, r])).values()].sort((a, b) => compare(a.revisionId, b.revisionId) || compare(a.id, b.id));
    result.recordOutcome = inaccessible ? 'unavailable' : result.records.length ? 'matches' : 'empty';
    if (result.recordOutcome === 'empty') result.limitations.push('No matching recorded notes or knowledge records were found. This does not establish that no engineering problem or change occurred. Reference context may still be available.');
    if (result.coverage !== 'readable') result.limitations.push('Unavailable or unsupported metadata may conceal additional matches; the returned records must not be presented as complete.');
    if (issues.some(i => i.status === 'not_recorded')) result.limitations.push('Some optional historical evidence was not recorded. Readable recorded metadata does not establish complete evidence for a technical claim.');
    return structuredClone(result);
  };
  if (query.projectId !== state.project.projectId) {
    add('project_scope', 'unavailable', 'project.json', 'The requested project is not the reconstructed vault owner.'); inaccessible = true; return finish();
  }
  if (query.branchId && state.branches.filter(b => b.branchId === query.branchId && b.projectId === query.projectId && b.schemaVersion === 1).length !== 1) {
    add('branch_scope', 'unavailable', 'branches/', 'The requested branch identity is missing, ambiguous or unsupported.'); inaccessible = true; return finish();
  }
  if (query.revisionId && state.revisions.filter(r => r.manifest.revisionId === query.revisionId).length !== 1) {
    add('revision_scope', 'unavailable', 'revisions/', 'The requested saved revision is missing or ambiguous.', query.revisionId); inaccessible = true; return finish();
  }
  for (const d of index.diagnostics) add('vault_diagnostic', state.incompleteAttempts.some(a => a.path === d.source) ? 'not_recorded' : 'unavailable', d.source, d.reason, undefined, undefined, 'unresolved-project');
  if (state.components?.status !== 'available') {
    const status = state.components?.status === 'legacy' ? 'not_recorded' : state.components?.status === 'unsupported' ? 'unsupported' : 'unavailable';
    add('component_evidence', status, 'components/', state.components?.reason ?? (status === 'not_recorded' ? 'Historical component identity was not recorded.' : 'Component evidence was not reconstructed.'), undefined, undefined, 'unresolved-project');
  }
  if (query.sourceType !== 'm1a-derived') {
    if (!state.knowledge || state.knowledge.status === 'unavailable') add('persisted_store', 'unavailable', 'knowledge/', 'Persisted knowledge was not reconstructed or its storage is unavailable.', undefined, undefined, 'unresolved-project');
    for (const d of index.persistedDiagnostics) issues.push({ code: 'persisted_diagnostic', status: d.status, source: d.recordPath, reason: d.reason, relevance: 'unresolved-project',
      ...(d.recordId ? { recordId: d.recordId } : {}), ...(d.recordType ? { recordType: d.recordType } : {}),
      ...(Number.isSafeInteger(d.schemaVersion) ? { schemaVersion: d.schemaVersion } : {}),
      ...(Number.isSafeInteger(d.formatVersion) ? { formatVersion: d.formatVersion } : {}),
      ...(d.publicationPath ? { publicationPath: d.publicationPath } : {}),
    });
  }
  // Never canonicalize a PublishedKnowledgeRecord wrapper: its extra depth is
  // outside the storage contract. Identity/source keys are bounded and sufficient.
  const accepted = new Map<string, PublishedKnowledgeRecord>();
  if (query.sourceType !== 'm1a-derived' && state.knowledge?.status === 'available') {
    const candidates = [...index.persistedRecords].sort((a, b) => compare(a.record.recordId, b.record.recordId) ||
      compare(a.source.recordPath, b.source.recordPath) || compare(a.source.recordSha256, b.source.recordSha256) || compare(a.source.publicationPath, b.source.publicationPath));
    const duplicates = new Set<string>();
    for (const p of candidates) {
      if (accepted.has(p.record.recordId)) duplicates.add(p.record.recordId);
      accepted.set(p.record.recordId, p);
    }
    for (const id of duplicates) {
      for (const p of candidates.filter(p => p.record.recordId === id)) add('persisted_identity', 'unavailable', p.source.recordPath, 'Duplicate accepted knowledge identity; no publication is selected.', undefined, id, 'unresolved-project');
      accepted.delete(id);
    }
  }
  const resolve = createRelationshipResolver(state, index);
  const bindings = new Map<string, ReturnType<typeof resolve>[number]['binding'] | Error>();
  const bind = (target: KnowledgeTarget) => {
    const key = canonicalJson(target);
    if (!bindings.has(key)) {
      try { bindings.set(key, resolve([{ relation: 'context', target }], accepted, 'retrieval-only')[0].binding); }
      catch (error) { bindings.set(key, new Error(reason(error))); }
    }
    const binding = bindings.get(key)!;
    if (binding instanceof Error) throw binding;
    return binding;
  };
  const projectedById = new Map(index.revisions.map(r => [r.revisionId, r]));
  const revisionsById = new Map(state.revisions.map(r => [r.manifest.revisionId, r]));
  const ancestry = new Map<string, KnowledgeAvailability>();
  // Check longest existing projected lineages first. A successful strict engine
  // check validates every ancestor; reuse those successes, never failed descendants.
  for (const projected of [...index.revisions].sort((a, b) => b.history.ancestry.length - a.history.ancestry.length || compare(a.revisionId, b.revisionId))) {
    if (ancestry.has(projected.revisionId)) continue;
    try {
      assertRevisionAncestry(state, projected.revisionId);
      for (const ancestor of projected.history.ancestry) {
        if (projectedById.get(ancestor)?.notes.status !== 'available') throw new Error('An ancestor has unsupported or unavailable manifest metadata.');
        bind({ kind: 'revision', projectId: query.projectId, revisionId: ancestor });
      }
      for (const ancestor of projected.history.ancestry) ancestry.set(ancestor, { status: 'available' });
    } catch (error) { ancestry.set(projected.revisionId, availability(reason(error))); }
  }
  const cache = new Map<string, RetrievalContext | null>();
  function revisionContext(id: string): RetrievalContext | null {
    if (cache.has(id)) return cache.get(id)!;
    const projected = projectedById.get(id)!;
    const revision = revisionsById.get(id)!;
    try {
      const binding = bind({ kind: 'revision', projectId: query.projectId, revisionId: id });
      if (binding.kind !== 'revision') throw new Error('Revision binding is unavailable.');
      const context: RetrievalContext = {
        projectId: query.projectId, revisionId: id, branchId: binding.branchId, source: binding.source,
        recordedAt: revision.manifest.captureCompletedAt, chronologicalTime: null,
        ancestry: { ...projected.history, availability: ancestry.get(id)! },
        fileNotes: projected.fileNotes, referenceContext: projected.referenceContext.availability,
      };
      if (/(Z|[+-]\d{2}:\d{2})$/.test(context.recordedAt) && Number.isFinite(Date.parse(context.recordedAt))) context.chronologicalTime = Date.parse(context.recordedAt);
      cache.set(id, context); return context;
    } catch { cache.set(id, null); return null; }
  }
  const componentContexts = new Map<string, RetrievalContext | null>();
  function componentContext(id: string, componentId: string): RetrievalContext | null {
    const key = JSON.stringify([id, componentId]);
    if (componentContexts.has(key)) return componentContexts.get(key)!;
    const base = revisionContext(id);
    if (!base) return null;
    try {
      const binding = bind({ kind: 'component', projectId: query.projectId, revisionId: id, componentId });
      const context = binding.kind === 'component' ? { ...base, component: { componentId, historicalPath: binding.historicalPath, mappingPayloadSha256: binding.mappingPayloadSha256, source: binding.source } } : null;
      componentContexts.set(key, context); return context;
    } catch { componentContexts.set(key, null); return null; }
  }
  const revisionReference = (revisionId: string, branchId: string, a: KnowledgeAttachment): RetrievedReference => ({
    id: JSON.stringify([query.projectId, revisionId, a.source.recordPath, a.source.jsonPointer]), sourceType: 'm1a-derived', projectId: query.projectId,
    revisionId, branchId, attachment: a, origin: 'revision-context', relation: 'context', verification: verification(),
  });
  if (query.componentId) {
    const known = index.revisions.some(r => componentContext(r.revisionId, query.componentId!) !== null);
    result.componentIdentity = known ? { status: 'available' }
      : state.components?.status === 'legacy' ? { status: 'not_recorded', reason: 'No committed component mapping was recorded for this history.' }
      : state.components?.status === 'unsupported' ? { status: 'unsupported', reason: state.components.reason ?? 'Component schema is unsupported.' }
      : availability(state.components?.reason ?? 'This component ID is not established by any usable historical mapping. No identity is inferred from filenames.');
    if (result.componentIdentity.status !== 'available') {
      add('component_identity', result.componentIdentity.status, 'components/', result.componentIdentity.reason);
      inaccessible = true; return finish();
    }
  }
  const inScope = (context: RetrievalContext) => (!query.revisionId || query.revisionId === context.revisionId) && (!query.branchId || query.branchId === context.branchId) && (!query.componentId || query.componentId === context.component?.componentId);
  const selectedRevisions = index.revisions.filter(r => (!query.revisionId || query.revisionId === r.revisionId) && (!query.branchId || query.branchId === r.branchId));
  for (const r of selectedRevisions) {
    const base = revisionContext(r.revisionId);
    if (!base) { add('revision_metadata', r.notes.status === 'unsupported' ? 'unsupported' : 'unavailable', `revisions/${r.revisionId}.manifest.json`, 'Saved revision or owning branch metadata is not trustworthy.', r.revisionId); continue; }
    let context = base;
    if (query.componentId) {
      const mapped = componentContext(r.revisionId, query.componentId);
      if (!mapped) {
        if (state.components?.status !== 'available' || !state.components.revisions[r.revisionId] || state.components.revisions[r.revisionId].files.some(f => f.componentId === query.componentId)) add('component_mapping', 'unavailable', `components/revisions/${r.revisionId}.json`, 'This revision has no unambiguous usable component mapping; relevance to the selected component cannot be established.', r.revisionId);
        continue;
      }
      context = mapped;
    }
    result.contexts.push(context);
    if (context.chronologicalTime === null) add('chronology', 'unavailable', context.source.recordPath, 'The recorded timestamp has no usable explicit timezone; chronological position is unknown.', r.revisionId);
    for (const [code, value] of [['ancestry', context.ancestry.availability], ['file_notes', context.fileNotes], ['reference_context', context.referenceContext]] as const) {
      if (value.status !== 'available') add(code, value.status, code === 'reference_context' ? `references/contexts/${r.revisionId}.json` : context.source.recordPath, value.reason, r.revisionId);
    }
    for (const a of r.referenceContext.attachments) {
      if (query.componentId && a.componentId !== null && a.componentId !== query.componentId) continue;
      result.references.push(revisionReference(r.revisionId, r.branchId, a));
    }
  }
  const matchesRecord = (record: RetrievedKnowledgeRecord) =>
    (!query.recordType || record.recordType === query.recordType) && (!query.recordId || record.id === query.recordId) &&
    (query.text === undefined || (record.sourceType === 'm1a-derived' ? record.content.text.includes(query.text) : containsText(record.content.payload, query.text))) &&
    (!query.relatedRecordId || (record.sourceType === 'm1b-persisted' && record.content.relationships.some(r => r.target.kind === 'record' && r.target.recordId === query.relatedRecordId)));
  if (query.sourceType !== 'm1b-persisted') for (const note of index.records) {
    const base = revisionContext(note.revisionId);
    if (!base) continue;
    let context = base;
    if (note.scope === 'file') {
      const mapped = note.componentId && note.component?.status === 'available' ? componentContext(note.revisionId, note.componentId) : null;
      if (mapped) context = mapped;
      else if ((!query.revisionId || query.revisionId === note.revisionId) && (!query.branchId || query.branchId === note.branchId)) add('note_component', note.component?.status === 'unsupported' ? 'unsupported' : note.component?.status === 'not_recorded' ? 'not_recorded' : 'unavailable', note.source.recordPath, note.component && 'reason' in note.component ? note.component.reason : 'The file note has no usable component identity.', note.revisionId);
    }
    if (!inScope(context)) continue;
    const references = note.attachments.map(a => revisionReference(note.revisionId, note.branchId, a));
    const record: RetrievedKnowledgeRecord = { id: note.id, sourceType: 'm1a-derived', projectId: note.projectId, recordType: `m1a.${note.kind}`, recordedAt: context.recordedAt, chronologicalTime: context.chronologicalTime, contexts: [context], references, source: note.source, content: note, verification: verification() };
    if (matchesRecord(record)) { result.records.push(record); result.references.push(...references); }
  }
  if (query.sourceType !== 'm1a-derived') for (const published of accepted.values()) {
    const record = published.record;
    try {
      const resolved = resolve(record.relationships.map(({ relation, target }) => ({ relation, target })), accepted, record.recordId);
      if (canonicalJson(resolved) !== canonicalJson(record.relationships)) throw new Error('Stored relationship provenance no longer matches reconstructed metadata.');
      const contexts: RetrievalContext[] = [];
      const refs: RetrievedReference[] = [];
      for (const [i, link] of record.relationships.entries()) {
        if (link.target.kind === 'record') continue;
        const context = link.target.kind === 'component' ? componentContext(link.target.revisionId, link.target.componentId) : revisionContext(link.target.revisionId);
        if (!context) continue;
        if (inScope(context)) contexts.push(context);
        if (link.target.kind === 'reference-version' && link.binding.kind === 'reference-version') {
          const a = link.binding.association;
          // Explicit citations belong to the matching record, independently of
          // its component ownership. Keep even cross-context citation scopes.
          refs.push({
            id: JSON.stringify([query.projectId, record.recordId, i]), sourceType: 'm1b-persisted', projectId: query.projectId, revisionId: context.revisionId, branchId: context.branchId,
            attachment: { ...a, scope: a.componentId !== null ? 'component' : a.origin === 'project' ? 'project' : 'revision', metadata: { status: 'available' }, content: { status: 'unavailable', reason: 'Retrieval does not verify attachment bytes.' } },
            origin: 'persisted-relationship', relation: link.relation, recordId: record.recordId,
            relationshipSource: { ...published.source, relationshipJsonPointer: `/relationships/${i}` }, verification: verification(),
          });
        }
      }
      if ((query.revisionId || query.branchId || query.componentId) && !contexts.length) continue;
      const at = /(Z|[+-]\d{2}:\d{2})$/.test(record.createdAt) ? Date.parse(record.createdAt) : NaN;
      const retrieved: RetrievedKnowledgeRecord = { id: record.recordId, sourceType: 'm1b-persisted', projectId: record.projectId, recordType: record.recordType,
        recordedAt: record.createdAt, chronologicalTime: Number.isFinite(at) ? at : null, contexts: [...new Map(contexts.map(c => [canonicalJson(c), c])).values()].sort(contextOrder), references: refs, source: published.source, content: record, verification: published.verification };
      if (matchesRecord(retrieved)) { result.records.push(retrieved); result.references.push(...refs); }
    } catch (error) { add('persisted_relationship', 'unavailable', published.source.recordPath, reason(error), undefined, record.recordId, 'unresolved-project'); }
  }
  if (selectedRevisions.length && !selectedRevisions.some(r => revisionContext(r.revisionId))) inaccessible = result.records.length === 0;
  if (query.sourceType === 'm1b-persisted' && (!state.knowledge || state.knowledge.status === 'unavailable') && !result.records.length) inaccessible = true;
  return finish();
}

/** Component occurrences and explicitly associated recorded knowledge, never inferred geometry events. */
export function getComponentKnowledgeTimeline(state: VaultState, query: KnowledgeQuery & { componentId: string }): ComponentKnowledgeTimeline {
  if (!nonblank(query?.componentId)) throw new Error('A component ID is required for a component knowledge timeline.');
  const result = retrieveKnowledge(state, query);
  return { ...result, componentId: query.componentId, events: result.contexts.map(context => {
    const records = result.records.filter(r => r.contexts.some(c => c.revisionId === context.revisionId && c.component?.componentId === query.componentId));
    const citationIds = new Set(records.flatMap(r => r.references.map(reference => reference.id)));
    // The overall collection is already unique by stable ID and deterministically
    // ordered. Preserve that order and each citation's original source identity.
    const references = result.references.filter(r =>
      (r.origin === 'revision-context' && r.revisionId === context.revisionId) || citationIds.has(r.id));
    return { context, records, references };
  }) };
}
