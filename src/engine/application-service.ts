import type { FileSystemDirectoryAdapter } from "./fs-adapter";
import {
  FileConflictError,
  splitAndValidatePath,
  validateDirectoryIsolation,
} from "./fs-adapter";
import {
  prepareApplyPreview,
  buildApplyPreview,
  buildReplacePlan,
  isReplaceMode,
  replaceKeepsCopy,
  replacePlanHash,
  ReplacePlanChangedError,
  type ApplyPreviewPlan,
  type ReplaceMode,
  type ReplacePlan,
} from "./apply-preview";
import {
  appendApplicationEvent,
  applicationPath,
  applicationPlanPath,
  applicationStagedPath,
  applicationUnexpectedFolder,
  applicationUnexpectedPath,
  branchApplications,
  changedActions,
  foldersToCreate,
  foldersToRemove,
  isFinishedOperation,
  sealApplication,
  type ApplicationOperation,
  type ApplicationRecord,
  type ApplicationReview,
} from "./application-records";
import {
  validateWorkingFolderBindings,
  type WorkingFolderBindings,
} from "./branch-state";
import { getObjectPathSegments, verifyStoredObject } from "./object-store";
import { hashStream, hashString } from "./hash";
import {
  assertHoldsProjectWriterLock,
  withProjectWriterLock,
  type ProjectWriterLock,
} from "./locks";
import { eventIdBase, eventIdCandidate } from "./ids";
import {
  isSystemClutterName,
  partitionSystemFiles,
  scanBranchChanges,
} from "./scanner";
import {
  inventorySignature,
  readVerifiedInventory,
  throwIfCancelled,
  type CopyOptions,
} from "./copy-service";
import { formatRevisionNumber, openExistingVault } from "./vault-service";
import {
  captureUnderLock,
  type CaptureRevisionResult,
} from "./revision-service";
import { assertCaseWritable } from "./case-lifecycle";
import type {
  CaptureRevisionInput,
  FileEntry,
  RevisionManifest,
  RevisionNotes,
  ScanResult,
  VaultState,
} from "./types";
import { getBranchBaseline } from "./branch-state";
import {
  DISCARDED_FOLDER,
  DISCARDED_MAX_COUNTER,
  DISCARDED_NOTE_FALLBACK,
  DISCARDED_NOTE_FILENAME,
  discardedFolderBase,
  discardedFolderPath,
} from "./discarded-paths";
import { clashKey, withCounter } from "./folder-names";
import { PathTooLongError } from "./path-limits";

export interface ApplicationOptions extends CopyOptions {
  /** Clock for new event IDs; defaults to the current time. Tests inject a fixed one. */
  now?: () => Date;
  workingFolders: WorkingFolderBindings;
  resolveWorkingFolders?: (state: VaultState) => Promise<WorkingFolderBindings>;
}
/** Called only from an explicit Confirm/Recover user gesture. Engine execution
 * only checks permissions; it never silently elevates a remembered connection. */
