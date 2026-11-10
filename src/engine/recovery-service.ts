import { isEffectivelyEmpty, isSystemClutterName } from "./scanner";
import {
  checkCaseInsensitiveCollisions,
  FileSystemDirectoryAdapter,
  splitAndValidatePath,
  validateDirectoryIsolation,
} from './fs-adapter';
import { hashStream } from './hash';
import { withProjectWriterLock } from './locks';
import { validateOperationWorkingFolders, type WorkingFolderBindings } from './branch-state';
import { getObjectPathSegments, verifyStoredObject } from './object-store';
import { FileEntry, ProgressUpdate, RestoreResult } from './types';
import { computeManifestPayloadChecksum, openExistingVault } from './vault-service';

export interface RestoreRevisionOptions {
  vaultDir: FileSystemDirectoryAdapter;
  destinationDir: FileSystemDirectoryAdapter;
  workingDir?: FileSystemDirectoryAdapter | null;
  workingFolders?: WorkingFolderBindings;
  revisionId: string;
  onProgress?: (progress: ProgressUpdate) => void;
  signal?: AbortSignal;
}

export interface RestoreSelectedFilesOptions extends RestoreRevisionOptions {
  selectedPaths: string[];
}

const RECOVERY_MARKER_FILENAME = '_CADTREE_RECOVERY_INCOMPLETE.txt';

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
  kind: 'full_project' | 'selected_files';
  vaultDir: FileSystemDirectoryAdapter;
  destinationDir: FileSystemDirectoryAdapter;
  workingDir?: FileSystemDirectoryAdapter | null;
  workingFolders?: WorkingFolderBindings;
  revisionId: string;
  selectedPaths?: string[];
  onProgress?: (progress: ProgressUpdate) => void;
  signal?: AbortSignal;
}): Promise<RestoreResult> {
  const {
    kind,
    vaultDir,
    destinationDir,
    workingDir,
    workingFolders,
    revisionId,
    selectedPaths,
    onProgress,
    signal,
  } = params;

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

    let filesToRestore: FileEntry[];
    let directoriesToRestore: string[];
    let normalizedSelectedPaths: string[] | undefined;

    if (kind === 'selected_files') {
      if (!selectedPaths || selectedPaths.length === 0) {
        throw new Error('Select at least one file to restore.');
      }
      const uniqueSelected = Array.from(new Set(selectedPaths.map((p) => p.trim()))).filter(
        Boolean
      );
      if (uniqueSelected.length === 0) {
        throw new Error('Select at least one valid file path to restore.');
      }

      const manifestFileMap = new Map<string, FileEntry>();
      for (const f of manifest.files) {
        manifestFileMap.set(f.path, f);
      }

      filesToRestore = [];
      for (const reqPath of uniqueSelected) {
        splitAndValidatePath(reqPath);
        const entry = manifestFileMap.get(reqPath);
        if (!entry) {
          throw new Error(
            `Selected file "${reqPath}" does not exist in Rev ${String(
              manifest.displayNumber
            ).padStart(3, '0')}.`
          );
        }
        filesToRestore.push(entry);
      }
      filesToRestore.sort((a, b) => a.path.localeCompare(b.path));
      normalizedSelectedPaths = filesToRestore.map((f) => f.path);
      directoriesToRestore = computeRequiredParentDirectories(normalizedSelectedPaths);
    } else {
      filesToRestore = [...manifest.files];
      directoriesToRestore = [...manifest.directories];
    }

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
        throw new Error(
          `Destination conflict: folder "${destinationDir.name}" was populated (${preWriteRootEntries[0].name}) after initial check. Recovery stopped to avoid overwriting existing content.`
        );
      }

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
          throw new Error(
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
        if (
          (await destinationDir.hasFile(fileSegments)) ||
          (await destinationDir.hasDirectory(fileSegments))
        ) {
          abortedDueToDestinationConflict = true;
          throw new Error(
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
            { signal, exclusive: !isSystemClutterName(fileEntry.path.split('/').pop()!) }
          );

          if (bytesWritten !== fileEntry.size) {
            throw new Error(
              `Incomplete write while restoring "${fileEntry.path}": expected ${fileEntry.size} bytes, wrote ${bytesWritten} bytes.`
            );
          }
        } catch (writeErr) {
          if (
            writeErr instanceof Error &&
            writeErr.message.startsWith('Destination conflict:')
          ) {
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
        kind,
        revisionId: manifest.revisionId,
        displayNumber: manifest.displayNumber,
        ...(normalizedSelectedPaths ? { selectedPaths: normalizedSelectedPaths } : {}),
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
              `WARNING: cAdtree ${
                kind === 'selected_files' ? 'selected-files' : 'full-project'
              } recovery of Revision ${manifest.displayNumber} (${
                manifest.revisionId
              }) DID NOT COMPLETE.\n` +
                `Timestamp: ${new Date().toISOString()}\n` +
                `Reason: ${errorMsg}\n` +
                `Do NOT open these files in SolidWorks. Delete this incomplete folder and retry recovery into a fresh folder.\n`,
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
  return executeVerifiedRecovery({
    ...options,
    kind: 'full_project',
  });
}

/**
 * Restores only user-selected files (and their necessary parent directories) from a
 * committed revision into a fresh destination folder as a partial project copy.
 */
export async function restoreSelectedFilesToFolder(
  options: RestoreSelectedFilesOptions
): Promise<RestoreResult> {
  return executeVerifiedRecovery({
    ...options,
    kind: 'selected_files',
  });
}

