import {
  type FileSystemDirectoryAdapter,
  splitAndValidatePath,
  validateDirectoryIsolation,
} from "./fs-adapter";
import { hashString } from "./hash";
import { withProjectWriterLock } from "./locks";
import { folderNameFor, pickFreeName } from "./folder-names";
import {
  branchNameKey,
  validateWorkingFolderBindings,
  type WorkingFolderBindings,
} from "./branch-state";
import {
  copyVerifiedTree,
  inventorySignature,
  readVerifiedInventory,
  throwIfCancelled,
  type CopyOptions,
} from "./copy-service";
import {
  initializeProjectVault,
  openExistingVault,
  verifyRevisionObjects,
} from "./vault-service";
import { createDesignBranch } from "./branch-service";
import { componentWriteBlock } from './component-identity';
import { referenceWriteBlock, verifyReferenceLibraryContent } from './references';
import {
  restoreRevisionToFolder,
  restoreSelectedFilesToFolder,
} from "./recovery-service";
import { MAIN_BRANCH_ID, type BranchRecord, type VaultState } from "./types";

const WORKSPACE_FILE = ".cadtree-workspace.json";
const VERSION = 1;
export interface WorkspaceIdentity {
  schemaVersion: number;
  workspaceId: string;
  name: string;
  createdAt: string;
  payloadSha256: string;
}
export interface ManagedProjectRecord {
  schemaVersion: number;
  workspaceId: string;
  projectId: string;
  name: string;
  containerPath: string;
  vaultPath: string;
  createdAt: string;
  origin: "create" | "import" | "adoption";
  payloadSha256: string;
}
export interface BranchLocationRecord {
  schemaVersion: number;
  workspaceId: string;
  projectId: string;
  branchId: string;
  workingPath: string;
  createdAt: string;
  payloadSha256: string;
}
export interface ManagedProject {
  record: ManagedProjectRecord;
  vaultDir: FileSystemDirectoryAdapter;
  vaultState: VaultState;
  workingFolders: WorkingFolderBindings;
  workingPaths: Record<string, string>;
  issues: string[];
  ready: boolean;
}
export interface WorkspaceProjectEntry {
  containerPath: string;
  projectId?: string;
  name: string;
  status: "ready" | "damaged" | "incomplete" | "duplicate";
  issues: string[];
  project?: ManagedProject;
}
export interface WorkspaceState {
  root: FileSystemDirectoryAdapter;
  identity: WorkspaceIdentity;
  projects: WorkspaceProjectEntry[];
}
export class WorkspaceOperationError extends Error {
  constructor(
    message: string,
    readonly destinationPath: string,
    readonly publicationUncertain = false,
  ) {
    super(
      `${message} Destination retained: ${destinationPath}.${publicationUncertain ? " Reopen the workspace before retrying; publication may have completed." : " Retry uses a fresh destination."}`,
    );
    this.name = "WorkspaceOperationError";
  }
}
export function managementChecksum(record: object): string {
  return hashString(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(record)
          .filter(([key]) => key !== "payloadSha256")
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    ),
  );
}
function seal<T extends object>(value: T): T & { payloadSha256: string } {
  return { ...value, payloadSha256: managementChecksum(value) };
}
function checkRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} is not a valid record.`);
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== VERSION)
    throw new Error(
      `Unsupported ${label} schema version (${String(record.schemaVersion)}); supported version is ${VERSION}. No migration was performed.`,
    );
  if (record.payloadSha256 !== managementChecksum(record))
    throw new Error(`${label} checksum mismatch.`);
}
function requireStrings(record: object, fields: string[], label: string) {
  for (const field of fields)
    if (
      typeof (record as Record<string, unknown>)[field] !== "string" ||
      !(record as Record<string, string>)[field].trim()
    )
      throw new Error(`${label} has an invalid ${field}.`);
}
function idSegment(id: string) {
  const segments = splitAndValidatePath(id);
  if (segments.length !== 1 || /[:*?"<>|]/.test(id))
    throw new Error("Unsafe record identity.");
  return id;
}
export function managedPath(path: string, prefix?: string): string[] {
  const segments = splitAndValidatePath(path);
  if (segments.some((segment) => /[:*?"<>|]/.test(segment)))
    throw new Error("Unsafe management path.");
  if (prefix && (!path.startsWith(prefix + "/") || path === prefix))
    throw new Error(`Managed path must be a descendant of ${prefix}.`);
  return segments;
}
/** Leaf folder name of a stored branch location (`projects/<any>/working/<leaf>`). */
function workingLeaf(storedPath: string): string {
  const stored = managedPath(storedPath);
  if (
    stored.length !== 4 ||
    stored[0] !== "projects" ||
    stored[2] !== "working"
  )
    throw new Error(
      "Working location must identify a branch leaf, not a shared container.",
    );
  return stored[3];
}
async function resolve(
  root: FileSystemDirectoryAdapter,
  path: string,
  prefix?: string,
) {
  const segments = managedPath(path, prefix);
  const directory = await root.getDirectory(segments, { create: false });
  const relative = await root.resolveRelativePath(directory);
  if (!relative || relative.join("/") !== path)
    throw new Error(
      `Directory identity does not match its recorded workspace location: ${path}.`,
    );
  return directory;
}
async function writeVerified(
  directory: FileSystemDirectoryAdapter,
  path: string[],
  value: object,
) {
  const text = JSON.stringify(value, null, 2);
  let writeError: unknown;
  try {
    await directory.writeFileText(path, text, { exclusive: true });
  } catch (error) {
    writeError = error;
  }
  const readBack = await directory.readFileText(path);
  if (readBack !== text)
    throw new Error(
      `Management record read-back failed: ${path.join("/")}. ${writeError instanceof Error ? writeError.message : ""}`,
    );
  return text;
}
async function workspaceIdentity(
  root: FileSystemDirectoryAdapter,
): Promise<WorkspaceIdentity> {
  const value = JSON.parse(await root.readFileText([WORKSPACE_FILE]));
  checkRecord(value, "workspace");
  requireStrings(value, ["workspaceId", "name", "createdAt"], "Workspace");
  idSegment(String(value.workspaceId));
  return value as unknown as WorkspaceIdentity;
}
export async function createWorkspace(
  root: FileSystemDirectoryAdapter,
  name = root.name,
  workspaceId = `workspace-${crypto.randomUUID()}`,
): Promise<WorkspaceState> {
  return withProjectWriterLock("workspace-initialization", async () => {
    if (!name.trim()) throw new Error("Workspace name is required.");
    if ((await root.queryPermission("readwrite")) !== "granted")
      throw new Error("Grant write access to the selected workspace folder.");
    if ((await root.listEntries()).length)
      throw new Error(
        "Create a workspace only in an empty folder. Use Open workspace for an existing one.",
      );
    const identity = seal({
      schemaVersion: VERSION,
      workspaceId: idSegment(workspaceId),
      name: name.trim(),
      createdAt: new Date().toISOString(),
    });
    await writeVerified(root, [WORKSPACE_FILE], identity);
    await root.getDirectory(["projects"], {
      create: true,
      exclusiveCreate: true,
    });
    return openWorkspace(root);
  });
}
async function readProjectRecord(
  root: FileSystemDirectoryAdapter,
  workspace: WorkspaceIdentity,
  containerPath: string,
) {
  const container = await resolve(root, containerPath, "projects");
  if (managedPath(containerPath).length !== 2)
    throw new Error("Project container must be directly inside projects/.");
  const record = JSON.parse(
    await container.readFileText([".cadtree", "project.json"]),
  );
  checkRecord(record, "managed project");
  requireStrings(
    record,
    [
      "workspaceId",
      "projectId",
      "name",
      "containerPath",
      "vaultPath",
      "createdAt",
    ],
    "Managed project",
  );
  if (
    record.workspaceId !== workspace.workspaceId ||
    !["create", "import", "adoption"].includes(String(record.origin))
  )
    throw new Error(
      "Managed project identity does not match this workspace.",
    );
  idSegment(String(record.projectId));
  // Identity comes from the metadata IDs, not the folder name: the stored
  // containerPath/vaultPath are only the creation-time location. Callers get the
  // actual current location in memory; the file on disk (covered by ready.json) is untouched.
  return {
    container,
    record: {
      ...record,
      containerPath,
      vaultPath: `${containerPath}/vault`,
    } as unknown as ManagedProjectRecord,
  };
}
export async function resolveManagedProject(
  root: FileSystemDirectoryAdapter,
  containerPath: string,
  stateOverride?: VaultState,
): Promise<ManagedProject> {
  const workspace = await workspaceIdentity(root);
  const { container, record } = await readProjectRecord(
    root,
    workspace,
    containerPath,
  );
  const issues: string[] = [];
  let ready = false;
  try {
    const marker = JSON.parse(
      await container.readFileText([".cadtree", "ready.json"]),
    );
    if (
      marker.schemaVersion !== VERSION ||
      marker.projectId !== record.projectId ||
      marker.workspaceId !== workspace.workspaceId ||
      marker.recordSha256 !==
        hashString(await container.readFileText([".cadtree", "project.json"]))
    )
      throw new Error(
        "Project ready marker is invalid or has an unsupported schema.",
      );
    ready = true;
  } catch (error) {
    issues.push(
      `Project publication is incomplete or damaged: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const vaultDir = await resolve(root, record.vaultPath, containerPath);
  const vaultState = stateOverride ?? (await openExistingVault(vaultDir));
  if (vaultState.project.projectId !== record.projectId)
    throw new Error(
      "Managed project record and vault refer to different project identities.",
    );
  const workingFolders: WorkingFolderBindings = {};
  const workingPaths: Record<string, string> = {};
  for (const branch of vaultState.branches) {
    try {
      const raw = JSON.parse(
        await container.readFileText([
          ".cadtree",
          "branches",
          `${idSegment(branch.branchId)}.json`,
        ]),
      );
      checkRecord(raw, "branch location");
      requireStrings(
        raw,
        ["workspaceId", "projectId", "branchId", "workingPath", "createdAt"],
        "Branch location",
      );
      if (
        raw.workspaceId !== workspace.workspaceId ||
        raw.projectId !== record.projectId ||
        raw.branchId !== branch.branchId
      )
        throw new Error("Branch location identity mismatch.");
      // The stored path records where the leaf was created; only its shape and leaf
      // name matter. The actual location is always under this project's working/.
      const path = `${containerPath}/working/${workingLeaf(String(raw.workingPath))}`;
      managedPath(path, `${containerPath}/working`);
      if (
        Object.values(workingPaths).some(
          (other) => other.toLowerCase() === path.toLowerCase(),
        )
      )
        throw new Error("Case-insensitive branch location collision.");
      workingPaths[branch.branchId] = path;
      const dir = await resolve(root, path, `${containerPath}/working`);
      if ((await dir.queryPermission("read")) !== "granted")
        throw new Error(
          "Read permission is unavailable. Reconnect the workspace.",
        );
      workingFolders[branch.branchId] = dir;
    } catch (error) {
      issues.push(
        `"${branch.name}" working folder: ${error instanceof Error ? error.message : String(error)} No folder was recreated or rebound.`,
      );
    }
  }
  try {
    await validateWorkingFolderBindings(vaultState, vaultDir, workingFolders);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  if (
    vaultState.corruptedRecords.length ||
    Object.keys(vaultState.damagedBranchHeads).length ||
    Object.values(vaultState.competingHeads).some((heads) => heads.length)
  )
    issues.push(
      "Vault branch/history integrity needs attention. Inspect History and Settings; managed writes are blocked.",
    );
  return {
    record,
    vaultDir,
    vaultState,
    workingFolders,
    workingPaths,
    issues,
    ready,
  };
}
export async function openWorkspace(
  root: FileSystemDirectoryAdapter,
): Promise<WorkspaceState> {
  const identity = await workspaceIdentity(root);
  const projects: WorkspaceProjectEntry[] = [];
  const directory = await root.getDirectory(["projects"], { create: false });
  for (const entry of await directory.listEntries()) {
    if (entry.kind !== "directory") continue;
    const containerPath = `projects/${entry.name}`;
    try {
      const project = await resolveManagedProject(root, containerPath);
      if (project.record.workspaceId !== identity.workspaceId)
        throw new Error(
          "Workspace identity changed during discovery. Reopen the chosen workspace.",
        );
      projects.push({
        containerPath,
        projectId: project.record.projectId,
        name: project.record.name,
        status: !project.ready
          ? "incomplete"
          : project.issues.length
            ? "damaged"
            : "ready",
        issues: project.issues,
        project,
      });
    } catch (error) {
      let incomplete = false;
      let name = entry.name;
      try {
        const container = await resolve(root, containerPath, "projects");
        const attempt = JSON.parse(
          await container.readFileText([".cadtree", "attempt.json"]),
        );
        if (
          typeof attempt.containerPath === "string" &&
          ["create", "import", "adoption"].includes(attempt.operation) &&
          typeof attempt.name === "string" &&
          !(await container.hasFile([".cadtree", "ready.json"]))
        ) {
          incomplete = true;
          name = attempt.name;
        }
      } catch {
        /* Keep malformed or disconnected containers visible as damaged. */
      }
      projects.push({
        containerPath,
        name,
        status: incomplete ? "incomplete" : "damaged",
        issues: [error instanceof Error ? error.message : String(error)],
      });
    }
  }
  const counts = new Map<string, number>();
  for (const entry of projects)
    if (entry.projectId)
      counts.set(entry.projectId, (counts.get(entry.projectId) ?? 0) + 1);
  for (const entry of projects)
    if (entry.projectId && counts.get(entry.projectId)! > 1) {
      entry.status = "duplicate";
      entry.issues.push(
        "This project identity exists at multiple locations. Choose one location explicitly; histories are not merged.",
      );
    }
  if ((await workspaceIdentity(root)).workspaceId !== identity.workspaceId)
    throw new Error("Workspace identity changed during discovery.");
  return { root, identity, projects };
}

