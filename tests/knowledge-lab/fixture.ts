import { compactHex } from '../../src/engine/path-encoding';
import type { ReconstructedRevision, VaultState } from '../../src/engine/types';
import type { ProjectReference } from '../../src/engine/references';
import { hashString } from '../../src/engine/hash';
import { canonicalJson } from '../../src/knowledge/records/json';
import { bodyChecksum, validateEnvelope } from '../../src/knowledge/records/envelope';
import { resolveRelationships } from '../../src/knowledge/records/relationships';
import { defaultKnowledgeSchemas, type JsonObject, type KnowledgeRelationshipInput, type PublishedKnowledgeRecord, type UniversalKnowledgeRecord } from '../../src/knowledge/records';

const date = '2026-11-01T09:00:00Z';
const hash = 'a'.repeat(64);
export const collarId = 'component-00000000-0000-4000-8000-000000000001';
export const spacerId = 'component-00000000-0000-4000-8000-000000000002';

/** Disposable, deterministic simulated VaultState; no disk I/O or real engineering evidence. */
export function syntheticKnowledgeState(): VaultState {
  const projectId = 'synthetic-collar-project';
  const revision = (revisionId: string, parentRevisionId: string | null, displayNumber: number, branchId = 'branch-main'): ReconstructedRevision => ({
    manifest: {
      schemaVersion: 1, projectId, revisionId, parentRevisionId, branchId, displayNumber,
      captureStartedAt: date, captureCompletedAt: date,
      summary: `Collar design study R0${displayNumber}`,
      notes: { problem: 'Collar deflects under axial load.', modification: 'Increase collar thickness from 6 mm to 8 mm.', observations: 'Prototype validation pending.' },
      directories: ['Parts'], files: [
        { path: displayNumber >= 3 ? 'Parts/Collar_plate.SLDPRT' : 'Parts/Collar.SLDPRT', size: 24, sha256: hash, lastModified: 0 },
        { path: 'Parts/Spacer.SLDPRT', size: 16, sha256: hash, lastModified: 0 },
      ], manifestPayloadSha256: hash,
    },
    completion: { schemaVersion: 1, projectId, revisionId, branchId, displayNumber, manifestSha256: hash, completedAt: date },
    integrityStatus: 'manifest_verified', integrityErrors: [],
  });
  const revisions = [revision('r01', null, 1), revision('r02', 'r01', 2), revision('r03', 'r02', 3, 'branch-thicker'), revision('r04', 'r02', 4), revision('r05', 'r04', 5)];
  revisions[1].manifest.fileNotes = [{ path: 'Parts/Collar.SLDPRT', problem: 'Local bending near bolt holes.', modification: 'Add 2 mm thickness.', observations: '' }];
  // R03 intentionally has a component reference with NO file-specific notes.
  revisions[2].manifest.summary = 'Alternative collar plate; confirmed historical rename';
  revisions[3].manifest.fileNotes = [];
  revisions[4].manifest.schemaVersion = 99;
  const reference: ProjectReference = {
    referenceId: 'reference-synthetic-loads', title: 'Synthetic axial load requirement', description: 'Demonstration only', tags: ['fixture'], removed: false, projectVersionId: null,
    versions: [{ referenceId: 'reference-synthetic-loads', versionId: 'reference-version-synthetic-v1', originalFilename: 'synthetic-load-requirement.pdf', fileType: 'application/pdf', size: 256, sha256: hash, importedAt: date }],
  };
  const state: VaultState = {
    project: { schemaVersion: 1, projectId, name: 'Collar assembly · synthetic', createdAt: date, payloadSha256: hash },
    branches: [
      { schemaVersion: 1, projectId, branchId: 'branch-main', name: 'Main', reason: 'Baseline design', startingRevisionId: null, createdAt: date, isMain: true, payloadSha256: hash },
      { schemaVersion: 1, projectId, branchId: 'branch-thicker', name: 'Thicker collar', reason: 'Explore stiffness', startingRevisionId: 'r02', createdAt: date, isMain: false, payloadSha256: hash },
    ],
    revisions, branchHeads: { 'branch-main': 'r05', 'branch-thicker': 'r03' }, competingHeads: {}, damagedBranchHeads: {},
    incompleteAttempts: [{ id: 'synthetic-interrupted-import', kind: 'uncompleted_reference', path: 'references/enrollment/synthetic-pending.json', detail: 'Synthetic interrupted reference import; no published attachment evidence.' }],
    corruptedRecords: [{ recordPath: 'references/contexts/r04.json', reason: 'Synthetic missing committed reference context.' }],
    components: { status: 'available', revisions: {} },
    references: {
      status: 'available', library: [reference], catalogId: 'catalog-synthetic', catalogSha256: hash,
      catalogs: { 'catalog-synthetic': { sha256: hash, record: { schemaVersion: 1, projectId, catalogId: 'catalog-synthetic', parent: null, references: [reference], payloadSha256: hash } } },
      contexts: { r01: { status: 'legacy' }, r04: { status: 'unavailable', reason: 'Synthetic committed context is unavailable.' } },
    },
  };
  for (const r of revisions) {
    const id = r.manifest.revisionId;
    state.components!.revisions[id] = { files: r.manifest.files.map((f, i) => ({ path: f.path, componentId: i ? spacerId : collarId })), payloadSha256: hash, renames: id === 'r03' ? [{ from: 'Parts/Collar.SLDPRT', to: 'Parts/Collar_plate.SLDPRT' }] : [] };
    if (id !== 'r02' && id !== 'r03') continue;
    r.completion.referenceContext = { schemaVersion: 1, contextSha256: hash, boundarySha256: hash };
    state.references!.contexts[id] = { status: 'available', record: {
      schemaVersion: 1, projectId, revisionId: id, branchId: r.manifest.branchId, parentRevisionId: r.manifest.parentRevisionId,
      manifestSha256: hash, boundarySha256: hash, catalogId: 'catalog-synthetic', catalogSha256: hash, contextOnly: false, payloadSha256: hash,
      links: [{ referenceId: reference.referenceId, versionId: reference.versions[0].versionId, origin: 'revision', locator: 'Page 4 · table 2 · axial load', explanation: 'Context for the collar thickness study; not proof of validation.', componentId: collarId, componentPath: r.manifest.files[0].path }],
    } };
  }
  // Simulated published projections only: no filesystem adapter, no actual publication.
  // Bindings and schema validation still use the same M1B contracts as local vaults.
  state.knowledge = { status: 'available', records: [], diagnostics: [] };
  const accepted = new Map<string, PublishedKnowledgeRecord>();
  const add = (recordId: string, recordType: string, payload: JsonObject, relationships: KnowledgeRelationshipInput[]) => {
    const body: Omit<UniversalKnowledgeRecord, 'integrity'> = { formatVersion: 1, recordId, recordType, schemaVersion: 1, projectId,
      createdAt: '2026-11-02T09:00:00.000Z', payload, relationships: resolveRelationships(relationships, state, accepted, recordId), provenance: { kind: 'user-entered' } };
    const record: UniversalKnowledgeRecord = { ...body, integrity: { algorithm: 'sha256', bodySha256: bodyChecksum(body), publication: 'directory-marker-v1' } };
    validateEnvelope(record, defaultKnowledgeSchemas);
    const recordSha256 = hashString(canonicalJson(record));
    const entry: PublishedKnowledgeRecord = { record, source: { recordPath: `knowledge/records/${recordId}.json`, jsonPointer: '', recordSha256,
      bodySha256: record.integrity.bodySha256, publicationPath: `knowledge/completed/${recordId}.${compactHex(recordSha256)}.done`, formatVersion: 1, recordType, schemaVersion: 1 },
      verification: { metadata: 'checksum_verified', attachmentBytes: 'not_checked', claims: 'not_verified' } };
    accepted.set(recordId, entry); state.knowledge!.records.push(entry);
  };
  const designId = '20260101-000000-000001';
  add(designId, 'cad.design-change', { problem: 'Local bending near bolt holes.', change: { status: 'proposed', description: 'Explore an 8 mm collar.' },
    rationale: 'Recorded proposal; validation pending.', propertyChanges: [{ property: 'thickness', before: 6, after: 8, unit: 'mm' }] }, [
    { relation: 'related', target: { kind: 'component', projectId, revisionId: 'r02', componentId: collarId } },
    { relation: 'evidence', target: { kind: 'reference-version', projectId, revisionId: 'r03', referenceId: reference.referenceId, versionId: reference.versions[0].versionId, associationPointer: '/links/0' } },
  ]);
  add('20260101-000000-000002', 'generic.observation', { description: 'Alternative collar study observation.', attributes: { status: 'Not validated', sampleCount: 3 } }, [
    { relation: 'related', target: { kind: 'component', projectId, revisionId: 'r03', componentId: collarId } },
    { relation: 'related', target: { kind: 'record', projectId, recordId: designId } },
  ]);
  return state;
}
