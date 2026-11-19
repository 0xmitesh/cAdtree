import { assertCaseWritable } from "../engine/case-lifecycle";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { CreateBranchParams } from "../components/CreateBranchDialog";
import type { WorkingFolderBindings } from "../engine/branch-state";
import { changeCaseLifecycle } from "../engine/case-lifecycle-service";
import type { FileSystemDirectoryAdapter } from "../engine/fs-adapter";
import { MAIN_BRANCH_ID, type ScanResult, type VaultState } from "../engine/types";
import { openExistingVault } from "../engine/vault-service";
import { createManagedBranch, type ManagedProject, type WorkspaceState } from "../engine/workspace-service";
import { projectGuideTarget, refreshGuidesAfter } from "./offline-guide-refresh";
import { pathBudgetWarnSentence } from "../utils/path-budget-message";
import type { AssertProjectWritable, Perform, StatusBanner } from "./types";
import type { useApplicationActions } from "./useApplicationActions";
import type { useCaptureActions } from "./useCaptureActions";

export type UseBranchActionsArgs = {
  vaultDir: FileSystemDirectoryAdapter | null;
  vaultState: VaultState | null;
  workingFolders: WorkingFolderBindings;
  activeBranchId: string;
  managedProject: ManagedProject | null;
  workspace: WorkspaceState | null;
  operationRef: RefObject<AbortController | null>;
  contextVersion: RefObject<number>;
  perform: Perform;
  assertProjectWritable: AssertProjectWritable;
  scan: ReturnType<typeof useCaptureActions>["scan"];
  applicationOptions: ReturnType<typeof useApplicationActions>["applicationOptions"];
  applyVaultState: (next: VaultState) => void;
  persistWorkspace: (
    current: WorkspaceState,
    project?: { path: string; id: string },
    branchId?: string,
  ) => Promise<string>;
  refreshWorkspace: () => Promise<void>;
  ensureHomeAddress: (scope: "home" | "workspace") => Promise<void>;
  budgetWorkspaceAddress: () => Promise<string | undefined>;
  setVaultState: Dispatch<SetStateAction<VaultState | null>>;
  setManagedProject: Dispatch<SetStateAction<ManagedProject | null>>;
  setWorkingFolders: Dispatch<SetStateAction<WorkingFolderBindings>>;
  setWorkingDir: Dispatch<SetStateAction<FileSystemDirectoryAdapter | null>>;
  setActiveBranchId: Dispatch<SetStateAction<string>>;
  setScanResult: Dispatch<SetStateAction<ScanResult | null>>;
  setStatusBanner: Dispatch<SetStateAction<StatusBanner | null>>;
};