export async function adoptProject(
  root: FileSystemDirectoryAdapter,
  sourceVault: FileSystemDirectoryAdapter,
  sourceFolders: WorkingFolderBindings,
  options: CopyOptions = {},
): Promise<ManagedProject> {
  const workspace = await workspaceIdentity(root);
  const initial = await openExistingVault(sourceVault);
  await validateDirectoryIsolation(
    sourceVault,
    root,
    "Original revision vault",
    "cAdtree workspace",
  );
  for (const branch of initial.branches) {
    const directory = sourceFolders[branch.branchId];
    if (!directory)
      throw new Error(
        `Connect the current working folder for "${branch.name}" before bringing this project into the workspace.`,
      );
    await validateDirectoryIsolation(
      directory,
      root,
      `Original "${branch.name}" working folder`,
      "cAdtree workspace",
    );
  }
  // Always workspace registration first, then project lock; managed branch/capture only need the project lock.
  return withProjectWriterLock(`workspace:${workspace.workspaceId}`, () =>
    withProjectWriterLock(initial.project.projectId, async () => {
      const discovered = await openWorkspace(root);
      if (discovered.identity.workspaceId !== workspace.workspaceId)
        throw new Error(
          "Workspace identity changed while waiting for registration.",
        );
      if (
        discovered.projects.some(
          (entry) =>
            entry.projectId === initial.project.projectId &&
            entry.project?.ready,
        )
      )
        throw new Error(
          "This project identity already has a managed location. Choose its existing location explicitly instead of copying another history.",
        );
      const state = await openExistingVault(sourceVault);
      if (state.project.projectId !== initial.project.projectId)
        throw new Error("Source vault identity changed.");
      if (
        state.corruptedRecords.length ||
        componentWriteBlock(state) ||
        referenceWriteBlock(state) ||
        Object.keys(state.damagedBranchHeads).length ||
        Object.values(state.competingHeads).some((heads) => heads.length)
      )
        throw new Error(
          "The existing vault has damaged or ambiguous history and cannot be safely adopted. Read-only inspection of the original remains available.",
        );
      await validateWorkingFolderBindings(state, sourceVault, sourceFolders);
      await verifyReferenceLibraryContent(sourceVault, state, options.signal);
      throwIfCancelled(options.signal);
      const { path, container } = await allocateProject(
        root,
        state.project.name,
        "adoption",
      );
      try {
        const vault = await container.getDirectory(["vault"], {
          create: true,
          exclusiveCreate: true,
        });
        const snapshots: {
          source: FileSystemDirectoryAdapter;
          signature: string;
        }[] = [];
        const copiedVault = await copyVerifiedTree(sourceVault, vault, options);
        snapshots.push({
          source: sourceVault,
          signature: inventorySignature(copiedVault),
        });
        // allocateProject always creates "working".
        const workingRoot = await container.getDirectory(["working"]);
        const folders: WorkingFolderBindings = {};
        for (const branch of state.branches) {
          // Main stays "main"; design cases get readable names. Each pick lists
          // the folder again so it sees the cases created before it. The
          // workspace and project locks are held, and creation stays exclusive.
          const leaf = branch.isMain
            ? "main"
            : await pickFreeName(
                workingRoot,
                folderNameFor(branch.name, "Design case"),
                { extraTaken: ["main"] },
              );
          const destination = await container.getDirectory(["working", leaf], {
            create: true,
            exclusiveCreate: true,
          });
          const snapshot = await copyVerifiedTree(
            sourceFolders[branch.branchId]!,
            destination,
            options,
          );
          snapshots.push({
            source: sourceFolders[branch.branchId]!,
            signature: inventorySignature(snapshot),
          });
          folders[branch.branchId] = destination;
        }
        // Source working trees can change while another branch is being copied.
        for (const snapshot of snapshots)
          if (
            inventorySignature(
              await readVerifiedInventory(snapshot.source, options),
            ) !== snapshot.signature
          )
            throw new Error(
              "An adoption source changed before activation. Save and close CAD documents and retry.",
            );
        const reopened = await openExistingVault(vault);
        await verifyReferenceLibraryContent(vault, reopened, options.signal);
        if (
          reopened.project.projectId !== state.project.projectId ||
          reopened.branches.length !== state.branches.length ||
          reopened.revisions.length !== state.revisions.length
        )
          throw new Error(
            "Copied vault history did not validate against the source project.",
          );
        for (const [index, revision] of reopened.revisions.entries()) {
          throwIfCancelled(options.signal);
          options.onProgress?.({
            phase: "verifying_objects",
            processedFiles: index,
            totalFiles: reopened.revisions.length,
            processedBytes: 0,
            totalBytes: 0,
            message: `Verifying stored content for adopted revision ${revision.manifest.displayNumber}…`,
          });
          const verified = await verifyRevisionObjects(
            vault,
            revision,
            options.signal,
          );
          if (verified.integrityStatus === "corrupted")
            throw new Error(
              `Copied vault has corrupt stored objects: ${verified.integrityErrors.join("; ")}`,
            );
        }
        return await publishProject(
          root,
          workspace,
          path,
          reopened,
          folders,
          "adoption",
          options,
          async () => {
            for (const entry of snapshots)
              if (
                inventorySignature(
                  await readVerifiedInventory(entry.source, options),
                ) !== entry.signature
              )
                throw new Error(
                  "An adoption source changed before publication.",
                );
            if (
              inventorySignature(
                await readVerifiedInventory(vault, options),
              ) !== inventorySignature(copiedVault)
            )
              throw new Error("Copied vault changed before publication.");
            for (const [index, branch] of state.branches.entries())
              if (
                inventorySignature(
                  await readVerifiedInventory(
                    folders[branch.branchId]!,
                    options,
                  ),
                ) !== snapshots[index + 1].signature
              )
                throw new Error(
                  "Copied working folder changed before publication.",
                );
          },
        );
      } catch (error) {
        if (error instanceof WorkspaceOperationError) throw error;
        throw new WorkspaceOperationError(
          error instanceof Error ? error.message : String(error),
          path,
        );
      }
    }),
  );
}

