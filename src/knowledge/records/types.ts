export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export type KnowledgeProvenance =
  | { kind: 'user-entered' }
  | { kind: 'imported'; source: string; locator?: string }
  | { kind: 'machine-extracted'; source: string; method: string; locator?: string };

export type KnowledgeTarget =
  | { kind: 'revision'; projectId: string; revisionId: string }
  | { kind: 'component'; projectId: string; revisionId: string; componentId: string }
  | { kind: 'reference-version'; projectId: string; revisionId: string; referenceId: string; versionId: string; associationPointer: string }
  | { kind: 'record'; projectId: string; recordId: string };

/** An evidence link is an assertion by the record's origin, not independent verification. */
export interface KnowledgeRelationshipInput {
  relation: 'related' | 'context' | 'evidence';
  target: KnowledgeTarget;
}

/** Durable provenance fields only: never persist derived availability messages. */
export interface RevisionMetadataSource {
  recordPath: string;
  jsonPointer: string;
  manifestSha256: string;
  manifestPayloadSha256: string;
}

export interface ReferenceAssociationBinding {
  referenceId: string;
  versionId: string;
  sha256: string;
  size: number;
  originalFilename: string;
  fileType: string;
  locator: string;
  explanation: string;
  origin: 'project' | 'revision';
  componentId: string | null;
  componentPath: string | null;
  source: {
    recordPath: string;
    jsonPointer: string;
    contextSha256: string;
    contextPayloadSha256: string;
    boundarySha256: string;
    catalogId: string;
    catalogSha256: string;
  };
}

export type RelationshipBinding =
  | { kind: 'revision'; source: RevisionMetadataSource; branchId: string }
  | { kind: 'component'; source: RevisionMetadataSource; branchId: string; mappingPayloadSha256: string; historicalPath: string }
  | { kind: 'reference-version'; association: ReferenceAssociationBinding }
  | { kind: 'record'; source: StoredKnowledgeSource };

export interface KnowledgeRelationship extends KnowledgeRelationshipInput { binding: RelationshipBinding }

/** Storage format version is independent of the payload's (recordType, schemaVersion). */
export interface UniversalKnowledgeRecord {
  formatVersion: 1;
  recordId: string;
  recordType: string;
  schemaVersion: number;
  projectId: string;
  createdAt: string;
  author?: { id: string; displayName?: string };
  payload: JsonObject;
  relationships: KnowledgeRelationship[];
  provenance: KnowledgeProvenance;
  integrity: { algorithm: 'sha256'; bodySha256: string; publication: 'directory-marker-v1' };
}

export interface CreateKnowledgeRecordInput {
  projectId: string;
  /** Optional caller-supplied permanent identity, e.g. for a controlled import. Never reused. */
  recordId?: string;
  recordType: string;
  schemaVersion: number;
  author?: UniversalKnowledgeRecord['author'];
  payload: JsonObject;
  relationships: KnowledgeRelationshipInput[];
  provenance: KnowledgeProvenance;
}

export interface StoredKnowledgeSource {
  recordPath: string;
  jsonPointer: '';
  recordSha256: string;
  bodySha256: string;
  publicationPath: string;
  formatVersion: 1;
  recordType: string;
  schemaVersion: number;
}

export interface PublishedKnowledgeRecord {
  record: UniversalKnowledgeRecord;
  source: StoredKnowledgeSource;
  /** Metadata acceptance never verifies engineering correctness or source document bytes. */
  verification: { metadata: 'checksum_verified'; attachmentBytes: 'not_checked'; claims: 'not_verified' };
}

export interface KnowledgeRecordDiagnostic {
  status: 'incomplete' | 'unavailable' | 'unsupported';
  recordId?: string;
  recordType?: string;
  schemaVersion?: number;
  formatVersion?: number;
  recordPath: string;
  publicationPath?: string;
  reason: string;
}

export interface PersistedKnowledgeEvidence {
  status: 'not_recorded' | 'available' | 'unavailable';
  records: PublishedKnowledgeRecord[];
  diagnostics: KnowledgeRecordDiagnostic[];
}

export type CadDesignChangePayload = JsonObject & {
  problem: string;
  change: { status: 'proposed' | 'implemented'; description: string };
  rationale: string;
  propertyChanges?: { property: string; before: JsonValue; after: JsonValue; unit?: string }[];
  assumptions?: string[];
  observations?: string[];
}

export type GenericObservationPayload = JsonObject & {
  description: string;
  attributes?: JsonObject;
}
