import {
  splitAndValidatePath,
  type FileSystemDirectoryAdapter,
} from "./fs-adapter";
import { resolveManagedProject } from "./workspace-service";
import {
  openHome,
  type HomeState,
  type HomeWorkspaceEntry,
} from "./home-service";
import {
  type FilePathLocation,
} from "../utils/folder-path";

/** Prefix only a freshly validated managed descendant; external paths keep their own settings. */
export async function resolveHomeFilePath(
  home: HomeState,
  entry: HomeWorkspaceEntry,
  location: FilePathLocation,
): Promise<FilePathLocation> {
  const current = await openHome(home.root);
  if (current.identity.homeId !== home.identity.homeId)
    throw new Error("The Cadtree home changed.");
  const registered = current.workspaces.find((e) => e.key === entry.key);
  if (
    !registered?.workspace ||
    registered.workspaceId !== location.workspaceId ||
    !registered.directory
  )
    throw new Error("Workspace home mapping is unavailable.");
  if (
    entry.workspace &&
    !(await entry.workspace.root.isSameEntry(registered.workspace.root))
  )
    throw new Error("Workspace location changed. Reconnect it.");
  return {
    ...location,
    workspaceId: home.identity.homeId,
    relativeDirectory: `${registered.directory}/${location.relativeDirectory}`,
  };
}

async function existingFile(
  root: FileSystemDirectoryAdapter,
  directory: FileSystemDirectoryAdapter,
  location: FilePathLocation,
  checkFile = true,
) {
  const segments = splitAndValidatePath(location.filePath);
  if ((await directory.queryPermission("read")) !== "granted")
    throw new Error(
      "File path unavailable. Reconnect the workspace to renew folder access.",
    );
  const resolved = await root.resolveRelativePath(directory);
  if (!resolved || resolved.join("/") !== location.relativeDirectory)
    throw new Error(
      "File path unavailable. The folder no longer matches its recorded workspace location. Reconnect the workspace.",
    );
  if (!checkFile) return location;
  try {
    await directory.statFile(segments);
  } catch {
    throw new Error(
      "File path unavailable. The file is missing or cannot be read. Scan the relevant case or reconnect the workspace; export the version for historical bytes.",
    );
  }
  return location;
}

/** Resolves a specific branch, never the active branch as a fallback. Read-only. */
export async function resolveWorkingFilePath(
  root: FileSystemDirectoryAdapter,
  workspaceId: string,
  containerPath: string,
  branchId: string,
  filePath: string,
): Promise<FilePathLocation> {
  const project = await resolveManagedProject(root, containerPath);
  if (
    project.record.workspaceId !== workspaceId ||
    !project.ready ||
    project.issues.length
  )
    throw new Error(
      "File path unavailable. Project locations need attention; reconnect the workspace and inspect its connection details.",
    );
  const directory = project.workingFolders[branchId];
  const relativeDirectory = project.workingPaths[branchId];
  if (!directory || !relativeDirectory)
    throw new Error(
      "File path unavailable. This case folder is not connected. Reconnect the workspace.",
    );
  return existingFile(root, directory, {
    workspaceId,
    relativeDirectory,
    filePath,
  });
}

/** The folder of a branch's working copy (read-only). The placeholder file name is never read or shown. */
export async function resolveWorkingFolderPath(
  root: FileSystemDirectoryAdapter,
  workspaceId: string,
  containerPath: string,
  branchId: string,
): Promise<FilePathLocation> {
  const project = await resolveManagedProject(root, containerPath);
  if (
    project.record.workspaceId !== workspaceId ||
    !project.ready ||
    project.issues.length
  )
    throw new Error(
      "File path unavailable. Project locations need attention; reconnect the workspace and inspect its connection details.",
    );
  const directory = project.workingFolders[branchId];
  const relativeDirectory = project.workingPaths[branchId];
  if (!directory || !relativeDirectory)
    throw new Error(
      "File path unavailable. This case folder is not connected. Reconnect the workspace.",
    );
  return existingFile(
    root,
    directory,
    { workspaceId, relativeDirectory, filePath: "folder" },
    false,
  );
}
