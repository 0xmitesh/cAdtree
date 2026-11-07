/** In-memory views only; these types are not a vault storage schema. */
export type KnowledgeAvailability =
  | { status: 'available' }
  | { status: 'not_recorded' | 'unavailable' | 'unsupported'; reason: string };

export interface KnowledgeSource {
  /** Vault-relative immutable manifest and RFC 6901 JSON pointer. */
  recordPath: string;
  jsonPointer: string;
  manifestSha256: string;
  manifestPayloadSha256: string;
}

export interface KnowledgeAttachment {
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
  /** Context association, never a claim that this attachment proves a note. */
  scope: 'project' | 'revision' | 'component';
  source: {
    recordPath: string;
    jsonPointer: string;
    contextSha256: string;
    contextPayloadSha256: string;
    boundarySha256: string;
    catalogId: string;
    catalogSha256: string;
  };
  metadata: { status: 'available' };
  /** VaultState has no current attachment-byte verification result. */
  content: { status: 'unavailable'; reason: string };
}

export interface KnowledgeRecord {
  /** Collision-free tuple of project, revision and source pointer, not text/path inference. */
  id: string;
  projectId: string;
  revisionId: string;
  branchId: string;
  scope: 'project' | 'file';
  kind: 'summary' | 'problem' | 'modification' | 'observations';
  /** Empty/whitespace text means an empty field, never absence of an engineering issue. */
  status: 'recorded' | 'empty';
  text: string;
  source: KnowledgeSource;
  filePath?: string;
  componentId?: string;
  component?: KnowledgeAvailability;
  references: KnowledgeAvailability;
  attachments: KnowledgeAttachment[];
}

export interface KnowledgeRevision {
  revisionId: string;
  branchId: string;
  notes: KnowledgeAvailability;
  fileNotes: KnowledgeAvailability;
  history: {
    recordedParentRevisionId: string | null;
    validatedParentRevisionId: string | null;
    /** Includes this revision, as defined by ancestryOf. Only validated edges. */
    ancestry: string[];
    warnings: string[];
  };
}

export interface KnowledgeIndex {
  projectId: string;
  records: KnowledgeRecord[];
  revisions: KnowledgeRevision[];
  branches: {
    branchId: string;
    startingRevisionId: string | null;
    origin: KnowledgeAvailability;
  }[];
  /** Vault diagnostics remain visible even if no readable revision exists. */
  diagnostics: { source: string; reason: string }[];
}
