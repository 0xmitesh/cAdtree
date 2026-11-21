import {
  FileConflictError,
  FileSystemDirectoryAdapter,
  splitAndValidatePath,
  validateDirectoryIsolation,
} from './fs-adapter';
import { hashString } from './hash';
import { assertHoldsProjectWriterLock, withProjectWriterLock, type ProjectWriterLock } from './locks';
import { applicationCaptureBlock, branchApplications, linkApplicationCapture } from './application-records';
import { assertCaseWritable } from './case-lifecycle';
import { componentRecordPath, prepareComponentRecord, publishComponentRecord } from './component-identity';
import { newRecordId } from './ids';
import { prepareReferenceContext, referenceContextPath, referenceContextSignature, ensureReferenceStore, verifyReferenceContextContent, verifyReferencePublication, publishReferenceContext, storeCaptureReferenceAttachments } from './references';
import { getBranchBaseline, validateOperationWorkingFolders } from './branch-state';
import { getStagingSessionPathSegments, writeAndVerifyObject } from './object-store';
import { enumerateWorkingFolder, partitionSystemErrors, partitionSystemFiles, scanBranchChanges } from './scanner';
import {
  CADTREE_SCHEMA_VERSION,
  CaptureRevisionInput,
  CompletionRecord,
  ExpectedWorkingSnapshot,
  ReconstructedRevision,
  RevisionManifest,
  ScanResult,
  VaultState,
} from './types';
import {
  computeManifestPayloadChecksum,
  openExistingVault,
  sanitizeFileSpecificNotes,
  formatRevisionNumber,
} from './vault-service';

export class ReviewStaleError extends Error {
  readonly freshScan: ScanResult;
  constructor(message: string, freshScan: ScanResult) {
    super(message);
    this.name = 'ReviewStaleError';
    this.freshScan = freshScan;
  }
}

/** Capture's fresh scan differed from the caller's `expectedSnapshot`; nothing was written. */
export class WorkingFilesChangedError extends Error {
  readonly freshScan: ScanResult;
  constructor(freshScan: ScanResult) {
    super('The working files changed while saving; nothing was saved. Review the changes and save again.');
    this.name = 'WorkingFilesChangedError';
    this.freshScan = freshScan;
  }
}

/** Duplicate entries are a caller bug, not a working-folder change. */
function assertValidSnapshot(expected: ExpectedWorkingSnapshot): void {
  const paths = expected.files.map((f) => f.path);
  if (new Set(paths).size !== paths.length) throw new Error('Invalid expected snapshot: a file path is listed twice.');
  if (new Set(expected.directories).size !== expected.directories.length) throw new Error('Invalid expected snapshot: a folder is listed twice.');
}

/** True when the scan's tracked files and folders are exactly the expected ones. */
function scanMatchesSnapshot(scan: ScanResult, expected: ExpectedWorkingSnapshot): boolean {
  const files = [...scan.added, ...scan.modified.map((m) => m.current), ...scan.unchanged];
  if (files.length !== expected.files.length) return false;
  const expectedFiles = new Map(expected.files.map((f) => [f.path, f]));
  for (const file of files) {
    const want = expectedFiles.get(file.path);
    if (!want || want.sha256 !== file.sha256 || want.size !== file.size) return false;
  }
  const expectedDirs = new Set(expected.directories);
  if (scan.directories.length !== expectedDirs.size) return false;
  return scan.directories.every((dir) => expectedDirs.has(dir));
}

export const revisionManifestPath = (revisionId: string): string[] => ['revisions', `${revisionId}.manifest.json`];
export const revisionCompletionPath = (revisionId: string): string[] => ['completed', `${revisionId}.done.json`];

export interface CaptureRevisionResult {
  revision: ReconstructedRevision;
  vaultState: VaultState;
  cacheWarning?: string;
}

/** How many record IDs a capture draws before giving up (nothing is written by then). */
export const MAX_REVISION_ID_ATTEMPTS = 5;

/**
 * Captures and publishes a complete revision snapshot following the 7-step
 * Write and Publication Protocol under the project writer lock.
 */
