import type { FileSystemDirectoryAdapter, DirectoryEntryInfo } from '../../engine/fs-adapter';
import type { VaultState } from '../../engine/types';
import { hashBytes, hashString } from '../../engine/hash';
import { withProjectWriterLock } from '../../engine/locks';
import { bodyChecksum, UnsupportedKnowledgeFormatError, validateEnvelope } from './envelope';
import { canonicalJson, object, recordIdIsValid, shape } from './json';
import { defaultKnowledgeSchemas, KnowledgeSchemaRegistry, UnsupportedKnowledgeSchemaError } from './registry';
import { resolveRelationships } from './relationships';
import type { CreateKnowledgeRecordInput, KnowledgeRecordDiagnostic, PersistedKnowledgeEvidence, PublishedKnowledgeRecord, UniversalKnowledgeRecord } from './types';

const ROOT = 'knowledge';
const idPattern = 'knowledge-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const filePattern = new RegExp(`^(${idPattern})\\.json$`);
const markerPattern = new RegExp(`^(${idPattern})\\.([a-f0-9]{64})\\.done$`);
const prefixPattern = new RegExp(`^(${idPattern})(?=\\.|$)`);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const verification = () => ({ metadata: 'checksum_verified', attachmentBytes: 'not_checked', claims: 'not_verified' } as const);

export function knowledgeRecordPath(recordId: string): string[] {
  if (!recordIdIsValid(recordId)) throw new Error('Invalid permanent knowledge record ID.');
  return [ROOT, 'records', `${recordId}.json`];
}

export function knowledgePublicationPath(recordId: string, sha256: string): string[] {
  return [ROOT, 'completed', `${recordId}.${sha256}.done`];
}

function header(value: unknown): Pick<KnowledgeRecordDiagnostic, 'recordType' | 'schemaVersion' | 'formatVersion'> {
  if (!object(value)) return {};
  return {
    ...(typeof value.recordType === 'string' ? { recordType: value.recordType } : {}),
    ...(typeof value.schemaVersion === 'number' ? { schemaVersion: value.schemaVersion } : {}),
    ...(typeof value.formatVersion === 'number' ? { formatVersion: value.formatVersion } : {}),
  };
}

