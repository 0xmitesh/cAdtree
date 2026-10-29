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
  hasChanges: boolean;
  canCapture: boolean;
  totalBytes: number;
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

export interface CorruptedVaultRecord {
  recordPath: string;
  revisionId?: string;
  reason: string;
}

export interface IncompleteAttemptRecord {
  id: string;
  kind: 'uncompleted_manifest' | 'staging_artifact';
  path: string;
  detail: string;
}

export interface VaultState {
  project: ProjectIdentity;
  branches: BranchRecord[];
  revisions: ReconstructedRevision[];
  branchHeads: Record<string, string | null>;
  competingHeads: Record<string, string[]>;
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
  branchId: string;
  summary: string;
  notes: RevisionNotes;
  onProgress?: (progress: ProgressUpdate) => void;
  signal?: AbortSignal;
}

export interface RestoreResult {
  revisionId: string;
  displayNumber: number;
  restoredFilesCount: number;
  restoredDirectoriesCount: number;
  verifiedBytes: number;
  destinationName: string;
  completedAt: string;
}
