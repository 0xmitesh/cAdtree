import type { FileSystemDirectoryAdapter } from "./fs-adapter";
import { withProjectWriterLock } from "./locks";
import { openExistingVault } from "./vault-service";
import {
  getBranchBaseline,
  validateWorkingFolderBindings,
  type WorkingFolderBindings,
} from "./branch-state";
import { branchApplications } from "./application-records";
import { caseLifecycle, lifecyclePath, sealLifecycle } from "./case-lifecycle";
import { scanBranchChanges } from "./scanner";
import { throwIfCancelled, type CopyOptions } from "./copy-service";
import type { VaultState } from "./types";

export interface ChangeCaseLifecycle {
  projectId: string;
  branchId: string;
  activeBranchId: string;
  status: "active" | "archived";
  expectedVersion: string | null;
}
export interface LifecycleOptions extends CopyOptions {
  workingFolders: WorkingFolderBindings;
  resolveWorkingFolders?: (state: VaultState) => Promise<WorkingFolderBindings>;
}
export async function changeCaseLifecycle(
  vault: FileSystemDirectoryAdapter,
  request: ChangeCaseLifecycle,
  options: LifecycleOptions,
) {
  return withProjectWriterLock(request.projectId, async () => {
    throwIfCancelled(options.signal);
    const state = await openExistingVault(vault);
    const matches = state.branches.filter(
      (branch) => branch.branchId === request.branchId,
    );
    if (
      state.project.projectId !== request.projectId ||
      matches.length !== 1 ||
      matches[0].projectId !== request.projectId ||
      state.branches.filter(
        (branch) => branch.branchId === request.activeBranchId,
      ).length !== 1
    )
      throw new Error(
        "Project or branch identity changed. Refresh before changing the case lifecycle.",
      );
    const branch = matches[0];
    if (branch.isMain)
      throw new Error("Main cannot be archived or reopened as a case.");
    if (!["active", "archived"].includes(request.status))
      throw new Error("Unknown case lifecycle action.");
    if (
      request.status === "archived" &&
      request.branchId === request.activeBranchId
    )
      throw new Error(
        "Switch to another active branch before archiving this case. No branch was switched automatically.",
      );
    const current = caseLifecycle(state, request.branchId);
    if (current.status === "unavailable")
      throw new Error(
        `Lifecycle evidence is unavailable. ${current.error} Inspect the retained records; it was not assumed Active.`,
      );
    if (current.status === request.status) return { state, alreadySet: true };
    if (current.version !== request.expectedVersion)
      throw new Error(
        "The case lifecycle changed since review. Refresh and review the current status before trying again.",
      );
    if ((await vault.queryPermission("readwrite")) !== "granted")
      throw new Error(
        "Reconnect the vault with write permission before changing lifecycle metadata.",
      );
    if (request.status === "archived") {
      if (
        branchApplications(state, request.branchId).some((op) =>
          ["unresolved", "unavailable", "applied"].includes(op.status),
        )
      )
        throw new Error(
          "This case has a pending or unavailable application. Use its existing recovery, Save revision or explicit abandonment controls before archiving.",
        );
      const baseline = getBranchBaseline(state, request.branchId);
      if (!baseline)
        throw new Error(
          "A trustworthy saved baseline is required before archiving.",
        );
      const folders = options.resolveWorkingFolders
        ? await options.resolveWorkingFolders(state)
        : options.workingFolders;
      await validateWorkingFolderBindings(state, vault, folders);
      const working = folders[request.branchId]!;
      const scan = await scanBranchChanges(
        working,
        request.branchId,
        baseline,
        {
          signal: options.signal,
          onProgress: (path, count, bytes) =>
            options.onProgress?.({
              phase: "scanning_source",
              currentFile: path,
              processedFiles: count,
              totalFiles: count,
              processedBytes: bytes,
              totalBytes: bytes,
              message: `Checking case before archive: ${path}…`,
            }),
        },
      );
      if (scan.errors.length)
        throw new Error(
          `Case working evidence is unreadable or invalid: ${scan.errors.map((error) => `${error.path}: ${error.error}`).join("; ")}. Reconnect or resolve it before archiving.`,
        );
      if (scan.hasChanges)
        throw new Error(
          "This case has uncaptured file or directory changes. Save a revision or resolve them explicitly before archiving. Working files and in-app drafts were left intact.",
        );
      const refreshed = await openExistingVault(vault);
      const refreshedBaseline = getBranchBaseline(refreshed, request.branchId);
      if (
        refreshed.project.projectId !== request.projectId ||
        refreshed.branches.find((b) => b.branchId === request.branchId)
          ?.payloadSha256 !== branch.payloadSha256 ||
        refreshedBaseline?.manifestPayloadSha256 !==
          baseline.manifestPayloadSha256 ||
        caseLifecycle(refreshed, request.branchId).status !== current.status ||
        caseLifecycle(refreshed, request.branchId).version !== current.version
      )
        throw new Error(
          "The case baseline or lifecycle changed during review. Refresh and review again.",
        );
      if (options.resolveWorkingFolders) {
        const checked = await options.resolveWorkingFolders(refreshed);
        await validateWorkingFolderBindings(refreshed, vault, checked);
        if (
          !checked[request.branchId] ||
          !(await working.isSameEntry(checked[request.branchId]!))
        )
          throw new Error(
            "The case working connection changed during review. Refresh before archiving.",
          );
      }
    }
    throwIfCancelled(options.signal);
    const record = sealLifecycle({
      schemaVersion: 1,
      projectId: request.projectId,
      branchId: request.branchId,
      branchRecordSha256: branch.payloadSha256,
      sequence: current.sequence + 1,
      previousSha256: current.version,
      status: request.status,
      changedAt: new Date().toISOString(),
    });
    const path = lifecyclePath(request.branchId, record.sequence);
    const text = JSON.stringify(record, null, 2);
    let warning: string | undefined;
    try {
      await vault.writeFileText(path, text, { exclusive: true });
    } catch (error) {
      warning = `Lifecycle write acknowledgement failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    try {
      if ((await vault.readFileText(path)) !== text)
        throw new Error("Record bytes differ from the intended change.");
    } catch (error) {
      throw new Error(
        `Lifecycle publication was not confirmed. Reload and inspect the retained lifecycle evidence before retrying. ${warning ?? ""} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const updated = await openExistingVault(vault);
    const saved = caseLifecycle(updated, request.branchId);
    if (saved.status !== request.status || saved.version !== record.checksum)
      throw new Error(
        "Lifecycle readback is unavailable. Reload before retrying.",
      );
    return { state: updated, alreadySet: false, warning };
  });
}
