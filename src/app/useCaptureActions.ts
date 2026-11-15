import type { Dispatch, RefObject, SetStateAction } from "react";
import type { AuthSnapshot } from "../auth/firebase-auth";
import type { IdentityReview } from "../engine/component-identity";
import type { FileSystemDirectoryAdapter } from "../engine/fs-adapter";
import {
  getBranchBaseline,
  validateWorkingFolderBindings,
  type WorkingFolderBindings,
} from "../engine/branch-state";
import type { ReferenceReview } from "../engine/references";
import { captureRevision, ReviewStaleError } from "../engine/revision-service";
import { scanBranchChanges } from "../engine/scanner";
import type { FileSpecificNote, ScanResult, VaultState } from "../engine/types";
import { formatRevisionNumber, openExistingVault } from "../engine/vault-service";
import { resolveManagedProject, type ManagedProject, type WorkspaceState } from "../engine/workspace-service";
import { renamedNotice, type OpenProjectLookup } from "./project-lookup";
import type { Context, StatusBanner } from "./types";
import type { useOperation } from "./useOperation";

export type UseCaptureActionsArgs = {
  vaultDir: FileSystemDirectoryAdapter | null;
  workingDir: FileSystemDirectoryAdapter | null;
  workingFolders: WorkingFolderBindings;
  activeBranchId: string;
  managedProject: ManagedProject | null;
  workspace: WorkspaceState | null;
  authStateRef: RefObject<AuthSnapshot>;
  perform: ReturnType<typeof useOperation>["perform"];
  assertProjectWritable: (context: Context, readOnlyOperation?: boolean) => Promise<ManagedProject | null>;
  refindOpenProject: (context: Context, prescanned?: WorkspaceState) => Promise<OpenProjectLookup | null>;
  applyVaultState: (next: VaultState) => void;
  setVaultState: Dispatch<SetStateAction<VaultState | null>>;
  setManagedProject: Dispatch<SetStateAction<ManagedProject | null>>;
  setWorkingFolders: Dispatch<SetStateAction<WorkingFolderBindings>>;
  setWorkingDir: Dispatch<SetStateAction<FileSystemDirectoryAdapter | null>>;
  setScanResult: Dispatch<SetStateAction<ScanResult | null>>;
  setStatusBanner: Dispatch<SetStateAction<StatusBanner | null>>;
};