export async function createManagedBranch(
  root: FileSystemDirectoryAdapter,
  containerPath: string,
  input: {
    sourceRevisionId: string;
    name: string;
    reason: string;
  } & CopyOptions,
): Promise<
  ManagedProject & { createdBranchId: string; publicationWarning?: string }
> {
  const workspace = await workspaceIdentity(root);
  const project = await resolveManagedProject(root, containerPath);
  assertWritable(project);
  const parent = await resolve(root, `${containerPath}/working`, containerPath);
  let bindingPath = "";
  let latestFolders = project.workingFolders;
  let latestPaths = project.workingPaths;
  const result = await createDesignBranch({
    ...input,
    vaultDir: project.vaultDir,
    workingFolders: project.workingFolders,
    destinationParent: parent,
    resolveWorkingFolders: async (state) => {
      const current = await resolveManagedProject(root, containerPath, state);
      assertWritable(current);
      latestFolders = current.workingFolders;
      latestPaths = current.workingPaths;
      return current.workingFolders;
    },
    beforePublish: async (branch, directory) => {
      bindingPath = await writeBranchLocation(
        root,
        workspace,
        project.record,
        branch,
        directory,
      );
    },
  });
  // The branch/mapping commit is complete. A subsequent read or browser cache failure
  // must not turn a successful publication into an invitation to create it twice.
  return {
    ...project,
    vaultState: result.vaultState,
    workingFolders: {
      ...latestFolders,
      [result.branch.branchId]: result.workingDir,
    },
    workingPaths: { ...latestPaths, [result.branch.branchId]: bindingPath },
    createdBranchId: result.branch.branchId,
    publicationWarning: result.publicationWarning,
  };
}