export async function requestApplicationWriteAccess(
  vault: FileSystemDirectoryAdapter,
  working: FileSystemDirectoryAdapter | null,
) {
  if (!working)
    throw new Error(
      "Reconnect the destination working folder first.",
    );
  for (const folder of [working, vault]) {
    if ((await folder.queryPermission("readwrite")) === "granted") continue;
    try {
      if ((await folder.requestPermission("readwrite")) !== "granted")
        throw new Error("Permission was not granted.");
    } catch (error) {
      throw new Error(
        `Read/write access to "${folder.name}" is required. Try again to renew permission, or reconnect the folder. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
export function applicationReview(
  plan: ApplyPreviewPlan,
  choices: ApplicationReview["choices"],
): ApplicationReview {
  return {
    mode: plan.mode,
    projectId: plan.projectId,
    sourceRevisionId: plan.sourceRevisionId,
    destinationBranchId: plan.destinationBranchId,
    expectedPlanHash: hashString(JSON.stringify(plan)),
    choices: structuredClone(choices),
    reason: plan.reason,
  };
}
function recompute(state: VaultState, review: ApplicationReview) {
  assertCaseWritable(state,review.destinationBranchId);
  if (state.project.projectId !== review.projectId)
    throw new Error("Project identity changed. Refresh and review again.");
  const preparation = prepareApplyPreview(
    state,
    review.sourceRevisionId,
    review.destinationBranchId,
    review.mode ?? "merge",
  );
  if (preparation.status !== "available") throw new Error(preparation.reason);
  const plan = buildApplyPreview(
    preparation.context,
    review.choices,
    review.reason,
  );
  if (!plan.ready) throw new Error(plan.blockers.join(" "));
  if (hashString(JSON.stringify(plan)) !== review.expectedPlanHash)
    throw new Error(
      "The baseline or reviewed evidence changed. Refresh and review the plan again; no working files were changed.",
    );
  return { plan, context: preparation.context };
}
async function connections(
  vault: FileSystemDirectoryAdapter,
  state: VaultState,
  branchId: string,
  options: ApplicationOptions,
) {
  const bindings = options.resolveWorkingFolders
    ? await options.resolveWorkingFolders(state)
    : options.workingFolders;
  await validateWorkingFolderBindings(state, vault, bindings);
  const working = bindings[branchId];
  if (!working) throw new Error("Reconnect the destination working folder.");
  if (
    (await working.queryPermission("readwrite")) !== "granted" ||
    (await vault.queryPermission("readwrite")) !== "granted"
  )
    throw new Error(
      "Read/write permission is required for the destination and vault. Reconnect explicitly.",
    );
  return working;
}
function noUnfinished(state: VaultState, branchId: string) {
  if (
    branchApplications(state, branchId).some((op) => !isFinishedOperation(op))
  )
    throw new Error(
      "This destination has an unfinished application (an earlier Bring back or Copy). Undo it if it was interrupted, or choose Save now or Don't save it, before another Bring back or Copy.",
    );
}
async function cleanDestination(
  working: FileSystemDirectoryAdapter,
  state: VaultState,
  review: ApplicationReview,
  options: CopyOptions,
) {
  const { context, plan } = recompute(state, review);
  const scan = await scanBranchChanges(
    working,
    review.destinationBranchId,
    context.destination.manifest,
    {
      signal: options.signal,
      onProgress: (path, count, bytes) =>
        options.onProgress?.({
          phase: "scanning_source",
          currentFile: path,
          processedFiles: count,
          totalFiles: count,
          processedBytes: bytes,
          totalBytes: bytes,
          message: `Checking destination: ${path}…`,
        }),
    },
  );
  if (scan.errors.length)
    throw new Error(
      `Destination scan unavailable: ${scan.errors.map((e) => `${e.path}: ${e.error}`).join("; ")}`,
    );
  const blocked = plan.actions
    .filter((a) => a.operation !== "keep")
    .filter((a) =>
    scan.skippedSystemFiles?.includes(a.path),
  );
  if (blocked.length)
    throw new Error(
      `An untracked system file ${blocked.map((a) => a.path).join(", ")} exists at this path in the destination; remove it or save it first. No working files were changed.`,
    );
  if (scan.hasChanges)
    throw new Error(
      "Destination has uncaptured file or directory changes. Save a revision first, then refresh and review the plan. No edits were discarded or captured automatically.",
    );
  await assertFolderRemovalsReady(working, plan, context.destination.manifest.files);
}
/**
 * Before any write: every folder this application removes must end up empty. What
 * remains after this apply's own deletions must not be user data (a destination
 * change) and must not be untracked OS clutter either: cAdtree never deletes user
 * files, clutter included, so the user is asked to delete it or untick the folder.
 */
async function assertFolderRemovalsReady(
  working: FileSystemDirectoryAdapter,
  plan: ApplyPreviewPlan,
  destinationFiles: FileEntry[],
) {
  const removals = plan.folderActions
    .filter((action) => action.operation === "remove")
    .map((action) => action.path)
    .sort((a, b) => a.localeCompare(b));
  if (!removals.length) return;
  const removed = new Set(removals);
  const deleted = new Set(
    plan.actions
      .filter((action) => action.operation === "delete")
      .map((action) => action.path),
  );
  const tracked = new Set(destinationFiles.map((file) => file.path));
  const other: string[] = [];
  const clutter = new Map<string, string[]>();
  for (const path of removals) {
    let entries;
    try {
      entries = await (
        await working.getDirectory(splitAndValidatePath(path))
      ).listEntries();
    } catch {
      other.push(path);
      continue;
    }
    const names = new Set(entries.map((entry) => entry.name));
    for (const entry of entries) {
      const child = `${path}/${entry.name}`;
      if (entry.kind === "directory") {
        if (!removed.has(child)) other.push(child);
      } else if (!deleted.has(child)) {
        const isClutter =
          !tracked.has(child) &&
          entry.kind === "file" &&
          (isSystemClutterName(entry.name) ||
            (entry.name.startsWith("._") &&
              entry.name.length > 2 &&
              names.has(entry.name.slice(2))));
        if (isClutter) clutter.set(path, [...(clutter.get(path) ?? []), entry.name]);
        else other.push(child);
      }
    }
  }
  if (other.length)
    throw new Error(
      `Destination changed: ${other.join(", ")} would remain inside a folder this application removes. Save a revision first, then refresh and review the plan. No working files were changed.`,
    );
  for (const [path, names] of clutter)
    throw new Error(
      `Folder "${path}" holds only system files (${names.join(", ")}). Delete them, or untick the folder, then try again. No working files were changed.`,
    );
}
/** Absence is established by readable directory entries, never by hasFile (which
 * deliberately hides errors in some adapters). Reject case aliases and directory paths. */
async function currentFile(
  root: FileSystemDirectoryAdapter,
  path: string,
  signal?: AbortSignal,
): Promise<FileEntry | null> {
  const segments = splitAndValidatePath(path);
  let dir = root;
  for (const [index, name] of segments.entries()) {
    const matches = (await dir.listEntries()).filter(
      (e) => e.name.toLowerCase() === name.toLowerCase(),
    );
    if (!matches.length) return null;
    if (matches.length !== 1 || matches[0].name !== name)
      throw new Error(`Case collision at ${path}. Manual inspection required.`);
    if (index < segments.length - 1) {
      if (matches[0].kind !== "directory")
        throw new Error(`File/directory collision at ${path}.`);
      dir = await dir.getDirectory([name]);
    } else {
      if (matches[0].kind !== "file")
        throw new Error(`File/directory collision at ${path}.`);
      const stat = await dir.statFile([name]);
      const actual = await hashStream(await dir.readFileStream([name]), {
        signal,
      });
      if (stat.size !== actual.size) throw new Error(`Unstable file: ${path}`);
      return {
        path,
        size: actual.size,
        sha256: actual.sha256,
        lastModified: stat.lastModified,
      };
    }
  }
  return null;
}
const same = (a: FileEntry | null, b: FileEntry | null) =>
  a && b ? a.sha256 === b.sha256 && a.size === b.size : a === b;
/** "directory" / "missing" / "other" (a file, or a parent that is not a folder).
 * Established from exact directory entries; case aliases are a collision. */
async function folderState(
  root: FileSystemDirectoryAdapter,
  path: string,
): Promise<"directory" | "missing" | "other"> {
  const segments = splitAndValidatePath(path);
  let dir = root;
  for (const [index, name] of segments.entries()) {
    const matches = (await dir.listEntries()).filter(
      (e) => e.name.toLowerCase() === name.toLowerCase(),
    );
    if (!matches.length) return "missing";
    if (matches.length !== 1 || matches[0].name !== name)
      throw new Error(`Case collision at ${path}. Manual inspection required.`);
    if (matches[0].kind !== "directory") return "other";
    if (index < segments.length - 1) dir = await dir.getDirectory([name]);
  }
  return "directory";
}
const folderDepth = (path: string) => path.split("/").length;
function stagedPath(
  op: ApplicationOperation,
  side: "before" | "source",
  index: number,
) {
  return applicationStagedPath(
    op.destinationBranchId,
    op.operationId,
    side,
    index,
  );
}
async function verifiedFile(
  dir: FileSystemDirectoryAdapter,
  path: string[],
  expected: FileEntry,
  signal?: AbortSignal,
) {
  const result = await hashStream(await dir.readFileStream(path), { signal });
  if (result.sha256 !== expected.sha256 || result.size !== expected.size)
    throw new Error(
      `Staged/recovered file verification failed for ${expected.path}.`,
    );
}
async function stageFile(
  vault: FileSystemDirectoryAdapter,
  path: string[],
  source: FileSystemDirectoryAdapter,
  sourcePath: string[],
  expected: FileEntry,
  signal?: AbortSignal,
) {
  const result = await vault.writeFileStream(
    path,
    await source.readFileStream(sourcePath),
    { signal, exclusive: true },
  );
  if (result.bytesWritten !== expected.size)
    throw new Error(`Incomplete staged copy: ${expected.path}`);
  await verifiedFile(vault, path, expected, signal);
}
function progress(
  options: CopyOptions,
  phase: "restoring_files" | "verifying_restored_files",
  path: string,
  count: number,
  total: number,
  bytes: number,
) {
  options.onProgress?.({
    phase,
    currentFile: path,
    processedFiles: count,
    totalFiles: total,
    processedBytes: bytes,
    totalBytes: bytes,
    message: `${phase === "restoring_files" ? "Applying" : "Verifying"} ${path}…`,
  });
}
const MAX_EVENT_ATTEMPTS = 999;
/**
 * Creates a new folder named by a fresh event ID (YYYYMMDD-HHMMSS, then -2, -3, ...) with
 * exclusiveCreate. Only an "already exists" clash moves to the next candidate; any other
 * error is rethrown unchanged. Nothing existing is ever reused or overwritten.
 */
export async function createEventFolder(
  vault: FileSystemDirectoryAdapter,
  now: (() => Date) | undefined,
  folderFor: (eventId: string) => string[],
  what: string,
): Promise<string> {
  const base = eventIdBase(now ? now() : new Date());
  for (let attempt = 1; attempt <= MAX_EVENT_ATTEMPTS; attempt++) {
    const candidate = eventIdCandidate(base, attempt);
    try {
      await vault.getDirectory(folderFor(candidate), {
        create: true,
        exclusiveCreate: true,
      });
      return candidate;
    } catch (error) {
      if (!(error instanceof FileConflictError)) throw error;
    }
  }
  throw new Error(
    `No free ${what} ID for ${base}: all ${MAX_EVENT_ATTEMPTS} candidates are taken. Nothing was written.`,
  );
}
/**
 * First durable step of every operation (Apply and replace): a fresh event-ID
 * folder (never reused) and its sealed `plan.json`, read back. A durable plan
 * precedes staging; a durable attempt precedes each write, so any uncertain
 * outcome remains discoverable.
 */
async function startOperation(
  vault: FileSystemDirectoryAdapter,
  options: Pick<ApplicationOptions, "now">,
  body: Pick<ApplicationRecord, "sourceBranchId" | "review" | "plan">,
): Promise<ApplicationOperation> {
  const branchId = body.plan.destinationBranchId;
  const operationId = await createEventFolder(
    vault,
    options.now,
    (id) => applicationPath(branchId, id),
    "application",
  );
  const record: ApplicationRecord = sealApplication({
    schemaVersion: 1 as const,
    kind: "cadtree-file-application" as const,
    operationId,
    createdAt: new Date().toISOString(),
    sourceBranchId: body.sourceBranchId,
    review: body.review,
    plan: body.plan,
  });
  const text = JSON.stringify(record, null, 2);
  const planPath = applicationPlanPath(branchId, operationId);
  await vault.writeFileText(planPath, text, {
    exclusive: true,
  });
  if ((await vault.readFileText(planPath)) !== text)
    throw new Error(
      "Application plan readback failed. Reopen and inspect retained operation storage.",
    );
  return {
    operationId,
    destinationBranchId: branchId,
    relativePath: applicationPath(branchId, operationId).join("/"),
    status: "unresolved",
    record,
    events: [],
  };
}
/**
 * Verified copies in the vault of every changed path: the after-state from its
 * stored object (`source/`), the current bytes (`before/`) after checking they
 * still match the plan. Ends with the `staged` event. No working-folder write.
 */
async function stageOperation(
  vault: FileSystemDirectoryAdapter,
  working: FileSystemDirectoryAdapter,
  op: ApplicationOperation,
  options: ApplicationOptions,
) {
  const record = op.record!;
    const actions = changedActions(record);
    for (const [index, action] of actions.entries()) {
      throwIfCancelled(options.signal);
      progress(
        options,
        "verifying_restored_files",
        action.path,
        index,
        actions.length,
        0,
      );
      if (action.after) {
        const verification = await verifyStoredObject(
          vault,
          action.after.sha256,
          action.after.size,
          options.signal,
        );
        if (!verification.valid)
          throw new Error(
            `Source object unavailable for ${action.path}: ${verification.reason}. Application is unfinished; recover its retained operation before retrying.`,
          );
        await stageFile(
          vault,
          stagedPath(op, "source", index),
          vault,
          getObjectPathSegments(action.after.sha256),
          action.after,
          options.signal,
        );
      }
      if (
        !same(
          await currentFile(working, action.path, options.signal),
          action.before,
        )
      )
        throw new Error(
          `Destination changed before staging ${action.path}. Reopen and recover the unfinished operation.`,
        );
      if (action.before)
        await stageFile(
          vault,
          stagedPath(op, "before", index),
          working,
          splitAndValidatePath(action.path),
          action.before,
          options.signal,
        );
    }
    await appendApplicationEvent(vault, op, { kind: "staged" });
}
/**
 * The working-folder writes of an operation, after staging: folders created,
 * files written or removed (each with an attempt event, a check that the bytes
 * still match `before`, a verified result and a written event), then folders
 * removed. Stops at the first difference; recovery undoes what was written.
 */
async function writeOperation(
  vault: FileSystemDirectoryAdapter,
  working: FileSystemDirectoryAdapter,
  op: ApplicationOperation,
  options: ApplicationOptions,
) {
  const record = op.record!;
  const actions = changedActions(record);
    // Folders first (shallowest first), so files can land in them; removals come
    // after the file writes, deepest first, and only for folders that are empty.
    for (const folder of foldersToCreate(record)) {
      throwIfCancelled(options.signal);
      await appendApplicationEvent(vault, op, {
        kind: "attempt",
        path: folder.path,
      });
      try {
        await working.getDirectory(splitAndValidatePath(folder.path), {
          create: true,
          exclusiveCreate: true,
        });
      } catch (error) {
        if (error instanceof FileConflictError)
          throw new Error(
            `Destination changed at ${folder.path}; application stopped. Reopen to recover; unexpected edits will be preserved.`,
          );
        throw error;
      }
      if ((await folderState(working, folder.path)) !== "directory")
        throw new Error(
          `Applied result verification failed at ${folder.path}; recover the unfinished application.`,
        );
      await appendApplicationEvent(vault, op, {
        kind: "written",
        path: folder.path,
      });
    }
    let bytes = 0;
    for (const [index, action] of actions.entries()) {
      throwIfCancelled(options.signal);
      progress(
        options,
        "restoring_files",
        action.path,
        index,
        actions.length,
        bytes,
      );
      await appendApplicationEvent(vault, op, {
        kind: "attempt",
        path: action.path,
      });
      if (
        !same(
          await currentFile(working, action.path, options.signal),
          action.before,
        )
      )
        throw new Error(
          `Destination changed at ${action.path}; application stopped. Reopen to recover; unexpected edits will be preserved.`,
        );
      throwIfCancelled(options.signal);
      if (action.after) {
        await verifiedFile(
          vault,
          stagedPath(op, "source", index),
          action.after,
          options.signal,
        );
        await working.writeFileStream(
          splitAndValidatePath(action.path),
          await vault.readFileStream(stagedPath(op, "source", index)),
          { signal: options.signal, exclusive: action.before === null },
        );
      } else await working.removeEntry(splitAndValidatePath(action.path));
      if (
        !same(
          await currentFile(working, action.path, options.signal),
          action.after,
        )
      )
        throw new Error(
          `Applied result verification failed at ${action.path}; recover the unfinished application.`,
        );
      bytes += action.after?.size ?? 0;
      await appendApplicationEvent(vault, op, {
        kind: "written",
        path: action.path,
      });
    }
    for (const folder of foldersToRemove(record)) {
      throwIfCancelled(options.signal);
      await appendApplicationEvent(vault, op, {
        kind: "attempt",
        path: folder.path,
      });
      const segments = splitAndValidatePath(folder.path);
      if ((await folderState(working, folder.path)) !== "directory")
        throw new Error(
          `Destination changed at ${folder.path}; application stopped. Reopen to recover; unexpected edits will be preserved.`,
        );
      if ((await (await working.getDirectory(segments)).listEntries()).length)
        throw new Error(
          `Folder ${folder.path} is no longer empty; application stopped. Nothing inside it was deleted. Reopen to recover.`,
        );
      await working.removeEntry(segments);
      if ((await folderState(working, folder.path)) !== "missing")
        throw new Error(
          `Applied result verification failed at ${folder.path}; recover the unfinished application.`,
        );
      await appendApplicationEvent(vault, op, {
        kind: "written",
        path: folder.path,
      });
    }
}
/**
 * The apply steps of `applyAndSave`, for a caller that already holds the project
 * writer lock (`lock`). Checks, then writes (plan, staged copies, attempt/written
 * events, folder and file changes, full inventory check, `applied` last). Exported
 * so tests can stop at the `applied` state without saving.
 */
export async function applyUnderLock(
  vault: FileSystemDirectoryAdapter,
  review: ApplicationReview,
  options: ApplicationOptions,
  lock: ProjectWriterLock,
): Promise<{
  op: ApplicationOperation;
  plan: ApplyPreviewPlan;
  working: FileSystemDirectoryAdapter;
  state: VaultState;
}> {
  assertHoldsProjectWriterLock(lock, review.projectId);
  {
    throwIfCancelled(options.signal);
    const state = await openExistingVault(vault);
    const { plan, context } = recompute(state, review);
    noUnfinished(state, review.destinationBranchId);
    const working = await connections(
      vault,
      state,
      review.destinationBranchId,
      options,
    );
    await validateDirectoryIsolation(working, vault, "Working folder", "Revision vault");
    await cleanDestination(working, state, review, options);
    const op = await startOperation(vault, options, {
      sourceBranchId: context.source.manifest.branchId,
      review: structuredClone(review),
      plan: {
        mode: plan.mode,
        projectId: plan.projectId,
        sourceRevisionId: plan.sourceRevisionId,
        destinationRevisionId: plan.destinationRevisionId,
        baseRevisionId: plan.baseRevisionId,
        destinationBranchId: plan.destinationBranchId,
        reason: plan.reason,
        actions: structuredClone(plan.actions),
        folderActions: structuredClone(plan.folderActions),
      },
    });
    await stageOperation(vault, working, op, options);
    // Detect edits anywhere in the destination during staging, including new empty folders.
    const reloaded = await openExistingVault(vault);
    recompute(reloaded, review);
    const reconnected = await connections(
      vault,
      reloaded,
      review.destinationBranchId,
      options,
    );
    if (!(await reconnected.isSameEntry(working)))
      throw new Error(
        "Destination mapping changed during staging. Recover the retained operation before retrying.",
      );
    await cleanDestination(working, reloaded, review, options);
    await writeOperation(vault, working, op, options);
    const rawResult = await readVerifiedInventory(working, options);
    const result = {
      ...rawResult,
      files: partitionSystemFiles(
        rawResult.files,
        new Set(plan.resultFiles.map((f) => f.path)),
      ).files,
    };
    if (
      inventorySignature(result) !==
      inventorySignature({
        ...result,
        files: plan.resultFiles,
        directories: plan.resultDirectories,
      })
    )
      throw new Error(
        "Destination changed during application. Do not capture the partial result; inspect/recover this application.",
      );
    throwIfCancelled(options.signal);
    await appendApplicationEvent(vault, op, { kind: "applied" });
    op.status = "applied";
    return { op, plan, working, state };
  }
}
export interface ApplyAndSaveOptions extends ApplicationOptions {
  /** Test seam passed to the save: supplies each candidate revision record ID. */
  newRevisionId?: CaptureRevisionInput["newRevisionId"];
}
/**
 * `applyAndSave` either saved the result, or wrote it and then could not save it.
 * Anything that fails before the `applied` event is thrown (nothing written, or
 * an `unresolved` operation that the existing recovery undoes).
 */
export type ApplyAndSaveResult =
  | ({
      status: "saved";
      operation: ApplicationOperation;
      summary: string;
    } & CaptureRevisionResult)
  | {
      /** The working files hold the verified result; the operation stays
       * `applied`. A normal save (summary/notes below as a prefill) links its
       * provenance once, as after a manual Apply. */
      status: "not-saved";
      operation: ApplicationOperation;
      summary: string;
      notes: RevisionNotes;
      reason: string;
      error: unknown;
    };
/** "Brought back Rev 003" or "Copied 2 files from <case>". */
export function applySaveSummary(
  state: VaultState,
  record: ApplicationRecord,
): string {
  if ((record.plan.mode ?? "merge") === "revert") {
    const source = state.revisions.find(
      (r) => r.manifest.revisionId === record.plan.sourceRevisionId,
    );
    return source
      ? `Brought back ${formatRevisionNumber(source.manifest.displayNumber)}`
      : "Brought back an earlier revision";
  }
  const name =
    state.branches.find((b) => b.branchId === record.sourceBranchId)?.name ??
    "a design case";
  const files = changedActions(record).length;
  if (!files) {
    const folders = record.plan.folderActions.length;
    return `Copied ${folders} folder change${folders === 1 ? "" : "s"} from ${name}`;
  }
  return `Copied ${files} file${files === 1 ? "" : "s"} from ${name}`;
}
/**
 * Bring back (revert) or Copy files from a case (merge), then save the result as
 * a revision, all under ONE project writer lock (the lock cannot be taken twice:
 * see `captureUnderLock`). The apply steps are `applyUnderLock`'s;
 * the save is a normal capture whose fresh scan must equal the plan's result
 * (`expectedSnapshot`), so an edit made meanwhile is never swept in. Provenance is
 * linked by capture exactly as for a manual save after Apply (`captured` status,
 * identity transfers, the graph's copy links). The optional reason becomes the
 * revision's Why (`notes.problem`).
 */
export async function applyAndSave(
  vault: FileSystemDirectoryAdapter,
  review: ApplicationReview,
  options: ApplyAndSaveOptions,
): Promise<ApplyAndSaveResult> {
  return withProjectWriterLock(review.projectId, async (lock) => {
    const { op, plan, working, state } = await applyUnderLock(
      vault,
      review,
      options,
      lock,
    );
    const summary = applySaveSummary(state, op.record!);
    const notes: RevisionNotes = {
      problem: (review.reason ?? "").trim(),
      modification: "",
      observations: "",
    };
    try {
      const saved = await captureUnderLock(
        working,
        vault,
        {
          branchId: review.destinationBranchId,
          summary,
          notes,
          expectedSnapshot: {
            files: plan.resultFiles.map(({ path, sha256, size }) => ({
              path,
              sha256,
              size,
            })),
            directories: [...plan.resultDirectories],
          },
          workingFolders: options.workingFolders,
          resolveWorkingFolders: options.resolveWorkingFolders,
          newRevisionId: options.newRevisionId,
          signal: options.signal,
          onProgress: options.onProgress,
        },
        review.projectId,
        lock,
      );
      const linked = branchApplications(
        saved.vaultState,
        review.destinationBranchId,
      ).find((o) => o.operationId === op.operationId);
      return { status: "saved", operation: linked ?? op, summary, ...saved };
    } catch (error) {
      // The write succeeded; only the save did not. If the save did publish
      // before failing (e.g. a lost acknowledgement), report it as saved.
      try {
        const reloaded = await openExistingVault(vault);
        const current = branchApplications(
          reloaded,
          review.destinationBranchId,
        ).find((o) => o.operationId === op.operationId);
        const revision =
          current?.status === "captured"
            ? reloaded.revisions.find(
                (r) => r.manifest.revisionId === current.capturedRevisionId,
              )
            : undefined;
        if (current && revision)
          return {
            status: "saved",
            operation: current,
            summary,
            revision,
            vaultState: reloaded,
            cacheWarning: `The revision was published, but its last step reported: ${error instanceof Error ? error.message : String(error)}`,
          };
        if (current) op.status = current.status;
      } catch {
        // Keep the in-memory `applied` operation; the vault is re-read later.
      }
      return {
        status: "not-saved",
        operation: op,
        summary,
        notes,
        reason: error instanceof Error ? error.message : String(error),
        error,
      };
    }
  });
}
/**
 * The scan a replace plan (Discard) is built from: every file hashed (never the
 * display cache) and untracked OS clutter kept, so clutter inside a folder being
 * removed is moved with it. Use it for the plan a confirmation shows, so its hash
 * matches the one rebuilt under the lock.
 */
export function scanForReplace(
  working: FileSystemDirectoryAdapter,
  branchId: string,
  baseline: RevisionManifest | null,
  options: CopyOptions = {},
): Promise<ScanResult> {
  return scanBranchChanges(working, branchId, baseline, {
    signal: options.signal,
    keepSystemFiles: true,
    onProgress: (path, count, bytes) =>
      options.onProgress?.({
        phase: "scanning_source",
        currentFile: path,
        processedFiles: count,
        totalFiles: count,
        processedBytes: bytes,
        totalBytes: bytes,
        message: `Checking working files: ${path}…`,
      }),
  });
}
export interface ReplaceWorkingFilesRequest extends ApplicationOptions {
  mode: ReplaceMode;
  projectId: string;
  branchId: string;
  /** Discard: the branch's latest saved revision. Get this version: the revision to take the file from. */
  targetRevisionId: string;
  /** The selected files and folders, as given to `buildReplacePlan`. */
  paths: readonly string[];
  /** `replacePlanHash` of the plan the user confirmed. */
  expectedPlanHash: string;
}
export interface ReplaceWorkingFilesResult {
  operation: ApplicationOperation;
  plan: ReplacePlan;
  /** Project-relative folder of the readable copy (`Discarded/<name>`), or null when nothing needed keeping. */
  keptAs: string | null;
  /** Paths whose readable copy could not be written (path too long); their copy stays in the vault. */
  keptInsideOnly: string[];
}
/**
 * Discard and Get this version ("restore-file": one file from an older
 * revision): makes the selected working paths match a
 * saved revision without saving, keeping a copy of what it replaces. Under the
 * project lock: a fresh full-hash scan, the plan rebuilt and compared with the
 * confirmed hash ("Changes differ from what you saw; review again"), then the
 * Apply write path: plan record, staged after/before copies (`staged`), the
 * readable copy in Discarded/ (`kept`), per-path attempt / check / write /
 * verify / written, folder changes, and `applied`, which for these modes is
 * terminal (`done`). Only the selected paths are checked and written; other
 * unsaved files are neither touched nor blocking. Anything that stops before
 * the first working-folder write changes nothing there; an interrupted write is
 * undone by `recoverApplication` from the staged copies.
 */
export async function replaceWorkingFiles(
  vault: FileSystemDirectoryAdapter,
  projectFolder: FileSystemDirectoryAdapter,
  request: ReplaceWorkingFilesRequest,
): Promise<ReplaceWorkingFilesResult> {
  return withProjectWriterLock(request.projectId, async (lock) => {
    assertHoldsProjectWriterLock(lock, request.projectId);
    throwIfCancelled(request.signal);
    const state = await openExistingVault(vault);
    if (state.project.projectId !== request.projectId)
      throw new Error("Project identity changed. Refresh and review again.");
    assertCaseWritable(state, request.branchId);
    noUnfinished(state, request.branchId);
    const working = await connections(vault, state, request.branchId, request);
    await validateDirectoryIsolation(working, vault, "Working folder", "Revision vault");
    const vaultPlace = await projectFolder.resolveRelativePath(vault);
    if (vaultPlace?.length !== 1 || vaultPlace[0] !== "vault")
      throw new Error(
        "The project folder does not hold this vault. Reopen the project. Nothing was changed.",
      );
    if ((await projectFolder.queryPermission("readwrite")) !== "granted")
      throw new Error(
        "Read/write permission is required for the project folder. Reconnect explicitly.",
      );
    const scan = await scanForReplace(
      working,
      request.branchId,
      getBranchBaseline(state, request.branchId),
      request,
    );
    const plan = buildReplacePlan(
      state,
      scan,
      request.targetRevisionId,
      request.paths,
      request.mode,
    );
    if (replacePlanHash(plan) !== request.expectedPlanHash)
      throw new ReplacePlanChangedError();
    if (!plan.ready)
      throw new Error(`${plan.blockers.join(" ")} Nothing was changed.`);
    // Refuse before any record is written; checked again just before the first
    // working-folder write, for anything that appears while copies are kept.
    await assertReplaceRemovalsReady(working, plan);
    if (replaceKeepsCopy(plan)) {
      const at = request.now ? request.now() : new Date();
      if (!(await freeDiscardedName(projectFolder, at))) throw tooManyDiscards(at);
    }
    const choices = Object.fromEntries(
      [...plan.actions, ...plan.folderActions].map((action) => [
        action.path,
        { selected: true, decision: "use-source" as const },
      ]),
    );
    const op = await startOperation(vault, request, {
      sourceBranchId: request.branchId,
      review: {
        mode: plan.mode,
        projectId: plan.projectId,
        sourceRevisionId: plan.sourceRevisionId,
        destinationBranchId: plan.destinationBranchId,
        expectedPlanHash: request.expectedPlanHash,
        choices,
        reason: plan.reason,
      },
      plan: {
        mode: plan.mode,
        projectId: plan.projectId,
        sourceRevisionId: plan.sourceRevisionId,
        destinationRevisionId: plan.destinationRevisionId,
        baseRevisionId: plan.baseRevisionId,
        destinationBranchId: plan.destinationBranchId,
        reason: plan.reason,
        actions: structuredClone(plan.actions),
        folderActions: structuredClone(plan.folderActions),
        ...(plan.componentId ? { componentId: plan.componentId } : {}),
      },
    });
    await stageOperation(vault, working, op, request);
    const kept = await keepDiscardedCopy(projectFolder, vault, working, op, state, request);
    await appendApplicationEvent(vault, op, {
      kind: "kept",
      ...(kept.keptAs ? { keptAs: kept.keptAs } : {}),
    });
    await assertReplaceRemovalsReady(working, op.record!.plan);
    await writeOperation(vault, working, op, request);
    throwIfCancelled(request.signal);
    await appendApplicationEvent(vault, op, { kind: "applied" });
    op.status = "done";
    return { operation: op, plan, ...kept };
  });
}
interface DiscardedEntry {
  path: string;
  kind: "edit" | "new file" | "deleted file" | "new folder" | "deleted folder";
  /** The readable copy is in the Discarded folder. */
  copied: boolean;
  /** Vault copy (project-relative) when the readable one could not be written. */
  insideOnly?: string;
  sha256?: string;
}
/** The opaque refusal Chrome gives for a too-long path when the address is unknown. */
const isOpaqueRefusal = (error: unknown) =>
  typeof DOMException !== "undefined" &&
  error instanceof DOMException &&
  (error.name === "InvalidStateError" || error.name === "NotFoundError");
/**
 * The readable copy of a discard, after staging and before any working-folder
 * write: `Discarded/<YYYY-MM-DD HH.MM local>` (counter on a clash, created with
 * exclusiveCreate), each replaced file written from its verified staged
 * before-copy (exclusive, then hash-verified), each removed folder recreated,
 * and `_DISCARDED cAdtree.txt` written last. A copy whose path is too long is
 * skipped and listed as kept inside cAdtree only (the vault's staged copy stays).
 * Nothing is kept when the discard replaces no bytes and removes no folder.
 */
async function keepDiscardedCopy(
  projectFolder: FileSystemDirectoryAdapter,
  vault: FileSystemDirectoryAdapter,
  working: FileSystemDirectoryAdapter,
  op: ApplicationOperation,
  state: VaultState,
  options: ApplicationOptions,
): Promise<{ keptAs: string | null; keptInsideOnly: string[] }> {
  const record = op.record!;
  const actions = changedActions(record);
  if (!replaceKeepsCopy(record.plan))
    return { keptAs: null, keptInsideOnly: [] };
  const at = options.now ? options.now() : new Date();
  const parent = await projectFolder.getDirectory([DISCARDED_FOLDER], {
    create: true,
  });
  const base = discardedFolderBase(at);
  // The folder-name allocator's rules (case-insensitive clash, counter), bounded
  // so the prefix stays within the path budget; exclusiveCreate is the backstop.
  const taken = new Set(
    (await parent.listEntries()).map((entry) => clashKey(entry.name)),
  );
  let name: string | undefined;
  for (let n = 1; n <= DISCARDED_MAX_COUNTER && !name; n++) {
    const candidate = withCounter(base, n);
    if (taken.has(clashKey(candidate))) continue;
    try {
      await parent.getDirectory([candidate], {
        create: true,
        exclusiveCreate: true,
      });
      name = candidate;
    } catch (error) {
      if (!(error instanceof FileConflictError)) throw error;
    }
  }
  if (!name) throw tooManyDiscards(at);
  const folder = await parent.getDirectory([name]);
  const entries: DiscardedEntry[] = [];
  for (const action of foldersToRemove(record).reverse()) {
    throwIfCancelled(options.signal);
    try {
      await folder.getDirectory(splitAndValidatePath(action.path), {
        create: true,
      });
      entries.push({ path: action.path, kind: "new folder", copied: true });
    } catch (error) {
      if (!(error instanceof PathTooLongError) && !isOpaqueRefusal(error)) throw error;
      entries.push({ path: action.path, kind: "new folder", copied: false });
    }
  }
  for (const action of foldersToCreate(record))
    entries.push({ path: action.path, kind: "deleted folder", copied: false });
  for (const [index, action] of actions.entries()) {
    throwIfCancelled(options.signal);
    if (!action.before) {
      entries.push({ path: action.path, kind: "deleted file", copied: false });
      continue;
    }
    const kind = action.after ? "edit" : "new file";
    const staged = stagedPath(op, "before", index);
    const segments = splitAndValidatePath(action.path);
    // Reading the vault copy is outside the path-failure handling: if it fails,
    // the discard stops before any working file changes.
    const source = await vault.readFileStream(staged);
    try {
      const result = await folder.writeFileStream(segments, source, {
        signal: options.signal,
        exclusive: true,
      });
      if (result.bytesWritten !== action.before.size)
        throw new Error(`Incomplete discarded copy: ${action.path}`);
      await verifiedFile(folder, segments, action.before, options.signal);
      entries.push({ path: action.path, kind, copied: true, sha256: action.before.sha256 });
    } catch (error) {
      if (!(error instanceof PathTooLongError)) {
        if (!isOpaqueRefusal(error)) throw error;
        // An opaque refusal counts as a path failure only while the vault copy
        // is intact (re-verified here); otherwise it stops the discard.
        await verifiedFile(vault, staged, action.before, options.signal);
      }
      await removePartialCopy(folder, segments);
      entries.push({
        path: action.path,
        kind,
        copied: false,
        insideOnly: ["vault", ...staged].join("/"),
        sha256: action.before.sha256,
      });
    }
  }
  const noteName = actions.some(
    (a) => a.before && a.path.toLowerCase() === DISCARDED_NOTE_FILENAME.toLowerCase(),
  )
    ? DISCARDED_NOTE_FALLBACK
    : DISCARDED_NOTE_FILENAME;
  const target = state.revisions.find(
    (r) => r.manifest.revisionId === record.plan.sourceRevisionId,
  );
  const text = discardedNoteText({
    at,
    projectName: state.project.name,
    caseName:
      state.branches.find((b) => b.branchId === record.plan.destinationBranchId)
        ?.name ?? record.plan.destinationBranchId,
    workingFolder: working.name,
    revision: target
      ? `${formatRevisionNumber(target.manifest.displayNumber)} (${target.manifest.revisionId})`
      : record.plan.sourceRevisionId,
    operation: ["vault", ...applicationPath(op.destinationBranchId, op.operationId)].join("/"),
    restore: record.plan.mode === "restore-file",
    entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
  });
  const notePath = [noteName];
  await folder.writeFileText(notePath, text, { exclusive: true });
  if ((await folder.readFileText(notePath)) !== text)
    throw new Error(
      "The note of the discarded copy did not read back. No working files were changed.",
    );
  return {
    keptAs: discardedFolderPath(name).join("/"),
    keptInsideOnly: entries.filter((e) => e.insideOnly).map((e) => e.path),
  };
}
/** Removes what a failed readable-copy write may have left (only that file, best effort). */
async function removePartialCopy(
  folder: FileSystemDirectoryAdapter,
  segments: string[],
) {
  try {
    const parent = await folder.getDirectory(segments.slice(0, -1));
    if (
      (await parent.listEntries()).some(
        (entry) => entry.kind === "file" && entry.name === segments.at(-1),
      )
    )
      await parent.removeEntry([segments.at(-1)!]);
  } catch {
    // Nothing was written there, or it cannot be removed: the note still says
    // the readable copy is missing and where the vault keeps it.
  }
}
/**
 * Read-only: the first free `Discarded/` name for `at` (counter up to
 * DISCARDED_MAX_COUNTER), or undefined when all are taken. Checked before an
 * operation starts; the exclusive create later is the backstop.
 */
async function freeDiscardedName(
  projectFolder: FileSystemDirectoryAdapter,
  at: Date,
): Promise<string | undefined> {
  const base = discardedFolderBase(at);
  const entry = (await projectFolder.listEntries()).find(
    (e) => e.name === DISCARDED_FOLDER,
  );
  const taken = new Set(
    entry?.kind === "directory"
      ? (
          await (await projectFolder.getDirectory([DISCARDED_FOLDER])).listEntries()
        ).map((e) => clashKey(e.name))
      : [],
  );
  for (let n = 1; n <= DISCARDED_MAX_COUNTER; n++) {
    const candidate = withCounter(base, n);
    if (!taken.has(clashKey(candidate))) return candidate;
  }
  return undefined;
}
const tooManyDiscards = (at: Date) =>
  new Error(
    `Too many discards in the same minute (${discardedFolderBase(at)}). Wait a minute and try again. No working files were changed.`,
  );
/** Text of `_DISCARDED cAdtree.txt`. Pure. */
export function discardedNoteText(input: {
  at: Date;
  projectName: string;
  caseName: string;
  workingFolder: string;
  revision: string;
  operation: string;
  /** Get this version: the file was replaced by an older version, not discarded. */
  restore?: boolean;
  entries: DiscardedEntry[];
}): string {
  const lines: string[] = [
    input.restore ? "cAdtree: file replaced by Get this version" : "cAdtree: discarded changes",
    "",
    input.restore
      ? "This folder keeps a copy of the working file that Get this version replaced in cAdtree."
      : "This folder keeps copies of unsaved changes that were discarded in cAdtree.",
    "cAdtree never deletes it. Delete it yourself when you no longer need it.",
    "The copies were made just before the working files were replaced. If that step was",
    "interrupted and then undone in cAdtree, the files are back in the working folder as well",
    "and these copies are spares.",
    "",
    `Discarded at (UTC): ${input.at.toISOString()}`,
    `Project: ${input.projectName}`,
    `Case: ${input.caseName}`,
    `Working folder: working/${input.workingFolder}`,
    `${input.restore ? "Got this version from" : "Went back to"}: ${input.revision}`,
    `cAdtree record: ${input.operation}`,
    "",
    input.restore ? "WHAT WAS REPLACED" : "WHAT WAS DISCARDED",
  ];
  const what: Record<DiscardedEntry["kind"], string> = {
    edit: input.restore ? "Replaced file" : "Unsaved edit",
    "new file": "Unsaved new file",
    "deleted file": "Unsaved deletion",
    "new folder": "Unsaved new folder",
    "deleted folder": "Unsaved folder deletion",
  };
  for (const entry of input.entries) {
    const where = entry.copied
      ? "copy in this folder"
      : entry.insideOnly
        ? "kept inside cAdtree only (see below)"
        : entry.kind === "new folder"
          ? "not copied (path too long)"
          : "put back from the saved revision; nothing to keep";
    lines.push(`  ${what[entry.kind]}: ${entry.path}`, `    ${where}`);
  }
  const inside = input.entries.filter((e) => e.insideOnly);
  if (inside.length) {
    lines.push(
      "",
      "KEPT INSIDE cAdtree ONLY",
      "The path was too long for a readable copy here. The bytes are kept in the vault:",
    );
    for (const entry of inside)
      lines.push(
        `  ${entry.path}`,
        `    ${entry.insideOnly}`,
        `    SHA-256 ${entry.sha256}`,
      );
  }
  lines.push(
    "",
    "HOW TO PUT FILES BACK",
    `Copy a file from this folder to the same place under working/${input.workingFolder}/ in the`,
    "project folder (same relative path), replacing the file there. It then shows as an unsaved",
    "change in cAdtree.",
  );
  if (inside.length)
    lines.push(
      "For a file kept inside cAdtree only, copy the .bin file named above to that place and",
      "rename it to the original name; its SHA-256 checksum must match the one above.",
    );
  return `${lines.join("\n")}\n`;
}
/**
 * Before a replace writes anything (no record yet) and again before its first
 * working-folder write: each folder it removes must hold nothing but what the
 * plan removes (its files, clutter included, and its removed subfolders).
 * Something that appeared since the scan stops here (`ReplacePlanChangedError`).
 */
async function assertReplaceRemovalsReady(
  working: FileSystemDirectoryAdapter,
  plan: Pick<ReplacePlan, "actions" | "folderActions">,
) {
  const removed = new Set(
    plan.folderActions
      .filter((action) => action.operation === "remove")
      .map((action) => action.path),
  );
  const deleted = new Set(
    plan.actions
      .filter((action) => action.operation === "delete")
      .map((action) => action.path),
  );
  const appeared: string[] = [];
  for (const path of removed) {
    let entries;
    try {
      entries = await (
        await working.getDirectory(splitAndValidatePath(path))
      ).listEntries();
    } catch {
      appeared.push(path);
      continue;
    }
    for (const entry of entries) {
      const child = `${path}/${entry.name}`;
      if (!(entry.kind === "directory" ? removed : deleted).has(child))
        appeared.push(child);
    }
  }
  if (appeared.length) throw new ReplacePlanChangedError(appeared);
}
export async function recoverApplication(
  vault: FileSystemDirectoryAdapter,
  projectId: string,
  branchId: string,
  operationId: string,
  options: ApplicationOptions,
): Promise<{ manualPaths: string[] }> {
  return withProjectWriterLock(projectId, async () => {
    const state = await openExistingVault(vault);
    if (state.project.projectId !== projectId)
      throw new Error("Project identity changed.");
    const op = branchApplications(state, branchId).find(
      (o) => o.operationId === operationId,
    );
    if (!op?.record || op.status !== "unresolved")
      throw new Error(
        "Only a validated unfinished application can be recovered here. Unavailable evidence requires manual inspection; a Bring back or Copy that was written can be saved (Save now) or left unsaved (Don't save it).",
      );
    const working = await connections(vault, state, branchId, options);
    await appendApplicationEvent(vault, op, { kind: "recovery-start" });
    const touched = new Set(
      op.events.filter((e) => e.kind === "attempt").map((e) => e.path),
    );
    const manualPaths: string[] = [];
    // Undo in reverse: first recreate folders this apply removed (shallowest first,
    // so files can be restored into them). Never touches a folder that is already there.
    for (const folder of foldersToRemove(op.record).reverse()) {
      throwIfCancelled(options.signal);
      if (!touched.has(folder.path)) continue;
      let state;
      try {
        state = await folderState(working, folder.path);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        manualPaths.push(folder.path);
        continue;
      }
      if (state === "directory") continue;
      if (state === "other") {
        manualPaths.push(folder.path);
        continue;
      }
      await appendApplicationEvent(vault, op, {
        kind: "recovery-attempt",
        path: folder.path,
      });
      try {
        await working.getDirectory(splitAndValidatePath(folder.path), {
          create: true,
          exclusiveCreate: true,
        });
      } catch (error) {
        if (!(error instanceof FileConflictError)) throw error;
        manualPaths.push(folder.path);
        continue;
      }
      if ((await folderState(working, folder.path)) !== "directory")
        throw new Error(
          `Recovery verification failed for ${folder.path}. Evidence is retained.`,
        );
    }
    // The recovery ID is allocated lazily, when the first unexpected file is staged.
    let recoveryId: string | undefined;
    for (const [index, action] of changedActions(op.record).entries()) {
      throwIfCancelled(options.signal);
      let current: FileEntry | null;
      try {
        current = await currentFile(working, action.path, options.signal);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        manualPaths.push(action.path);
        continue;
      }
      if (same(current, action.before)) continue;
      if (!touched.has(action.path) || !same(current, action.after)) {
        // Retain a verified copy of unexpected bytes as well as leaving the live
        // file untouched. No blind rollback of truncated writes or later CAD edits.
        if (current) {
          recoveryId ??= await createEventFolder(
            vault,
            options.now,
            (id) => applicationUnexpectedFolder(branchId, operationId, id),
            "recovery",
          );
          await stageFile(
            vault,
            applicationUnexpectedPath(branchId, operationId, recoveryId, index),
            working,
            splitAndValidatePath(action.path),
            current,
            options.signal,
          );
        }
        manualPaths.push(action.path);
        continue;
      }
      if (action.before)
        await verifiedFile(
          vault,
          stagedPath(op, "before", index),
          action.before,
          options.signal,
        );
      await appendApplicationEvent(vault, op, {
        kind: "recovery-attempt",
        path: action.path,
      });
      // Second read prevents a slow backup read from authorizing a later edit.
      if (
        !same(await currentFile(working, action.path, options.signal), current)
      ) {
        manualPaths.push(action.path);
        continue;
      }
      throwIfCancelled(options.signal);
      if (action.before)
        await working.writeFileStream(
          splitAndValidatePath(action.path),
          await vault.readFileStream(stagedPath(op, "before", index)),
          { signal: options.signal, exclusive: current === null },
        );
      else await working.removeEntry(splitAndValidatePath(action.path));
      if (
        !same(
          await currentFile(working, action.path, options.signal),
          action.before,
        )
      )
        throw new Error(
          `Recovery verification failed for ${action.path}. Evidence is retained.`,
        );
    }
    await removeCreatedFolders(vault, op, working, state, touched, manualPaths, options);
    if (!manualPaths.length)
      await appendApplicationEvent(vault, op, { kind: "recovered" });
    return { manualPaths };
  });
}
/**
 * Last recovery step: remove folders this apply created, now that files are back.
 * Candidates are the created folder actions and the parent folders that file adds and
 * created folders brought along (never folders the destination baseline already had).
 * Deepest first; only a folder that is empty is removed, anything else is reported
 * for manual inspection. No file is ever deleted.
 */
async function removeCreatedFolders(
  vault: FileSystemDirectoryAdapter,
  op: ApplicationOperation,
  working: FileSystemDirectoryAdapter,
  state: VaultState,
  touched: Set<string | undefined>,
  manualPaths: string[],
  options: ApplicationOptions,
) {
  const record = op.record!;
  const touchedAdds = changedActions(record)
    .filter((a) => a.operation === "add" && touched.has(a.path))
    .map((a) => a.path);
  const touchedCreates = foldersToCreate(record)
    .filter((a) => touched.has(a.path))
    .map((a) => a.path);
  const candidates = new Set<string>(touchedCreates);
  // A replace plan lists every folder it creates (missing parents included), so
  // exactly those are candidates; the baseline does not describe the working
  // folder it started from.
  const replace = isReplaceMode(record.plan.mode);
  if (!replace)
    for (const path of [...touchedAdds, ...touchedCreates]) {
      const segments = path.split("/");
      for (let i = 1; i < segments.length; i++)
        candidates.add(segments.slice(0, i).join("/"));
    }
  if (!candidates.size) return;
  const baseline = state.revisions.find(
    (r) => r.manifest.revisionId === record.plan.destinationRevisionId,
  );
  const baselineDirs = new Set(baseline?.manifest.directories ?? []);
  const ordered = [...candidates]
    .filter((path) => replace || !baselineDirs.has(path))
    .sort((a, b) => folderDepth(b) - folderDepth(a) || a.localeCompare(b));
  for (const path of ordered) {
    throwIfCancelled(options.signal);
    let current;
    try {
      current = await folderState(working, path);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      manualPaths.push(path);
      continue;
    }
    if (current === "missing") continue;
    const inspect = async () =>
      (
        await (
          await working.getDirectory(splitAndValidatePath(path))
        ).listEntries()
      ).length;
    // A deeper manual path (or unknown baseline) keeps this folder as it is.
    const covered = () =>
      manualPaths.some((m) => m === path || m.startsWith(`${path}/`));
    if (
      (!baseline && !replace) ||
      current === "other" ||
      covered() ||
      (await inspect())
    ) {
      if (!covered()) manualPaths.push(path);
      continue;
    }
    await appendApplicationEvent(vault, op, {
      kind: "recovery-attempt",
      path,
    });
    // Second read prevents a slow check from authorizing a later edit.
    if (await inspect()) {
      manualPaths.push(path);
      continue;
    }
    await working.removeEntry(splitAndValidatePath(path));
    if ((await folderState(working, path)) !== "missing")
      throw new Error(
        `Recovery verification failed for ${path}. Evidence is retained.`,
      );
  }
}
export async function abandonApplication(
  vault: FileSystemDirectoryAdapter,
  projectId: string,
  branchId: string,
  operationId: string,
) {
  return withProjectWriterLock(projectId, async () => {
    const state = await openExistingVault(vault);
    if (state.project.projectId !== projectId)
      throw new Error("Project identity changed.");
    const op = branchApplications(state, branchId).find(
      (o) => o.operationId === operationId,
    );
    if (op?.status !== "applied")
      throw new Error(
        "Only a successful pending application can be abandoned. Recover incomplete work first.",
      );
    await appendApplicationEvent(vault, op, { kind: "abandoned" });
  });
}