/** Read-only, failure-isolated reconstruction. Never modifies CAD diagnostics or stored bytes. */
export async function reconstructKnowledgeRecords(
  vault: FileSystemDirectoryAdapter, state: VaultState, registry: KnowledgeSchemaRegistry = defaultKnowledgeSchemas,
): Promise<PersistedKnowledgeEvidence> {
  const result: PersistedKnowledgeEvidence = { status: 'not_recorded', records: [], diagnostics: [] };
  const diagnose = (diagnostic: KnowledgeRecordDiagnostic) => result.diagnostics.push(diagnostic);
  try {
    const roots = (await vault.listEntries()).filter(e => e.name.toLowerCase() === ROOT);
    if (!roots.length) return result;
    result.status = 'unavailable';
    if (roots.length !== 1 || roots[0].name !== ROOT || roots[0].kind !== 'directory') throw new Error('Knowledge storage root is invalid or ambiguous.');
    const root = await vault.getDirectory([ROOT]);
    const rootEntries = await root.listEntries();
    const entries = async (name: string): Promise<DirectoryEntryInfo[]> => {
      const matching = rootEntries.filter(e => e.name.toLowerCase() === name);
      if (!matching.length) return [];
      if (matching.length !== 1 || matching[0].kind !== 'directory' || matching[0].name !== name) throw new Error(`Invalid knowledge ${name} directory.`);
      return (await root.getDirectory([name])).listEntries();
    };
    const files = await entries('records'), markers = await entries('completed');
    const ids = new Map<string, { files: DirectoryEntryInfo[]; markers: DirectoryEntryInfo[] }>();
    const group = (id: string) => {
      if (!ids.has(id)) ids.set(id, { files: [], markers: [] });
      return ids.get(id)!;
    };
    for (const e of rootEntries.filter(e => !['records', 'completed'].includes(e.name))) diagnose({ status: 'unsupported', recordPath: `${ROOT}/${e.name}`, reason: 'Unrecognized knowledge storage entry; original data retained.' });
    for (const e of files) {
      const match = filePattern.exec(e.name);
      if (match) group(match[1]).files.push(e);
      else {
        const id = prefixPattern.exec(e.name)?.[1];
        if (id) group(id).files.push(e);
        else diagnose({ status: 'unsupported', recordPath: `${ROOT}/records/${e.name}`, reason: 'Unrecognized knowledge record filename; original data retained.' });
      }
    }
    for (const e of markers) {
      const id = prefixPattern.exec(e.name)?.[1];
      if (id) group(id).markers.push(e);
      else diagnose({ status: 'unsupported', recordPath: `${ROOT}/completed/${e.name}`, reason: 'Unrecognized knowledge publication; original data retained.' });
    }
    const candidates = new Map<string, PublishedKnowledgeRecord>();
    for (const [id, group] of [...ids].sort(([a], [b]) => compare(a, b))) {
      const recordPath = knowledgeRecordPath(id).join('/');
      const publicationPath = group.markers.length === 1 ? `${ROOT}/completed/${group.markers[0].name}` : undefined;
      let parsed: unknown;
      try {
        if (group.files.length !== 1 || group.files[0].kind !== 'file' || group.files[0].name !== `${id}.json`) throw new Error('Knowledge record file is missing, ambiguous or not a regular file.');
        const bytes = await vault.readFileBytes(recordPath.split('/'));
        let raw: string;
        try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); parsed = JSON.parse(raw); }
        catch (error) {
          if (!group.markers.length) {
            diagnose({ status: 'incomplete', recordId: id, recordPath, reason: 'Unpublished knowledge record is incomplete or unreadable JSON.' });
            continue;
          }
          throw error;
        }
        if (!group.markers.length) {
          diagnose({ status: 'incomplete', recordId: id, ...header(parsed), recordPath, reason: 'Knowledge record has no final publication marker. Its identity remains reserved.' });
          continue;
        }
        if (group.markers.length !== 1) throw new Error('Competing knowledge publications for the same permanent identity.');
        const marker = markerPattern.exec(group.markers[0].name);
        if (!marker || group.markers[0].kind !== 'directory') throw new Error('Invalid knowledge publication marker.');
        if ((await (await vault.getDirectory(publicationPath!.split('/'))).listEntries()).length) throw new Error('Knowledge publication marker is not empty.');
        const recordSha256 = hashBytes(bytes);
        if (recordSha256 !== marker[2]) throw new Error('Knowledge record bytes do not match the published SHA-256.');
        validateEnvelope(parsed, registry);
        if (canonicalJson(parsed) !== raw) throw new Error('Knowledge record is not canonically serialized.');
        if (parsed.recordId !== id || parsed.projectId !== state.project.projectId) throw new Error('Knowledge record identity or project binding mismatch.');
        candidates.set(id, {
          record: parsed,
          source: { recordPath, jsonPointer: '', recordSha256, bodySha256: parsed.integrity.bodySha256,
            publicationPath: publicationPath!, formatVersion: 1, recordType: parsed.recordType, schemaVersion: parsed.schemaVersion },
          verification: verification(),
        });
      } catch (error) {
        diagnose({ status: error instanceof UnsupportedKnowledgeSchemaError || error instanceof UnsupportedKnowledgeFormatError ? 'unsupported' : 'unavailable',
          recordId: id, ...header(parsed), recordPath, ...(publicationPath ? { publicationPath } : {}), reason: errorText(error) });
      }
    }
    // Existing accepted records are the only valid knowledge-record targets. No forward
    // declarations or cyclic claims are trusted. Repeated passes only resolve this DAG.
    const accepted = new Map<string, PublishedKnowledgeRecord>();
    while (candidates.size) {
      let progressed = false;
      for (const [id, candidate] of candidates) {
        const dependencies = candidate.record.relationships.flatMap(r => r.target.kind === 'record' ? [r.target.recordId] : []);
        if (dependencies.some(dependency => candidates.has(dependency))) continue;
        candidates.delete(id); progressed = true;
        try {
          const inputs = candidate.record.relationships.map(({ relation, target }) => ({ relation, target }));
          if (canonicalJson(resolveRelationships(inputs, state, accepted, id)) !== canonicalJson(candidate.record.relationships)) throw new Error('Knowledge relationship provenance no longer matches reconstructed evidence.');
          accepted.set(id, candidate);
        } catch (error) {
          diagnose({ status: 'unavailable', recordId: id, ...header(candidate.record), recordPath: candidate.source.recordPath, publicationPath: candidate.source.publicationPath, reason: errorText(error) });
        }
      }
      if (!progressed) {
        for (const [id, candidate] of candidates) diagnose({ status: 'unavailable', recordId: id, ...header(candidate.record), recordPath: candidate.source.recordPath, publicationPath: candidate.source.publicationPath, reason: 'Cyclic or unresolved knowledge-record dependency.' });
        break;
      }
    }
    result.records = [...accepted.values()].sort((a, b) => compare(a.record.recordId, b.record.recordId));
    if (!files.length && !markers.length) diagnose({ status: 'incomplete', recordPath: ROOT, reason: 'Knowledge storage contains no record publications.' });
    result.status = 'available';
  } catch (error) {
    result.status = 'unavailable'; result.records = [];
    diagnose({ status: 'unavailable', recordPath: ROOT, reason: errorText(error) });
  }
  result.diagnostics.sort((a, b) => compare(a.recordPath, b.recordPath) || compare(a.reason, b.reason));
  return result;
}

export class KnowledgePublicationError extends Error {
  constructor(message: string, readonly recordId: string, readonly recordPath: string, readonly publicationMayExist: boolean) {
    super(message); this.name = 'KnowledgePublicationError';
  }
}

