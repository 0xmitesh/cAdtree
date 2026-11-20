import type { Dispatch, SetStateAction } from "react";
import {
  buildReplacePlan,
  replacePlanHash,
  type ReplacePlan,
} from "../engine/apply-preview";
import {
  replaceWorkingFiles,
  requestApplicationWriteAccess,
  scanForReplace,
  type ReplaceWorkingFilesResult,
} from "../engine/application-service";
import { getBranchBaseline, type WorkingFolderBindings } from "../engine/branch-state";
import type { FileSystemDirectoryAdapter } from "../engine/fs-adapter";
import { partitionSystemFiles } from "../engine/scanner";
import type { RevisionManifest, ScanResult, VaultState } from "../engine/types";
import { openExistingVault } from "../engine/vault-service";
import { resolveManagedProject, type ManagedProject, type WorkspaceState } from "../engine/workspace-service";
import type { ResolveFilePath } from "../utils/folder-path";
import type { AssertProjectWritable, Context, Perform, StatusBanner } from "./types";

/** What a Discard confirmation shows: the plan built from a fresh full-hash scan, and its hash. */
export type DiscardReview = {
  projectId: string;
  branchId: string;
  targetRevisionId: string;
  paths: string[];
  plan: ReplacePlan;
  hash: string;
};
/** `"all"`: every unsaved change of the case (Discard all…); otherwise the selected paths. */
export type DiscardSelection = "all" | string[];

/** Everything Discard all takes from a replace scan. Untracked OS clutter is left
 * alone unless it sits in a folder that is discarded (it then moves with it). */
export function discardAllPaths(scan: ScanResult, baseline: RevisionManifest): string[] {
  const tracked = new Set(baseline.files.map((file) => file.path));
  return [
    ...new Set([
      ...partitionSystemFiles(scan.added, tracked).files.map((file) => file.path),
      ...scan.modified.map((change) => change.current.path),
      ...scan.deleted.map((file) => file.path),
      ...scan.addedDirectories,
      ...scan.deletedDirectories,
    ]),
  ].sort();
}

/** The number of changes a discard undoes (files and folders), as the Changes list counts them. */
export const discardedCount = (plan: Pick<ReplacePlan, "actions" | "folderActions">) =>
  plan.actions.length + plan.folderActions.length;

export function discardSuccessMessage(result: Pick<ReplaceWorkingFilesResult, "plan" | "keptAs" | "keptInsideOnly">) {
  const n = discardedCount(result.plan);
  const parts = [`Discarded ${n} ${n === 1 ? "change" : "changes"}.`];
  if (result.keptAs) parts.push(`A copy is in ${result.keptAs}.`);
  if (result.keptInsideOnly.length)
    parts.push(
      `Kept inside cAdtree only (the path was too long for the Discarded folder): ${result.keptInsideOnly.join(", ")}.`,
    );
  return parts.join(" ");
}

export type UseDiscardActionsArgs = {
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
  requestAutoRefresh: (options?: { immediate?: boolean }) => void;
  setStatusBanner: Dispatch<SetStateAction<StatusBanner | null>>;
  /** Copy path for a folder of the open project (relative to the project folder), when path shortcuts are possible. */
  projectFolderResolver?: (relative: string) => ResolveFilePath;
};

/**
 * Discard unsaved changes of the active case (all, or selected files and folders),
 * keeping a copy in the project's Discarded folder (engine `replaceWorkingFiles`,
 * mode `discard`). The review scans afresh (every file hashed), so the hash the
 * user confirms is the one the engine rebuilds under the project lock.
 */
export function useDiscardActions({
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
  projectFolderResolver,
}: UseDiscardActionsArgs) {
  const discardBlock = !vaultDir || !vaultState
    ? "Open the project first."
    : !managedProject || !workspace
      ? "Discard is available for projects in a workspace."
      : undefined;
  const resolveWorkingFolders = async (state: VaultState) => {
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
  const reviewDiscard = (branchId: string, selection: DiscardSelection) => {
    if (discardBlock) return Promise.reject(new Error(discardBlock));
    if (branchId !== activeBranchId)
      return Promise.reject(new Error("The case changed. Close this and try again."));
    return perform(
      "scan",
      async (context): Promise<DiscardReview> => {
        const state = await openExistingVault(vaultDir!);
        if (state.project.projectId !== vaultState!.project.projectId)
          throw new Error("Project identity changed. Reopen the project.");
        const baseline = getBranchBaseline(state, branchId);
        if (!baseline)
          throw new Error("This case has no saved version yet, so there is nothing to go back to.");
        const working = workingFolders[branchId] ?? workingDir;
        if (!working) throw new Error("Reconnect the working folder first.");
        const scan = await scanForReplace(working, branchId, baseline, {
          signal: context.signal,
          onProgress: context.progress,
        });
        const paths = selection === "all" ? discardAllPaths(scan, baseline) : [...selection];
        const plan = buildReplacePlan(state, scan, baseline.revisionId, paths, "discard");
        return {
          projectId: state.project.projectId,
          branchId,
          targetRevisionId: baseline.revisionId,
          paths,
          plan,
          hash: replacePlanHash(plan),
        };
      },
      { rethrow: true, banner: false },
    );
  };
  const refreshAfter = async () => {
    if (!vaultDir) return;
    try {
      applyVaultState(await openExistingVault(vaultDir));
      requestAutoRefresh({ immediate: true });
    } catch {
      /* The discard's own outcome or error stays visible. */
    }
  };
  const handleDiscard = (review: DiscardReview) => {
    if (discardBlock) return Promise.reject(new Error(discardBlock));
    if (review.branchId !== activeBranchId)
      return Promise.reject(new Error("The case changed. Close this and try again."));
    return perform(
      "apply",
      async (context: Context) => {
        try {
          const refound = await assertProjectWritable(context);
          const project = refound ?? managedProject!;
          await requestApplicationWriteAccess(vaultDir!, workingFolders[review.branchId] ?? workingDir);
          const projectFolder = await workspace!.root.getDirectory(
            project.record.containerPath.split("/"),
          );
          if ((await projectFolder.queryPermission("readwrite")) !== "granted" &&
            (await projectFolder.requestPermission("readwrite")) !== "granted")
            throw new Error("Read/write access to the project folder is required. Nothing was changed.");
          const result = await replaceWorkingFiles(vaultDir!, projectFolder, {
            mode: "discard",
            projectId: review.projectId,
            branchId: review.branchId,
            targetRevisionId: review.targetRevisionId,
            paths: review.paths,
            expectedPlanHash: review.hash,
            workingFolders,
            resolveWorkingFolders,
            signal: context.signal,
            onProgress: context.progress,
          });
          if (context.current()) {
            const keptAs = result.keptAs;
            setStatusBanner({
              type: "success",
              message: discardSuccessMessage(result),
              copyFolder:
                keptAs && projectFolderResolver
                  ? { label: "Copy folder path", resolve: projectFolderResolver(keptAs) }
                  : undefined,
            });
          }
          return result;
        } finally {
          if (context.current()) await refreshAfter();
        }
      },
      { rethrow: true, banner: false },
    );
  };
  return { reviewDiscard, handleDiscard, discardBlock };
}