export async function captureRevision(
  workingDir: FileSystemDirectoryAdapter,
  vaultDir: FileSystemDirectoryAdapter,
  input: CaptureRevisionInput
): Promise<CaptureRevisionResult> {
  const cleanSummary = input.summary.trim();
  if (!cleanSummary) {
    throw new Error('Version summary is required.');
  }

  await validateDirectoryIsolation(workingDir, vaultDir, 'Working folder', 'Version vault');

  // Peek project ID first so we can lock on the exact projectId
  const initialVaultState = await openExistingVault(vaultDir);
  const projectId = initialVaultState.project.projectId;

  input.onProgress?.({
    phase: 'acquiring_lock',
    processedFiles: 0,
    totalFiles: 0,
    processedBytes: 0,
    totalBytes: 0,
    message: 'Waiting for other cAdtree work on this project to finish...',
  });

  return withProjectWriterLock(projectId, (lock) => captureUnderLock(workingDir, vaultDir, input, projectId, lock));
}

/**
 * Everything `captureRevision` does inside the project writer lock, for a caller
 * that ALREADY holds `withProjectWriterLock(projectId, ...)` (e.g. an Apply that
 * saves in the same locked operation). Such a caller must not call
 * `captureRevision`: `locks.ts` queues a second request for the same lock name
 * behind the first (in-process promise chain, then `navigator.locks` exclusive
 * mode), so a nested acquisition would wait for the outer one to release - which
 * only happens after the nested call returns. That is a deadlock, not reentrancy.
 *
 * Preconditions: the caller holds the writer lock for `projectId` and passes
 * the `lock` token `withProjectWriterLock` gave it (checked here), and
 * `workingDir` and `vaultDir` have passed `validateDirectoryIsolation` (checked
 * by `captureRevision` before it takes the lock). The vault is reloaded here and
 * must still have `projectId`.
 */
