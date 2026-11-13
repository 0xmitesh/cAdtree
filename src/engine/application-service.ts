import type { FileSystemDirectoryAdapter } from "./fs-adapter";
import { FileConflictError, splitAndValidatePath } from "./fs-adapter";
import {
  prepareApplyPreview,
  buildApplyPreview,
  type ApplyPreviewPlan,
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
import { withProjectWriterLock } from "./locks";
import { eventIdBase, eventIdCandidate } from "./ids";
import { partitionSystemFiles, scanBranchChanges } from "./scanner";
import {
  inventorySignature,
  readVerifiedInventory,
  throwIfCancelled,
  type CopyOptions,
} from "./copy-service";
import { openExistingVault } from "./vault-service";
import { assertCaseWritable } from "./case-lifecycle";
import type { FileEntry, VaultState } from "./types";

export interface ApplicationOptions extends CopyOptions {
  /** Clock for new event IDs; defaults to the current time. Tests inject a fixed one. */
  now?: () => Date;
  workingFolders: WorkingFolderBindings;
  resolveWorkingFolders?: (state: VaultState) => Promise<WorkingFolderBindings>;
}
export interface PreparedApplication {
  review: ApplicationReview;
  plan: ApplyPreviewPlan;
  destinationName: string;
  branchName: string;
  connection: FileSystemDirectoryAdapter;
}
/** Called only from an explicit Prepare/Recover user gesture. Engine execution
 * only checks permissions; it never silently elevates a remembered connection. */
export async function requestApplicationWriteAccess(
  vault: FileSystemDirectoryAdapter,
  working: FileSystemDirectoryAdapter | null,
) {
  if (!working)
    throw new Error(
      "Reconnect the destination working folder before preparing application.",
    );
  for (const folder of [working, vault]) {
    if ((await folder.queryPermission("readwrite")) === "granted") continue;
    try {
      if ((await folder.requestPermission("readwrite")) !== "granted")
        throw new Error("Permission was not granted.");
    } catch (error) {
      throw new Error(
        `Read/write access to "${folder.name}" is required. Use Prepare application or Recover again to renew permission, or reconnect the folder. ${error instanceof Error ? error.message : String(error)}`,
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
    branchApplications(state, branchId).some(
      (op) => !["captured", "recovered", "abandoned"].includes(op.status),
    )
  )
    throw new Error(
      "This destination has an unfinished application. Review its status and recover, save or explicitly abandon it before another apply.",
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
}
export async function prepareApplication(
  vault: FileSystemDirectoryAdapter,
  review: ApplicationReview,
  options: ApplicationOptions,
): Promise<PreparedApplication> {
  return withProjectWriterLock(review.projectId, async () => {
    throwIfCancelled(options.signal);
    const state = await openExistingVault(vault);
    const { plan } = recompute(state, review);
    noUnfinished(state, review.destinationBranchId);
    const connection = await connections(
      vault,
      state,
      review.destinationBranchId,
      options,
    );
    await cleanDestination(connection, state, review, options);
    return {
      review: structuredClone(review),
      plan,
      destinationName: connection.name,
      branchName: state.branches.find(
        (b) => b.branchId === review.destinationBranchId,
      )!.name,
      connection,
    };
  });
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
export async function applyPreparedApplication(
  vault: FileSystemDirectoryAdapter,
  prepared: PreparedApplication,
  options: ApplicationOptions,
): Promise<ApplicationOperation> {
  const review = prepared.review;
  return withProjectWriterLock(review.projectId, async () => {
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
    if (!(await working.isSameEntry(prepared.connection)))
      throw new Error(
        "Destination connection changed after preparation. Refresh and review again.",
      );
    await cleanDestination(working, state, review, options);
    // A fresh operation ID is never reused. A durable plan precedes staging; a
    // durable attempt precedes each write. Any uncertain outcome remains discoverable.
    const operationId = await createEventFolder(
      vault,
      options.now,
      (id) => applicationPath(review.destinationBranchId, id),
      "application",
    );
    const record: ApplicationRecord = sealApplication({
      schemaVersion: 1 as const,
      kind: "cadtree-file-application" as const,
      operationId,
      createdAt: new Date().toISOString(),
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
      },
    });
    const text = JSON.stringify(record, null, 2);
    const planPath = applicationPlanPath(review.destinationBranchId, operationId);
    await vault.writeFileText(planPath, text, {
      exclusive: true,
    });
    if ((await vault.readFileText(planPath)) !== text)
      throw new Error(
        "Application plan readback failed. Reopen and inspect retained operation storage.",
      );
    const op: ApplicationOperation = {
      operationId,
      destinationBranchId: review.destinationBranchId,
      relativePath: applicationPath(review.destinationBranchId, operationId).join("/"),
      status: "unresolved",
      record,
      events: [],
    };
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
    return op;
  });
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
        "Only a validated unfinished application can be recovered here. Unavailable evidence requires manual inspection; successful applications can be saved or abandoned.",
      );
    const working = await connections(vault, state, branchId, options);
    await appendApplicationEvent(vault, op, { kind: "recovery-start" });
    const touched = new Set(
      op.events.filter((e) => e.kind === "attempt").map((e) => e.path),
    );
    const manualPaths: string[] = [];
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
    if (!manualPaths.length)
      await appendApplicationEvent(vault, op, { kind: "recovered" });
    return { manualPaths };
  });
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
