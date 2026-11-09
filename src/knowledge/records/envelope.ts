import { hashString } from '../../engine/hash';
import { canonicalJson, checksum, nonblank, recordIdIsValid, shape } from './json';
import type { KnowledgeSchemaRegistry } from './registry';
import { validateRelationshipInput } from './relationships';
import type { UniversalKnowledgeRecord } from './types';

export class UnsupportedKnowledgeFormatError extends Error {
  constructor() { super('Unsupported knowledge storage format version.'); this.name = 'UnsupportedKnowledgeFormatError'; }
}

export function bodyChecksum(record: Omit<UniversalKnowledgeRecord, 'integrity'> | UniversalKnowledgeRecord) {
  const { integrity: _, ...body } = record as UniversalKnowledgeRecord;
  return hashString(canonicalJson(body));
}

export function validateEnvelope(value: unknown, registry: KnowledgeSchemaRegistry): asserts value is UniversalKnowledgeRecord {
  if (!value || typeof value !== 'object' || !('formatVersion' in value)) throw new Error('Missing knowledge storage format version.');
  if (value.formatVersion !== 1) throw new UnsupportedKnowledgeFormatError();
  if (!shape(value, ['formatVersion', 'recordId', 'recordType', 'schemaVersion', 'projectId', 'createdAt', 'payload', 'relationships', 'provenance', 'integrity'], ['author']) ||
    !recordIdIsValid(value.recordId) || !nonblank(value.projectId) || !nonblank(value.recordType) || !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(value.recordType) ||
    !Number.isSafeInteger(value.schemaVersion) || Number(value.schemaVersion) < 1 || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) throw new Error('Invalid knowledge record envelope.');
  if (Object.hasOwn(value, 'author') && (!shape(value.author, ['id'], ['displayName']) || !nonblank(value.author.id) ||
    (Object.hasOwn(value.author, 'displayName') && !nonblank(value.author.displayName)))) throw new Error('Invalid optional knowledge author.');
  const p = value.provenance;
  if (!p || typeof p !== 'object' || Array.isArray(p) || !(
    (p.kind === 'user-entered' && shape(p, ['kind'])) ||
    (p.kind === 'imported' && shape(p, ['kind', 'source'], ['locator']) && nonblank(p.source)) ||
    (p.kind === 'machine-extracted' && shape(p, ['kind', 'source', 'method'], ['locator']) && nonblank(p.source) && nonblank(p.method))
  ) || (Object.hasOwn(p, 'locator') && !nonblank(p.locator))) throw new Error('Invalid knowledge provenance declaration.');
  if (!Array.isArray(value.relationships)) throw new Error('Invalid knowledge relationships.');
  for (const relationship of value.relationships) {
    if (!shape(relationship, ['relation', 'target', 'binding'])) throw new Error('Invalid stored knowledge relationship.');
    validateRelationshipInput({ relation: relationship.relation, target: relationship.target });
  }
  if (!shape(value.integrity, ['algorithm', 'bodySha256', 'publication']) || value.integrity.algorithm !== 'sha256' || value.integrity.publication !== 'directory-marker-v1' || !checksum(value.integrity.bodySha256) || bodyChecksum(value as unknown as UniversalKnowledgeRecord) !== value.integrity.bodySha256) throw new Error('Knowledge body checksum or publication format mismatch.');
  registry.validate(value.recordType, Number(value.schemaVersion), value.payload);
}