export async function recoverManagedCopy(
  root: FileSystemDirectoryAdapter,
  containerPath: string,
  revisionId: string,
  selectedPaths: string[] | undefined,
  options: CopyOptions = {},
) {
  const first = await resolveManagedProject(root, containerPath);
  return withProjectWriterLock(first.record.projectId, async () => {
    const project = await resolveManagedProject(root, containerPath);
    assertWritable(project);
    throwIfCancelled(options.signal);
    const relativePath = `${containerPath}/recoveries/copy-${crypto.randomUUID()}`;
    const recoveryParent = await resolve(
      root,
      `${containerPath}/recoveries`,
      containerPath,
    );
    const destination = await recoveryParent.getDirectory(
      [relativePath.split("/").at(-1)!],
      { create: true, exclusiveCreate: true },
    );
    try {
      const restoreOptions = {
        ...options,
        vaultDir: project.vaultDir,
        workingFolders: project.workingFolders,
        destinationDir: destination,
        revisionId,
      };
      const result = selectedPaths
        ? await restoreSelectedFilesToFolder({
            ...restoreOptions,
            selectedPaths,
          })
        : await restoreRevisionToFolder(restoreOptions);
      return { result, relativePath };
    } catch (error) {
      throw new WorkspaceOperationError(
        error instanceof Error ? error.message : String(error),
        relativePath,
      );
    }
  });
}

