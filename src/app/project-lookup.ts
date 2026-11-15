import {
  DUPLICATE_PROJECT_REASON,
  type ManagedProject,
  type WorkspaceState,
} from "../engine/workspace-service";

export const PROJECT_NEEDS_ATTENTION =
  "This project location needs attention. Open the workspace to inspect it.";
export const PROJECT_NOT_FOUND =
  "This project's folder can't be found in the workspace any more.";
/** Info-level stop: the open project was re-found at a new folder and nothing was written. */
export class ProjectRenamedNotice extends Error {}
export const renamedNotice = (project: ManagedProject) =>
  `This project's folder was renamed to '${project.record.containerPath.split("/").pop()}'. cAdtree found it by its project ID.`;
export type OpenProjectLookup =
  | { kind: "ok"; workspace: WorkspaceState; project: ManagedProject; renamed: boolean }
  | { kind: "unavailable"; workspace: WorkspaceState; reason: string };
/**
 * Identity is the project ID alone: never the folder name or a stored path. This checks identity only;
 * a damaged or incomplete entry that is still found stays blocked by the project's own issues (managedBlockReason).
 */
export const locateProjectById = (
  current: WorkspaceState,
  projectId: string,
  storedPath: string,
): OpenProjectLookup => {
  const matches = current.projects.filter((entry) => entry.projectId === projectId);
  if (matches.length > 1 || matches[0]?.status === "duplicate")
    return { kind: "unavailable", workspace: current, reason: DUPLICATE_PROJECT_REASON };
  const entry = matches[0];
  if (!entry?.project) {
    // A damaged or incomplete folder at the stored location is not "gone": it needs a look.
    const stillThere = current.projects.some((e) => !e.projectId && e.containerPath === storedPath);
    return {
      kind: "unavailable",
      workspace: current,
      reason: stillThere ? PROJECT_NEEDS_ATTENTION : PROJECT_NOT_FOUND,
    };
  }
  return {
    kind: "ok",
    workspace: current,
    project: entry.project,
    renamed: entry.containerPath !== storedPath,
  };
};
