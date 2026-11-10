import type { FileSystemDirectoryAdapter } from "./fs-adapter";
import { validateDirectoryIsolation } from "./fs-adapter";
import {
  assertRevisionAncestry,
  branchNameKey,
  validateWorkingFolderBindings,
  type WorkingFolderBindings,
} from "./branch-state";
import { withProjectWriterLock } from "./locks";
import { folderNameFor, pickFreeName } from "./folder-names";
import { componentWriteBlock } from './component-identity';
import { hashString } from "./hash";
import { restoreRevisionToFolder } from "./recovery-service";
import { enumerateWorkingFolder, partitionSystemFiles } from "./scanner";
import {
  computeBranchRecordChecksum,
  openExistingVault,
} from "./vault-service";
import {
  CADTREE_SCHEMA_VERSION,
  type BranchRecord,
  type ProgressUpdate,
  type VaultState,
} from "./types";

export interface CreateDesignBranchOptions {
  vaultDir: FileSystemDirectoryAdapter;
  destinationParent: FileSystemDirectoryAdapter;
  workingFolders: WorkingFolderBindings;
  sourceRevisionId: string;
  name: string;
  reason: string;
  signal?: AbortSignal;
  onProgress?: (progress: ProgressUpdate) => void;
  resolveWorkingFolders?: (state: VaultState) => Promise<WorkingFolderBindings>;
  beforePublish?: (branch: BranchRecord, workingDir: FileSystemDirectoryAdapter) => Promise<void>;
}
export class BranchCreationError extends Error {
  constructor(
    message: string,
    readonly incompleteDestination?: string,
    readonly publicationUncertain = false,
  ) {
    super(message);
    this.name = "BranchCreationError";
  }
}
function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new DOMException("Branch creation cancelled.", "AbortError");
}
function validateName(state: VaultState, name: string) {
  if (!branchNameKey(name)) throw new Error("Branch name is required.");
  if (
    state.branches.some((b) => branchNameKey(b.name) === branchNameKey(name))
  ) {
    throw new Error(
      `A branch named "${name.trim()}" already exists. Choose a different name.`,
    );
  }
  if (
    state.corruptedRecords.some((r) => r.recordPath.startsWith("branches/"))
  ) {
    throw new Error(
      "A branch record is damaged. Restore that record before adding another branch.",
    );
  }
}

