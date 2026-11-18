import type { Dispatch, RefObject, SetStateAction } from "react";
import type { AuthSnapshot } from "../auth/firebase-auth";
import type { FileSystemDirectoryAdapter } from "../engine/fs-adapter";
import { AddReferencesError } from "../components/ReferencesView";
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
    // The panel shows any failure, so the status banner stays quiet for this call.
    await perform(
      "references",
      async (context) => {
        await assertProjectWritable(context);
        let published = 0;
        let current = 0;
        try {
          for (const [index, file] of files.entries()) {
            current = index;
            // One reference per file, named after the file; the note is kept as its description. The engine publishes
            // the reference and its whole-project link in one write, so a file is never added without being applied.
            context.progress({ phase: "writing_objects", currentFile: file.name, processedFiles: index, totalFiles: files.length, processedBytes: 0, totalBytes: file.size, message: `Adding ${file.name}…` });
            await importReferenceAttachment(
              vaultDir, projectId, file,
              { title: file.name, description: note.trim(), tags: [] },
              undefined,
              { savedBy, applyToProject: true, signal: context.signal, onProgress: context.progress },
            );
            published++;
          }
        } catch (error) {
          // Show whatever was published, so the list never lags behind the disk.
          try {
            const latest = await openExistingVault(vaultDir);
            if (context.current()) setVaultState(latest);
          } catch { /* the original error below is the one to report */ }
          if (published) refreshGuidesAfter({ project: projectGuideTarget(workspace, managedProject) });
          const remaining = files.slice(current);
          const count = published ? `${published} of ${files.length} files were added. ` : "";
          const cancelled = error instanceof DOMException && error.name === "AbortError";
          const reason = error instanceof Error ? error.message : String(error);
          const rest = remaining.length > 1 ? ` Not added yet: ${remaining.slice(1).map((file) => file.name).join(", ")}.` : "";
          throw new AddReferencesError(
            cancelled
              ? `Cancelled. ${published ? count : "Nothing was added."}`.trim()
              : `${count}${remaining[0].name} could not be added: ${reason}${rest}`,
            remaining,
          );
        }
        const latest = await openExistingVault(vaultDir);
        refreshGuidesAfter({ project: projectGuideTarget(workspace, managedProject) });
        if (!context.current()) return;
        setVaultState(latest);
        setStatusBanner({
          type: "success",
          message: `Added ${published} reference${published === 1 ? "" : "s"} to the project. ${published === 1 ? "It is" : "They are"} included whenever you save a revision.`,
        });
      },
      { rethrow: true, banner: false },
    );
  };
  /** Stops carrying a reference into new revisions. The reference stays in the library and earlier revisions keep it. */
  const handleStopApplyingReference = async (referenceId: string) => {
    if (!vaultDir || !vaultState) throw new Error("Open a project first.");
    const projectId = vaultState.project.projectId;
    await perform(
      "references",
      async (context) => {
        await assertProjectWritable(context);
        const latest = await updateProjectReference(vaultDir, projectId, referenceId, { projectVersionId: null }, { signal: context.signal });
        refreshGuidesAfter({ project: projectGuideTarget(workspace, managedProject) });
        if (!context.current()) return;
        setVaultState(latest);
        setStatusBanner({ type: "success", message: "The reference no longer applies to the whole project. Revisions you save from now on will not include it; earlier revisions keep it." });
      },
      { rethrow: true, banner: false },
    );
  };
  return { handleAddReferences, handleStopApplyingReference };
}