/** Scan and capture: scan a branch's working folder against its saved revision, and save a revision. */
export function useCaptureActions({
  vaultDir,
  workingDir,
  workingFolders,
  activeBranchId,
  managedProject,
  workspace,
  authStateRef,
  perform,
  assertProjectWritable,
  refindOpenProject,
  applyVaultState,
  setVaultState,
  setManagedProject,
  setWorkingFolders,
  setWorkingDir,
  setScanResult,
  setStatusBanner,
}: UseCaptureActionsArgs) {
  const scan = async (
    vault: FileSystemDirectoryAdapter,
    folders: WorkingFolderBindings,
    branchId: string,
    context: Context,
    explicitContext?: {
      root: FileSystemDirectoryAdapter;
      path: string;
    } | null,
    // Called when the open project was re-found at a new folder during this scan (the banner is already set).
    onRebound?: (notice: string) => void,
  ) => {
    let folder = folders[branchId];
    let state: VaultState;
    // Without an explicit location, the open project's stored path is used, and re-found by ID if it moved.
    const managedContext =
      explicitContext !== undefined
        ? explicitContext
        : managedProject && workspace
          ? { root: workspace.root, path: managedProject.record.containerPath }
          : null;
    if (managedContext) {
      let current: ManagedProject;
      try {
        current = await resolveManagedProject(
          managedContext.root,
          managedContext.path,
        );
        if (
          explicitContext === undefined &&
          current.record.projectId !== managedProject?.record.projectId
        )
          throw new Error("The project at the stored location changed.");
      } catch (error) {
        if (explicitContext !== undefined) throw error;
        const found = await refindOpenProject(context);
        if (!found) throw error;
        if (found.kind === "unavailable") throw new Error(found.reason);
        current = found.project;
        vault = current.vaultDir;
        if (found.renamed) {
          const notice = renamedNotice(found.project);
          if (context.current()) setStatusBanner({ type: "info", message: notice });
          onRebound?.(notice);
        }
      }
      if (context.current()) {
        setManagedProject(current);
        setWorkingFolders(current.workingFolders);
        setWorkingDir(current.workingFolders[branchId] ?? null);
      }
      if (!current.ready || current.issues.length)
        throw new Error(
          `This managed project is read-only. ${current.issues.join(" ")}`,
        );
      folders = current.workingFolders;
      folder = folders[branchId];
      state = current.vaultState;
    } else state = await openExistingVault(vault);
    if (!folder)
      throw new Error(
        "Connect the selected branch’s working folder before scanning.",
      );
    if (!context.current()) return;
    applyVaultState(state);
    await validateWorkingFolderBindings(state, vault, folders, false);
    if ((await folder.queryPermission("read")) !== "granted")
      throw new Error(
        "Reconnect the selected branch’s working folder to restore read permission.",
      );
    const baseline = getBranchBaseline(state, branchId);
    const result = await scanBranchChanges(folder, branchId, baseline, {
      signal: context.signal,
      onProgress: (path, files, bytes) =>
        context.progress({
          phase: "scanning_source",
          currentFile: path,
          processedFiles: files,
          totalFiles: files,
          processedBytes: bytes,
          totalBytes: bytes,
          message: `Scanning ${path}…`,
        }),
    });
    if (context.current()) setScanResult(result);
    return result;
  };
  const handleScanCurrent = async () => {
    if (!vaultDir) return;
    await perform("scan", async (context) => {
      setScanResult(null);
      let renamed: string | null = null;
      const result = await scan(
        vaultDir,
        workingFolders,
        activeBranchId,
        context,
        undefined,
        (notice) => {
          renamed = notice;
        },
      );
      if (result && context.current())
        setStatusBanner({
          type: "info",
          message: `${renamed ? `${renamed} ` : ""}${
            result.hasChanges
              ? `Scan complete: ${result.added.length} added, ${result.modified.length} modified, ${result.deleted.length} deleted.`
              : "This working folder matches its branch’s saved revision."
          }`,
        });
    });
  };
  const handleCaptureRevision = async (
    branchId: string,
    params: {
      summary: string;
      notes: { problem: string; modification: string; observations: string };
      fileNotes: FileSpecificNote[];
      reviewedChangesSignature: string;
      identityReview?: IdentityReview;
      referenceReview?: ReferenceReview;
      referenceAttachments?: import('../engine/references').PendingReferenceAttachment[];
      onReferenceAttachmentsStored?: (review: ReferenceReview) => void;
    },
  ) => {
    if (!workingDir || !vaultDir || branchId !== activeBranchId)
      throw new Error(
        "The active branch connection changed. Scan again before saving.",
      );
    await perform(
      "capture",
      async (context) => {
        try {
          await assertProjectWritable(context);
          const result = await captureRevision(workingDir, vaultDir, {
            ...params,
            referenceAuthor: authStateRef.current.user ? { id: authStateRef.current.user.uid, displayName: authStateRef.current.user.displayName || authStateRef.current.user.email || 'User' } : undefined,
            onReferenceAttachmentsStored: (review, state) => {
              if (!context.current()) return;
              setVaultState(state);
              params.onReferenceAttachmentsStored?.(review);
            },
            branchId,
            workingFolders,
            resolveWorkingFolders:
              managedProject && workspace
                ? async (state) => {
                    const current = await resolveManagedProject(
                      workspace.root,
                      managedProject.record.containerPath,
                      state,
                    );
                    if (!current.ready || current.issues.length)
                      throw new Error(current.issues.join(" "));
                    return current.workingFolders;
                  }
                : undefined,
            signal: context.signal,
            onProgress: context.progress,
          });
          if (!context.current()) return;
          setVaultState(result.vaultState);
          setScanResult(null);
          // Publication succeeded even if a subsequent scan loses folder access.
          let scanWarning = "";
          try {
            await scan(vaultDir, workingFolders, branchId, context);
          } catch (error) {
            scanWarning = `Rescan needed: ${error instanceof Error ? error.message : String(error)}`;
          }
          if (context.current())
            setStatusBanner({
              type: "success",
              message: `Published and verified ${formatRevisionNumber(result.revision.manifest.displayNumber)} on this working case. ${result.cacheWarning ?? ""} ${scanWarning}`,
            });
        } catch (error) {
          if (error instanceof ReviewStaleError && context.current())
            setScanResult(error.freshScan);
          throw error;
        }
      },
      true,
    );
  };
  return { scan, handleScanCurrent, handleCaptureRevision };
}
