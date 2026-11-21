import { isEffectivelyEmpty } from "./scanner";
import {
  type FileSystemDirectoryAdapter,
  validateDirectoryIsolation,
} from "./fs-adapter";
import { componentWriteBlock } from './component-identity';
import {
  createWorkspace,
  openWorkspace,
  managedPath,
  managementChecksum,
  WorkspaceOperationError,
  type WorkspaceState,
} from "./workspace-service";
import {
  copyVerifiedTree,
  inventorySignature,
  readVerifiedInventory,
  throwIfCancelled,
  type CopyOptions,
} from "./copy-service";
import { withProjectWriterLock } from "./locks";
import { folderNameFor, pickFreeName } from "./folder-names";
import { hashString } from "./hash";
import { verifyRevisionObjects } from "./vault-service";
import { referenceWriteBlock, verifyReferenceLibraryContent } from './references';
import {
  CASE_ALLOWANCE, UNCHECKED_PATH_BUDGET, checkWorstPath, joinAddress, longestPath, longestOf, longestRelativePaths,
  projectWorstPath, workspaceWorstPath, type PathBudgetInput, type PathBudgetReport,
} from './path-budget';

const IDENTITY = ".cadtree-home.json";
const RECORDS = [".cadtree-home", "workspaces"];
export interface HomeOperationOptions extends CopyOptions {
  expectedHomeId?: string;
  /** Absolute home address for the path budget check; without it the check is reported as 'unchecked'. */
  budget?: Pick<PathBudgetInput, "homeAddress">;
}
export interface HomeIdentity {
  schemaVersion: number;
  homeId: string;
  name: string;
  createdAt: string;
  payloadSha256: string;
}
export interface HomeWorkspaceRecord {
  schemaVersion: number;
  homeId: string;
  workspaceId: string;
  name: string;
  directory: string;
  registrationId: string;
  operation: "create" | "adoption";
  createdAt: string;
  payloadSha256: string;
}
export interface HomeWorkspaceEntry {
  key: string;
  name: string;
  directory?: string;
  /** Directory written in the registration; differs from `directory` when the folder was renamed. */
  recordedDirectory?: string;
  workspaceId?: string;
  status: "ready" | "damaged" | "incomplete" | "duplicate";
  issues: string[];
  workspace?: WorkspaceState;
}
export interface HomeState {
  root: FileSystemDirectoryAdapter;
  identity: HomeIdentity;
  workspaces: HomeWorkspaceEntry[];
}
/** Incomplete retries belong to the same logical workspace, never separate identities in navigation. */
export function homeWorkspaceGroups(
  entries: HomeWorkspaceEntry[],
): HomeWorkspaceEntry[][] {
  const groups = new Map<string, HomeWorkspaceEntry[]>();
  for (const entry of entries) {
    const key = entry.workspaceId
      ? `identity:${entry.workspaceId}`
      : `record:${entry.key}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.values()];
}
const seal = <T extends object>(record: T) => ({
  ...record,
  payloadSha256: managementChecksum(record),
});
function validate(
  value: unknown,
  fields: string[],
  label: string,
): asserts value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${label} record.`);
  const r = value as Record<string, unknown>;
  if (r.schemaVersion !== 1)
    throw new Error(`Unsupported ${label} schema. No records were changed.`);
  if (r.payloadSha256 !== managementChecksum(r))
    throw new Error(`${label} checksum mismatch.`);
  for (const field of fields)
    if (typeof r[field] !== "string" || !(r[field] as string).trim())
      throw new Error(`Invalid ${label} ${field}.`);
}
function segment(value: string) {
  if (managedPath(value).length !== 1 || /[:*?"<>|]/.test(value))
    throw new Error("Invalid home identity or child location.");
  return value;
}
async function writeVerified(
  root: FileSystemDirectoryAdapter,
  path: string[],
  value: object,
) {
  const text = JSON.stringify(value, null, 2);
  let failure: unknown;
  try {
    await root.writeFileText(path, text, { exclusive: true });
  } catch (error) {
    failure = error;
  }
  if ((await root.readFileText(path)) !== text)
    throw new Error(
      `Home record read-back failed. ${failure instanceof Error ? failure.message : ""}`,
    );
  return text;
}
async function identity(
  root: FileSystemDirectoryAdapter,
): Promise<HomeIdentity> {
  const value: unknown = JSON.parse(await root.readFileText([IDENTITY]));
  validate(value, ["homeId", "name", "createdAt"], "Cadtree home");
  segment(value.homeId);
  return value as unknown as HomeIdentity;
}
export async function createHome(
  root: FileSystemDirectoryAdapter,
): Promise<HomeState> {
  return withProjectWriterLock("home-initialization", async () => {
    if ((await root.queryPermission("readwrite")) !== "granted")
      throw new Error("Grant write access to the Cadtree home.");
    if (!isEffectivelyEmpty(await root.listEntries()))
      throw new Error(
        "Choose an empty dedicated folder, suggested name Cadtree. Use Open Cadtree home for a recognized existing home.",
      );
    await writeVerified(
      root,
      [IDENTITY],
      seal({
        schemaVersion: 1,
        homeId: `home-${crypto.randomUUID()}`,
        name: root.name,
        createdAt: new Date().toISOString(),
      }),
    );
    await root.getDirectory(RECORDS, { create: true, exclusiveCreate: true });
    return openHome(root);
  });
}
/** Registry records reserve identities/locations before work begins. Missing leaves never get recreated. */
export async function openHome(
  root: FileSystemDirectoryAdapter,
): Promise<HomeState> {
  const home = await identity(root);
  const workspaces: HomeWorkspaceEntry[] = [];
  const records = await root.getDirectory(RECORDS, { create: false });
  const reserved = new Set<string>();
  const recordedIds = new Map<string, string[]>();
  const pending: { entry: HomeWorkspaceEntry; r: HomeWorkspaceRecord }[] = [];
  for (const file of await records.listEntries()) {
    if (
      file.kind !== "file" ||
      !file.name.endsWith(".json") ||
      file.name.endsWith(".ready.json")
    )
      continue;
    const entry: HomeWorkspaceEntry = {
      key: file.name,
      name: "Unavailable workspace",
      status: "damaged",
      issues: [],
    };
    try {
      const text = await records.readFileText([file.name]);
      const raw: unknown = JSON.parse(text);
      validate(
        raw,
        [
          "homeId",
          "workspaceId",
          "name",
          "directory",
          "registrationId",
          "createdAt",
          "operation",
        ],
        "workspace registration",
      );
      const r = raw as unknown as HomeWorkspaceRecord;
      segment(r.directory);
      segment(r.workspaceId);
      segment(r.registrationId);
      if (
        r.homeId !== home.homeId ||
        file.name !== `${r.registrationId}.json` ||
        !["create", "adoption"].includes(r.operation) ||
        r.directory.startsWith(".")
      )
        throw new Error(
          "Workspace registration identity or location mismatch.",
        );
      Object.assign(entry, {
        name: r.name,
        directory: r.directory,
        recordedDirectory: r.directory,
        workspaceId: r.workspaceId,
      });
      reserved.add(r.directory.toLowerCase());
      recordedIds.set(r.directory.toLowerCase(), [
        ...(recordedIds.get(r.directory.toLowerCase()) ?? []),
        r.workspaceId,
      ]);
      if (!(await records.hasFile([`${r.registrationId}.ready.json`]))) {
        entry.status = "incomplete";
        throw new Error(
          "Workspace publication is incomplete. Destination kept; it will not be reused.",
        );
      }
      const ready = JSON.parse(
        await records.readFileText([`${r.registrationId}.ready.json`]),
      );
      validate(
        ready,
        ["registrationId", "recordSha256"],
        "workspace publication",
      );
      if (
        ready.registrationId !== r.registrationId ||
        ready.recordSha256 !== hashString(text)
      )
        throw new Error(
          "Workspace publication does not match its registration.",
        );
      pending.push({ entry, r });
    } catch (error) {
      entry.issues.push(error instanceof Error ? error.message : String(error));
    }
    workspaces.push(entry);
  }
  // Second pass: all recorded directories are known, so a renamed folder can be found by identity.
  let folderIds: Map<string, string[]> | undefined;
  for (const { entry, r } of pending) {
    try {
      let workspace: WorkspaceState;
      try {
        workspace = await resolveHomeWorkspace(
          root,
          home.homeId,
          r.workspaceId,
          r.directory,
        );
      } catch (error) {
        folderIds ??= await workspaceFolderIds(root);
        // Fall back only when the recorded folder is missing, unreadable as a workspace, or holds another identity.
        // A recorded folder that still carries this identity but fails to open keeps its error; a copy is never bound instead.
        if (
          (folderIds.get(r.workspaceId) ?? []).some(
            (name) => name === r.directory,
          )
        )
          throw error;
        const matches = (folderIds.get(r.workspaceId) ?? []).filter((name) => {
          const lower = name.toLowerCase();
          // Names are compared exactly, so a case-only rename still binds by id. A folder recorded by another registration is only claimable when that registration's own workspace lives elsewhere (a swap).
          return (
            name !== r.directory &&
            (recordedIds.get(lower) ?? []).every(
              (id) => id === r.workspaceId || folderIds!.has(id),
            )
          );
        });
        if (!matches.length) throw error;
        if (matches.length > 1)
          throw new Error(
            `Workspace folder not found at "${r.directory}"; it was found in more than one folder (${matches.join(", ")}). No folder was chosen.`,
          );
        workspace = await resolveHomeWorkspace(
          root,
          home.homeId,
          r.workspaceId,
          matches[0],
        );
        entry.directory = matches[0];
        reserved.add(matches[0].toLowerCase());
      }
      entry.workspace = workspace;
      entry.status = workspace.projects.every((p) => p.status === "ready")
        ? "ready"
        : "damaged";
      if (entry.status === "damaged")
        entry.issues.push(
          "Some projects need attention. Open the workspace to inspect them.",
        );
    } catch (error) {
      entry.issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  // Retain identifiable orphan destinations even if a registration was damaged or interrupted.
  for (const child of await root.listEntries()) {
    if (
      child.kind !== "directory" ||
      child.name.startsWith(".") ||
      reserved.has(child.name.toLowerCase())
    )
      continue;
    const dir = await root.getDirectory([child.name], { create: false });
    if (await dir.hasFile([".cadtree-workspace.json"]))
      workspaces.push({
        key: `unregistered:${child.name}`,
        name: child.name,
        directory: child.name,
        status: "damaged",
        issues: [
          "Unregistered workspace location. No binding was guessed or published.",
        ],
      });
  }
  const ids = new Map<string, number>();
  const paths = new Map<string, number>();
  for (const e of workspaces) {
    if (e.workspaceId && e.status !== "incomplete")
      ids.set(e.workspaceId, (ids.get(e.workspaceId) ?? 0) + 1);
    if (e.directory)
      paths.set(
        e.directory.toLowerCase(),
        (paths.get(e.directory.toLowerCase()) ?? 0) + 1,
      );
  }
  for (const e of workspaces)
    if (
      (e.workspaceId && ids.get(e.workspaceId)! > 1) ||
      (e.directory && paths.get(e.directory.toLowerCase())! > 1)
    ) {
      e.status = "duplicate";
      e.workspace = undefined;
      e.issues.push(
        "Duplicate workspace identity or location. Resolve the kept records explicitly; copies are never merged.",
      );
    }
  if ((await identity(root)).homeId !== home.homeId)
    throw new Error("The Cadtree home changed during discovery.");
  return { root, identity: home, workspaces };
}
/** Read-only map of workspace identity to the child folders whose metadata carries it. */
async function workspaceFolderIds(root: FileSystemDirectoryAdapter) {
  const found = new Map<string, string[]>();
  for (const child of await root.listEntries()) {
    if (child.kind !== "directory" || child.name.startsWith(".")) continue;
    try {
      const dir = await root.getDirectory([child.name], { create: false });
      const value: unknown = JSON.parse(
        await dir.readFileText([".cadtree-workspace.json"]),
      );
      const id = (value as { workspaceId?: unknown } | null)?.workspaceId;
      if (typeof id === "string")
        found.set(id, [...(found.get(id) ?? []), child.name].sort());
    } catch {
      /* not a readable workspace folder */
    }
  }
  return found;
}
export async function resolveHomeWorkspace(
  root: FileSystemDirectoryAdapter,
  homeId: string,
  workspaceId: string,
  directory: string,
) {
  if ((await identity(root)).homeId !== homeId)
    throw new Error("The Cadtree home changed. Reconnect it.");
  segment(directory);
  const child = await root.getDirectory([directory], { create: false });
  if ((await root.resolveRelativePath(child))?.join("/") !== directory)
    throw new Error("Workspace directory does not match its home mapping.");
  const workspace = await openWorkspace(child);
  if (workspace.identity.workspaceId !== workspaceId)
    throw new Error(
      "Workspace identity does not match its home registration. No folder was rebound.",
    );
  return workspace;
}
/**
 * Worst case for a workspace folder `directory` in the home at `homeAddress`: a future project plus
 * the project worst case (nothing for the user's files). When bringing a workspace in, each of its
 * projects is also measured with its real folder name, longest file and working-folder names.
 * Read-only. Unknown address: reported as unchecked.
 */
async function checkWorkspaceBudget(
  homeAddress: string | undefined,
  directory: string,
  source: FileSystemDirectoryAdapter | undefined,
): Promise<PathBudgetReport> {
  if (!homeAddress) return UNCHECKED_PATH_BUDGET;
  const workspaceAddress = joinAddress(homeAddress, directory);
  const candidates: { path: string }[] = [{ path: workspaceWorstPath(workspaceAddress) }];
  if (source) {
    for (const entry of (await openWorkspace(source)).projects) {
      if (!entry.project) continue;
      let longestFile = "";
      let longestDir = "";
      let allowance = CASE_ALLOWANCE;
      for (const branch of entry.project.vaultState.branches) {
        const folder = entry.project.workingFolders[branch.branchId];
        if (folder) {
          const found = await longestRelativePaths(folder);
          longestFile = longestOf([longestFile, found.file]);
          longestDir = longestOf([longestDir, found.dir]);
        }
        // The readable case folder name used on copy, with room for a counter.
        allowance = Math.max(allowance, folderNameFor(branch.name, "Design case").length + " (2)".length);
      }
      candidates.push({
        path: projectWorstPath({
          projectAddress: joinAddress(workspaceAddress, entry.containerPath),
          longestUserFile: longestFile,
          longestUserDir: longestDir,
          caseAllowance: allowance,
        }),
      });
    }
  }
  const worst = longestPath(candidates.map((c) => c.path))!;
  // The name the user can shorten is always the workspace folder name.
  return checkWorstPath(worst, "workspace", directory);
}
async function register(
  root: FileSystemDirectoryAdapter,
  name: string,
  source: FileSystemDirectoryAdapter | undefined,
  options: HomeOperationOptions,
) {
  const first = await identity(root);
  if (options.expectedHomeId && first.homeId !== options.expectedHomeId)
    throw new Error(
      "The Cadtree home changed. Reopen the intended home before writing.",
    );
  if (!name.trim()) throw new Error("Workspace name is required.");
  options.onProgress?.({
    phase: "acquiring_lock",
    processedFiles: 0,
    totalFiles: 0,
    processedBytes: 0,
    totalBytes: 0,
    message: "Preparing workspace registration…",
  });
  if (source)
    await validateDirectoryIsolation(
      source,
      root,
      "Existing workspace",
      "Cadtree home",
    );
  return withProjectWriterLock(`home:${first.homeId}`, async () => {
    const home = await openHome(root);
    if (home.identity.homeId !== first.homeId)
      throw new Error("The home changed while waiting for registration.");
    if (home.workspaces.some((e) => e.status === "damaged" && !e.workspaceId))
      throw new Error(
        "A damaged home registration needs attention before allocating another workspace.",
      );
    const original = source ? await openWorkspace(source) : undefined;
    const workspaceId =
      original?.identity.workspaceId ?? `workspace-${crypto.randomUUID()}`;
    if (
      home.workspaces.some(
        (e) => e.workspaceId === workspaceId && e.status !== "incomplete",
      )
    )
      throw new Error(
        "This workspace identity already has a kept managed registration. Open or inspect that location; it was not copied again.",
      );
    const run = async () => {
      throwIfCancelled(options.signal);
      const registrationId = `registration-${crypto.randomUUID()}`;
      const directory = await pickFreeName(root, folderNameFor(name, "Workspace"), {
        extraTaken: home.workspaces.flatMap((e) =>
          [e.directory, e.recordedDirectory].filter((d): d is string => !!d),
        ),
      });
      // Path budget: the final folder name is known and nothing has been written yet.
      const pathBudget = await checkWorkspaceBudget(options.budget?.homeAddress, directory, source);
      const record = seal({
        schemaVersion: 1,
        homeId: first.homeId,
        workspaceId,
        name: name.trim(),
        directory,
        registrationId,
        operation: source ? ("adoption" as const) : ("create" as const),
        createdAt: new Date().toISOString(),
      });
      let publishing = false;
      try {
        const recordText = await writeVerified(
          root,
          [...RECORDS, `${registrationId}.json`],
          record,
        );
        const destination = await root.getDirectory([directory], {
          create: true,
          exclusiveCreate: true,
        });
        let signature: string | undefined;
        if (source) {
          const current = await openWorkspace(source);
          if (
            current.identity.workspaceId !== workspaceId ||
            current.projects.some((p) => p.status !== "ready" || (p.project && (componentWriteBlock(p.project.vaultState) || referenceWriteBlock(p.project.vaultState))))
          )
            throw new Error(
              "Existing workspace has damaged, duplicate, or incomplete projects. Inspect the original before bringing it into Cadtree.",
            );
          for (const p of current.projects)
            for (const rev of p.project!.vaultState.revisions) {
              options.onProgress?.({
                phase: "verifying_objects",
                processedFiles: 0,
                totalFiles: rev.manifest.files.length,
                processedBytes: 0,
                totalBytes: rev.manifest.files.reduce(
                  (sum, file) => sum + file.size,
                  0,
                ),
                message: `Checking saved content in ${p.name}…`,
              });
              const checked = await verifyRevisionObjects(
                p.project!.vaultDir,
                rev,
                options.signal,
              );
              if (checked.integrityStatus === "corrupted")
                throw new Error(
                  "Existing workspace contains damaged historical content.",
                );
            }
          for (const p of current.projects) await verifyReferenceLibraryContent(p.project!.vaultDir, p.project!.vaultState, options.signal);
          signature = inventorySignature(
            await copyVerifiedTree(source, destination, options),
          );
        } else await createWorkspace(destination, name.trim(), workspaceId);
        const verified = await resolveHomeWorkspace(
          root,
          first.homeId,
          workspaceId,
          directory,
        );
        if (verified.projects.some((p) => p.status !== "ready" || (p.project && referenceWriteBlock(p.project.vaultState))))
          throw new Error(
            "Copied workspace needs attention and was not published.",
          );
        if (
          source &&
          (inventorySignature(await readVerifiedInventory(source, options)) !==
            signature ||
            inventorySignature(
              await readVerifiedInventory(destination, options),
            ) !== signature)
        )
          throw new Error(
            "Source or managed workspace changed before publication.",
          );
        options.onProgress?.({
          phase: "publishing_completion",
          processedFiles: 0,
          totalFiles: 0,
          processedBytes: 0,
          totalBytes: 0,
          message: "Finishing the workspace…",
        });
        throwIfCancelled(options.signal);
        publishing = true;
        await writeVerified(
          root,
          [...RECORDS, `${registrationId}.ready.json`],
          seal({
            schemaVersion: 1,
            registrationId,
            recordSha256: hashString(recordText),
          }),
        );
        return { workspace: verified, directory, pathBudget };
      } catch (error) {
        throw new WorkspaceOperationError(
          error instanceof Error ? error.message : String(error),
          directory,
          publishing,
        );
      }
    };
    if (!source) return run();
    // Same-origin mutation lock order: home → source workspace → project IDs in sorted order.
    return withProjectWriterLock(`workspace:${workspaceId}`, async () => {
      const locked = await openWorkspace(source);
      const ids = [
        ...new Set(
          locked.projects.flatMap((p) => (p.projectId ? [p.projectId] : [])),
        ),
      ].sort();
      const lockNext = (index: number): ReturnType<typeof run> =>
        index === ids.length
          ? run()
          : withProjectWriterLock(ids[index], () => lockNext(index + 1));
      return lockNext(0);
    });
  });
}
export const createHomeWorkspace = (
  root: FileSystemDirectoryAdapter,
  name: string,
  options: HomeOperationOptions = {},
) => register(root, name, undefined, options);
export async function bringWorkspaceIntoHome(
  root: FileSystemDirectoryAdapter,
  source: FileSystemDirectoryAdapter,
  options: HomeOperationOptions = {},
) {
  const workspace = await openWorkspace(source);
  return register(root, workspace.identity.name, source, options);
}
