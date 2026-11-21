import { useSyncExternalStore } from "react";
import type { FileSystemDirectoryAdapter } from "../engine/fs-adapter";
import { refreshHomeGuide, refreshProjectGuide, type GuideRefreshResult } from "../engine/offline-guide";
import {
  HOME_INDEX_FILENAME,
  HOME_README_FILENAME,
  PROJECT_MAP_FILENAME,
  PROJECT_RESTORE_PAGE_FILENAME,
} from "../engine/offline-guide-paths";
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

// ---------------------------------------------------------------------------
// The latest failure per project or home (in memory, for a quiet notice in Settings)
// ---------------------------------------------------------------------------

const HOME_KEY = "\u0000home";
const failures = new WeakMap<object, Map<string, string>>();
const listeners = new Set<() => void>();
let version = 0;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getVersion = () => version;

function setFailure(root: object, key: string, problem: string | null) {
  const current = failures.get(root)?.get(key) ?? null;
  if (current === problem) return;
  let forRoot = failures.get(root);
  if (!forRoot) failures.set(root, (forRoot = new Map()));
  if (problem === null) forRoot.delete(key);
  else forRoot.set(key, problem);
  version++;
  for (const listener of [...listeners]) listener();
}

const fileLabel = (path: string): string => {
  if (path.endsWith(PROJECT_MAP_FILENAME)) return "the project map";
  if (path.endsWith(PROJECT_RESTORE_PAGE_FILENAME)) return "the restore page";
  if (path.endsWith(HOME_README_FILENAME)) return "the home readme";
  if (path.endsWith(HOME_INDEX_FILENAME)) return "the home index";
  if (path.includes("revisions/")) return "a version listing";
  return "a guide file";
};
const sentence = (text: string) => text.trim().replace(/[.\s]+$/, "");

/**
 * What went wrong in plain words, or null when the refresh did not fail. A refresh that was skipped for a normal
 * reason (read-only project, a copy sharing an ID) is not a failure: the guide is simply not written there.
 */
export function guideFailureReason(result: GuideRefreshResult): string | null {
  if (result.status === "partial" && result.failed.length) {
    const labels = [...new Set(result.failed.map((entry) => fileLabel(entry.path)))];
    const what = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}` : labels[0];
    return `${what} couldn't be written (${sentence(result.failed[0].error)})`;
  }
  if (result.status === "skipped" && result.error !== undefined) return `the folder couldn't be read (${sentence(result.error)})`;
  return null;
}

/** A finished refresh: remembers a failure, clears the earlier one after a success, ignores a normal skip. */
function report(root: object, key: string, result: GuideRefreshResult) {
  const reason = guideFailureReason(result);
  if (reason !== null) setFailure(root, key, reason);
  else if (result.status === "written") setFailure(root, key, null);
}

/** The latest failure for the open project (or its home), or null. Re-renders when it changes. */
export function useGuideProblem(
  workspaceRoot: FileSystemDirectoryAdapter | null | undefined,
  containerPath: string | null | undefined,
  homeRoot: FileSystemDirectoryAdapter | null | undefined,
): string | null {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return (
    (workspaceRoot && containerPath ? failures.get(workspaceRoot)?.get(containerPath) : undefined) ??
    (homeRoot ? failures.get(homeRoot)?.get(HOME_KEY) : undefined) ??
    null
  );
}

/**
 * Brings the offline guide files up to date (project Map and revision listings, home Readme and Index) after an
 * operation has SUCCEEDED. Call it only on success, never on failure or cancellation, and after the operation has
 * released its locks: each refresh takes its own lock.
 *
 * Fire-and-forget and best-effort: it never delays the operation's banner or busy state, never throws (the
 * engine functions log failures with console.warn) and never touches React state, so it is safe after unmount.
 * The latest failure per project or home is kept in memory (see `useGuideProblem`) and cleared by a later success.
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
  const refreshProject = (target: GuideProjectTarget) =>
    void refreshProjectGuide(target.workspaceRoot, target.containerPath)
      .then((result) => report(target.workspaceRoot, target.containerPath, result))
      .catch(() => undefined);
  if (project) refreshProject(project);
  for (const target of projects ?? []) refreshProject(target);
  if (homeRoot) {
    void refreshHomeGuide(homeRoot)
      .then((result) => report(homeRoot, HOME_KEY, result))
      .catch(() => undefined);
  }
}
