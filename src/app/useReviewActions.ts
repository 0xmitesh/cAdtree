import type { ExportReviewAction } from "../components/ReviewExportDialog";
import type { WorkingFolderBindings } from "../engine/branch-state";
import type { FileSystemDirectoryAdapter } from "../engine/fs-adapter";
import { retrieveReferenceAttachment } from "../engine/references";
import { exportRevisionForReview } from "../engine/review-export";
import type { VaultState } from "../engine/types";
import { resolveManagedProject, type ManagedProject, type WorkspaceState } from "../engine/workspace-service";
import type { Context } from "./types";
import type { useOperation } from "./useOperation";

export type UseReviewActionsArgs = {
  vaultDir: FileSystemDirectoryAdapter | null;
  vaultState: VaultState | null;
  workingFolders: WorkingFolderBindings;
  managedProject: ManagedProject | null;
  workspace: WorkspaceState | null;
  perform: ReturnType<typeof useOperation>["perform"];
  assertProjectWritable: (context: Context, readOnlyOperation?: boolean) => Promise<ManagedProject | null>;
};

/** Export for review and reference retrieval: hand a saved revision or an attachment to the user. */
export function useReviewActions({
  vaultDir,
  vaultState,
  workingFolders,
  managedProject,
  workspace,
  perform,
  assertProjectWritable,
}: UseReviewActionsArgs) {
  const handleExportForReview: ExportReviewAction = async (plan, parent, folderName) => {
    if (!vaultDir || !vaultState) throw new Error('Open the saved project before exporting.');
    const result = await perform('export', async context => {
      await assertProjectWritable(context);
      return exportRevisionForReview({
      vaultDir, parent, plan, folderName, workingFolders,
      signal: context.signal, onProgress: context.progress,
      resolveWorkingFolders: managedProject && workspace ? async () => {
        const current = await resolveManagedProject(workspace.root, managedProject.record.containerPath);
        if (current.record.projectId !== plan.projectId || !current.ready || current.issues.length) throw new Error('Reconnect the project to validate its working-folder isolation before exporting.');
        return current.workingFolders;
      } : undefined,
    });
    }, true);
    if (!result) throw new Error('Export did not complete.');
    return result;
  };
  const handleRetrieveReference = async (referenceId: string, versionId: string) => {
    if (!vaultDir || !vaultState) throw new Error('Open a project first.');
    await perform('references', async context => {
      if (await vaultDir.requestPermission('read') !== 'granted') throw new Error('Allow read access to the project folder, then retrieve the attachment again.');
      const { version, bytes } = await retrieveReferenceAttachment(vaultDir, vaultState.project.projectId, referenceId, versionId);
      if (!context.current() || context.signal.aborted) throw new Error('Attachment retrieval cancelled.');
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = version.originalFilename;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, true);
  };
  return { handleExportForReview, handleRetrieveReference };
}