/** Design cases: switch the working case, create a case, hide or unhide one, and reattach working folders. */
export function useBranchActions({
  vaultDir,
  vaultState,
  workingFolders,
  activeBranchId,
  managedProject,
  workspace,
  operationRef,
  contextVersion,
  perform,
  assertProjectWritable,
  scan,
  applicationOptions,
  applyVaultState,
  persistWorkspace,
  refreshWorkspace,
  ensureHomeAddress,
  budgetWorkspaceAddress,
  setVaultState,
  setManagedProject,
  setWorkingFolders,
  setWorkingDir,
  setActiveBranchId,
  setScanResult,
  setStatusBanner,
}: UseBranchActionsArgs) {
  const handleSelectBranch = async (branchId: string) => {
    if (
      operationRef.current ||
      !vaultState ||
      !vaultDir ||
      branchId === activeBranchId
    )
      return;
    contextVersion.current++;
    setScanResult(null);
    setStatusBanner(null);
    await perform("scan", async (context) => {
      await assertProjectWritable(context, true);
      const state = await openExistingVault(vaultDir);
      if (!context.current()) return;
      applyVaultState(state);
      if (!state.branches.some((b) => b.branchId === branchId))
        throw new Error("Selected branch is missing. Reopen the vault.");
      assertCaseWritable(state, branchId);
      setActiveBranchId(branchId);
      setWorkingDir(null);
      const folder = workingFolders[branchId];
      let readable = false;
      try {
        readable = Boolean(
          folder && (await folder.queryPermission("read")) === "granted",
        );
      } catch {
        /* Reconnect a stale handle explicitly. */
      }
      if (folder && readable) {
        if (!context.current()) return;
        setWorkingDir(folder);
        await scan(vaultDir, workingFolders, branchId, context);
      } else {
        setWorkingFolders((previous) => {
          const updated = { ...previous };
          delete updated[branchId];
          return updated;
        });
      }
      const warning = workspace && managedProject
        ? await persistWorkspace(
            workspace,
            { path: managedProject.record.containerPath, id: managedProject.record.projectId },
            branchId,
          )
        : "";
      if (context.current())
        setStatusBanner(
          !readable || warning
            ? {
                type: "info",
                message:
                  `${readable ? "" : "Connect this branch’s working folder explicitly to scan or save."} ${warning}`.trim(),
              }
            : null,
        );
    });
  };
  /** Hide case ("archived") or Unhide ("active"). Hiding the working case
   * switches the app to Main once the case is hidden. */
  const handleCaseLifecycle = async (
    branchId: string,
    status: "active" | "archived",
    expectedVersion: string | null,
    acknowledgedChangesSignature?: string,
  ) => {
    if (!vaultDir || !vaultState) throw new Error("Open the project first.");
    const hidingWorkingCase =
      status === "archived" && branchId === activeBranchId;
    let message = "";
    await perform(
      "scan",
      async (context) => {
        try {
          await assertProjectWritable(context);
          if (
            (await vaultDir.queryPermission("readwrite")) !== "granted" &&
            (await vaultDir.requestPermission("readwrite")) !== "granted"
          )
            throw new Error(
              "Write access to the project is required to hide or unhide a case.",
            );
          const result = await changeCaseLifecycle(
            vaultDir,
            {
              projectId: vaultState.project.projectId,
              branchId,
              activeBranchId: hidingWorkingCase ? MAIN_BRANCH_ID : activeBranchId,
              status,
              expectedVersion,
              acknowledgedChangesSignature,
            },
            applicationOptions(context),
          );
          // Hidden or unhidden: update the Map's case status.
          refreshGuidesAfter({ project: projectGuideTarget(workspace, managedProject) });
          const name = result.state.branches.find((branch) => branch.branchId === branchId)?.name;
          message = `${status === "archived" ? `Hid ${name}. Turn on Show hidden cases in History or Explorer to see it again.${hidingWorkingCase ? " You are now working on Main." : ""}` : `${name} is shown again.`} ${result.warning ?? ""}`.trim();
          if (context.current()) {
            applyVaultState(result.state);
            if (!hidingWorkingCase) setStatusBanner({ type: "success", message });
          }
        } finally {
          if (context.current()) {
            try {
              applyVaultState(await openExistingVault(vaultDir));
            } catch {
              /* Original error remains visible. */
            }
          }
        }
      },
      // The hide/unhide dialog shows a failure itself: no second copy in the page banner.
      { rethrow: true, banner: false },
    );
    if (hidingWorkingCase) {
      // The case is hidden (read-only): leave it for Main.
      await handleSelectBranch(MAIN_BRANCH_ID);
      setStatusBanner({ type: "success", message });
    }
  };
  const handleReattachWorkingFolder = async () => {
    if (managedProject && workspace) await refreshWorkspace();
  };
  const handleCreateBranch = async (params: CreateBranchParams) => {
    if (!vaultDir || !vaultState || !managedProject || !workspace)
      throw new Error("Open a project in a Cadtree workspace first.");
    await ensureHomeAddress("workspace");
    await perform(
      "branch",
      async (context) => {
        await assertProjectWritable(context);
        if (managedProject && workspace) {
          const current = await createManagedBranch(
            workspace.root,
            managedProject.record.containerPath,
            {
              sourceRevisionId: params.sourceRevisionId,
              name: params.name,
              reason: params.reason,
              signal: context.signal,
              onProgress: context.progress,
              budget: { workspaceAddress: await budgetWorkspaceAddress() },
            },
          );
          // The case is published: update the Map (the new case and its folder).
          refreshGuidesAfter({ project: projectGuideTarget(workspace, current) });
          if (!context.current()) return;
          setManagedProject(current);
          setVaultState(current.vaultState);
          setWorkingFolders(current.workingFolders);
          setWorkingDir(current.workingFolders[current.createdBranchId]!);
          setActiveBranchId(current.createdBranchId);
          setScanResult(null);
          const warning = await persistWorkspace(
            workspace,
            { path: current.record.containerPath, id: current.record.projectId },
            current.createdBranchId,
          );
          try {
            await scan(
              current.vaultDir,
              current.workingFolders,
              current.createdBranchId,
              context,
            );
          } catch {
            /* The published branch stays successful; connection diagnostics are refreshed next time. */
          }
          if (context.current())
            setStatusBanner({
              type: "success",
              message: `Created and verified "${params.name}". Open ${workspace.root.name}/${current.workingPaths[current.createdBranchId]} manually in SolidWorks. ${warning}${pathBudgetWarnSentence(current.pathBudget) ? ` ${pathBudgetWarnSentence(current.pathBudget)}` : ""}`,
            });
          return;
        }
      },
      true,
    );
  };
  return {
    handleSelectBranch,
    handleCaseLifecycle,
    handleReattachWorkingFolder,
    handleCreateBranch,
  };
}
