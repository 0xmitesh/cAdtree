import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  abandonApplication,
  applySaveSummary,
  applyAndSave,
  recoverApplication,
  requestApplicationWriteAccess,
  type ApplyAndSaveResult,
} from "../engine/application-service";
import type {
  ApplicationOperation,
  ApplicationReview,
} from "../engine/application-records";
import type { WorkingFolderBindings } from "../engine/branch-state";
import type { FileSystemDirectoryAdapter } from "../engine/fs-adapter";
import type { RevisionNotes, VaultState } from "../engine/types";
import { formatRevisionNumber, openExistingVault } from "../engine/vault-service";
import { resolveManagedProject, type ManagedProject, type WorkspaceState } from "../engine/workspace-service";
import { projectGuideTarget, refreshGuidesAfter } from "./offline-guide-refresh";
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
  /** Asks for a quiet rescan of the page (useAutoRefresh); `immediate` skips the minimum interval. */
  requestAutoRefresh: (options?: { immediate?: boolean }) => void;
  setStatusBanner: Dispatch<SetStateAction<StatusBanner | null>>;
};

/** A request from outside History (the Undo link) to open Bring back for one revision. */
export type BringBackRequest = { projectId: string; revisionId: string; nonce: number };
/** The normal Save, prefilled after a Bring back or Copy that was written but not saved. */
export type CapturePrefill = {
  projectId: string;
  /** The operation it saves: the prefill applies only while that operation is `applied`. */
  operationId: string;
  branchId: string;
  summary: string;
  notes: RevisionNotes;
  key: string;
};

/**
 * Bring back (revert) and Copy files from a case (merge) on the active branch:
 * write and save in one step (engine `applyAndSave`), Save now when only the
 * save failed, and the recovery of an interrupted write.
 */
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
  requestAutoRefresh,
  setStatusBanner,
}: UseApplicationActionsArgs) {
  // Why the save failed, per operation, for this session (the operation itself stays `applied`).
  const [notSavedReasons, setNotSavedReasons] = useState<Record<string, string>>({});
  const [bringBackRequest, setBringBackRequest] = useState<BringBackRequest | null>(null);
  const [capturePrefill, setCapturePrefill] = useState<CapturePrefill | null>(null);
  // Once its operation is saved or finished, the prefill is dropped for good.
  const prefillStillPending =
    !capturePrefill ||
    (vaultState?.project.projectId === capturePrefill.projectId &&
      (vaultState.applicationOperations ?? []).some(
        (op) =>
          op.operationId === capturePrefill.operationId && op.status === "applied",
      ));
  useEffect(() => {
    if (!prefillStillPending) setCapturePrefill(null);
  }, [prefillStillPending]);
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
  const refreshApplicationState = async () => {
    if (!vaultDir) return;
    try {
      applyVaultState(await openExistingVault(vaultDir));
      // The files just changed: the result on screen stays until a quiet rescan replaces it.
      requestAutoRefresh({ immediate: true });
    } catch {
      /* The operation's original permission/outcome error remains visible. */
    }
  };
  const requestBringBack = (projectId: string, revisionId: string) =>
    setBringBackRequest((previous) => ({
      projectId,
      revisionId,
      nonce: (previous?.nonce ?? 0) + 1,
    }));
  const reportResult = (result: ApplyAndSaveResult) => {
    if (result.status === "not-saved") {
      setNotSavedReasons((previous) => ({
        ...previous,
        [result.operation.operationId]: result.reason,
      }));
      return;
    }
    const state = result.vaultState;
    const previousId = result.operation.record?.plan.destinationRevisionId;
    const previous = state.revisions.find(
      (r) => r.manifest.revisionId === previousId,
    );
    const saved = formatRevisionNumber(result.revision.manifest.displayNumber);
    setStatusBanner({
      type: "success",
      message: previous
        ? `Saved as ${saved}. To undo, bring back ${formatRevisionNumber(previous.manifest.displayNumber)}.${result.cacheWarning ? ` ${result.cacheWarning}` : ""}`
        : `Saved as ${saved}.`,
      action: previous
        ? {
            label: "Undo",
            run: () =>
              requestBringBack(state.project.projectId, previous.manifest.revisionId),
          }
        : undefined,
    });
  };
  const handleApplyAndSave = async (review: ApplicationReview) => {
    if (!vaultDir || review.destinationBranchId !== activeBranchId)
      throw new Error("The case changed. Close this and try again.");
    return perform(
      "apply",
      async (context) => {
        let saved = false;
        try {
          await assertProjectWritable(context);
          await requestApplicationWriteAccess(vaultDir, workingDir);
          const result = await applyAndSave(
            vaultDir,
            review,
            applicationOptions(context),
          );
          saved = result.status === "saved";
          if (context.current()) reportResult(result);
          return result;
        } finally {
          if (context.current()) await refreshApplicationState();
          if (saved && workspace && managedProject)
            refreshGuidesAfter({ project: projectGuideTarget(workspace, managedProject) });
        }
      },
      { rethrow: true, banner: false },
    );
  };
  /** Save now: the normal Save on Changes, with the summary and Why prefilled. */
  const handleSaveNow = (op: ApplicationOperation) => {
    if (!vaultState || !op.record) return;
    setCapturePrefill({
      projectId: vaultState.project.projectId,
      operationId: op.operationId,
      branchId: op.destinationBranchId,
      summary: applySaveSummary(vaultState, op.record),
      notes: { problem: op.record.plan.reason ?? "", modification: "", observations: "" },
      key: `${op.operationId}:${Date.now()}`,
    });
  };
  /** Don't save it: the working files stay; cAdtree stops waiting to save the operation. */
  const handleDontSave = async (id: string) => {
    if (!vaultDir || !vaultState) return;
    await perform(
      "apply",
      async (context) => {
        try {
          await assertProjectWritable(context);
          await requestApplicationWriteAccess(vaultDir, workingDir);
          await abandonApplication(
            vaultDir,
            vaultState.project.projectId,
            activeBranchId,
            id,
          );
          if (context.current()) {
            setCapturePrefill((previous) =>
              previous?.operationId === id ? null : previous,
            );
            setStatusBanner({
              type: "success",
              message:
                "cAdtree is no longer waiting to save it. Your working files were not changed.",
            });
          }
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
                "The unfinished change was undone: the affected files are back as they were. Other files were not touched.",
            });
        } finally {
          if (context.current()) await refreshApplicationState();
        }
      },
      true,
    );
  };
  return {
    applicationOptions,
    handleApplyAndSave,
    handleRecoverApplication,
    handleSaveNow,
    handleDontSave,
    notSavedReasons,
    bringBackRequest,
    capturePrefill: prefillStillPending ? capturePrefill : null,
  };
}
