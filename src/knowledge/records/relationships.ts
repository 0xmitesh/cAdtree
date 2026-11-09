import type { VaultState } from '../../engine/types';
import { buildKnowledgeIndex } from '../index';
import type { KnowledgeIndex } from '../types';
import { canonicalJson, checksum, nonblank, shape } from './json';
import type { KnowledgeRelationship, KnowledgeRelationshipInput, PublishedKnowledgeRecord, RelationshipBinding } from './types';

export function validateRelationshipInput(value: unknown): asserts value is KnowledgeRelationshipInput {
  if (!shape(value, ['relation', 'target']) || (value.relation !== 'related' && value.relation !== 'context' && value.relation !== 'evidence')) throw new Error('Invalid knowledge relationship.');
  const t = value.target;
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('Invalid knowledge relationship target.');
  const fields = {
    revision: ['kind', 'projectId', 'revisionId'],
    component: ['kind', 'projectId', 'revisionId', 'componentId'],
    'reference-version': ['kind', 'projectId', 'revisionId', 'referenceId', 'versionId', 'associationPointer'],
    record: ['kind', 'projectId', 'recordId'],
  };
  if (typeof t.kind !== 'string' || !Object.hasOwn(fields, t.kind)) throw new Error('Unsupported knowledge relationship target kind.');
  const required = fields[t.kind as keyof typeof fields];
  if (!shape(t, required) || !required.every(k => nonblank(t[k]))) throw new Error('Invalid knowledge relationship target identities.');
}

/** Uses reconstructed evidence and the existing M1A/history projection. No filename inference. */
export function resolveRelationships(
  inputs: KnowledgeRelationshipInput[], state: VaultState, accepted: Map<string, PublishedKnowledgeRecord>, ownRecordId: string,
): KnowledgeRelationship[] {
  if (!Array.isArray(inputs)) throw new Error('Knowledge relationships must be an array.');
  return createRelationshipResolver(state)(inputs, accepted, ownRecordId);
}

/** Query-local preparation of the same checks used by publication/reconstruction.
 * The supplied projection must belong to this reconstructed state. No durable cache. */
export function createRelationshipResolver(state: VaultState, index: Pick<KnowledgeIndex, 'revisions'> = buildKnowledgeIndex(state)) {
  const group = <T>(values: T[], key: (value: T) => string) => {
    const groups = new Map<string, T[]>();
    for (const value of values) { const id = key(value); groups.set(id, [...(groups.get(id) ?? []), value]); }
    return groups;
  };
  const revisions = group(state.revisions, r => r.manifest.revisionId);
  const branchesById = group(state.branches, b => b.branchId);
  const projectedById = new Map(index.revisions.map(r => [r.revisionId, r]));
  const bindings = new Map<string, RelationshipBinding>();
  return (inputs: KnowledgeRelationshipInput[], accepted: Map<string, PublishedKnowledgeRecord>, ownRecordId: string): KnowledgeRelationship[] => {
    if (!Array.isArray(inputs)) throw new Error('Knowledge relationships must be an array.');
    const seen = new Set<string>();
    return inputs.map(input => {
      validateRelationshipInput(input);
      const key = canonicalJson(input);
      if (seen.has(key)) throw new Error('Duplicate knowledge relationship.');
      seen.add(key);
      const target = input.target;
      if (target.projectId !== state.project.projectId) throw new Error('Cross-project knowledge relationship is forbidden.');
      if (target.kind === 'record') {
        const record = accepted.get(target.recordId);
        if (target.recordId === ownRecordId || !record || record.record.projectId !== target.projectId) throw new Error('Knowledge target record is missing, unavailable, cyclic or unpublished.');
        return { ...input, binding: { kind: 'record', source: structuredClone(record.source) } };
      }
      const targetKey = canonicalJson(target);
      const cached = bindings.get(targetKey);
      if (cached) return { ...input, binding: structuredClone(cached) };
      const bound = (binding: RelationshipBinding): KnowledgeRelationship => {
        bindings.set(targetKey, binding);
        return { ...input, binding: structuredClone(binding) };
      };
      const matching = revisions.get(target.revisionId) ?? [];
      const revision = matching[0];
      const projected = projectedById.get(target.revisionId);
      if (matching.length !== 1 || !revision || projected?.notes.status !== 'available' || revision.manifest.projectId !== target.projectId) throw new Error('Knowledge target revision is missing, damaged, ambiguous or unsupported.');
      const branches = branchesById.get(revision.manifest.branchId) ?? [];
      if (branches.length !== 1 || branches[0].projectId !== target.projectId || branches[0].schemaVersion !== 1) throw new Error('Knowledge target revision has no usable project branch identity.');
      const source = {
        recordPath: `revisions/${target.revisionId}.manifest.json`, jsonPointer: '',
        manifestSha256: revision.completion.manifestSha256, manifestPayloadSha256: revision.manifest.manifestPayloadSha256,
      };
      if (target.kind === 'revision') return bound({ kind: 'revision', source, branchId: revision.manifest.branchId });
      if (target.kind === 'component') {
        const mapping = state.components?.status === 'available' ? state.components.revisions[target.revisionId] : undefined;
        const components = mapping?.files.filter(f => f.componentId === target.componentId) ?? [];
        const path = components[0]?.path;
        const fileIndex = revision.manifest.files.findIndex(f => f.path === path);
        if (!mapping || !checksum(mapping.payloadSha256) || components.length !== 1 || fileIndex < 0) throw new Error('Knowledge component target has no verified historical identity in this revision.');
        return bound({ kind: 'component', source: { ...source, jsonPointer: `/files/${fileIndex}` },
          branchId: revision.manifest.branchId, mappingPayloadSha256: mapping.payloadSha256, historicalPath: path });
      }
      const association = projected.referenceContext.attachments.find(a => a.referenceId === target.referenceId && a.versionId === target.versionId && a.source.jsonPointer === target.associationPointer);
      if (projected.referenceContext.availability.status !== 'available' || !association) throw new Error('Knowledge reference target has no verified exact version association in this revision context.');
      // Persist immutable association/version facts, not M1A's transient availability
      // messages or derived scope. Metadata integrity does not verify document bytes.
      const binding = {
        referenceId: association.referenceId, versionId: association.versionId,
        sha256: association.sha256, size: association.size, originalFilename: association.originalFilename, fileType: association.fileType,
        locator: association.locator, explanation: association.explanation, origin: association.origin,
        componentId: association.componentId, componentPath: association.componentPath,
        source: {
          recordPath: association.source.recordPath, jsonPointer: association.source.jsonPointer,
          contextSha256: association.source.contextSha256, contextPayloadSha256: association.source.contextPayloadSha256,
          boundarySha256: association.source.boundarySha256, catalogId: association.source.catalogId, catalogSha256: association.source.catalogSha256,
        },
      };
      return bound({ kind: 'reference-version', association: binding });
    });
  };
}
