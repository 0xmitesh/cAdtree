import {
  FileSystemDirectoryAdapter,
  splitAndValidatePath,
  validateDirectoryIsolation,
} from './fs-adapter';
import { hashString } from './hash';
import { withProjectWriterLock } from './locks';
import { writeAndVerifyObject } from './object-store';
import { enumerateWorkingFolder, scanBranchChanges } from './scanner';
import {
  CADTREE_SCHEMA_VERSION,
  CaptureRevisionInput,
  CompletionRecord,
  ReconstructedRevision,
  RevisionManifest,
  VaultState,
} from './types';
import {
  computeManifestPayloadChecksum,
  openExistingVault,
} from './vault-service';

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
    const vaultState = await openExistingVault(vaultDir);
    const branch = vaultState.branches.find((b) => b.branchId === input.branchId);
    if (!branch) {
      throw new Error(`Branch "${input.branchId}" does not exist in vault.`);
    }

    if (vaultState.competingHeads[branch.branchId]?.length) {
      throw new Error(
        `Branch "${branch.name}" has competing heads (${vaultState.competingHeads[branch.branchId].join(
          ', '
        )}). Resolve repository inconsistency before capturing new revisions.`
      );
    }

    const parentRevisionId = vaultState.branchHeads[branch.branchId] ?? branch.startingRevisionId ?? null;
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
      (max, r) => Math.max(max, r.manifest.displayNumber),
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

    if (!freshScan.hasChanges) {
      throw new Error(
        'No changes detected between the working folder and the latest saved revision. Capture skipped to avoid an unnecessary revision.'
      );
    }

    const allSnapshotFiles = [
      ...freshScan.added,
      ...freshScan.modified.map((m) => m.current),
      ...freshScan.unchanged,
    ].sort((a, b) => a.path.localeCompare(b.path));

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

    // Step 4: Check source stability (re-enumerate working directory and compare inventory & hashes)
    input.onProgress?.({
      phase: 'checking_stability',
      processedFiles: allSnapshotFiles.length,
      totalFiles: allSnapshotFiles.length,
      processedBytes: totalBytes,
      totalBytes,
      message: 'Checking source stability after object capture...',
    });

    const postCaptureInventory = await enumerateWorkingFolder(workingDir, {
      signal: input.signal,
    });

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

    if (postCaptureInventory.directories.length !== freshScan.directories.length) {
      throw new Error(
        'Source instability detected: directory structure changed during capture.'
      );
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

    const completionJson = JSON.stringify(completion, null, 2);
    const expectedCompletionSha256 = hashString(completionJson);
    const completionPath = ['completed', `${revisionId}.done.json`];

    await vaultDir.writeFileText(completionPath, completionJson);
    const readBackCompletionText = await vaultDir.readFileText(completionPath);
    if (hashString(readBackCompletionText) !== expectedCompletionSha256) {
      throw new Error(
        `Completion record verification failed for ${revisionId}.`
      );
    }

    // Clean up temporary staging folder for this session (best-effort)
    try {
      if (await vaultDir.hasDirectory(['staging', sessionId])) {
        await vaultDir.removeEntry(['staging', sessionId], { recursive: true });
      }
    } catch {
      // Ignore staging cleanup failure
    }

    // Step 7: Update optional caches and return success.
    // A cache failure after publication must NOT fail the published revision or cause duplicate revisions on retry.
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
