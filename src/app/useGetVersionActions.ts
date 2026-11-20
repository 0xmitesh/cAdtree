import type { Dispatch, SetStateAction } from "react";
import {
  replaceWorkingFiles,
  requestApplicationWriteAccess,
  scanForReplace,
  type ApplicationOptions,
} from "../engine/application-service";
import { buildReplacePlan, replacePlanHash } from "../engine/apply-preview";
import { getBranchBaseline, type WorkingFolderBindings } from "../engine/branch-state";
import { caseLabel } from "../engine/case-lifecycle";
import { discardedFolderBase, discardedFolderPath } from "../engine/discarded-paths";
import type { FileSystemDirectoryAdapter } from "../engine/fs-adapter";
import type { ScanResult, VaultState } from "../engine/types";
import { formatRevisionNumber, openExistingVault } from "../engine/vault-service";
import type { ManagedProject, WorkspaceState } from "../engine/workspace-service";
import type { AssertProjectWritable, Context, Perform, StatusBanner } from "./types";

/** What the Get this version confirmation shows: built from a fresh full-hash scan. */
export type GetVersionCheck = {
  projectId: string;
  branchId: string;
  revisionId: string;
  path: string;
  /** "V3" */
  revisionLabel: string;
  /** "V3", or "V8 on <case>" when the version belongs to another case. */
  fromLabel: string;
  planHash: string;
  /** Why it cannot be done now (empty when it can). */
  blockers: string[];
  /** The working file has edits that are not saved (or is a new, unsaved file). */
  hasUnsavedEdits: boolean;
  /** Where the replaced file will be kept, e.g. "Discarded/2026-11-20 09.30" (the minute may move on). */
  keptFolder: string;
};

export type GetVersionController = {
  check: (revisionId: string, path: string) => Promise<GetVersionCheck>;
  confirm: (check: GetVersionCheck) => Promise<void>;
  /**
   * The file in the working folder per the last scan of the active case:
   * undefined when unknown (no current scan), null when it is missing.
   */
  workingFile: (path: string) => { sha256: string; size: number } | null | undefined;
  /** Set when nothing may be written now (read-only case, unfinished operation…). */
  blockedReason?: string;
};

export type UseGetVersionActionsArgs = {
  vaultDir: FileSystemDirectoryAdapter | null;
  workingDir: FileSystemDirectoryAdapter | null;
  workingFolders: WorkingFolderBindings;
  activeBranchId: string;
  managedProject: ManagedProject | null;
  workspace: WorkspaceState | null;
  perform: Perform;
  assertProjectWritable: AssertProjectWritable;
  applicationOptions: (context: Context) => ApplicationOptions;
  applyVaultState: (next: VaultState) => void;
  requestAutoRefresh: (options?: { immediate?: boolean }) => void;
  setStatusBanner: Dispatch<SetStateAction<StatusBanner | null>>;
};

/**
 * Get this version: puts one file from a saved revision into the active case's
 * working folder as an unsaved change (engine `replaceWorkingFiles`, mode
 * "restore-file"). The file it replaces is kept in Discarded/.
 */
export function useGetVersionActions({
  vaultDir,
  workingDir,
  workingFolders,
  activeBranchId,
  managedProject,
  workspace,
  perform,
  assertProjectWritable,
  applicationOptions,
  applyVaultState,
  requestAutoRefresh,
  setStatusBanner,
}: UseGetVersionActionsArgs) {
  const working = () => workingFolders[activeBranchId] ?? workingDir;
  const check = async (revisionId: string, path: string): Promise<GetVersionCheck> => {
    const folder = working();
    if (!vaultDir || !folder)
      throw new Error("Reconnect the working folder to get this version.");
    const result = await perform(
      "apply",
      async (context) => {
        const state = await openExistingVault(vaultDir);
        const scan = await scanForReplace(
          folder,
          activeBranchId,
          getBranchBaseline(state, activeBranchId),
          { signal: context.signal, onProgress: context.progress },
        );
        const plan = buildReplacePlan(state, scan, revisionId, [path], "restore-file");
        const revision = state.revisions.find((r) => r.manifest.revisionId === revisionId);
        const revisionLabel = revision
          ? formatRevisionNumber(revision.manifest.displayNumber)
          : "that version";
        return {
          projectId: state.project.projectId,
          branchId: activeBranchId,
          revisionId,
          path,
          revisionLabel,
          fromLabel:
            revision && revision.manifest.branchId !== activeBranchId
              ? `${revisionLabel} on ${caseLabel(state, revision.manifest.branchId)}`
              : revisionLabel,
          planHash: replacePlanHash(plan),
          blockers: plan.blockers,
          hasUnsavedEdits:
            scan.added.some((f) => f.path === path) ||
            scan.modified.some((m) => m.current.path === path),
          keptFolder: discardedFolderPath(discardedFolderBase(new Date())).join("/"),
        };
      },
      { rethrow: true, banner: false },
    );
    if (!result) throw new Error("Finish or cancel the current operation first.");
    return result;
  };
  const confirm = async (request: GetVersionCheck) => {
    if (!vaultDir || request.branchId !== activeBranchId)
      throw new Error("The case changed. Close this and try again.");
    await perform(
      "apply",
      async (context) => {
        try {
          const project = (await assertProjectWritable(context)) ?? managedProject;
          if (!project || !workspace)
            throw new Error("Get this version needs a project in a workspace. Nothing was changed.");
          await requestApplicationWriteAccess(vaultDir, working());
          const projectFolder = await workspace.root.getDirectory(
            project.record.containerPath.split("/"),
          );
          const result = await replaceWorkingFiles(vaultDir, projectFolder, {
            ...applicationOptions(context),
            mode: "restore-file",
            projectId: request.projectId,
            branchId: request.branchId,
            targetRevisionId: request.revisionId,
            paths: [request.path],
            expectedPlanHash: request.planHash,
          });
          if (context.current())
            setStatusBanner({
              type: "success",
              message: `${request.revisionLabel} of ${request.path} is in your working folder. Save to keep it, or Discard to undo.${
                result.keptAs ? ` The file it replaced is kept in ${result.keptAs}.` : ""
              }`,
            });
        } finally {
          if (context.current()) {
            try {
              applyVaultState(await openExistingVault(vaultDir));
            } catch {
              /* The operation's own error stays visible. */
            }
            // The file just changed: rescan quietly so it shows as an unsaved change.
            requestAutoRefresh({ immediate: true });
          }
        }
      },
      { rethrow: true, banner: false },
    );
  };
  return { check, confirm };
}

/** The working file per a scan of the active case (see GetVersionController.workingFile). */
export function scannedWorkingFile(scan: ScanResult | null, branchId: string, path: string) {
  if (!scan || scan.branchId !== branchId) return undefined;
  if (scan.deleted.some((f) => f.path === path)) return null;
  const file =
    scan.unchanged.find((f) => f.path === path) ??
    scan.added.find((f) => f.path === path) ??
    scan.modified.find((m) => m.current.path === path)?.current;
  return file ? { sha256: file.sha256, size: file.size } : null;
}
