import type { FileSystemDirectoryAdapter } from "./fs-adapter";
import { splitAndValidatePath } from "./fs-adapter";
import { hashString } from "./hash";
import type { ApplyPreviewPlan, PreviewChoice } from "./apply-preview";
import type { FileEntry, RevisionManifest, VaultState } from "./types";

export interface ApplicationReview {
  projectId: string;
  sourceRevisionId: string;
  destinationBranchId: string;
  expectedPlanHash: string;
  choices: Record<string, PreviewChoice>;
  reason: string;
}
export interface ApplicationRecord {
  schemaVersion: 1;
  kind: "cadtree-file-application";
  operationId: string;
  createdAt: string;
  sourceBranchId: string;
  review: ApplicationReview;
  plan: Pick<
    ApplyPreviewPlan,
    | "projectId"
    | "sourceRevisionId"
    | "destinationRevisionId"
    | "baseRevisionId"
    | "destinationBranchId"
    | "reason"
    | "actions"
  >;
  checksum: string;
}
export type ApplicationEventKind =
  | "staged"
  | "attempt"
  | "written"
  | "applied"
  | "recovery-start"
  | "recovery-attempt"
  | "recovered"
  | "abandoned"
  | "capture";
export interface ApplicationEvent {
  schemaVersion: 1;
  operationId: string;
  sequence: number;
  previous: string;
  kind: ApplicationEventKind;
  at: string;
  path?: string;
  revisionId?: string;
  manifestSha256?: string;
  finalFiles?: { path: string; file: FileEntry | null }[];
  reviewedChangesSignature?: string;
  checksum: string;
}
export interface ApplicationOperation {
  operationId: string;
  destinationBranchId: string;
  relativePath: string;
  status:
    | "unresolved"
    | "applied"
    | "captured"
    | "recovered"
    | "abandoned"
    | "unavailable";
  record?: ApplicationRecord;
  events: ApplicationEvent[];
  capturedRevisionId?: string;
  error?: string;
}
export function sealApplication<T extends object>(
  body: T,
): T & { checksum: string } {
  return { ...body, checksum: hashString(JSON.stringify(body)) };
}
function verified<T extends { checksum: string }>(text: string): T {
  const value = JSON.parse(text) as T;
  const { checksum, ...body } = value;
  if (!checksum || checksum !== hashString(JSON.stringify(body)))
    throw new Error("Application record checksum mismatch.");
  return value;
}
const digest = (v: unknown) =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const safeId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-zA-Z0-9_-]+$/.test(id);
function assertFile(file: FileEntry | null, path: string) {
  if (
    file !== null &&
    (!file ||
      file.path !== path ||
      !digest(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !Number.isFinite(file.lastModified))
  )
    throw new Error(`Invalid application file evidence: ${path}`);
}
export function applicationPath(
  branchId: string,
  operationId: string,
): string[] {
  if (!safeId(branchId) || !safeId(operationId))
    throw new Error("Unsafe application identity.");
  return ["applications", branchId, operationId];
}
const sixDigits = (n: number) => String(n).padStart(6, "0");
export function applicationPlanPath(
  branchId: string,
  operationId: string,
): string[] {
  return [...applicationPath(branchId, operationId), "plan.json"];
}
export function applicationEventPath(
  branchId: string,
  operationId: string,
  sequence: number,
): string[] {
  return [
    ...applicationPath(branchId, operationId),
    "events",
    `${sixDigits(sequence)}.json`,
  ];
}
export function applicationStagedPath(
  branchId: string,
  operationId: string,
  side: "before" | "source",
  index: number,
): string[] {
  return [
    ...applicationPath(branchId, operationId),
    side,
    `${sixDigits(index)}.bin`,
  ];
}
export function applicationUnexpectedFolder(
  branchId: string,
  operationId: string,
  recoveryId: string,
): string[] {
  return [...applicationPath(branchId, operationId), "unexpected", recoveryId];
}
export function applicationUnexpectedPath(
  branchId: string,
  operationId: string,
  recoveryId: string,
  index: number,
): string[] {
  return [
    ...applicationUnexpectedFolder(branchId, operationId, recoveryId),
    `${sixDigits(index)}.bin`,
  ];
}
function validateRecord(
  record: ApplicationRecord,
  state: VaultState,
  branchId: string,
  operationId: string,
) {
  const { plan, review } = record;
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "cadtree-file-application" ||
    record.operationId !== operationId ||
    !safeId(record.sourceBranchId) ||
    !record.createdAt ||
    !plan ||
    !review ||
    plan.projectId !== state.project.projectId ||
    review.projectId !== plan.projectId ||
    plan.destinationBranchId !== branchId ||
    review.destinationBranchId !== branchId ||
    review.sourceRevisionId !== plan.sourceRevisionId ||
    ![
      plan.sourceRevisionId,
      plan.baseRevisionId,
      plan.destinationRevisionId,
    ].every(safeId) ||
    !plan.reason?.trim() ||
    plan.reason !== review.reason ||
    !digest(review.expectedPlanHash) ||
    !Array.isArray(plan.actions) ||
    !plan.actions.length
  )
    throw new Error("Invalid application identity, review or plan.");
  const seen = new Set<string>();
  for (const action of plan.actions) {
    splitAndValidatePath(action.path);
    if (
      seen.has(action.path) ||
      !["add", "replace", "delete", "keep"].includes(action.operation) ||
      !["added", "modified", "deleted"].includes(action.sourceChange) ||
      !["use-source", "keep-destination"].includes(action.decision) ||
      review.choices[action.path]?.selected !== true ||
      review.choices[action.path]?.decision !== action.decision
    )
      throw new Error("Invalid application action or conflict decision.");
    seen.add(action.path);
    for (const file of [
      action.base,
      action.source,
      action.before,
      action.after,
    ])
      assertFile(file, action.path);
    if (
      JSON.stringify(action.after) !==
      JSON.stringify(
        action.decision === "use-source" ? action.source : action.before,
      )
    )
      throw new Error("Application after-state disagrees with its decision.");
    const expectedOperation =
      action.decision === "keep-destination"
        ? "keep"
        : action.source
          ? action.before
            ? "replace"
            : "add"
          : "delete";
    const sourceChange = !action.base
      ? "added"
      : !action.source
        ? "deleted"
        : "modified";
    if (
      action.operation !== expectedOperation ||
      action.sourceChange !== sourceChange ||
      (!action.base && !action.source) ||
      (action.base &&
        action.source &&
        action.base.sha256 === action.source.sha256)
    )
      throw new Error("Application action does not describe a source change.");
  }
  if (
    Object.values(review.choices).filter((choice) => choice.selected).length !==
    seen.size
  )
    throw new Error(
      "Application choices do not match its exact recorded actions.",
    );
  if (!plan.actions.some((action) => action.operation !== "keep"))
    throw new Error("Application contains no source operation.");
}
const kinds: ApplicationEventKind[] = [
  "staged",
  "attempt",
  "written",
  "applied",
  "recovery-start",
  "recovery-attempt",
  "recovered",
  "abandoned",
  "capture",
];
export function changedActions(record: ApplicationRecord) {
  return record.plan.actions.filter((action) => action.operation !== "keep");
}
function classify(operation: ApplicationOperation, state: VaultState) {
  const record = operation.record!;
  const events = operation.events;
  let staged = false,
    applied = false,
    recovering = false,
    terminal = false;
  const attempts = new Set<string>(),
    written = new Set<string>();
  const published = new Set<string>();
  for (const event of events) {
    if (terminal)
      throw new Error("Application has events after a terminal outcome.");
    if (event.kind === "staged") {
      if (staged || applied || recovering)
        throw new Error("Invalid staging transition.");
      staged = true;
    }
    if (["attempt", "written", "recovery-attempt"].includes(event.kind)) {
      if (
        !record.plan.actions.some(
          (a) => a.operation !== "keep" && a.path === event.path,
        )
      )
        throw new Error("Application event references an unknown action.");
    }
    if (event.kind === "attempt") {
      if (!staged || applied || recovering || attempts.has(event.path!))
        throw new Error("Invalid file attempt.");
      attempts.add(event.path!);
    }
    if (event.kind === "written") {
      if (
        !attempts.has(event.path!) ||
        written.has(event.path!) ||
        applied ||
        recovering
      )
        throw new Error("Invalid file acknowledgement.");
      written.add(event.path!);
    }
    if (event.kind === "applied") {
      if (
        !staged ||
        applied ||
        recovering ||
        changedActions(record).some((a) => !written.has(a.path))
      )
        throw new Error("Incomplete application cannot be marked applied.");
      applied = true;
    }
    if (event.kind === "recovery-start") {
      if (published.size)
        throw new Error("A captured application cannot be recovered.");
      recovering = true;
    }
    if (event.kind === "recovery-attempt" && !recovering)
      throw new Error("Recovery was not started.");
    if (event.kind === "capture") {
      if (
        !applied ||
        recovering ||
        !safeId(event.revisionId) ||
        !digest(event.manifestSha256) ||
        !digest(event.reviewedChangesSignature) ||
        !Array.isArray(event.finalFiles) ||
        event.finalFiles.length !== record.plan.actions.length
      )
        throw new Error("Invalid capture provenance link.");
      const paths = new Set<string>();
      for (const entry of event.finalFiles) {
        if (
          paths.has(entry.path) ||
          !record.plan.actions.some((a) => a.path === entry.path)
        )
          throw new Error("Invalid captured file identity.");
        paths.add(entry.path);
        assertFile(entry.file, entry.path);
      }
      const matches = state.revisions.filter(
        (r) => r.manifest.revisionId === event.revisionId,
      );
      if (
        matches.length > 1 ||
        matches.some((r) => r.integrityStatus === "corrupted")
      )
        throw new Error(
          "Application capture publication is damaged or ambiguous.",
        );
      if (matches.length) {
        const revision = matches[0];
        if (
          revision.completion.manifestSha256 !== event.manifestSha256 ||
          revision.manifest.branchId !== operation.destinationBranchId ||
          revision.manifest.parentRevisionId !==
            record.plan.destinationRevisionId
        )
          throw new Error(
            "Application capture identity does not match its publication.",
          );
        for (const entry of event.finalFiles)
          if (
            JSON.stringify(entry.file) !==
            JSON.stringify(
              revision.manifest.files.find((f) => f.path === entry.path) ??
                null,
            )
          )
            throw new Error("Final captured bytes disagree with provenance.");
        published.add(event.revisionId!);
      } else if (
        state.corruptedRecords.some((r) => r.revisionId === event.revisionId)
      )
        throw new Error(
          "Application capture completion is unavailable; do not consume provenance again.",
        );
    }
    if (event.kind === "abandoned") {
      if (!applied || recovering || published.size)
        throw new Error(
          "Only a successful uncaptured application can be abandoned.",
        );
      operation.status = "abandoned";
      terminal = true;
    }
    if (event.kind === "recovered") {
      if (!recovering || published.size)
        throw new Error("Invalid recovery outcome.");
      operation.status = "recovered";
      terminal = true;
    }
  }
  if (published.size > 1)
    throw new Error(
      "Application provenance was attached to more than one revision.",
    );
  if (published.size) {
    operation.status = "captured";
    operation.capturedRevisionId = [...published][0];
  } else if (!terminal)
    operation.status = applied && !recovering ? "applied" : "unresolved";
}
export async function readApplicationOperations(
  vault: FileSystemDirectoryAdapter,
  state: VaultState,
): Promise<ApplicationOperation[]> {
  const operations: ApplicationOperation[] = [];
  const unavailable = (
    branch: string,
    id: string,
    path: string,
    error: unknown,
  ): ApplicationOperation => ({
    operationId: id,
    destinationBranchId: branch,
    relativePath: path,
    status: "unavailable",
    events: [],
    error: error instanceof Error ? error.message : String(error),
  });
  try {
    if (!(await vault.listEntries()).some((e) => e.name === "applications"))
      return [];
    const root = await vault.getDirectory(["applications"]);
    for (const branch of await root.listEntries()) {
      if (branch.kind !== "directory" || !safeId(branch.name)) {
        operations.push(
          unavailable(
            "*",
            branch.name,
            `applications/${branch.name}`,
            "Unrecognized application branch entry. Manual inspection required.",
          ),
        );
        continue;
      }
      const branchDir = await root.getDirectory([branch.name]);
      for (const item of await branchDir.listEntries()) {
        const path = `applications/${branch.name}/${item.name}`;
        try {
          if (item.kind !== "directory" || !safeId(item.name))
            throw new Error("Unrecognized application operation entry.");
          const dir = await branchDir.getDirectory([item.name]);
          const record = verified<ApplicationRecord>(
            await dir.readFileText(["plan.json"]),
          );
          validateRecord(record, state, branch.name, item.name);
          const operation: ApplicationOperation = {
            operationId: item.name,
            destinationBranchId: branch.name,
            relativePath: path,
            status: "unresolved",
            record,
            events: [],
          };
          if ((await dir.listEntries()).some((e) => e.name === "events")) {
            const eventDir = await dir.getDirectory(["events"]);
            const entries = (await eventDir.listEntries()).sort((a, b) =>
              a.name.localeCompare(b.name),
            );
            let previous = record.checksum;
            for (const [index, entry] of entries.entries()) {
              if (
                entry.kind !== "file" ||
                entry.name !== `${String(index + 1).padStart(6, "0")}.json`
              )
                throw new Error(
                  "Missing, partial or ambiguous application event sequence.",
                );
              const event = verified<ApplicationEvent>(
                await eventDir.readFileText([entry.name]),
              );
              if (
                event.schemaVersion !== 1 ||
                event.operationId !== item.name ||
                event.sequence !== index + 1 ||
                event.previous !== previous ||
                !event.at ||
                !kinds.includes(event.kind)
              )
                throw new Error("Invalid application event chain.");
              previous = event.checksum;
              operation.events.push(event);
            }
          }
          classify(operation, state);
          operations.push(operation);
        } catch (error) {
          operations.push(unavailable(branch.name, item.name, path, error));
        }
      }
    }
  } catch (error) {
    operations.push(unavailable("*", "unreadable", "applications", error));
  }
  return operations;
}
export function branchApplications(state: VaultState, branchId: string) {
  return (state.applicationOperations ?? []).filter(
    (op) =>
      op.destinationBranchId === branchId || op.destinationBranchId === "*",
  );
}
export function applicationCaptureBlock(
  state: VaultState,
  branchId: string,
): string | undefined {
  const blocked = branchApplications(state, branchId).filter(
    (op) => op.status === "unresolved" || op.status === "unavailable",
  );
  const pending = branchApplications(state, branchId).filter(
    (op) => op.status === "applied",
  );
  return blocked.length || pending.length > 1
    ? "An unfinished or unavailable file application blocks saving. Recover or inspect its retained evidence first."
    : undefined;
}
export async function appendApplicationEvent(
  vault: FileSystemDirectoryAdapter,
  operation: ApplicationOperation,
  fields: Pick<ApplicationEvent, "kind"> &
    Partial<
      Pick<
        ApplicationEvent,
        | "path"
        | "revisionId"
        | "manifestSha256"
        | "finalFiles"
        | "reviewedChangesSignature"
      >
    >,
) {
  if (!operation.record) throw new Error("Application evidence unavailable.");
  const event = sealApplication({
    schemaVersion: 1 as const,
    operationId: operation.operationId,
    sequence: operation.events.length + 1,
    previous: operation.events.at(-1)?.checksum ?? operation.record.checksum,
    at: new Date().toISOString(),
    ...fields,
  });
  const path = applicationEventPath(
    operation.destinationBranchId,
    operation.operationId,
    event.sequence,
  );
  const text = JSON.stringify(event, null, 2);
  await vault.writeFileText(path, text, { exclusive: true });
  if ((await vault.readFileText(path)) !== text)
    throw new Error(
      "Application event readback failed. Reopen to inspect the outcome.",
    );
  operation.events.push(event);
}
export async function linkApplicationCapture(
  vault: FileSystemDirectoryAdapter,
  operation: ApplicationOperation,
  manifest: RevisionManifest,
  manifestSha256: string,
  reviewedChangesSignature: string,
) {
  await appendApplicationEvent(vault, operation, {
    kind: "capture",
    revisionId: manifest.revisionId,
    manifestSha256,
    reviewedChangesSignature,
    finalFiles: operation.record!.plan.actions.map((action) => ({
      path: action.path,
      file: manifest.files.find((f) => f.path === action.path) ?? null,
    })),
  });
}
