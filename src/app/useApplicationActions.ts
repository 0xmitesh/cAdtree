import type { Dispatch, SetStateAction } from "react";
import type { ApplicationReview } from "../engine/application-records";
import {
  abandonApplication,
  applyPreparedApplication,
  prepareApplication,
  recoverApplication,
  requestApplicationWriteAccess,
  type PreparedApplication,
} from "../engine/application-service";
import type { WorkingFolderBindings } from "../engine/branch-state";
import type { FileSystemDirectoryAdapter } from "../engine/fs-adapter";
import type { ScanResult, VaultState } from "../engine/types";
import { openExistingVault } from "../engine/vault-service";
import { resolveManagedProject, type ManagedProject, type WorkspaceState } from "../engine/workspace-service";
import type { AssertProjectWritable, Context, Perform, StatusBanner } from "./types";

export type UseApplicationActionsArgs = {
  vaultDir: FileSystemDirectoryAdapter | null;
  vaultState: VaultState | null;
  workingDir: FileSystemDirectoryAdapter | null;
  workingFolders: WorkingFolderBindings;
  activeBranchId: string;
  managedProject: ManagedProject | null;
  workspace: WorkspaceState | null;
  perform: Perform;
  assertProjectWritable: AssertProjectWritable;
  applyVaultState: (next: VaultState) => void;
  setScanResult: Dispatch<SetStateAction<ScanResult | null>>;
  setStatusBanner: Dispatch<SetStateAction<StatusBanner | null>>;
};

/** Apply (merge) and Bring back (revert): prepare, apply, recover and abandon an application on the active branch. */
export function useApplicationActions({
  vaultDir,
  vaultState,
  workingDir,
  workingFolders,
  activeBranchId,
  managedProject,
  workspace,
  perform,
  assertProjectWritable,
  applyVaultState,
  setScanResult,
  setStatusBanner,
}: UseApplicationActionsArgs) {
  const applicationFolders = async (state: VaultState) => {
    if (!managedProject || !workspace) return workingFolders;
    const current = await resolveManagedProject(
      workspace.root,
      managedProject.record.containerPath,
      state,
    );
    if (!current.ready || current.issues.length)
      throw new Error(current.issues.join(" "));
    return current.workingFolders;
  };
  const applicationOptions = (context: Context) => ({
    workingFolders,
    resolveWorkingFolders: applicationFolders,
    signal: context.signal,
    onProgress: context.progress,
  });
  const handlePrepareApplication = async (review: ApplicationReview) => {
    if (!vaultDir || review.destinationBranchId !== activeBranchId)
      throw new Error("Destination context changed. Refresh and review again.");
    const result = await perform(
      "apply",
      async (context) => {
        await assertProjectWritable(context);
        await requestApplicationWriteAccess(vaultDir, workingDir);
        return prepareApplication(
          vaultDir,
          review,
          applicationOptions(context),
        );
      },
      true,
    );
    if (!result) throw new Error("Application preparation did not finish.");
    return result;
  };
  const handleRefreshApplicationReview = async () => {
    if (!vaultDir) throw new Error("Reconnect the revision vault.");
    await perform(
      "scan",
      async (context) => {
        const state = await openExistingVault(vaultDir);
        if (context.current()) {
          applyVaultState(state);
          setScanResult(null);
        }
      },
      true,
    );
  };
  const refreshApplicationState = async () => {
    if (!vaultDir) return;
    try {
      applyVaultState(await openExistingVault(vaultDir));
      setScanResult(null);
    } catch {
      /* The operation's original permission/outcome error remains visible. */
    }
  };
  const handleApplyApplication = async (prepared: PreparedApplication) => {
    if (!vaultDir || prepared.review.destinationBranchId !== activeBranchId)
      throw new Error("Destination context changed. Refresh and review again.");
    await perform(
      "apply",
      async (context) => {
        try {
          await assertProjectWritable(context);
          await applyPreparedApplication(
            vaultDir,
            prepared,
            applicationOptions(context),
          );
          if (context.current())
            setStatusBanner({
              type: "success",
              message:
                prepared.plan.mode === "revert"
                  ? "Brought back into working files — revision not yet saved."
                  : "Applied to working files — revision not yet saved.",
            });
        } finally {
          if (context.current()) await refreshApplicationState();
        }
      },
      true,
    );
  };
  const handleRecoverApplication = async (id: string) => {
    if (!vaultDir || !vaultState) return;
    await perform(
      "apply",
      async (context) => {
        try {
          await assertProjectWritable(context);
          await requestApplicationWriteAccess(vaultDir, workingDir);
          const result = await recoverApplication(
            vaultDir,
            vaultState.project.projectId,
            activeBranchId,
            id,
            applicationOptions(context),
          );
          if (result.manualPaths.length)
            throw new Error(
              `Manual recovery required: ${result.manualPaths.join(", ")}. Unexpected files remain untouched; readable copies are retained under the operation's unexpected folder. Inspect the before-state evidence, restore affected paths manually, then retry recovery.`,
            );
          if (context.current())
            setStatusBanner({
              type: "success",
              message:
                "Affected file before-states recovered and verified. Unrelated files and directories were retained. Scan before saving.",
            });
        } finally {
          if (context.current()) await refreshApplicationState();
        }
      },
      true,
    );
  };
  const handleAbandonApplication = async (id: string) => {
    if (!vaultDir || !vaultState) return;
    await perform(
      "apply",
      async (context) => {
        try {
          await assertProjectWritable(context);
          await abandonApplication(
            vaultDir,
            vaultState.project.projectId,
            activeBranchId,
            id,
          );
        } finally {
          if (context.current()) await refreshApplicationState();
        }
      },
      true,
    );
  };
  return {
    applicationOptions,
    handlePrepareApplication,
    handleRefreshApplicationReview,
    handleApplyApplication,
    handleRecoverApplication,
    handleAbandonApplication,
  };
}
