import type { KnowledgeAttachment, KnowledgeAvailability, KnowledgeRecord, KnowledgeRevision, KnowledgeSource } from './types';
import type { PublishedKnowledgeRecord, StoredKnowledgeSource, UniversalKnowledgeRecord } from './records/types';

export type RetrievalSource = 'm1a-derived' | 'm1b-persisted';
export interface KnowledgeQuery {
  projectId: string;
  sourceType?: RetrievalSource;
  /** Derived note types are m1a.summary/problem/modification/observations. */
  recordType?: string;
  recordId?: string;
  revisionId?: string;
  branchId?: string;
  componentId?: string;
  /** Exact, case-sensitive substring of text / payload string values, not IDs or hashes. */
  text?: string;
  /** Direct outgoing record-to-record link only; no transitive expansion. */
  relatedRecordId?: string;
}

export interface RetrievalIssue {
  code: string;
  status: 'not_recorded' | 'unavailable' | 'unsupported' | 'incomplete';
  source: string;
  reason: string;
  revisionId?: string;
  recordId?: string;
  recordType?: string;
  schemaVersion?: number;
  formatVersion?: number;
  publicationPath?: string;
  /** Unreadable data cannot safely be excluded by text/type/identity filters. */
  relevance: 'scope' | 'unresolved-project';
}

export interface RetrievalContext {
  projectId: string;
  revisionId: string;
  branchId: string;
  source: KnowledgeSource;
  recordedAt: string;
  chronologicalTime: number | null;
  component?: { componentId: string; historicalPath: string; mappingPayloadSha256: string; source: KnowledgeSource };
  ancestry: KnowledgeRevision['history'] & { availability: KnowledgeAvailability };
  fileNotes: KnowledgeAvailability;
  referenceContext: KnowledgeAvailability;
}

export interface RetrievedReference {
  id: string;
  sourceType: RetrievalSource;
  projectId: string;
  revisionId: string;
  branchId: string;
  /** Reference scope remains explicit; null never means an inferred component. */
  attachment: KnowledgeAttachment;
  origin: 'revision-context' | 'persisted-relationship';
  relation: 'context' | 'evidence' | 'related';
  recordId?: string;
  relationshipSource?: StoredKnowledgeSource & { relationshipJsonPointer: string };
  verification: PublishedKnowledgeRecord['verification'];
}

interface RetrievedBase {
  id: string;
  projectId: string;
  recordType: string;
  recordedAt: string;
  chronologicalTime: number | null;
  /** Contexts satisfying all revision/branch/component filters together. */
  contexts: RetrievalContext[];
  references: RetrievedReference[];
  verification: PublishedKnowledgeRecord['verification'];
}
export type RetrievedKnowledgeRecord =
  | (RetrievedBase & { sourceType: 'm1a-derived'; source: KnowledgeSource; content: KnowledgeRecord })
  | (RetrievedBase & { sourceType: 'm1b-persisted'; source: StoredKnowledgeSource; content: UniversalKnowledgeRecord });

export interface KnowledgeRetrieval {
  query: KnowledgeQuery;
  /** Describes record matching only; independent revision reference context may still exist. */
  recordOutcome: 'matches' | 'empty' | 'unavailable';
  /** Readable is a statement about recorded metadata, never complete engineering evidence. */
  coverage: 'readable' | 'incomplete' | 'unavailable';
  componentIdentity?: KnowledgeAvailability;
  records: RetrievedKnowledgeRecord[];
  contexts: RetrievalContext[];
  /** Selected revision context plus citations of matching records. Explicit citations
   * can point outside the ownership filters; their original scope is retained. */
  references: RetrievedReference[];
  issues: RetrievalIssue[];
  limitations: string[];
}

export interface ComponentKnowledgeTimeline extends KnowledgeRetrieval {
  componentId: string;
  /** Snapshot contexts, including unchanged / reference-only revisions, not inferred CAD changes. */
  events: { context: RetrievalContext; records: RetrievedKnowledgeRecord[]; references: RetrievedReference[] }[];
}
