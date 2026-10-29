import {
  checkCaseInsensitiveCollisions,
  FileSystemDirectoryAdapter,
  splitAndValidatePath,
  validateDirectoryIsolation,
} from './fs-adapter';
import { hashStream } from './hash';
import { getObjectPathSegments, verifyStoredObject } from './object-store';
import { ProgressUpdate, RestoreResult } from './types';
import { computeManifestPayloadChecksum, openExistingVault } from './vault-service';

export interface RestoreRevisionOptions {
  vaultDir: FileSystemDirectoryAdapter;
  destinationDir: FileSystemDirectoryAdapter;
  workingDir?: FileSystemDirectoryAdapter | null;
  revisionId: string;
  onProgress?: (progress: ProgressUpdate) => void;
  signal?: AbortSignal;
}

/**
 * Restores a historical revision snapshot into a fresh destination folder.
 * - Rejects overlapping/nested vault or working folders.
 * - Rejects non-empty destination folders or case-insensitive path collisions.
 * - Verifies every vault object before and during restoration.
 * - Preserves relative paths and empty directories.
 * - Verifies every recovered destination file against its stored size and SHA-256 hash.
 * - Marks partial recoveries visibly incomplete if interrupted or failed.
 */
export async function restoreRevisionToFolder(
  options: RestoreRevisionOptions
): Promise<RestoreResult> {
  const { vaultDir, destinationDir, workingDir, revisionId, onProgress, signal } = options;

  await validateDirectoryIsolation(
    vaultDir,
    destinationDir,
    'Revision vault',
    'Recovery destination'
  );

  if (workingDir) {
    await validateDirectoryIsolation(
      workingDir,
      destinationDir,
      'Active working folder',
      'Recovery destination'
    );
  }

  const existingDestEntries = await destinationDir.listEntries();
  if (existingDestEntries.length > 0) {
    throw new Error(
      `Recovery destination "${destinationDir.name}" is not empty (contains ${existingDestEntries.length} item(s)). Select a fresh, empty folder for recovery.`
    );
  }

  const vaultState = await openExistingVault(vaultDir);
  const targetRev = vaultState.revisions.find((r) => r.manifest.revisionId === revisionId);
  if (!targetRev) {
    throw new Error(`Revision "${revisionId}" does not exist in committed vault history.`);
  }

  if (targetRev.integrityStatus === 'corrupted') {
    throw new Error(
      `Cannot restore Rev ${String(targetRev.manifest.displayNumber).padStart(
        3,
        '0'
      )}: revision is marked as damaged (${targetRev.integrityErrors.join('; ')}).`
    );
  }

  const manifest = targetRev.manifest;
  const expectedManifestChecksum = computeManifestPayloadChecksum(manifest);
  if (manifest.manifestPayloadSha256 !== expectedManifestChecksum) {
    throw new Error('Manifest checksum verification failed before recovery.');
  }

  // Validate all directory and file paths and check for case-insensitive collisions
  const allPaths = [...manifest.directories, ...manifest.files.map((f) => f.path)];
  for (const p of allPaths) {
    splitAndValidatePath(p);
  }
  const collisions = checkCaseInsensitiveCollisions(allPaths);
  if (collisions.length > 0) {
    throw new Error(`Unsafe manifest paths detected: ${collisions.join('; ')}`);
  }

  const totalFiles = manifest.files.length;
  const totalBytes = manifest.files.reduce((sum, f) => sum + f.size, 0);

  // Pre-verify all objects in vault before writing to destination, or verify during stream
  try {
    // 1. Create all directories (including empty directories)
    onProgress?.({
      phase: 'restoring_directories',
      processedFiles: 0,
      totalFiles,
      processedBytes: 0,
      totalBytes,
      message: 'Restoring directory hierarchy...',
    });

    for (const dirPath of manifest.directories) {
      if (signal?.aborted) {
        throw new DOMException('Recovery cancelled by user.', 'AbortError');
      }
      const segments = splitAndValidatePath(dirPath);
      await destinationDir.getDirectory(segments, { create: true });
    }

    // 2. Restore each file and verify its stored object first
    let processedBytes = 0;
    for (let i = 0; i < manifest.files.length; i++) {
      if (signal?.aborted) {
        throw new DOMException('Recovery cancelled by user.', 'AbortError');
      }
      const fileEntry = manifest.files[i];
      const fileSegments = splitAndValidatePath(fileEntry.path);

      onProgress?.({
        phase: 'restoring_files',
        currentFile: fileEntry.path,
        processedFiles: i,
        totalFiles,
        processedBytes,
        totalBytes,
        message: `Restoring ${fileEntry.path}...`,
      });

      const objVerification = await verifyStoredObject(
        vaultDir,
        fileEntry.sha256,
        fileEntry.size,
        signal
      );
      if (!objVerification.valid) {
        throw new Error(
          `Vault object integrity failure for "${fileEntry.path}": ${objVerification.reason}`
        );
      }

      const objectSegments = getObjectPathSegments(fileEntry.sha256);
      const objectStream = await vaultDir.readFileStream(objectSegments);
      const { bytesWritten } = await destinationDir.writeFileStream(
        fileSegments,
        objectStream,
        signal
      );

      if (bytesWritten !== fileEntry.size) {
        throw new Error(
          `Incomplete write while restoring "${fileEntry.path}": expected ${fileEntry.size} bytes, wrote ${bytesWritten} bytes.`
        );
      }

      processedBytes += fileEntry.size;
    }

    // 3. Re-read and verify every restored file in the destination folder
    let verifiedBytes = 0;
    for (let i = 0; i < manifest.files.length; i++) {
      if (signal?.aborted) {
        throw new DOMException('Recovery cancelled by user.', 'AbortError');
      }
      const fileEntry = manifest.files[i];
      const fileSegments = splitAndValidatePath(fileEntry.path);

      onProgress?.({
        phase: 'verifying_restored_files',
        currentFile: fileEntry.path,
        processedFiles: i + 1,
        totalFiles,
        processedBytes: verifiedBytes,
        totalBytes,
        message: `Verifying recovered file ${fileEntry.path}...`,
      });

      const exists = await destinationDir.hasFile(fileSegments);
      if (!exists) {
        throw new Error(`Verification failed: restored file "${fileEntry.path}" is missing.`);
      }

      const recoveredStream = await destinationDir.readFileStream(fileSegments);
      const { sha256: recoveredHash, size: recoveredSize } = await hashStream(recoveredStream, {
        signal,
      });

      if (recoveredSize !== fileEntry.size) {
        throw new Error(
          `Recovered file "${fileEntry.path}" size mismatch: expected ${fileEntry.size} bytes, got ${recoveredSize} bytes.`
        );
      }

      if (recoveredHash !== fileEntry.sha256) {
        throw new Error(
          `Recovered file "${fileEntry.path}" SHA-256 mismatch: expected ${fileEntry.sha256}, got ${recoveredHash}.`
        );
      }

      verifiedBytes += recoveredSize;
    }

    // Verify all empty/nested directories still exist
    for (const dirPath of manifest.directories) {
      const segments = splitAndValidatePath(dirPath);
      const dirExists = await destinationDir.hasDirectory(segments);
      if (!dirExists) {
        throw new Error(`Verification failed: directory "${dirPath}" missing in destination.`);
      }
    }

    return {
      revisionId: manifest.revisionId,
      displayNumber: manifest.displayNumber,
      restoredFilesCount: manifest.files.length,
      restoredDirectoriesCount: manifest.directories.length,
      verifiedBytes,
      destinationName: destinationDir.name,
      completedAt: new Date().toISOString(),
    };
  } catch (err) {
    // Keep partial recoveries visibly incomplete
    try {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await destinationDir.writeFileText(
        ['_CADTREE_RECOVERY_INCOMPLETE.txt'],
        `WARNING: cAdtree recovery of Revision ${manifest.displayNumber} (${manifest.revisionId}) DID NOT COMPLETE.\n` +
          `Timestamp: ${new Date().toISOString()}\n` +
          `Reason: ${errorMsg}\n` +
          `Do NOT open these files in SolidWorks. Delete this incomplete folder and retry recovery into a fresh folder.\n`
      );
    } catch {
      // Ignore secondary error if destination itself is unwritable
    }
    throw err;
  }
}
