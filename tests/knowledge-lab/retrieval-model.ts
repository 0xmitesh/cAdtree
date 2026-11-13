import type { VaultState } from '../../src/engine/types';
import type { KnowledgeIndex } from '../../src/knowledge';
import type { KnowledgeQuery, RetrievalSource } from '../../src/knowledge/retrieval';
import type { KnowledgeTarget, UniversalKnowledgeRecord } from '../../src/knowledge/records';
import { createRelationshipResolver } from '../../src/knowledge/records/relationships';
import { emptyFilters, type Filters } from './view-model';

export interface RetrievalFilters extends Filters { sourceType: RetrievalSource | ''; text: string; relatedRecordId: string }
export const emptyRetrievalFilters: RetrievalFilters = { ...emptyFilters, sourceType: '', text: '', relatedRecordId: '' };
export const noteKinds = ['problem', 'modification', 'observations', 'summary'];

/** UI input translation only. Matching and timeline assembly belong to M2-1. */
export function retrievalQuery(projectId: string, filters: RetrievalFilters): KnowledgeQuery {
  return { projectId,
    ...(filters.component ? { componentId: filters.component } : {}),
    ...(filters.branch ? { branchId: filters.branch } : {}),
    ...(filters.revision ? { revisionId: filters.revision } : {}),
    ...(filters.kind ? { recordType: noteKinds.includes(filters.kind) ? `m1a.${filters.kind}` : filters.kind } : {}),
    ...(filters.sourceType ? { sourceType: filters.sourceType } : {}),
    ...(filters.text !== '' ? { text: filters.text } : {}),
    ...(filters.relatedRecordId ? { relatedRecordId: filters.relatedRecordId } : {}),
  };
}

export function recordedTitle(record: UniversalKnowledgeRecord) {
  const text = record.payload.description ?? record.payload.problem;
  return typeof text === 'string' ? text : record.recordType;
}

/** Selectable identities use the existing verified relationship resolver. Paths are labels only. */
export function retrievalChoices(state: VaultState, index: KnowledgeIndex) {
  const resolve = createRelationshipResolver(state, index);
  const counts = new Map<string, number>();
  for (const p of index.persistedRecords) counts.set(p.record.recordId, (counts.get(p.record.recordId) ?? 0) + 1);
  const accepted = new Map((state.knowledge?.status === 'available' ? index.persistedRecords : [])
    .filter(p => counts.get(p.record.recordId) === 1).map(p => [p.record.recordId, p]));
  const usable = (target: KnowledgeTarget) => {
    try { resolve([{ relation: 'context', target }], accepted, 'retrieval-selector'); return true; } catch { return false; }
  };
  const branchName = (id: string) => state.branches.find(b => b.branchId === id)?.name ?? id;
  const revisionLabel = (id: string) => {
    const r = state.revisions.find(r => r.manifest.revisionId === id)?.manifest;
    return r ? `R${String(r.displayNumber).padStart(2, '0')} · ${r.summary}` : id;
  };
  const revisions = index.revisions.filter(r => usable({ kind: 'revision', projectId: state.project.projectId, revisionId: r.revisionId }))
    .map(r => ({ value: r.revisionId, label: `${revisionLabel(r.revisionId)} · ${branchName(r.branchId)} · ${r.revisionId}` }));
  const components = new Map<string, Set<string>>();
  if (state.components?.status === 'available') for (const r of revisions) {
    for (const file of state.components.revisions[r.value]?.files ?? []) {
      if (!usable({ kind: 'component', projectId: state.project.projectId, revisionId: r.value, componentId: file.componentId })) continue;
      if (!components.has(file.componentId)) components.set(file.componentId, new Set());
      components.get(file.componentId)!.add(file.path);
    }
  }
  return {
    revisions,
    branches: state.branches.filter(b => b.schemaVersion === 1 && b.projectId === state.project.projectId && state.branches.filter(other => other.branchId === b.branchId).length === 1)
      .map(b => ({ value: b.branchId, label: b.name })).sort((a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
    components: [...components].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, paths]) => ({ value: id, label: `${[...paths].sort().join(' / ')} · ${id}` })),
    records: [...accepted.values()].sort((a, b) => a.record.recordId < b.record.recordId ? -1 : 1)
      .filter(p => usable({ kind: 'record', projectId: state.project.projectId, recordId: p.record.recordId }))
      .map(p => ({ value: p.record.recordId, label: `${recordedTitle(p.record).slice(0, 70)} · ${p.record.recordId}` })),
    recordTypes: [...new Set(['cad.design-change', 'generic.observation', ...[...accepted.values()].map(p => p.record.recordType)])].sort(),
    branchName, revisionLabel,
  };
}
