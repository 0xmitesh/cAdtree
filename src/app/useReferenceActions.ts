import type { Dispatch, RefObject, SetStateAction } from "react";
import type { AuthSnapshot } from "../auth/firebase-auth";
import type { FileSystemDirectoryAdapter } from "../engine/fs-adapter";
import { importReferenceAttachment, updateProjectReference } from "../engine/references";
import type { VaultState } from "../engine/types";
import { openExistingVault } from "../engine/vault-service";
import type { ManagedProject, WorkspaceState } from "../engine/workspace-service";
import { projectGuideTarget, refreshGuidesAfter } from "./offline-guide-refresh";
import type { AssertProjectWritable, Perform, StatusBanner } from "./types";

export type UseReferenceActionsArgs = {
  vaultDir: FileSystemDirectoryAdapter | null;
  vaultState: VaultState | null;
  managedProject: ManagedProject | null;
  workspace: WorkspaceState | null;
  authStateRef: RefObject<AuthSnapshot>;
  perform: Perform;
  assertProjectWritable: AssertProjectWritable;
  setVaultState: Dispatch<SetStateAction<VaultState | null>>;
  setStatusBanner: Dispatch<SetStateAction<StatusBanner | null>>;
};

/**
 * Add reference files to the project without saving a revision. Each file becomes a project reference that applies to
 * the whole project: the engine includes it in every revision saved from then on. (A reference can only point at a
 * specific file inside a revision, so that choice stays in Changes, when a revision is saved.)
 */
export function useReferenceActions({
  vaultDir,
  vaultState,
  managedProject,
  workspace,
  authStateRef,
  perform,
  assertProjectWritable,
  setVaultState,
  setStatusBanner,
}: UseReferenceActionsArgs) {
  const handleAddReferences = async (files: File[], note: string) => {
    if (!vaultDir || !vaultState) throw new Error("Open a project first.");
    if (!files.length) throw new Error("Choose at least one file.");
    const projectId = vaultState.project.projectId;
    const user = authStateRef.current.user;
    const savedBy = user ? { id: user.uid, displayName: user.displayName || user.email || "User" } : undefined;
    await perform(
      "references",
      async (context) => {
        await assertProjectWritable(context);
        let added = 0;
        const known = new Set((vaultState.references?.library ?? []).map((item) => item.referenceId));
        try {
          for (const [index, file] of files.entries()) {
            // One reference per file, named after the file. The note is kept as the reference's description.
            const progress = { processedFiles: index, totalFiles: files.length };
            context.progress({ phase: "writing_objects", currentFile: file.name, processedBytes: 0, totalBytes: file.size, message: `Adding ${file.name}…`, ...progress });
            const imported = await importReferenceAttachment(
              vaultDir, projectId, file,
              { title: file.name, description: note.trim(), tags: [] },
              undefined,
              { savedBy, signal: context.signal, onProgress: context.progress },
            );
            // The import appends the new reference at the end of the library.
            const reference = imported.references?.library.filter((item) => !known.has(item.referenceId)).at(-1);
            if (!reference) throw new Error(`${file.name} was added, but could not be applied to the whole project.`);
            imported.references?.library.forEach((item) => known.add(item.referenceId));
            await updateProjectReference(vaultDir, projectId, reference.referenceId, { projectVersionId: reference.versions[0].versionId }, { signal: context.signal });
            added++;
          }
        } catch (error) {
          // Show whatever was published, so the list never lags behind the disk.
          try {
            const latest = await openExistingVault(vaultDir);
            if (context.current()) setVaultState(latest);
          } catch { /* the original error below is the one to report */ }
          if (added || files.length > 1) refreshGuidesAfter({ project: projectGuideTarget(workspace, managedProject) });
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof DOMException && error.name === "AbortError") throw error;
          throw new Error(added ? `${added} of ${files.length} files were added. ${message}` : message);
        }
        const latest = await openExistingVault(vaultDir);
        refreshGuidesAfter({ project: projectGuideTarget(workspace, managedProject) });
        if (!context.current()) return;
        setVaultState(latest);
        setStatusBanner({
          type: "success",
          message: `Added ${added} reference${added === 1 ? "" : "s"} to the project. ${added === 1 ? "It is" : "They are"} included whenever you save a revision.`,
        });
      },
      true,
    );
  };
  return { handleAddReferences };
}
