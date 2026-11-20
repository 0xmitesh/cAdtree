import { isEffectivelyEmpty, isSystemClutterName } from "./scanner";
import {
  checkCaseInsensitiveCollisions,
  FileConflictError,
  FileSystemDirectoryAdapter,
  splitAndValidatePath,
  validateDirectoryIsolation,
} from './fs-adapter';
import { hashStream } from './hash';
import { withProjectWriterLock } from './locks';
import { validateOperationWorkingFolders, type WorkingFolderBindings } from './branch-state';
import { getObjectPathSegments, verifyStoredObject } from './object-store';
import { FileEntry, ProgressUpdate, RestoreResult } from './types';
import { computeManifestPayloadChecksum, formatRevisionNumber, openExistingVault } from './vault-service';

export interface RestoreRevisionOptions {
  vaultDir: FileSystemDirectoryAdapter;
  destinationDir: FileSystemDirectoryAdapter;
  workingDir?: FileSystemDirectoryAdapter | null;
  workingFolders?: WorkingFolderBindings;
  revisionId: string;
  onProgress?: (progress: ProgressUpdate) => void;
  signal?: AbortSignal;
}

/** Written into a design-case working folder when creation fails part-way. Single source: path-budget.ts derives its template and reserve from this. */
export const RECOVERY_MARKER_FILENAME = '_CADTREE_RECOVERY_INCOMPLETE.txt';

/**
 * Computes the minimal sorted list of parent directory paths required to materialize
 * the given relative file paths.
 */
export function computeRequiredParentDirectories(filePaths: string[]): string[] {
  const dirSet = new Set<string>();
  for (const fp of filePaths) {
    const segments = splitAndValidatePath(fp);
    for (let i = 1; i < segments.length; i++) {
      dirSet.add(segments.slice(0, i).join('/'));
    }
  }
  return Array.from(dirSet).sort((a, b) => a.localeCompare(b));
}

