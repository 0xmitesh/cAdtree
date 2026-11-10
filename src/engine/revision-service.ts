import {
  FileSystemDirectoryAdapter,
  splitAndValidatePath,
  validateDirectoryIsolation,
} from './fs-adapter';
import { hashString } from './hash';
import { withProjectWriterLock } from './locks';
import { applicationCaptureBlock, branchApplications, linkApplicationCapture } from './application-records';
import { assertCaseWritable } from './case-lifecycle';
import { prepareComponentRecord, publishComponentRecord } from './component-identity';
import { prepareReferenceContext, referenceContextSignature, ensureReferenceStore, verifyReferenceContextContent, verifyReferencePublication, publishReferenceContext, storeCaptureReferenceAttachments } from './references';
import { getBranchBaseline, validateOperationWorkingFolders } from './branch-state';
import { getStagingSessionPathSegments, writeAndVerifyObject } from './object-store';
import { enumerateWorkingFolder, partitionSystemErrors, partitionSystemFiles, scanBranchChanges } from './scanner';
import {
  CADTREE_SCHEMA_VERSION,
  CaptureRevisionInput,
  CompletionRecord,
  ReconstructedRevision,
  RevisionManifest,
  ScanResult,
  VaultState,
} from './types';
import {
  computeManifestPayloadChecksum,
  openExistingVault,
  sanitizeFileSpecificNotes,
} from './vault-service';

export class ReviewStaleError extends Error {
  readonly freshScan: ScanResult;
  constructor(message: string, freshScan: ScanResult) {
    super(message);
    this.name = 'ReviewStaleError';
    this.freshScan = freshScan;
  }
}

function createUniqueId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Captures and publishes a complete revision snapshot following the 7-step
 * Write and Publication Protocol under the project writer lock.
 */
