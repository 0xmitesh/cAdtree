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

/** Every ready project of a workspace, e.g. one just copied into the home, whose copied Maps are stale. */
export function workspaceGuideTargets(workspace: WorkspaceState): GuideProjectTarget[] {
  return workspace.projects
    .filter((entry) => entry.status === "ready")
    .map((entry) => ({ workspaceRoot: workspace.root, containerPath: entry.containerPath }));
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
  projects,
  homeRoot,
}: {
  project?: GuideProjectTarget | null;
  projects?: readonly GuideProjectTarget[];
  homeRoot?: FileSystemDirectoryAdapter | null;
}): void {
  if (project) void refreshProjectGuide(project.workspaceRoot, project.containerPath).catch(() => undefined);
  for (const target of projects ?? []) void refreshProjectGuide(target.workspaceRoot, target.containerPath).catch(() => undefined);
  if (homeRoot) void refreshHomeGuide(homeRoot).catch(() => undefined);
}