function assertWritable(project: ManagedProject) {
  if (!project.ready || project.issues.length)
    throw new Error(
      `Managed project is read-only until its workspace connections and records are valid. ${project.issues.join(" ")}`,
    );
}
async function allocateProject(
  root: FileSystemDirectoryAdapter,
  name: string,
  operation: string,
) {
  // Lookup and name choice create nothing, so their failures are plain errors,
  // not retained destinations.
  const projectsDir = await root.getDirectory(["projects"], { create: false });
  const path = `projects/${await pickFreeName(projectsDir, folderNameFor(name, "Project"))}`;
  try {
    const container = await root.getDirectory(managedPath(path), {
      create: true,
      exclusiveCreate: true,
    });
    await container.getDirectory([".cadtree", "branches"], { create: true });
    await container.writeFileText(
      [".cadtree", "attempt.json"],
      JSON.stringify({
        operation,
        name,
        containerPath: path,
        startedAt: new Date().toISOString(),
      }),
      { exclusive: true },
    );
    await container.getDirectory(["working"], { create: true });
    await container.getDirectory(["recoveries"], { create: true });
    return { path, container };
  } catch (error) {
    throw new WorkspaceOperationError(
      error instanceof Error ? error.message : String(error),
      path,
    );
  }
}
async function writeBranchLocation(
  root: FileSystemDirectoryAdapter,
  workspace: WorkspaceIdentity,
  project: ManagedProjectRecord,
  branch: BranchRecord,
  workingDir: FileSystemDirectoryAdapter,
) {
  const relative = await root.resolveRelativePath(workingDir);
  if (!relative)
    throw new Error("The branch folder is outside the authorized workspace.");
  const workingPath = relative.join("/");
  managedPath(workingPath, `${project.containerPath}/working`);
  const value = seal({
    schemaVersion: VERSION,
    workspaceId: workspace.workspaceId,
    projectId: project.projectId,
    branchId: branch.branchId,
    workingPath,
    createdAt: new Date().toISOString(),
  });
  const container = await resolve(root, project.containerPath, "projects");
  await writeVerified(
    container,
    [".cadtree", "branches", `${idSegment(branch.branchId)}.json`],
    value,
  );
  return workingPath;
}
async function publishProject(
  root: FileSystemDirectoryAdapter,
  workspace: WorkspaceIdentity,
  path: string,
  state: VaultState,
  folders: WorkingFolderBindings,
  origin: "create" | "import" | "adoption",
  options: CopyOptions,
  verifyCopies?: () => Promise<void>,
) {
  const record = seal({
    schemaVersion: VERSION,
    workspaceId: workspace.workspaceId,
    projectId: state.project.projectId,
    name: state.project.name,
    containerPath: path,
    vaultPath: `${path}/vault`,
    createdAt: new Date().toISOString(),
    origin,
  });
  for (const branch of state.branches)
    await writeBranchLocation(
      root,
      workspace,
      record,
      branch,
      folders[branch.branchId]!,
    );
  const container = await resolve(root, path, "projects");
  const text = await writeVerified(
    container,
    [".cadtree", "project.json"],
    record,
  );
  throwIfCancelled(options.signal);
  const pending = await resolveManagedProject(root, path);
  const blocking = pending.issues.filter(
    (issue) =>
      !issue.startsWith("Project publication is incomplete or damaged:"),
  );
  if (blocking.length) throw new Error(blocking.join(" "));
  await verifyCopies?.();
  options.onProgress?.({
    phase: "publishing_completion",
    processedFiles: 0,
    totalFiles: 0,
    processedBytes: 0,
    totalBytes: 0,
    message: "Publishing the verified managed project…",
  });
  throwIfCancelled(options.signal);
  try {
    await writeVerified(container, [".cadtree", "ready.json"], {
      schemaVersion: VERSION,
      workspaceId: workspace.workspaceId,
      projectId: record.projectId,
      recordSha256: hashString(text),
    });
  } catch (error) {
    throw new WorkspaceOperationError(
      error instanceof Error ? error.message : String(error),
      path,
      true,
    );
  }
  return { ...pending, ready: true, issues: [] };
}
export async function importProject(
  root: FileSystemDirectoryAdapter,
  source: FileSystemDirectoryAdapter,
  name: string,
  options: CopyOptions = {},
): Promise<ManagedProject> {
  // Complete managed projects are history-bearing imports, never raw CAD sources.
  await validateDirectoryIsolation(source, root, 'Original project', 'cAdtree workspace');
  const entries = await source.listEntries();
  if (entries.some(e => e.name === '.cadtree-workspace.json' || e.name === '.cadtree-home.json')) throw new Error('Choose a project folder here. Use Import existing workspace for a workspace.');
  if (entries.some(e => e.name === '.cadtree') || await source.hasFile(['vault', 'project.json']) || await source.hasDirectory(['vault', 'components']) || await source.hasDirectory(['vault', 'completed'])) {
    if (!await source.hasFile(['.cadtree', 'project.json']) || !await source.hasFile(['.cadtree', 'ready.json']) || !await source.hasFile(['vault', 'project.json'])) throw new Error('Incomplete cAdtree project metadata. No new project identities were generated.');
    const text = await source.readFileText(['.cadtree', 'project.json']);
    const record = JSON.parse(text);
    checkRecord(record, 'imported managed project');
    requireStrings(record, ['projectId', 'workspaceId', 'containerPath', 'vaultPath'], 'Imported project');
    const ready = JSON.parse(await source.readFileText(['.cadtree', 'ready.json']));
    if (ready.schemaVersion !== VERSION || ready.projectId !== record.projectId || ready.workspaceId !== record.workspaceId || ready.recordSha256 !== hashString(text)) throw new Error('Imported project publication does not match its location records.');
    const vault = await source.getDirectory(['vault']);
    const state = await openExistingVault(vault);
    if (state.project.projectId !== record.projectId || componentWriteBlock(state) || referenceWriteBlock(state)) throw new Error(componentWriteBlock(state) ?? referenceWriteBlock(state) ?? 'Imported project identity mismatch.');
    const folders: WorkingFolderBindings = {};
    const leaves = new Set<string>();
    for (const branch of state.branches) {
      const location = JSON.parse(await source.readFileText(['.cadtree', 'branches', `${idSegment(branch.branchId)}.json`]));
      checkRecord(location, 'imported branch location');
      requireStrings(location, ['workingPath'], 'Imported branch');
      if (location.projectId !== record.projectId || location.workspaceId !== record.workspaceId || location.branchId !== branch.branchId) throw new Error('Imported branch location identity mismatch.');
      const leaf = workingLeaf(String(location.workingPath));
      if (leaves.has(leaf.toLowerCase())) throw new Error('Imported branch locations collide (case-insensitive).');
      leaves.add(leaf.toLowerCase());
      folders[branch.branchId] = await source.getDirectory(['working', leaf]);
    }
    return adoptProject(root, vault, folders, options);
  }
  if ((await source.hasFile(['project.json']) || await source.hasDirectory(['completed'])) && await source.hasDirectory(['revisions'])) throw new Error('Select the complete project folder, including working branches; a vault alone cannot be imported as CAD files.');
  return initializeManagedProject(root, name, options, source);
}