export async function createDesignBranch(
  options: CreateDesignBranchOptions,
): Promise<{
  branch: BranchRecord;
  workingDir: FileSystemDirectoryAdapter;
  vaultState: VaultState;
  publicationWarning?: string;
}> {
  const {
    vaultDir,
    destinationParent,
    workingFolders: initialWorkingFolders,
    sourceRevisionId,
    signal,
    onProgress,
  } = options;
  const name = options.name.trim().normalize("NFKC");
  const reason = options.reason.trim();
  const initial = await openExistingVault(vaultDir);
  validateName(initial, name);
  if (!reason)
    throw new Error("Add a short engineering reason for this branch.");
  onProgress?.({
    phase: "acquiring_lock",
    processedFiles: 0,
    totalFiles: 0,
    processedBytes: 0,
    totalBytes: 0,
    message: "Waiting for the project writer lock…",
  });
  return withProjectWriterLock(initial.project.projectId, async () => {
    checkCancelled(signal);
    const state = await openExistingVault(vaultDir);
    if (state.project.projectId !== initial.project.projectId)
      throw new Error(
        "Vault identity changed while waiting for the writer lock.",
      );
    validateName(state, name); // Concurrent creation must recheck under the capture lock.
    const workingFolders = options.resolveWorkingFolders ? await options.resolveWorkingFolders(state) : initialWorkingFolders;
    const source = assertRevisionAncestry(state, sourceRevisionId);
    const componentBlock = componentWriteBlock(state);
    if (componentBlock) throw new Error(componentBlock);
    await validateWorkingFolderBindings(state, vaultDir, workingFolders);
    if ((await vaultDir.queryPermission("readwrite")) !== "granted")
      throw new Error("Reconnect the revision vault with write permission.");
    if ((await destinationParent.queryPermission("readwrite")) !== "granted")
      throw new Error(
        "Write permission is required for the destination parent folder.",
      );
    // Parents may contain sibling working folders/vaults; the new child itself must be isolated.
    if (
      (await vaultDir.isSameEntry(destinationParent)) ||
      (await vaultDir.resolveRelativePath(destinationParent)) !== null
    ) {
      throw new Error(
        "The destination parent is inside the revision vault. Choose a separate parent.",
      );
    }
    for (const branch of state.branches) {
      const dir = workingFolders[branch.branchId]!;
      if (
        (await dir.isSameEntry(destinationParent)) ||
        (await dir.resolveRelativePath(destinationParent)) !== null
      ) {
        throw new Error(
          `The destination parent is inside the "${branch.name}" working folder. Choose a separate parent.`,
        );
      }
    }
    const branchId = `branch-${crypto.randomUUID()}`;
    // Readable name chosen under the project writer lock, before the breadcrumb
    // records it. "main" is reserved: Main's folder is working/main.
    const folderName = await pickFreeName(
      destinationParent,
      folderNameFor(name, "Design case"),
      { extraTaken: ["main"] },
    );
    const stagingPath = ["staging", `${branchId}.branch-attempt.json`];
    let workingDir: FileSystemDirectoryAdapter | undefined;
    let publicationAttempted = false;
    try {
      checkCancelled(signal);
      await vaultDir.writeFileText(
        stagingPath,
        JSON.stringify({
          branchId,
          name,
          sourceRevisionId,
          destinationName: folderName,
          startedAt: new Date().toISOString(),
        }),
        { exclusive: true },
      );
      workingDir = await destinationParent.getDirectory([folderName], {
        create: true,
        exclusiveCreate: true,
      });
      await validateDirectoryIsolation(
        workingDir,
        vaultDir,
        "New branch working folder",
        "Revision vault",
      );
      for (const branch of state.branches) {
        await validateDirectoryIsolation(
          workingDir,
          workingFolders[branch.branchId]!,
          "New branch working folder",
          `"${branch.name}" working folder`,
        );
      }
      // Recovery uses a separate destination lock and never requests the project lock.
      // Holding the project lock throughout restore serializes creation with all captures.
      await restoreRevisionToFolder({
        vaultDir,
        workingFolders,
        destinationDir: workingDir,
        revisionId: sourceRevisionId,
        signal,
        onProgress,
      });
      checkCancelled(signal);
      onProgress?.({
        phase: "checking_stability",
        processedFiles: 0,
        totalFiles: source.files.length,
        processedBytes: 0,
        totalBytes: source.files.reduce((n, f) => n + f.size, 0),
        message: "Checking the completed branch inventory before publication…",
      });
      const inventory = await enumerateWorkingFolder(workingDir, {
        signal,
        onProgress: (path, files, bytes) =>
          onProgress?.({
            phase: "checking_stability",
            currentFile: path,
            processedFiles: files,
            totalFiles: source.files.length,
            processedBytes: bytes,
            totalBytes: source.files.reduce((n, f) => n + f.size, 0),
            message: `Checking branch file ${path}…`,
          }),
      });
      const expected = source.files
        .map((f) => [f.path, f.size, f.sha256])
        .sort();
      const actual = partitionSystemFiles(
        inventory.files,
        new Set(source.files.map((f) => f.path)),
      ).files
        .map((f) => [f.path, f.size, f.sha256])
        .sort();
      if (
        inventory.errors.length ||
        JSON.stringify(expected) !== JSON.stringify(actual) ||
        JSON.stringify([...source.directories].sort()) !==
          JSON.stringify([...inventory.directories].sort())
      ) {
        throw new Error(
          "The restored working copy changed or contains unexpected files/directories. Branch was not published.",
        );
      }
      await validateWorkingFolderBindings(state, vaultDir, workingFolders);
      const draft: Omit<BranchRecord, "payloadSha256"> = {
        schemaVersion: CADTREE_SCHEMA_VERSION,
        projectId: state.project.projectId,
        branchId,
        name,
        reason,
        startingRevisionId: sourceRevisionId,
        createdAt: new Date().toISOString(),
        isMain: false,
      };
      const branch: BranchRecord = {
        ...draft,
        payloadSha256: computeBranchRecordChecksum(draft),
      };
      await options.beforePublish?.(branch, workingDir);
      checkCancelled(signal);
      const recordPath = ["branches", `${branchId}.branch.json`];
      const text = JSON.stringify(branch, null, 2);
      // The large record is staged and read back before a small ready marker commits it.
      let publicationWarning: string | undefined;
      try {
        await vaultDir.writeFileText(recordPath, text, { exclusive: true });
      } catch (error) {
        publicationWarning = `Branch record write acknowledgement failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      if ((await vaultDir.readFileText(recordPath)) !== text)
        throw new Error(
          "Branch record read-back verification failed. No ready marker was published.",
        );
      const readyPath = ["branches", `${branchId}.ready.json`];
      const readyText = JSON.stringify({
        projectId: state.project.projectId,
        branchId,
        recordSha256: hashString(text),
      });
      onProgress?.({
        phase: "publishing_branch",
        processedFiles: source.files.length,
        totalFiles: source.files.length,
        processedBytes: inventory.totalBytes,
        totalBytes: inventory.totalBytes,
        message: "Publishing the verified design branch…",
      });
      checkCancelled(signal);
      publicationAttempted = true;
      try {
        await vaultDir.writeFileText(readyPath, readyText, { exclusive: true });
      } catch (error) {
        // A close/acknowledgement can fail after the full record reached storage.
        publicationWarning = `The branch record was saved, but its write acknowledgement failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      if ((await vaultDir.readFileText(readyPath)) !== readyText)
        throw new Error(
          "Branch ready marker read-back verification failed. Reopen the vault to inspect its publication status.",
        );
      // The verified ready marker is the commit point; cancellation after it is success.
      const updated: VaultState = {
        ...state,
        branches: [...state.branches, branch].sort(
          (a, b) =>
            Number(b.isMain) - Number(a.isMain) || a.name.localeCompare(b.name),
        ),
        branchHeads: { ...state.branchHeads, [branchId]: sourceRevisionId },
      };
      try {
        await vaultDir.removeEntry(stagingPath);
      } catch {
        /* Successful publication is authoritative, even if staging cleanup fails. */
      }
      return { branch, workingDir, vaultState: updated, publicationWarning };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BranchCreationError(
        `${message}${workingDir ? (publicationAttempted ? ` Destination "${workingDir.name}" was retained. Its publication status is uncertain; reopen the vault before retrying.` : ` Incomplete destination: "${workingDir.name}". It was not deleted. Retry into a fresh folder.`) : ""}`,
        workingDir?.name,
        publicationAttempted,
      );
    }
  });
}
