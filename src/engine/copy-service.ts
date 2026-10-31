import {
  type FileSystemDirectoryAdapter,
  splitAndValidatePath,
  validateDirectoryIsolation,
} from "./fs-adapter";
import {
  enumerateWorkingFolder,
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
      "Operation cancelled. Incomplete copies were retained.",
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
export async function readVerifiedInventory(
  source: FileSystemDirectoryAdapter,
  options: CopyOptions = {},
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
  if (inventory.errors.length)
    throw new Error(
      `Cannot copy "${source.name}": ${inventory.errors.map((error) => `${error.path}: ${error.error}`).join("; ")}`,
    );
  return inventory;
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
  if ((await destination.listEntries()).length)
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
      { signal: options.signal, exclusive: true },
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
  const copied = await readVerifiedInventory(destination, options);
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
  const after = await readVerifiedInventory(source, options);
  if (inventorySignature(after) !== inventorySignature(before))
    throw new Error(
      "Source changed during the copy. Save and close CAD documents, then retry into a fresh destination.",
    );
  throwIfCancelled(options.signal);
  return before;
}