/** Allocate an empty project using the same verified publication as imports. */
export async function createProject(
  root: FileSystemDirectoryAdapter,
  name: string,
  options: CopyOptions = {},
): Promise<ManagedProject> {
  return initializeManagedProject(root, name, options);
}

async function initializeManagedProject(
  root: FileSystemDirectoryAdapter,
  name: string,
  options: CopyOptions,
  source?: FileSystemDirectoryAdapter,
): Promise<ManagedProject> {
  if (!name.trim()) throw new Error("Project name is required.");
  if (source)
    await validateDirectoryIsolation(
      source,
      root,
      "Original CAD source",
      "cAdtree workspace",
    );
  const workspace = await workspaceIdentity(root);
  return withProjectWriterLock(
    `workspace:${workspace.workspaceId}`,
    async () => {
      const refreshed = await openWorkspace(root);
      if (refreshed.identity.workspaceId !== workspace.workspaceId)
        throw new Error(
          "Workspace identity changed while waiting for registration.",
        );
      if (
        refreshed.projects.some(
          (entry) =>
            entry.status !== "incomplete" &&
            branchNameKey(entry.name) === branchNameKey(name),
        )
      )
        throw new Error(
          "A project with that name is already present in this workspace.",
        );
      throwIfCancelled(options.signal);
      const origin = source ? "import" : "create";
      const { path, container } = await allocateProject(root, name, origin);
      try {
        const main = await container.getDirectory(["working", "main"], {
          create: true,
          exclusiveCreate: true,
        });
        const copied = source
          ? await copyVerifiedTree(source, main, options)
          : await readVerifiedInventory(main, options);
        const vault = await container.getDirectory(["vault"], {
          create: true,
          exclusiveCreate: true,
        });
        const state = await initializeProjectVault(main, vault, name.trim());
        return await publishProject(
          root,
          workspace,
          path,
          state,
          { [MAIN_BRANCH_ID]: main },
          origin,
          options,
          async () => {
            if (
              (source &&
                inventorySignature(
                  await readVerifiedInventory(source, options),
                ) !== inventorySignature(copied)) ||
              inventorySignature(await readVerifiedInventory(main, options)) !==
                inventorySignature(copied)
            )
              throw new Error(
                "Source or managed Main changed before publication.",
              );
          },
        );
      } catch (error) {
        if (error instanceof WorkspaceOperationError) throw error;
        throw new WorkspaceOperationError(
          error instanceof Error ? error.message : String(error),
          path,
        );
      }
    },
  );
}