/** Create-only append. The actual recording timestamp is assigned here, never copied from a revision. */
export async function createKnowledgeRecord(
  vault: FileSystemDirectoryAdapter, input: CreateKnowledgeRecordInput, registry: KnowledgeSchemaRegistry = defaultKnowledgeSchemas,
): Promise<PublishedKnowledgeRecord> {
  const snapshot: CreateKnowledgeRecordInput = JSON.parse(canonicalJson(input));
  if (!shape(snapshot, ['projectId', 'recordType', 'schemaVersion', 'payload', 'relationships', 'provenance'], ['recordId', 'author'])) throw new Error('Invalid knowledge creation input.');
  if (Object.hasOwn(snapshot, 'recordId') && !recordIdIsValid(snapshot.recordId)) throw new Error('Invalid permanent knowledge record ID.');
  return withProjectWriterLock(snapshot.projectId, async () => {
    const { openExistingVault } = await import('../../engine/vault-service');
    const state = await openExistingVault(vault, { knowledgeSchemas: registry });
    if (state.project.projectId !== snapshot.projectId) throw new Error('Knowledge owner does not match this vault project.');
    if (state.knowledge?.status === 'unavailable') throw new Error('Knowledge storage cannot be inspected safely.');
    const id = snapshot.recordId ?? `knowledge-${crypto.randomUUID()}`;
    const path = knowledgeRecordPath(id);
    if (state.knowledge?.records.some(r => r.record.recordId === id) || state.knowledge?.diagnostics.some(d => d.recordId === id)) throw new Error('Knowledge record identity already exists or is reserved by an incomplete publication.');
    const accepted = new Map((state.knowledge?.records ?? []).map(r => [r.record.recordId, r]));
    const body: Omit<UniversalKnowledgeRecord, 'integrity'> = {
      formatVersion: 1, recordId: id, recordType: snapshot.recordType, schemaVersion: snapshot.schemaVersion,
      projectId: snapshot.projectId, createdAt: new Date().toISOString(),
      ...(Object.hasOwn(snapshot, 'author') ? { author: snapshot.author } : {}), payload: snapshot.payload,
      relationships: resolveRelationships(snapshot.relationships, state, accepted, id), provenance: snapshot.provenance,
    };
    const record: UniversalKnowledgeRecord = { ...body, integrity: { algorithm: 'sha256', bodySha256: bodyChecksum(body), publication: 'directory-marker-v1' } };
    validateEnvelope(record, registry);
    const raw = canonicalJson(record), sha256 = hashString(raw);
    const publication = knowledgePublicationPath(id, sha256);
    let publicationMayExist = false;
    try {
      await vault.writeFileText(path, raw, { exclusive: true });
      // Re-read project/relationship evidence after the write and before final publication.
      const refreshed = await openExistingVault(vault, { knowledgeSchemas: registry });
      if (refreshed.project.projectId !== snapshot.projectId || refreshed.knowledge?.status === 'unavailable') throw new Error('Knowledge project or storage changed before publication.');
      const ownDiagnostics = refreshed.knowledge?.diagnostics.filter(d => d.recordId === id) ?? [];
      if (refreshed.knowledge?.records.some(r => r.record.recordId === id) || ownDiagnostics.length !== 1 || ownDiagnostics[0].status !== 'incomplete') throw new Error('Knowledge identity reservation changed before publication.');
      const current = new Map((refreshed.knowledge?.records ?? []).map(r => [r.record.recordId, r]));
      if (canonicalJson(resolveRelationships(snapshot.relationships, refreshed, current, id)) !== canonicalJson(record.relationships)) throw new Error('Knowledge target evidence changed before publication.');
      if (hashBytes(await vault.readFileBytes(path)) !== sha256) throw new Error('Knowledge record readback failed before publication.');
      publicationMayExist = true;
      const marker = await vault.getDirectory(publication, { create: true, exclusiveCreate: true });
      if ((await marker.listEntries()).length) throw new Error('Knowledge publication marker is not empty.');
      const reopened = await openExistingVault(vault, { knowledgeSchemas: registry });
      const published = reopened.knowledge?.records.find(r => r.record.recordId === id);
      if (!published) throw new Error('Knowledge publication could not be confirmed; inspect reconstruction before retrying.');
      return published;
    } catch (error) {
      throw new KnowledgePublicationError(`Knowledge publication failed: ${errorText(error)} Reopen the vault to inspect this identity; never overwrite it.`, id, path.join('/'), publicationMayExist);
    }
  });
}

/** Reconstruct on every read; stale in-memory acceptance never bypasses current integrity checks. */
export async function readKnowledgeRecord(vault: FileSystemDirectoryAdapter, projectId: string, recordId: string, registry: KnowledgeSchemaRegistry = defaultKnowledgeSchemas): Promise<PublishedKnowledgeRecord | undefined> {
  knowledgeRecordPath(recordId);
  const { openExistingVault } = await import('../../engine/vault-service');
  const state = await openExistingVault(vault, { knowledgeSchemas: registry });
  if (state.project.projectId !== projectId) throw new Error('Knowledge owner does not match this vault project.');
  if (state.knowledge?.status === 'unavailable' || state.knowledge?.diagnostics.some(d => d.recordId === recordId)) throw new Error('Knowledge record is unavailable, unsupported or unpublished.');
  return state.knowledge?.records.find(r => r.record.recordId === recordId);
}