async function executeVerifiedRecovery(params: {
  vaultDir: FileSystemDirectoryAdapter;
  destinationDir: FileSystemDirectoryAdapter;
  workingDir?: FileSystemDirectoryAdapter | null;
  workingFolders?: WorkingFolderBindings;
  revisionId: string;
  onProgress?: (progress: ProgressUpdate) => void;
  signal?: AbortSignal;
}): Promise<RestoreResult> {
  const {
    vaultDir,
    destinationDir,
    workingDir,
    workingFolders,
    revisionId,
    onProgress,
    signal,
  } = params;

  await validateDirectoryIsolation(
    vaultDir,
    destinationDir,
    'Version vault',
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

  // Coordinate overlapping recovery operations within the application
  const lockKey = `recovery-lock:${vaultDir.name}:${destinationDir.name}`;
  return withProjectWriterLock(lockKey, async () => {
    const existingDestEntries = await destinationDir.listEntries();
    if (!isEffectivelyEmpty(existingDestEntries)) {
      throw new Error(
        `Recovery destination "${destinationDir.name}" is not empty (contains ${existingDestEntries.length} item(s)). Select a fresh, empty folder for recovery.`
      );
    }

    const vaultState = await openExistingVault(vaultDir);
    await validateOperationWorkingFolders(vaultState, vaultDir, workingFolders);
    if (workingFolders) {
      for (const branch of vaultState.branches) {
        await validateDirectoryIsolation(destinationDir, workingFolders[branch.branchId]!, 'Recovery destination', `"${branch.name}" working folder`);
      }
    }
    const targetRev = vaultState.revisions.find((r) => r.manifest.revisionId === revisionId);
    if (!targetRev) {
      throw new Error(`Version "${revisionId}" does not exist in committed vault history.`);
    }

    if (targetRev.integrityStatus === 'corrupted') {
      throw new Error(
        `Cannot restore ${formatRevisionNumber(targetRev.manifest.displayNumber)}: version is marked as damaged (${targetRev.integrityErrors.join('; ')}).`
      );
    }

    const manifest = targetRev.manifest;
    const expectedManifestChecksum = computeManifestPayloadChecksum(manifest);
    if (manifest.manifestPayloadSha256 !== expectedManifestChecksum) {
      throw new Error('Manifest checksum verification failed before recovery.');
    }

    const filesToRestore: FileEntry[] = [...manifest.files];
    const directoriesToRestore: string[] = [...manifest.directories];

    // Validate all directory and file paths and check for case-insensitive collisions
    const allPaths = [...directoriesToRestore, ...filesToRestore.map((f) => f.path)];
    for (const p of allPaths) {
      splitAndValidatePath(p);
    }
    const collisions = checkCaseInsensitiveCollisions(allPaths);
    if (collisions.length > 0) {
      throw new Error(`Unsafe manifest paths detected: ${collisions.join('; ')}`);
    }

    const totalFiles = filesToRestore.length;
    const totalBytes = filesToRestore.reduce((sum, f) => sum + f.size, 0);
    let wroteAnyDestinationEntry = false;
    let abortedDueToDestinationConflict = false;

    try {
      // 1. Pre-verify all required objects in the vault BEFORE creating any files in destination
      onProgress?.({
        phase: 'verifying_objects',
        processedFiles: 0,
        totalFiles,
        processedBytes: 0,
        totalBytes,
        message: 'Verifying stored content objects in vault before recovery...',
      });

      for (let i = 0; i < filesToRestore.length; i++) {
        if (signal?.aborted) {
          throw new DOMException('Recovery cancelled by user.', 'AbortError');
        }
        const fileEntry = filesToRestore[i];
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
      }

      // Recheck that destination root is still completely empty right before materialization
      const preWriteRootEntries = await destinationDir.listEntries();
      if (!isEffectivelyEmpty(preWriteRootEntries)) {
        abortedDueToDestinationConflict = true;
        throw new FileConflictError(
          `Destination conflict: folder "${destinationDir.name}" was populated (${preWriteRootEntries[0].name}) after initial check. Recovery stopped to avoid overwriting existing content.`
        );
      }

      // Root-level OS clutter seen in the destination may be overwritten by a saved
      // file of the same name; every other path stays exclusive.
      const tolerated = new Set(
        preWriteRootEntries
          .filter((e) => e.kind === 'file' && isSystemClutterName(e.name))
          .map((e) => e.name)
      );

      // 2. Create required directories with exclusive conflict checks
      onProgress?.({
        phase: 'restoring_directories',
        processedFiles: 0,
        totalFiles,
        processedBytes: 0,
        totalBytes,
        message: 'Restoring directory hierarchy...',
      });

      for (const dirPath of directoriesToRestore) {
        if (signal?.aborted) {
          throw new DOMException('Recovery cancelled by user.', 'AbortError');
        }
        const segments = splitAndValidatePath(dirPath);
        if (await destinationDir.hasFile(segments)) {
          abortedDueToDestinationConflict = true;
          throw new FileConflictError(
            `Destination conflict: a file already exists at directory path "${dirPath}".`
          );
        }
        wroteAnyDestinationEntry = true;
        await destinationDir.getDirectory(segments, {
          create: true,
          exclusiveCheck: true,
        });
      }

      // 3. Restore each file with immediate pre-write conflict checks (exclusive: true)
      let processedBytes = 0;
      for (let i = 0; i < filesToRestore.length; i++) {
        if (signal?.aborted) {
          throw new DOMException('Recovery cancelled by user.', 'AbortError');
        }
        const fileEntry = filesToRestore[i];
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

        // Recheck immediately before writing that neither a file nor directory occupies target path
        const isTolerated = fileSegments.length === 1 && tolerated.has(fileSegments[0]);
        if (
          !isTolerated &&
          ((await destinationDir.hasFile(fileSegments)) ||
            (await destinationDir.hasDirectory(fileSegments)))
        ) {
          abortedDueToDestinationConflict = true;
          throw new FileConflictError(
            `Destination conflict: "${fileEntry.path}" already exists in destination folder. Recovery stopped without overwriting.`
          );
        }

        const objectSegments = getObjectPathSegments(fileEntry.sha256);
        const objectStream = await vaultDir.readFileStream(objectSegments);
        wroteAnyDestinationEntry = true;

        try {
          const { bytesWritten } = await destinationDir.writeFileStream(
            fileSegments,
            objectStream,
            { signal, exclusive: !isTolerated }
          );

          if (bytesWritten !== fileEntry.size) {
            throw new Error(
              `Incomplete write while restoring "${fileEntry.path}": expected ${fileEntry.size} bytes, wrote ${bytesWritten} bytes.`
            );
          }
        } catch (writeErr) {
          if (writeErr instanceof FileConflictError) {
            abortedDueToDestinationConflict = true;
          }
          throw writeErr;
        }

        processedBytes += fileEntry.size;
      }

      // 4. Re-read and verify every restored file in the destination folder
      let verifiedBytes = 0;
      for (let i = 0; i < filesToRestore.length; i++) {
        if (signal?.aborted) {
          throw new DOMException('Recovery cancelled by user.', 'AbortError');
        }
        const fileEntry = filesToRestore[i];
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
        const { sha256: recoveredHash, size: recoveredSize } = await hashStream(
          recoveredStream,
          { signal }
        );

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

      // Verify all expected directories exist
      for (const dirPath of directoriesToRestore) {
        const segments = splitAndValidatePath(dirPath);
        const dirExists = await destinationDir.hasDirectory(segments);
        if (!dirExists) {
          throw new Error(`Verification failed: directory "${dirPath}" missing in destination.`);
        }
      }

      return {
        kind: 'full_project',
        revisionId: manifest.revisionId,
        displayNumber: manifest.displayNumber,
        restoredFilesCount: filesToRestore.length,
        restoredDirectoriesCount: directoriesToRestore.length,
        verifiedBytes,
        destinationName: destinationDir.name,
        completedAt: new Date().toISOString(),
      };
    } catch (err) {
      // Write a partial-recovery warning marker ONLY if recovery failed after writing or during verification,
      // and NEVER overwrite an existing file or marker in the destination folder.
      if (wroteAnyDestinationEntry || !abortedDueToDestinationConflict) {
        try {
          const markerExists =
            (await destinationDir.hasFile([RECOVERY_MARKER_FILENAME])) ||
            (await destinationDir.hasDirectory([RECOVERY_MARKER_FILENAME]));
          if (!markerExists) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            await destinationDir.writeFileText(
              [RECOVERY_MARKER_FILENAME],
              `WARNING: cAdtree restore of ${formatRevisionNumber(manifest.displayNumber)} (${
                manifest.revisionId
              }) DID NOT COMPLETE.\n` +
                `Timestamp: ${new Date().toISOString()}\n` +
                `Reason: ${errorMsg}\n` +
                `Do NOT open these files in your CAD app. Delete this incomplete folder and retry into a fresh folder.\n`,
              { exclusive: true }
            );
          }
        } catch {
          // Ignore secondary error if destination is unwritable or marker already exists
        }
      }
      throw err;
    }
  });
}

/**
 * Restores a complete historical revision snapshot into a fresh destination folder.
 */
export async function restoreRevisionToFolder(
  options: RestoreRevisionOptions
): Promise<RestoreResult> {
  return executeVerifiedRecovery(options);
}
