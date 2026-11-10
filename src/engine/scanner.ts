import {
  checkCaseInsensitiveCollisions,
  DirectoryEntryInfo,
  FileSystemDirectoryAdapter,
  splitAndValidatePath,
} from './fs-adapter';
import { hashStream, hashString } from './hash';
import {
  FileEntry,
  ModifiedFileChange,
  RevisionManifest,
  ScanErrorEntry,
  ScanResult,
} from './types';

export interface EnumerateWorkingFolderResult {
  files: FileEntry[];
  directories: string[];
  errors: ScanErrorEntry[];
  totalBytes: number;
}

/**
 * OS-generated clutter names (Finder, Explorer). These are never CAD data, but a
 * file that a saved revision already contains is always tracked normally.
 */
export function isSystemClutterName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === '.ds_store' || lower === 'thumbs.db' || lower === 'desktop.ini';
}

/**
 * Splits scanned files into kept files and skipped untracked OS clutter. A file is
 * skipped only when its path is not in `expectedPaths` and it is either a clutter
 * name or a macOS AppleDouble `._x` companion whose `x` sibling exists (scanned or
 * expected). Anything the expected set contains is never hidden.
 */
export function partitionSystemFiles(
  files: FileEntry[],
  expectedPaths: ReadonlySet<string>
): { files: FileEntry[]; skipped: string[] } {
  const known = new Set<string>([...expectedPaths, ...files.map((f) => f.path)]);
  const kept: FileEntry[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    if (!expectedPaths.has(file.path)) {
      const slash = file.path.lastIndexOf('/');
      const dir = slash >= 0 ? file.path.slice(0, slash + 1) : '';
      const base = file.path.slice(slash + 1);
      if (
        isSystemClutterName(base) ||
        (base.startsWith('._') && base.length > 2 && known.has(dir + base.slice(2)))
      ) {
        skipped.push(file.path);
        continue;
      }
    }
    kept.push(file);
  }
  return { files: kept, skipped };
}

/** True when a folder holds nothing but OS clutter files (directories never count). */
export function isEffectivelyEmpty(entries: DirectoryEntryInfo[]): boolean {
  return entries.every((e) => e.kind === 'file' && isSystemClutterName(e.name));
}

/**
 * Recursively enumerates all files and subdirectories under `workingDir`.
 * Subdirectory counts and paths exclude the selected working folder root itself,
 * and empty subdirectories are preserved in `directories`.
 */
