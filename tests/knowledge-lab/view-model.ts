import type { VaultState } from '../../src/engine/types';
import type { KnowledgeAvailability, KnowledgeIndex, KnowledgeRecord } from '../../src/knowledge';

export interface Filters { revision: string; component: string; branch: string; kind: string }
export const emptyFilters: Filters = { revision: '', component: '', branch: '', kind: '' };

export function componentAvailability(state: VaultState, index: KnowledgeIndex, revisionId: string): KnowledgeAvailability {
  const notes = index.revisions.find(r => r.revisionId === revisionId)?.notes;
  if (notes && notes.status !== 'available') return notes;
  const evidence = state.components;
  if (!evidence) return { status: 'unavailable', reason: 'Component evidence was not reconstructed.' };
  if (evidence.status === 'legacy') return { status: 'not_recorded', reason: 'No committed component mapping for this history.' };
  if (evidence.status !== 'available') return { status: evidence.status, reason: evidence.reason ?? 'Component evidence is unavailable.' };
  return evidence.revisions[revisionId] ? { status: 'available' } : { status: 'unavailable', reason: 'This revision has no verified component mapping.' };
}

/** Only reconstructed usable mappings; never infer identity from filenames. */
export function revisionComponents(state: VaultState, index: KnowledgeIndex, revisionId: string) {
  if (componentAvailability(state, index, revisionId).status !== 'available') return [];
  return state.components?.revisions[revisionId]?.files ?? [];
}

export function filterKnowledge(state: VaultState, index: KnowledgeIndex, filters: Filters) {
  const revisions = index.revisions.filter(r =>
    (!filters.revision || r.revisionId === filters.revision) && (!filters.branch || r.branchId === filters.branch) &&
    (!filters.component || revisionComponents(state, index, r.revisionId).some(c => c.componentId === filters.component) ||
      r.referenceContext.attachments.some(a => a.componentId === filters.component) ||
      index.records.some(n => n.revisionId === r.revisionId && n.componentId === filters.component)));
  const ids = new Set(revisions.map(r => r.revisionId));
  const records = index.records.filter((r: KnowledgeRecord) => ids.has(r.revisionId) &&
    (!filters.component || r.componentId === filters.component) && (!filters.kind || r.kind === filters.kind));
  return { revisions, records };
}
