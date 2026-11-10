import type { FileSystemDirectoryAdapter } from './fs-adapter';

export const CADTREE_SCHEMA_VERSION = 1;
export const MAIN_BRANCH_ID = 'branch-main';

export interface ProjectIdentity {
  schemaVersion: number;
  projectId: string;
  name: string;
  createdAt: string;
  payloadSha256: string;
}

export interface BranchRecord {
  schemaVersion: number;
  branchId: string;
  projectId: string;
  name: string;
  reason: string;
  startingRevisionId: string | null;
  createdAt: string;
  isMain: boolean;
  payloadSha256: string;
}

export interface FileEntry {
  path: string;
  size: number;
  sha256: string;
  lastModified: number;
}

export interface RevisionNotes {
  problem: string;
  modification: string;
  observations: string;
}

export interface FileSpecificNote {
  path: string;
  problem: string;
  modification: string;
  observations: string;
}

export interface RevisionManifest {
  schemaVersion: number;
  projectId: string;
  revisionId: string;
  branchId: string;
  parentRevisionId: string | null;
  displayNumber: number;
  captureStartedAt: string;
  captureCompletedAt: string;
  summary: string;
  notes: RevisionNotes;
  fileNotes?: FileSpecificNote[];
  directories: string[];
  files: FileEntry[];
  manifestPayloadSha256: string;
}

export interface CompletionRecord {
  schemaVersion: number;
  projectId: string;
  revisionId: string;
  branchId: string;
  displayNumber: number;
  manifestSha256: string;
  completedAt: string;
  /** Additive binding for new captures only; old completion records stay unchanged. */
  referenceContext?: { schemaVersion: number; contextSha256: string; boundarySha256: string };
}

export interface ScanErrorEntry {
  path: string;
  error: string;
}

export interface ModifiedFileChange {
  current: FileEntry;
  previous: FileEntry;
}

export interface ScanResult {
  scannedAt: string;
  branchId: string;
  baselineRevisionId: string | null;
  baselineDisplayNumber: number | null;
  added: FileEntry[];
  modified: ModifiedFileChange[];
  deleted: FileEntry[];
  unchanged: FileEntry[];
  directories: string[];
  addedDirectories: string[];
  deletedDirectories: string[];
  errors: ScanErrorEntry[];
  /** Untracked OS-generated files left out of this scan (e.g. .DS_Store). */
  skippedSystemFiles?: string[];
  hasChanges: boolean;
  canCapture: boolean;
  totalBytes: number;
  changesSignature: string;
}

export type RevisionIntegrityStatus =
  | 'manifest_verified'
  | 'objects_verified'
  | 'corrupted';

export interface ReconstructedRevision {
  manifest: RevisionManifest;
  completion: CompletionRecord;
  integrityStatus: RevisionIntegrityStatus;
  integrityErrors: string[];
}

export interface RevisionDiffResult {
  status: 'baseline' | 'compared' | 'unavailable';
  unavailableReason?: string;
  parentRevisionId: string | null;
  parentDisplayNumber: number | null;
  added: FileEntry[];
  modified: ModifiedFileChange[];
  deleted: FileEntry[];
  unchanged: FileEntry[];
  addedDirectories: string[];
  deletedDirectories: string[];
  unchangedDirectories: string[];
}

export interface CorruptedVaultRecord {
  recordPath: string;
  revisionId?: string;
  reason: string;
}

export interface IncompleteAttemptRecord {
  id: string;
  kind: 'uncompleted_manifest' | 'staging_artifact' | 'uncompleted_branch' | 'uncompleted_component' | 'uncompleted_reference';
  path: string;
  detail: string;
}

export interface VaultState {
  /** Independent append-only knowledge store. Failures never enter CAD recovery diagnostics. */
  knowledge?: import('../knowledge/records/types').PersistedKnowledgeEvidence;
  references?: import('./references').ReferenceEvidence;
  components?: import('./component-identity').ComponentEvidence;
  /** Reconstructed endpoint identities only; absence means the saved head is unavailable.
   * Kept separate from ancestry damage so read-only Compare can remain endpoint-local. */
  branchBaselineEndpoints?: Record<string, string | null>;
  caseLifecycles?: Record<string, import('./case-lifecycle').CaseLifecycle>;
  applicationOperations?: import('./application-records').ApplicationOperation[];
  project: ProjectIdentity;
  branches: BranchRecord[];
  revisions: ReconstructedRevision[];
  branchHeads: Record<string, string | null>;
  competingHeads: Record<string, string[]>;
  damagedBranchHeads: Record<string, string>;
  incompleteAttempts: IncompleteAttemptRecord[];
  corruptedRecords: CorruptedVaultRecord[];
}

export interface ProgressUpdate {
  phase:
    | 'acquiring_lock'
    | 'scanning_source'
    | 'writing_objects'
    | 'verifying_objects'
    | 'checking_stability'
    | 'writing_manifest'
    | 'publishing_completion'
    | 'publishing_branch'
    | 'restoring_directories'
    | 'restoring_files'
    | 'verifying_restored_files';
  currentFile?: string;
  processedFiles: number;
  totalFiles: number;
  processedBytes: number;
  totalBytes: number;
  message: string;
}

export interface CaptureRevisionInput {
  referenceAttachments?: import('./references').PendingReferenceAttachment[];
  referenceAuthor?: import('./references').ReferenceAuthor;
  onReferenceAttachmentsStored?: (review: import('./references').ReferenceReview, state: VaultState) => void;
  referenceReview?: import('./references').ReferenceReview;
  identityReview?: import('./component-identity').IdentityReview;
  workingFolders?: Record<string, FileSystemDirectoryAdapter | undefined>;
  resolveWorkingFolders?: (state: VaultState) => Promise<Record<string, FileSystemDirectoryAdapter | undefined>>;
  branchId: string;
  summary: string;
  notes: RevisionNotes;
  fileNotes?: FileSpecificNote[];
  reviewedChangesSignature?: string;
  onProgress?: (progress: ProgressUpdate) => void;
  signal?: AbortSignal;
}

export interface RestoreResult {
  kind: 'full_project' | 'selected_files';
  revisionId: string;
  displayNumber: number;
  selectedPaths?: string[];
  restoredFilesCount: number;
  restoredDirectoriesCount: number;
  verifiedBytes: number;
  destinationName: string;
  completedAt: string;
}