export async function captureRevision(
  workingDir: FileSystemDirectoryAdapter,
  vaultDir: FileSystemDirectoryAdapter,
  input: CaptureRevisionInput
): Promise<{
  revision: ReconstructedRevision;
  vaultState: VaultState;
  cacheWarning?: string;
}> {
  const cleanSummary = input.summary.trim();
  if (!cleanSummary) {
    throw new Error('Revision summary is required.');
  }

  await validateDirectoryIsolation(workingDir, vaultDir, 'Working folder', 'Revision vault');

  // Peek project ID first so we can lock on the exact projectId
  const initialVaultState = await openExistingVault(vaultDir);
  const projectId = initialVaultState.project.projectId;

  input.onProgress?.({
    phase: 'acquiring_lock',
    processedFiles: 0,
    totalFiles: 0,
    processedBytes: 0,
    totalBytes: 0,
    message: 'Acquiring single-writer project lock...',
  });

  return withProjectWriterLock(projectId, async () => {
    if (input.signal?.aborted) {
      throw new DOMException('Capture cancelled before starting.', 'AbortError');
    }

    // Step 1: Reload validated vault and branch state under the writer lock
    let vaultState = await openExistingVault(vaultDir);
    if (vaultState.project.projectId !== projectId) throw new Error('Vault identity changed while waiting for the writer lock.');
    assertCaseWritable(vaultState,input.branchId);
    const applicationBlock = applicationCaptureBlock(vaultState, input.branchId);
    if (applicationBlock) throw new Error(applicationBlock);
    // A retry of the same reviewed capture reconciles its already-published
    // revision. Provenance is consumed by a verified completion, not a cache or
    // a fallible post-publication acknowledgement.
    const reconciled = input.reviewedChangesSignature && branchApplications(vaultState, input.branchId).find(op => op.status === 'captured' && op.events.some(event => event.kind === 'capture' && event.revisionId === op.capturedRevisionId && event.reviewedChangesSignature === input.reviewedChangesSignature));
    if (reconciled) {
      const revision = vaultState.revisions.find(r => r.manifest.revisionId === reconciled.capturedRevisionId)!;
      return { revision, vaultState, cacheWarning: 'Reconciled the existing published application revision; no duplicate capture was created.' };
    }
    const pendingApplication = branchApplications(vaultState, input.branchId).find(op => op.status === 'applied');
    getBranchBaseline(vaultState, input.branchId);
    const workingFolders = input.resolveWorkingFolders ? await input.resolveWorkingFolders(vaultState) : input.workingFolders;
    await validateOperationWorkingFolders(vaultState, vaultDir, workingFolders);
    if (workingFolders) {
      const connected = workingFolders[input.branchId];
      if (!connected || !await connected.isSameEntry(workingDir)) throw new Error('The capture folder does not match the selected branch connection.');
    }
    const branch = vaultState.branches.find((b) => b.branchId === input.branchId);
    if (!branch) {
      throw new Error(`Branch "${input.branchId}" does not exist in vault.`);
    }

    if (vaultState.damagedBranchHeads[branch.branchId]) {
      throw new Error(vaultState.damagedBranchHeads[branch.branchId]);
    }

    if (vaultState.competingHeads[branch.branchId]?.length) {
      throw new Error(
        `Branch "${branch.name}" has competing heads (${vaultState.competingHeads[
          branch.branchId
        ].join(', ')}). Resolve repository inconsistency before capturing new revisions.`
      );
    }

    const parentRevisionId =
      vaultState.branchHeads[branch.branchId] ?? branch.startingRevisionId ?? null;
    if (pendingApplication && pendingApplication.record!.plan.destinationRevisionId !== parentRevisionId) throw new Error('The pending application baseline no longer matches this branch. Inspect its provenance before saving.');
    let baselineManifest: RevisionManifest | null = null;

    if (parentRevisionId) {
      const parentRev = vaultState.revisions.find(
        (r) => r.manifest.revisionId === parentRevisionId
      );
      if (!parentRev) {
        throw new Error(
          `Baseline revision "${parentRevisionId}" referenced by branch "${branch.name}" is missing from committed history.`
        );
      }
      if (parentRev.integrityStatus === 'corrupted') {
        throw new Error(
          `Baseline revision Rev ${String(parentRev.manifest.displayNumber).padStart(
            3,
            '0'
          )} is marked as corrupted and cannot be used as a parent baseline.`
        );
      }
      baselineManifest = parentRev.manifest;
    }

    const maxDisplayNumber = vaultState.revisions.reduce(
      (max, r) => Math.max(max, r.manifest.displayNumber, r.completion.displayNumber),
      0
    );
    const nextDisplayNumber = maxDisplayNumber + 1;
    const revisionId = createUniqueId('rev');
    const sessionId = `session-${revisionId}`;
    const captureStartedAt = new Date().toISOString();

    // Step 2: Capture fresh source inventory and stream file data with bounded memory
    input.onProgress?.({
      phase: 'scanning_source',
      processedFiles: 0,
      totalFiles: 0,
      processedBytes: 0,
      totalBytes: 0,
      message: 'Validating working folder inventory...',
    });

    const freshScan = await scanBranchChanges(
      workingDir,
      branch.branchId,
      baselineManifest,
      {
        signal: input.signal,
        onProgress: (filePath, count, bytes) => {
          input.onProgress?.({
            phase: 'scanning_source',
            currentFile: filePath,
            processedFiles: count,
            totalFiles: count,
            processedBytes: bytes,
            totalBytes: bytes,
            message: `Scanning ${filePath}...`,
          });
        },
      }
    );

    if (freshScan.errors.length > 0) {
      const firstErr = freshScan.errors[0];
      throw new Error(
        `Capture aborted due to unreadable or invalid source file (${firstErr.path}): ${firstErr.error}`
      );
    }

    // Refresh the scan through the existing review path before validating either
    // identity or reference selections bound to that scan.
    if (input.reviewedChangesSignature && freshScan.changesSignature !== input.reviewedChangesSignature) {
      throw new ReviewStaleError('Working folder changes differ from the file list you reviewed. The change list has been refreshed - please review your file changes and note associations before saving.', freshScan);
    }
    const componentDraft = prepareComponentRecord(vaultState, freshScan, input.identityReview);
    let referenceDraft = prepareReferenceContext(vaultState, freshScan, componentDraft?.files ?? [], input.referenceReview);
    const previousReferences = parentRevisionId ? vaultState.references?.contexts[parentRevisionId]?.record?.links ?? [] : [];
    const referenceChanged = Boolean(input.referenceAttachments?.length) || referenceContextSignature(referenceDraft.links) !== referenceContextSignature(previousReferences);
    const referenceContextOnly = !freshScan.hasChanges && referenceChanged && !input.identityReview?.replacements.length;
    if (!freshScan.hasChanges && !input.identityReview?.replacements.length && !referenceChanged) {
      throw new Error(
        'No changes detected between the working folder and the latest saved revision. Capture skipped to avoid an unnecessary revision.'
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
            `File-specific note refers to "${fn.path}", which is not in the current snapshot or deleted file set. Please review your file note associations.`,
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

    // Step 3: Write new objects, close writes, reopen stored bytes, and verify size/hash.
    // Reused objects are also verified before the new revision relies on them.
    let processedBytes = 0;
    const totalBytes = freshScan.totalBytes;

    for (let i = 0; i < allSnapshotFiles.length; i++) {
      if (input.signal?.aborted) {
        throw new DOMException('Capture cancelled by user.', 'AbortError');
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
        message: `Storing and verifying ${entry.path}...`,
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
      message: 'Checking source stability after object capture...',
    });

    const rawPostCapture = await enumerateWorkingFolder(workingDir, {
      signal: input.signal,
    });
    const baselinePaths = new Set((baselineManifest?.files ?? []).map((f) => f.path));
    const postCaptureInventory = {
      ...rawPostCapture,
      errors: partitionSystemErrors(rawPostCapture.errors, rawPostCapture.files, baselinePaths).errors,
      files: partitionSystemFiles(rawPostCapture.files, baselinePaths).files,
    };

    if (postCaptureInventory.errors.length > 0) {
      throw new Error(
        `Source stability check failed: file "${postCaptureInventory.errors[0].path}" became unreadable during capture.`
      );
    }

    if (postCaptureInventory.files.length !== allSnapshotFiles.length) {
      throw new Error(
        `Source instability detected: file count changed during capture (${allSnapshotFiles.length} -> ${postCaptureInventory.files.length}). Save and close CAD documents before capturing.`
      );
    }

    // Compare complete normalized directory-path sets before and after capture, not just their lengths
    if (postCaptureInventory.directories.length !== freshScan.directories.length) {
      throw new Error(
        `Source instability detected: directory count changed during capture (${freshScan.directories.length} -> ${postCaptureInventory.directories.length}).`
      );
    }

    for (let i = 0; i < freshScan.directories.length; i++) {
      if (freshScan.directories[i] !== postCaptureInventory.directories[i]) {
        throw new Error(
          `Source instability detected: directory path set changed during capture ("${freshScan.directories[i]}" vs "${postCaptureInventory.directories[i]}").`
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
          `Source instability detected: "${before.path}" changed while capture was in progress. Ensure CAD documents are saved and closed.`
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
      message: 'Writing and verifying revision manifest...',
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
    const manifestPath = ['revisions', `${revisionId}.manifest.json`];

    await vaultDir.writeFileText(manifestPath, manifestJson);
    const readBackManifestText = await vaultDir.readFileText(manifestPath);
    const actualManifestFileSha256 = hashString(readBackManifestText);

    if (actualManifestFileSha256 !== expectedManifestFileSha256) {
      throw new Error(
        `Manifest verification failed for ${revisionId}: written bytes do not match expected SHA-256.`
      );
    }

    if (input.signal?.aborted) {
      throw new DOMException('Capture cancelled before completion publication.', 'AbortError');
    }

    // Step 6: Publish and verify completion record tied to that manifest's hash
    input.onProgress?.({
      phase: 'publishing_completion',
      processedFiles: allSnapshotFiles.length,
      totalFiles: allSnapshotFiles.length,
      processedBytes: totalBytes,
      totalBytes,
      message: 'Publishing revision completion record...',
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
    if (input.signal?.aborted) throw new DOMException('Capture cancelled before completion publication.', 'AbortError');

    const completionJson = JSON.stringify(completion, null, 2);
    const expectedCompletionSha256 = hashString(completionJson);
    const completionPath = ['completed', `${revisionId}.done.json`];

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
      cacheWarning = `Revision was published and verified, but optional cache update failed: ${
        cacheErr instanceof Error ? cacheErr.message : String(cacheErr)
      }`;
    }

    const updatedVaultState = await openExistingVault(vaultDir);
    const publishedRevision = updatedVaultState.revisions.find(
      (r) => r.manifest.revisionId === revisionId
    );
    if (!publishedRevision) {
      throw new Error('Unexpected state: published revision not found when reloading vault.');
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
  });
}

