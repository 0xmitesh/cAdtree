import {
  splitAndValidatePath,
  type FileSystemDirectoryAdapter,
} from "./fs-adapter";
import { managedPath, resolveManagedProject } from "./workspace-service";
import {
  validateWindowsSegments,
  type FilePathLocation,
} from "../utils/windows-path";

async function existingFile(
  root: FileSystemDirectoryAdapter,
  directory: FileSystemDirectoryAdapter,
  location: FilePathLocation,
) {
  const segments = splitAndValidatePath(location.filePath);
  validateWindowsSegments(segments);
  if ((await directory.queryPermission("read")) !== "granted")
    throw new Error(
      "File path unavailable. Reconnect the workspace to renew folder access.",
    );
  const resolved = await root.resolveRelativePath(directory);
  if (!resolved || resolved.join("/") !== location.relativeDirectory)
    throw new Error(
      "File path unavailable. The folder no longer matches its recorded workspace location. Reconnect the workspace.",
    );
  try {
    await directory.statFile(segments);
  } catch {
    throw new Error(
      "File path unavailable. The file is missing or cannot be read. Scan the relevant branch or reconnect the workspace; restore a copy for historical bytes.",
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
      "File path unavailable. This branch folder is not connected. Reconnect the workspace.",
    );
  return existingFile(root, directory, {
    workspaceId,
    relativeDirectory,
    filePath,
  });
}

/** Only a successfully recovered managed destination is passed here by the app. */
export async function resolveRecoveredFilePath(
  root: FileSystemDirectoryAdapter,
  workspaceId: string,
  containerPath: string,
  relativeDirectory: string,
  filePath: string,
): Promise<FilePathLocation> {
  const project = await resolveManagedProject(root, containerPath);
  if (project.record.workspaceId !== workspaceId)
    throw new Error("Workspace identity changed. Reopen the workspace.");
  const parts = managedPath(relativeDirectory, `${containerPath}/recoveries`);
  if (parts.length !== managedPath(containerPath).length + 2)
    throw new Error("Invalid recovered-copy location.");
  let directory: FileSystemDirectoryAdapter;
  try {
    directory = await root.getDirectory(parts, { create: false });
  } catch {
    throw new Error(
      "File path unavailable. The restored folder is missing or inaccessible. Reconnect the workspace.",
    );
  }
  return existingFile(root, directory, {
    workspaceId,
    relativeDirectory,
    filePath,
  });
}
