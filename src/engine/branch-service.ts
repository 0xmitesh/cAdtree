import type { FileSystemDirectoryAdapter } from "./fs-adapter";
import { FileConflictError, validateDirectoryIsolation } from "./fs-adapter";
import { newRecordId } from "./ids";
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
  MAIN_BRANCH_ID,
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
  /** Test seam: supplies each candidate record ID. Defaults to newRecordId(). */
  newBranchId?: () => string;
  /** Extra clash check for stores outside the vault (e.g. the workspace breadcrumb). Read-only. */
  isBranchIdTaken?: (branchId: string) => Promise<boolean>;
  /**
   * Called under the project writer lock after the final folder name is chosen and before anything
   * is written. Throwing here leaves nothing behind (e.g. the path budget check).
   */
  beforeFirstWrite?: (info: { folderName: string; sourceFiles: string[]; sourceDirectories: string[] }) => void | Promise<void>;
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
    throw new DOMException("Case creation cancelled.", "AbortError");
}
function validateName(state: VaultState, name: string) {
  if (!branchNameKey(name)) throw new Error("Case name is required.");
  if (
    state.branches.some((b) => branchNameKey(b.name) === branchNameKey(name))
  ) {
    throw new Error(
      `A case named "${name.trim()}" already exists. Choose a different name.`,
    );
  }
  if (
    state.corruptedRecords.some((r) => r.recordPath.startsWith("branches/"))
  ) {
    throw new Error(
      "A case record is damaged. Restore that record before adding another case.",
    );
  }
}

export const branchAttemptPath = (branchId: string): string[] => ["staging", `${branchId}.branch-attempt.json`];
export const branchRecordPath = (branchId: string): string[] => ["branches", `${branchId}.branch.json`];
export const branchReadyPath = (branchId: string): string[] => ["branches", `${branchId}.ready.json`];
/** New cases try this many record IDs before giving up; nothing is written for a rejected ID. */
export const MAX_BRANCH_ID_ATTEMPTS = 5;
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
    throw new Error("Add a short reason for this case.");
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
        "The vault changed while waiting for the writer lock.",
      );
    validateName(state, name); // Concurrent creation must recheck under the capture lock.
    const workingFolders = options.resolveWorkingFolders ? await options.resolveWorkingFolders(state) : initialWorkingFolders;
    const source = assertRevisionAncestry(state, sourceRevisionId);
    const componentBlock = componentWriteBlock(state);
    if (componentBlock) throw new Error(componentBlock);
    await validateWorkingFolderBindings(state, vaultDir, workingFolders);
    if ((await vaultDir.queryPermission("readwrite")) !== "granted")
      throw new Error("Reconnect the version vault with write permission.");
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
        "The destination parent is inside the version vault. Choose a separate parent.",
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
    // Readable name chosen under the project writer lock, before the breadcrumb
    // records it. "main" is reserved: Main's folder is working/main.
    const folderName = await pickFreeName(
      destinationParent,
      folderNameFor(name, "Design case"),
      { extraTaken: ["main"] },
    );
    await options.beforeFirstWrite?.({ folderName, sourceFiles: source.files.map((f) => f.path), sourceDirectories: source.directories });
    let workingDir: FileSystemDirectoryAdapter | undefined;
    let publicationAttempted = false;
    let branchId = "";
    let stagingPath: string[] = [];
    try {
      checkCancelled(signal);
      // The staging attempt is the first write for a case and is exclusive, so it claims the
      // record ID. A clash (existing case, leftover attempt, existing breadcrumb) draws a new ID
      // before anything else is written; other cases' records are never touched.
      for (let attempt = 1; ; attempt++) {
        const candidate = (options.newBranchId ?? newRecordId)();
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(candidate) || candidate === MAIN_BRANCH_ID)
          throw new Error("Invalid design case ID. Nothing was written.");
        const known =
          state.branches.some((b) => b.branchId === candidate) ||
          (await vaultDir.hasFile(branchRecordPath(candidate))) ||
          (await vaultDir.hasFile(branchReadyPath(candidate))) ||
          (await vaultDir.hasFile(branchAttemptPath(candidate))) ||
          (options.isBranchIdTaken ? await options.isBranchIdTaken(candidate) : false);
        if (!known) {
          try {
            await vaultDir.writeFileText(
              branchAttemptPath(candidate),
              JSON.stringify({
                branchId: candidate,
                name,
                sourceRevisionId,
                destinationName: folderName,
                startedAt: new Date().toISOString(),
              }),
              { exclusive: true },
            );
            branchId = candidate;
            stagingPath = branchAttemptPath(candidate);
            break;
          } catch (error) {
            if (!(error instanceof FileConflictError)) throw error;
          }
        }
        if (attempt >= MAX_BRANCH_ID_ATTEMPTS)
          throw new Error(
            `No free design case ID after ${MAX_BRANCH_ID_ATTEMPTS} attempts. Nothing was written. Try again.`,
          );
      }
      workingDir = await destinationParent.getDirectory([folderName], {
        create: true,
        exclusiveCreate: true,
      });
      await validateDirectoryIsolation(
        workingDir,
        vaultDir,
        "New case working folder",
        "Version vault",
      );
      for (const branch of state.branches) {
        await validateDirectoryIsolation(
          workingDir,
          workingFolders[branch.branchId]!,
          "New case working folder",
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
        message: "Checking the completed case inventory before publication…",
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
            message: `Checking case file ${path}…`,
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
          "The restored working copy changed or contains unexpected files/directories. Case was not published.",
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
      const recordPath = branchRecordPath(branchId);
      const text = JSON.stringify(branch, null, 2);
      // The large record is staged and read back before a small ready marker commits it.
      let publicationWarning: string | undefined;
      try {
        await vaultDir.writeFileText(recordPath, text, { exclusive: true });
      } catch (error) {
        publicationWarning = `Case record write acknowledgement failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      if ((await vaultDir.readFileText(recordPath)) !== text)
        throw new Error(
          "Case record read-back verification failed. No ready marker was published.",
        );
      const readyPath = branchReadyPath(branchId);
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
        message: "Publishing the verified design case…",
      });
      checkCancelled(signal);
      publicationAttempted = true;
      try {
        await vaultDir.writeFileText(readyPath, readyText, { exclusive: true });
      } catch (error) {
        // A close/acknowledgement can fail after the full record reached storage.
        publicationWarning = `The case record was saved, but its write acknowledgement failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      if ((await vaultDir.readFileText(readyPath)) !== readyText)
        throw new Error(
          "Case ready marker read-back verification failed. Reopen the vault to inspect its publication status.",
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
        `${message}${workingDir ? (publicationAttempted ? ` Destination "${workingDir.name}" was kept. Its publication status is uncertain; reopen the vault before retrying.` : ` Incomplete destination: "${workingDir.name}". It was not deleted. Retry into a fresh folder.`) : ""}`,
        workingDir?.name,
        publicationAttempted,
      );
    }
  });
}
