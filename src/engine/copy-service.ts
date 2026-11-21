import {
  type FileSystemDirectoryAdapter,
  splitAndValidatePath,
  validateDirectoryIsolation,
} from "./fs-adapter";
import {
  enumerateWorkingFolder,
  isEffectivelyEmpty,
  partitionSystemErrors,
  partitionSystemFiles,
  isSystemClutterName,
  type EnumerateWorkingFolderResult,
} from "./scanner";
import type { ProgressUpdate } from "./types";

export interface CopyOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ProgressUpdate) => void;
}
export function throwIfCancelled(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new DOMException(
      "Operation cancelled. Incomplete copies were kept.",
      "AbortError",
    );
}
export function inventorySignature(
  inventory: EnumerateWorkingFolderResult,
): string {
  return JSON.stringify({
    directories: [...inventory.directories].sort(),
    files: inventory.files
      .map((file) => [file.path, file.size, file.sha256])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  });
}
/**
 * Reads and hashes a folder, failing on any read error. With `expectedPaths` (a
 * working folder whose tracked files are known), read errors for untracked system
 * or temporary files (a lock file while its document is open) are dropped, the
 * way a scan and a save drop them; every other read error still fails.
 */
export async function readVerifiedInventory(
  source: FileSystemDirectoryAdapter,
  options: CopyOptions = {},
  expectedPaths?: ReadonlySet<string>,
) {
  const inventory = await enumerateWorkingFolder(source, {
    signal: options.signal,
    onProgress: (path, count, bytes) =>
      options.onProgress?.({
        phase: "scanning_source",
        currentFile: path,
        processedFiles: count,
        totalFiles: count,
        processedBytes: bytes,
        totalBytes: bytes,
        message: `Reading ${source.name}: ${path}…`,
      }),
  });
  const errors = expectedPaths
    ? partitionSystemErrors(inventory.errors, inventory.files, expectedPaths).errors
    : inventory.errors;
  if (errors.length)
    throw new Error(
      `Cannot copy "${source.name}": ${errors.map((error) => `${error.path}: ${error.error}`).join("; ")}`,
    );
  return { ...inventory, errors };
}
/** Bounded file streams; hashes and inventories establish best-effort source stability. */
export async function copyVerifiedTree(
  source: FileSystemDirectoryAdapter,
  destination: FileSystemDirectoryAdapter,
  options: CopyOptions = {},
) {
  await validateDirectoryIsolation(
    source,
    destination,
    "Source folder",
    "Managed destination",
  );
  throwIfCancelled(options.signal);
  const destinationEntries = await destination.listEntries();
  if (!isEffectivelyEmpty(destinationEntries))
    throw new Error("Copy destination must be fresh and empty.");
  const before = await readVerifiedInventory(source, options);
  for (const path of before.directories) {
    throwIfCancelled(options.signal);
    await destination.getDirectory(splitAndValidatePath(path), {
      create: true,
      exclusiveCheck: true,
    });
  }
  let processedBytes = 0;
  for (const [index, file] of before.files.entries()) {
    options.onProgress?.({
      phase: "restoring_files",
      currentFile: file.path,
      processedFiles: index,
      totalFiles: before.files.length,
      processedBytes,
      totalBytes: before.totalBytes,
      message: `Copying ${file.path}…`,
    });
    throwIfCancelled(options.signal);
    const written = await destination.writeFileStream(
      splitAndValidatePath(file.path),
      await source.readFileStream(splitAndValidatePath(file.path)),
      {
        signal: options.signal,
        // Only a root-level clutter file that the pre-write listing showed may be
        // overwritten; every other path stays exclusive.
        exclusive: !(
          !file.path.includes("/") &&
          isSystemClutterName(file.path) &&
          destinationEntries.some((e) => e.kind === "file" && e.name === file.path)
        ),
      },
    );
    if (written.bytesWritten !== file.size)
      throw new Error(`Incomplete copy of "${file.path}".`);
    processedBytes += written.bytesWritten;
  }
  options.onProgress?.({
    phase: "verifying_restored_files",
    processedFiles: before.files.length,
    totalFiles: before.files.length,
    processedBytes,
    totalBytes: before.totalBytes,
    message: "Verifying the copied bytes and directory hierarchy…",
  });
  const beforePaths = new Set(before.files.map((f) => f.path));
  const rawCopied = await readVerifiedInventory(destination, options);
  const copied = {
    ...rawCopied,
    files: partitionSystemFiles(rawCopied.files, beforePaths).files,
  };
  if (inventorySignature(copied) !== inventorySignature(before))
    throw new Error(
      "Copied files or directories do not match the source inventory.",
    );
  options.onProgress?.({
    phase: "checking_stability",
    processedFiles: before.files.length,
    totalFiles: before.files.length,
    processedBytes,
    totalBytes: before.totalBytes,
    message: "Rechecking source stability before publication…",
  });
  const rawAfter = await readVerifiedInventory(source, options);
  const after = {
    ...rawAfter,
    files: partitionSystemFiles(rawAfter.files, beforePaths).files,
  };
  if (inventorySignature(after) !== inventorySignature(before))
    throw new Error(
      "Source changed during the copy. Save and close CAD documents, then retry into a fresh destination.",
    );
  throwIfCancelled(options.signal);
  return before;
}