export async function captureUnderLock(
  workingDir: FileSystemDirectoryAdapter,
  vaultDir: FileSystemDirectoryAdapter,
  input: CaptureRevisionInput,
  projectId: string,
  lock: ProjectWriterLock
): Promise<CaptureRevisionResult> {
  assertHoldsProjectWriterLock(lock, projectId);
  const cleanSummary = input.summary.trim();
  if (!cleanSummary) {
    throw new Error('Version summary is required.');
  }
  if (input.expectedSnapshot) assertValidSnapshot(input.expectedSnapshot);
  // Files the caller expects to save count as tracked, so listed OS clutter is kept.
  const expectedPaths = input.expectedSnapshot?.files.map((f) => f.path) ?? [];

  if (input.signal?.aborted) {
    throw new DOMException('Saving was cancelled before it started.', 'AbortError');
  }

  // Step 1: Reload validated vault and branch state under the writer lock
  let vaultState = await openExistingVault(vaultDir);
  if (vaultState.project.projectId !== projectId) throw new Error('The project changed while waiting for another cAdtree task to finish.');
  assertCaseWritable(vaultState,input.branchId);
  const applicationBlock = applicationCaptureBlock(vaultState, input.branchId);
  if (applicationBlock) throw new Error(applicationBlock);
  // A retry of the same reviewed capture reconciles its already-published
  // revision. Provenance is consumed by a verified completion, not a cache or
  // a fallible post-publication acknowledgement.
  const reconciled = input.reviewedChangesSignature && branchApplications(vaultState, input.branchId).find(op => op.status === 'captured' && op.events.some(event => event.kind === 'capture' && event.revisionId === op.capturedRevisionId && event.reviewedChangesSignature === input.reviewedChangesSignature));
  if (reconciled) {
    const revision = vaultState.revisions.find(r => r.manifest.revisionId === reconciled.capturedRevisionId)!;
    return { revision, vaultState, cacheWarning: 'This change was already saved as a version; no duplicate was created.' };
  }
  const pendingApplication = branchApplications(vaultState, input.branchId).find(op => op.status === 'applied');
  getBranchBaseline(vaultState, input.branchId);
  const workingFolders = input.resolveWorkingFolders ? await input.resolveWorkingFolders(vaultState) : input.workingFolders;
  await validateOperationWorkingFolders(vaultState, vaultDir, workingFolders);
  if (workingFolders) {
    const connected = workingFolders[input.branchId];
    if (!connected || !await connected.isSameEntry(workingDir)) throw new Error('The working folder does not match the selected case.');
  }
  const branch = vaultState.branches.find((b) => b.branchId === input.branchId);
  if (!branch) {
    throw new Error(`Case "${input.branchId}" does not exist in vault.`);
  }

  if (vaultState.damagedBranchHeads[branch.branchId]) {
    throw new Error(vaultState.damagedBranchHeads[branch.branchId]);
  }

  if (vaultState.competingHeads[branch.branchId]?.length) {
    throw new Error(
      `Case "${branch.name}" has competing heads (${vaultState.competingHeads[
        branch.branchId
      ].join(', ')}). Fix this before saving new versions.`
    );
  }

  const parentRevisionId =
    vaultState.branchHeads[branch.branchId] ?? branch.startingRevisionId ?? null;
  if (pendingApplication && pendingApplication.record!.plan.destinationRevisionId !== parentRevisionId) throw new Error('The pending Bring back or Copy no longer matches this case. Check its record before saving.');
  let baselineManifest: RevisionManifest | null = null;

  if (parentRevisionId) {
    const parentRev = vaultState.revisions.find(
      (r) => r.manifest.revisionId === parentRevisionId
    );
    if (!parentRev) {
      throw new Error(
        `Baseline version "${parentRevisionId}" referenced by case "${branch.name}" is missing from committed history.`
      );
    }
    if (parentRev.integrityStatus === 'corrupted') {
      throw new Error(
        `Baseline version ${formatRevisionNumber(parentRev.manifest.displayNumber)} is marked as corrupted and cannot be used as a parent baseline.`
      );
    }
    baselineManifest = parentRev.manifest;
  }

  const maxDisplayNumber = vaultState.revisions.reduce(
    (max, r) => Math.max(max, r.manifest.displayNumber, r.completion.displayNumber),
    0
  );
  const nextDisplayNumber = maxDisplayNumber + 1;
  const captureStartedAt = new Date().toISOString();

  // Step 2: Capture fresh source inventory and stream file data with bounded memory
  input.onProgress?.({
    phase: 'scanning_source',
    processedFiles: 0,
    totalFiles: 0,
    processedBytes: 0,
    totalBytes: 0,
    message: 'Checking your files...',
  });

  const freshScan = await scanBranchChanges(
    workingDir,
    branch.branchId,
    baselineManifest,
    {
      signal: input.signal,
      alsoTrackedPaths: expectedPaths,
      onProgress: (filePath, count, bytes) => {
        input.onProgress?.({
          phase: 'scanning_source',
          currentFile: filePath,
          processedFiles: count,
          totalFiles: count,
          processedBytes: bytes,
          totalBytes: bytes,
          message: `Reading ${filePath}...`,
        });
      },
    }
  );

  if (freshScan.errors.length > 0) {
    const firstErr = freshScan.errors[0];
    throw new Error(
      `Nothing was saved because a file could not be read (${firstErr.path}): ${firstErr.error}`
    );
  }

  // The caller's exact expected content (e.g. an Apply's result): any edit made
  // meanwhile must never be swept into this revision. Checked before any write.
  if (input.expectedSnapshot && !scanMatchesSnapshot(freshScan, input.expectedSnapshot)) {
    throw new WorkingFilesChangedError(freshScan);
  }

  // Refresh the scan through the existing review path before validating either
  // identity or reference selections bound to that scan.
  if (input.reviewedChangesSignature && freshScan.changesSignature !== input.reviewedChangesSignature) {
    throw new ReviewStaleError('Working folder changes differ from the file list you reviewed. The change list has been refreshed - please review your file changes and notes before saving.', freshScan);
  }
  const componentDraft = prepareComponentRecord(vaultState, freshScan, input.identityReview);
  let referenceDraft = prepareReferenceContext(vaultState, freshScan, componentDraft?.files ?? [], input.referenceReview);
  const previousReferences = parentRevisionId ? vaultState.references?.contexts[parentRevisionId]?.record?.links ?? [] : [];
  const referenceChanged = Boolean(input.referenceAttachments?.length) || referenceContextSignature(referenceDraft.links) !== referenceContextSignature(previousReferences);
  const referenceContextOnly = !freshScan.hasChanges && referenceChanged && !input.identityReview?.replacements.length;
  if (!freshScan.hasChanges && !input.identityReview?.replacements.length && !referenceChanged) {
    throw new Error(
      'No changes detected between the working folder and the latest saved version. Capture skipped to avoid an unnecessary version.'
    );
  }

  const sanitizedFileNotes = sanitizeFileSpecificNotes(input.fileNotes);

  const allSnapshotFiles = [
    ...freshScan.added,
    ...freshScan.modified.map((m) => m.current),
    ...freshScan.unchanged,
  ].sort((a, b) => a.path.localeCompare(b.path));

  if (sanitizedFileNotes && sanitizedFileNotes.length > 0) {
    const validPaths = new Set<string>([
      ...allSnapshotFiles.map((f) => f.path),
      ...freshScan.deleted.map((f) => f.path),
    ]);
    for (const fn of sanitizedFileNotes) {
      if (!validPaths.has(fn.path)) {
        throw new ReviewStaleError(
          `File-specific note refers to "${fn.path}", which is not in the current snapshot or deleted file set. Please review your file notes.`,
          freshScan
        );
      }
    }
  }

  await verifyReferenceContextContent(vaultDir, vaultState, referenceDraft, input.signal);
  if (input.referenceAttachments?.length) {
    const stored = await storeCaptureReferenceAttachments(vaultDir, vaultState, freshScan, componentDraft?.files ?? [], input.referenceReview, input.referenceAttachments, { signal: input.signal, onProgress: input.onProgress, savedBy: input.referenceAuthor });
    vaultState = stored.state;
    referenceDraft = prepareReferenceContext(vaultState, freshScan, componentDraft?.files ?? [], stored.review);
    // Preserve published imports in the caller's draft if a later capture step fails.
    input.onReferenceAttachmentsStored?.(stored.review, vaultState);
  }
  const referenceBoundary = await ensureReferenceStore(vaultDir, vaultState);

  // The first revision-specific write (after all review validation, so a rejected capture writes nothing) is the exclusive creation of its staging session folder,
  // which claims the record ID. A clash (existing revision files, leftover attempt) draws a
  // new ID before anything else is written; other revisions' files are never touched.
  let revisionId = '';
  let sessionId = '';
  for (let attempt = 1; ; attempt++) {
    const candidate = (input.newRevisionId ?? newRecordId)();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(candidate)) throw new Error('Invalid version ID. Nothing was written.');
    const known =
      vaultState.revisions.some((r) => r.manifest.revisionId === candidate) ||
      (await vaultDir.hasFile(revisionManifestPath(candidate))) ||
      (await vaultDir.hasFile(revisionCompletionPath(candidate))) ||
      (await vaultDir.hasFile(componentRecordPath(candidate))) ||
      (await vaultDir.hasFile(referenceContextPath(candidate)));
    if (!known) {
      const candidateSession = `session-${candidate}`;
      try {
        await vaultDir.getDirectory(getStagingSessionPathSegments(candidateSession), { create: true, exclusiveCreate: true });
        revisionId = candidate;
        sessionId = candidateSession;
        break;
      } catch (error) {
        if (!(error instanceof FileConflictError)) throw error;
      }
    }
    if (attempt >= MAX_REVISION_ID_ATTEMPTS)
      throw new Error(`No free version ID after ${MAX_REVISION_ID_ATTEMPTS} attempts. Nothing was written. Try again.`);
  }
  // Step 3: Write new objects, close writes, reopen stored bytes, and verify size/hash.
  // Reused objects are also verified before the new revision relies on them.
  let processedBytes = 0;
  const totalBytes = freshScan.totalBytes;

  for (let i = 0; i < allSnapshotFiles.length; i++) {
    if (input.signal?.aborted) {
      throw new DOMException('Saving was cancelled.', 'AbortError');
    }
    const entry = allSnapshotFiles[i];
    const segments = splitAndValidatePath(entry.path);

    input.onProgress?.({
      phase: 'writing_objects',
      currentFile: entry.path,
      processedFiles: i,
      totalFiles: allSnapshotFiles.length,
      processedBytes,
      totalBytes,
      message: `Saving ${entry.path}...`,
    });

    await writeAndVerifyObject(
      vaultDir,
      sessionId,
      entry.sha256,
      entry.size,
      () => workingDir.readFileStream(segments),
      input.signal
    );

    processedBytes += entry.size;
  }

  // Step 4: Check source stability (re-enumerate working directory and compare full directory and file sets)
  input.onProgress?.({
    phase: 'checking_stability',
    processedFiles: allSnapshotFiles.length,
    totalFiles: allSnapshotFiles.length,
    processedBytes: totalBytes,
    totalBytes,
    message: 'Checking your files did not change while saving...',
  });

  const rawPostCapture = await enumerateWorkingFolder(workingDir, {
    signal: input.signal,
  });
  const baselinePaths = new Set([...(baselineManifest?.files ?? []).map((f) => f.path), ...expectedPaths]);
  const postCaptureInventory = {
    ...rawPostCapture,
    errors: partitionSystemErrors(rawPostCapture.errors, rawPostCapture.files, baselinePaths).errors,
    files: partitionSystemFiles(rawPostCapture.files, baselinePaths).files,
  };

  if (postCaptureInventory.errors.length > 0) {
    throw new Error(
      `Nothing was saved because the file "${postCaptureInventory.errors[0].path}" became unreadable while saving.`
    );
  }

  if (postCaptureInventory.files.length !== allSnapshotFiles.length) {
    throw new Error(
      `Nothing was saved because the number of files changed while saving (${allSnapshotFiles.length} -> ${postCaptureInventory.files.length}). Save and close your files in the app you use, then try again.`
    );
  }

  // Compare complete normalized directory-path sets before and after capture, not just their lengths
  if (postCaptureInventory.directories.length !== freshScan.directories.length) {
    throw new Error(
      `Nothing was saved because the number of folders changed while saving (${freshScan.directories.length} -> ${postCaptureInventory.directories.length}). Try again.`
    );
  }

  for (let i = 0; i < freshScan.directories.length; i++) {
    if (freshScan.directories[i] !== postCaptureInventory.directories[i]) {
      throw new Error(
        `Nothing was saved because the folders changed while saving ("${freshScan.directories[i]}" vs "${postCaptureInventory.directories[i]}"). Try again.`
      );
    }
  }

  for (let i = 0; i < allSnapshotFiles.length; i++) {
    const before = allSnapshotFiles[i];
    const after = postCaptureInventory.files[i];
    if (
      before.path !== after.path ||
      before.size !== after.size ||
      before.sha256 !== after.sha256
    ) {
      throw new Error(
        `Nothing was saved because "${before.path}" changed while saving. Save and close your files in the app you use, then try again.`
      );
    }
  }

  // Step 5: Write and verify the complete revision manifest under its unique ID
  input.onProgress?.({
    phase: 'writing_manifest',
    processedFiles: allSnapshotFiles.length,
    totalFiles: allSnapshotFiles.length,
    processedBytes: totalBytes,
    totalBytes,
    message: 'Writing the version...',
  });

  const captureCompletedAt = new Date().toISOString();
  const manifestDraft: Omit<RevisionManifest, 'manifestPayloadSha256'> = {
    schemaVersion: CADTREE_SCHEMA_VERSION,
    projectId,
    revisionId,
    branchId: branch.branchId,
    parentRevisionId,
    displayNumber: nextDisplayNumber,
    captureStartedAt,
    captureCompletedAt,
    summary: cleanSummary,
    notes: {
      problem: input.notes.problem.trim(),
      modification: input.notes.modification.trim(),
      observations: input.notes.observations.trim(),
    },
    ...(sanitizedFileNotes ? { fileNotes: sanitizedFileNotes } : {}),
    directories: freshScan.directories,
    files: allSnapshotFiles,
  };

  const manifest: RevisionManifest = {
    ...manifestDraft,
    manifestPayloadSha256: computeManifestPayloadChecksum(manifestDraft),
  };

  const manifestJson = JSON.stringify(manifest, null, 2);
  const expectedManifestFileSha256 = hashString(manifestJson);
  const manifestPath = revisionManifestPath(revisionId);

  await vaultDir.writeFileText(manifestPath, manifestJson, { exclusive: true });
  const readBackManifestText = await vaultDir.readFileText(manifestPath);
  const actualManifestFileSha256 = hashString(readBackManifestText);

  if (actualManifestFileSha256 !== expectedManifestFileSha256) {
    throw new Error(
      `Manifest verification failed for ${revisionId}: written bytes do not match expected SHA-256.`
    );
  }

  if (input.signal?.aborted) {
    throw new DOMException('Saving was cancelled before it finished.', 'AbortError');
  }

  // Step 6: Publish and verify completion record tied to that manifest's hash
  input.onProgress?.({
    phase: 'publishing_completion',
    processedFiles: allSnapshotFiles.length,
    totalFiles: allSnapshotFiles.length,
    processedBytes: totalBytes,
    totalBytes,
    message: 'Finishing the version...',
  });

  const completion: CompletionRecord = {
    schemaVersion: CADTREE_SCHEMA_VERSION,
    projectId,
    revisionId,
    branchId: branch.branchId,
    displayNumber: nextDisplayNumber,
    manifestSha256: actualManifestFileSha256,
    completedAt: new Date().toISOString(),
  };

  // Additive sidecar, outside the historical manifest/checksum format. Its
  // exact manifest hash and completion establish capture exactly once after
  // reload, even if the caller loses the final acknowledgement.
  await verifyReferencePublication(vaultDir, vaultState, referenceBoundary, referenceDraft, input.signal);
  const referenceContextSha256 = await publishReferenceContext(vaultDir, referenceBoundary, referenceDraft, manifest, actualManifestFileSha256, referenceContextOnly);
  completion.referenceContext = { schemaVersion: 1, contextSha256: referenceContextSha256, boundarySha256: referenceBoundary.payloadSha256 };
  if (pendingApplication) await linkApplicationCapture(vaultDir, pendingApplication, manifest, actualManifestFileSha256, freshScan.changesSignature);
  // Same completion marker commits both the immutable manifest and its mapping.
  // Uncompleted sidecars are never visible as component history.
  if (componentDraft) await publishComponentRecord(vaultDir, componentDraft, revisionId, actualManifestFileSha256);
  if (input.signal?.aborted) throw new DOMException('Saving was cancelled before it finished.', 'AbortError');

  const completionJson = JSON.stringify(completion, null, 2);
  const expectedCompletionSha256 = hashString(completionJson);
  const completionPath = revisionCompletionPath(revisionId);

  await vaultDir.writeFileText(completionPath, completionJson);
  const readBackCompletionText = await vaultDir.readFileText(completionPath);
  if (hashString(readBackCompletionText) !== expectedCompletionSha256) {
    throw new Error(`Completion record verification failed for ${revisionId}.`);
  }

  // Clean up temporary staging folder for this session (best-effort)
  try {
    const stagingPath = getStagingSessionPathSegments(sessionId);
    if (await vaultDir.hasDirectory(stagingPath)) {
      await vaultDir.removeEntry(stagingPath, { recursive: true });
    }
  } catch {
    // Ignore staging cleanup failure
  }

  // Step 7: Update optional caches and return success.
  let cacheWarning: string | undefined;
  try {
    const cachePayload = JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        latestDisplayNumber: nextDisplayNumber,
        latestRevisionId: revisionId,
        branchHeads: {
          ...vaultState.branchHeads,
          [branch.branchId]: revisionId,
        },
      },
      null,
      2
    );
    await vaultDir.writeFileText(['cache', 'index.json'], cachePayload);
  } catch (cacheErr) {
    cacheWarning = `The version was saved and checked, but a speed-up copy could not be updated: ${
      cacheErr instanceof Error ? cacheErr.message : String(cacheErr)
    }`;
  }

  const updatedVaultState = await openExistingVault(vaultDir);
  const publishedRevision = updatedVaultState.revisions.find(
    (r) => r.manifest.revisionId === revisionId
  );
  if (!publishedRevision) {
    throw new Error('Unexpected state: published version not found when reloading vault.');
  }
  if (componentDraft && updatedVaultState.components?.status !== 'available') throw new Error(updatedVaultState.components?.reason ?? 'Component publication could not be verified.');
  if (updatedVaultState.references?.status !== 'available') throw new Error(updatedVaultState.references?.reason ?? 'Reference context publication could not be verified.');

  return {
    revision: {
      ...publishedRevision,
      integrityStatus: 'objects_verified',
    },
    vaultState: updatedVaultState,
    cacheWarning,
  };
}