export async function enumerateWorkingFolder(
  workingDir: FileSystemDirectoryAdapter,
  options?: {
    onProgress?: (path: string, processedFiles: number, totalBytes: number) => void;
    signal?: AbortSignal;
  }
): Promise<EnumerateWorkingFolderResult> {
  const files: FileEntry[] = [];
  const directories: string[] = [];
  const errors: ScanErrorEntry[] = [];
  let totalBytes = 0;

  async function walk(
    currentDir: FileSystemDirectoryAdapter,
    prefixSegments: string[]
  ): Promise<void> {
    if (options?.signal?.aborted) {
      throw new DOMException('Scan cancelled by user.', 'AbortError');
    }

    let entries;
    try {
      entries = await currentDir.listEntries();
    } catch (err) {
      const dirPath = prefixSegments.length > 0 ? prefixSegments.join('/') : '.';
      errors.push({
        path: dirPath,
        error: `Unreadable directory: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    for (const entry of entries) {
      if (options?.signal?.aborted) {
        throw new DOMException('Scan cancelled by user.', 'AbortError');
      }

      const relSegments = [...prefixSegments, entry.name];
      const relPath = relSegments.join('/');

      try {
        splitAndValidatePath(relPath);
      } catch (pathErr) {
        errors.push({
          path: relPath,
          error: pathErr instanceof Error ? pathErr.message : String(pathErr),
        });
        continue;
      }

      if (entry.kind === 'directory') {
        directories.push(relPath);
        try {
          const childDir = await currentDir.getDirectory([entry.name], { create: false });
          await walk(childDir, relSegments);
        } catch (err) {
          errors.push({
            path: relPath,
            error: `Failed to traverse directory: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      } else if (entry.kind === 'file') {
        try {
          const stat = await currentDir.statFile([entry.name]);
          const stream = await currentDir.readFileStream([entry.name]);
          const { sha256, size } = await hashStream(stream, { signal: options?.signal });

          if (size !== stat.size) {
            errors.push({
              path: relPath,
              error: `File size changed while reading (${stat.size} -> ${size} bytes). Save and close CAD files before scanning.`,
            });
            continue;
          }

          files.push({
            path: relPath,
            size,
            sha256,
            lastModified: stat.lastModified,
          });
          totalBytes += size;
          options?.onProgress?.(relPath, files.length, totalBytes);
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            throw err;
          }
          errors.push({
            path: relPath,
            error: `Unreadable file: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
  }

  await walk(workingDir, []);

  files.sort((a, b) => a.path.localeCompare(b.path));
  directories.sort((a, b) => a.localeCompare(b));

  const pathCollisions = checkCaseInsensitiveCollisions([
    ...files.map((f) => f.path),
    ...directories,
  ]);
  for (const collision of pathCollisions) {
    errors.push({
      path: '(case-collision)',
      error: collision,
    });
  }

  return {
    files,
    directories,
    errors,
    totalBytes,
  };
}

export function computeChangesSignature(params: {
  baselineRevisionId: string | null;
  added: FileEntry[];
  modified: ModifiedFileChange[];
  deleted: FileEntry[];
  addedDirectories: string[];
  deletedDirectories: string[];
}): string {
  const payload = JSON.stringify({
    baselineRevisionId: params.baselineRevisionId,
    added: params.added.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })),
    modified: params.modified.map((m) => ({
      path: m.current.path,
      prevSha256: m.previous.sha256,
      currSha256: m.current.sha256,
      size: m.current.size,
    })),
    deleted: params.deleted.map((f) => ({ path: f.path, sha256: f.sha256 })),
    addedDirectories: params.addedDirectories,
    deletedDirectories: params.deletedDirectories,
  });
  return hashString(payload);
}

/**
 * Compares the selected branch's working folder against its baseline revision
 * (latest saved revision on that branch, or starting revision if the branch has no saves yet).
 * Uses SHA-256 content hashes as the authoritative comparison.
 */
export async function scanBranchChanges(
  workingDir: FileSystemDirectoryAdapter,
  branchId: string,
  baselineManifest: RevisionManifest | null,
  options?: {
    onProgress?: (path: string, processedFiles: number, totalBytes: number) => void;
    signal?: AbortSignal;
  }
): Promise<ScanResult> {
  const scannedAt = new Date().toISOString();
  const rawEnumerated = await enumerateWorkingFolder(workingDir, options);
  const partitioned = partitionSystemFiles(
    rawEnumerated.files,
    new Set((baselineManifest?.files ?? []).map((f) => f.path))
  );
  const enumerated = {
    ...rawEnumerated,
    files: partitioned.files,
    totalBytes: partitioned.files.reduce((n, f) => n + f.size, 0),
  };

  const baselineFilesMap = new Map<string, FileEntry>();
  const baselineDirsSet = new Set<string>();

  if (baselineManifest) {
    for (const f of baselineManifest.files) {
      baselineFilesMap.set(f.path, f);
    }
    for (const d of baselineManifest.directories) {
      baselineDirsSet.add(d);
    }
  }

  const added: FileEntry[] = [];
  const modified: ModifiedFileChange[] = [];
  const unchanged: FileEntry[] = [];
  const seenPaths = new Set<string>();

  for (const currentFile of enumerated.files) {
    seenPaths.add(currentFile.path);
    const prev = baselineFilesMap.get(currentFile.path);
    if (!prev) {
      added.push(currentFile);
    } else if (prev.sha256 !== currentFile.sha256) {
      modified.push({ current: currentFile, previous: prev });
    } else {
      unchanged.push(currentFile);
    }
  }

  const deleted: FileEntry[] = [];
  for (const [prevPath, prevFile] of baselineFilesMap.entries()) {
    if (!seenPaths.has(prevPath)) {
      deleted.push(prevFile);
    }
  }
  deleted.sort((a, b) => a.path.localeCompare(b.path));

  const currentDirsSet = new Set(enumerated.directories);
  const addedDirectories = enumerated.directories.filter((d) => !baselineDirsSet.has(d));
  const deletedDirectories = Array.from(baselineDirsSet)
    .filter((d) => !currentDirsSet.has(d))
    .sort((a, b) => a.localeCompare(b));

  const isFirstSnapshot = baselineManifest === null;
  const hasFileOrDirDelta =
    added.length > 0 ||
    modified.length > 0 ||
    deleted.length > 0 ||
    addedDirectories.length > 0 ||
    deletedDirectories.length > 0 ||
    (isFirstSnapshot && (enumerated.files.length > 0 || enumerated.directories.length > 0));

  const canCapture = enumerated.errors.length === 0 && hasFileOrDirDelta;
  const baselineRevisionId = baselineManifest ? baselineManifest.revisionId : null;

  const changesSignature = computeChangesSignature({
    baselineRevisionId,
    added,
    modified,
    deleted,
    addedDirectories,
    deletedDirectories,
  });

  return {
    scannedAt,
    branchId,
    baselineRevisionId,
    baselineDisplayNumber: baselineManifest ? baselineManifest.displayNumber : null,
    added,
    modified,
    deleted,
    unchanged,
    directories: enumerated.directories,
    addedDirectories,
    deletedDirectories,
    errors: enumerated.errors,
    skippedSystemFiles: partitioned.skipped,
    hasChanges: hasFileOrDirDelta,
    canCapture,
    totalBytes: enumerated.totalBytes,
    changesSignature,
  };
}
