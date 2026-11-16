import type { FileSystemDirectoryAdapter } from "../engine/fs-adapter";
import { refreshHomeGuide, refreshProjectGuide } from "../engine/offline-guide";
import type { ManagedProject, WorkspaceState } from "../engine/workspace-service";

export type GuideProjectTarget = { workspaceRoot: FileSystemDirectoryAdapter; containerPath: string };

/** The open project as a refresh target, or null when there is no managed project (nothing to refresh). */
export function projectGuideTarget(
  workspace: WorkspaceState | null | undefined,
  project: ManagedProject | null | undefined,
): GuideProjectTarget | null {
  return workspace && project ? { workspaceRoot: workspace.root, containerPath: project.record.containerPath } : null;
}

/**
 * Brings the offline guide files up to date (project Map and revision listings, home Readme and Index) after an
 * operation has SUCCEEDED. Call it only on success, never on failure or cancellation, and after the operation has
 * released its locks: each refresh takes its own lock.
 *
 * Fire-and-forget and best-effort: it never delays the operation's banner or busy state, never throws (the
 * engine functions log failures with console.warn) and never touches React state, so it is safe after unmount.
 * The engine skips read-only, duplicate and damaged projects and homes itself.
 */
export function refreshGuidesAfter({
  project,
  homeRoot,
}: {
  project?: GuideProjectTarget | null;
  homeRoot?: FileSystemDirectoryAdapter | null;
}): void {
  if (project) void refreshProjectGuide(project.workspaceRoot, project.containerPath).catch(() => undefined);
  if (homeRoot) void refreshHomeGuide(homeRoot).catch(() => undefined);
}
