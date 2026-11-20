import type { Dispatch, RefObject, SetStateAction } from "react";
import type { HomeAddress } from "../components/FolderAddressDialog";
import type { WorkingFolderBindings } from "../engine/branch-state";
import type { FileSystemDirectoryAdapter } from "../engine/fs-adapter";
import {
  clearAllConvenienceMetadata,
  type RememberedHome,
  type RememberedWorkspace,
} from "../engine/idb-store";
import type { ScanResult, VaultState } from "../engine/types";
import {
  formatRevisionNumber,
  openExistingVault,
  verifyRevisionObjects,
} from "../engine/vault-service";
import { openWorkspace, type ManagedProject, type WorkspaceState } from "../engine/workspace-service";
import { locateProjectById } from "./project-lookup";
import type { ActiveTab, Perform, StatusBanner } from "./types";

export type UseDiagnosticsActionsArgs = {
  vaultDir: FileSystemDirectoryAdapter | null;
  vaultState: VaultState | null;
  activeBranchId: string;
  managedProject: ManagedProject | null;
  workspace: WorkspaceState | null;
  homeAddressCache: RefObject<HomeAddress[]>;
  perform: Perform;
  setHomeAddress: Dispatch<SetStateAction<HomeAddress | null>>;
  setConvenienceEpoch: Dispatch<SetStateAction<number>>;
  setRememberedWorkspace: Dispatch<SetStateAction<RememberedWorkspace | null>>;
  setRememberedHome: Dispatch<SetStateAction<RememberedHome | null>>;
  setWorkspace: Dispatch<SetStateAction<WorkspaceState | null>>;
  setProjectUnavailable: Dispatch<SetStateAction<string | null>>;
  setManagedProject: Dispatch<SetStateAction<ManagedProject | null>>;
  setVaultState: Dispatch<SetStateAction<VaultState | null>>;
  setWorkingFolders: Dispatch<SetStateAction<WorkingFolderBindings>>;
  setWorkingDir: Dispatch<SetStateAction<FileSystemDirectoryAdapter | null>>;
  setScanResult: Dispatch<SetStateAction<ScanResult | null>>;
  setActiveTab: Dispatch<SetStateAction<ActiveTab>>;
  setStatusBanner: Dispatch<SetStateAction<StatusBanner | null>>;
};

/** Diagnostics: verify saved file contents, and reset this browser's remembered connections. */
export function useDiagnosticsActions({
  vaultDir,
  vaultState,
  activeBranchId,
  managedProject,
  workspace,
  homeAddressCache,
  perform,
  setHomeAddress,
  setConvenienceEpoch,
  setRememberedWorkspace,
  setRememberedHome,
  setWorkspace,
  setProjectUnavailable,
  setManagedProject,
  setVaultState,
  setWorkingFolders,
  setWorkingDir,
  setScanResult,
  setActiveTab,
  setStatusBanner,
}: UseDiagnosticsActionsArgs) {
  const handleVerifyObjects = async (ids: string[]) => {
    if (!vaultDir || !vaultState) return;
    await perform("verify", async (context) => {
      let processedFiles = 0,
        processedBytes = 0,
        corrupt = false;
      const targets = vaultState.revisions.filter((r) =>
        ids.includes(r.manifest.revisionId),
      );
      const totalFiles = targets.reduce(
        (n, r) => n + r.manifest.files.length,
        0,
      );
      const totalBytes = targets.reduce(
        (n, r) => n + r.manifest.files.reduce((s, f) => s + f.size, 0),
        0,
      );
      for (const revision of targets) {
        if (context.signal.aborted)
          throw new DOMException(
            "Verification cancelled. Completed checks have been retained.",
            "AbortError",
          );
        context.progress({
          phase: "verifying_objects",
          processedFiles,
          totalFiles,
          processedBytes,
          totalBytes,
          message: `Verifying ${formatRevisionNumber(revision.manifest.displayNumber)}…`,
        });
        const verified = await verifyRevisionObjects(
          vaultDir,
          revision,
          context.signal,
        );
        corrupt ||= verified.integrityStatus === "corrupted";
        if (context.current())
          setVaultState((previous) =>
            previous
              ? {
                  ...previous,
                  revisions: previous.revisions.map((r) =>
                    r.manifest.revisionId === verified.manifest.revisionId
                      ? verified
                      : r,
                  ),
                }
              : previous,
          );
        if (verified.integrityStatus === "objects_verified") {
          processedFiles += verified.manifest.files.length;
          processedBytes += verified.manifest.files.reduce(
            (n, f) => n + f.size,
            0,
          );
        }
      }
      if (context.current())
        setStatusBanner({
          type: corrupt ? "error" : "success",
          message: corrupt
            ? "One or more versions failed content verification."
            : `Verified file contents across ${targets.length} versions.`,
        });
    });
  };
  const handleVerifySingleRevisionObjects = (id: string) =>
    handleVerifyObjects([id]);
  const handleVerifyAllObjects = () =>
    handleVerifyObjects(
      vaultState?.revisions.map((r) => r.manifest.revisionId) ?? [],
    );
  const clearConnections = async () => {
    await clearAllConvenienceMetadata();
    homeAddressCache.current = [];
    setHomeAddress(null);
    setConvenienceEpoch((value) => value + 1);
    setRememberedWorkspace(null);
    setRememberedHome(null);
    if (workspace && managedProject) {
      const current = await openWorkspace(workspace.root);
      const found = locateProjectById(
        current,
        managedProject.record.projectId,
        managedProject.record.containerPath,
      );
      if (found.kind === "unavailable") {
        setWorkspace(current);
        setProjectUnavailable(found.reason);
        setStatusBanner({ type: "error", message: found.reason });
        return;
      }
      setProjectUnavailable(null);
      const managed = found.project;
      setWorkspace(current);
      setManagedProject(managed);
      setVaultState(managed.vaultState);
      setWorkingFolders(managed.workingFolders);
      setWorkingDir(managed.workingFolders[activeBranchId] ?? null);
      setScanResult(null);
      setActiveTab("history");
      setStatusBanner({
        type: "info",
        message:
          "Reset remembered folder connections and addresses across all workspaces in this browser. The current workspace was reread; reconnect folders and re-enter their addresses when needed.",
      });
      return;
    }
    setWorkingFolders({});
    setWorkingDir(null);
    setScanResult(null);
    if (vaultDir) {
      setVaultState(await openExistingVault(vaultDir));
      setActiveTab("history");
    }
    setStatusBanner({
      type: "info",
      message:
        "Reset remembered folder connections and addresses across all workspaces in this browser. Saved history was reread from the vault. Reconnect working folders and re-enter their addresses when needed.",
    });
  };
  const handleResetConnections = async () => {
    await perform("connect", clearConnections);
  };
  return {
    handleVerifySingleRevisionObjects,
    handleVerifyAllObjects,
    handleResetConnections,
  };
}
