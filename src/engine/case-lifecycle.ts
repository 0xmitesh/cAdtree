import type { FileSystemDirectoryAdapter } from "./fs-adapter";
import { splitAndValidatePath } from "./fs-adapter";
import { hashString } from "./hash";
import type { VaultState } from "./types";

export interface CaseLifecycle {
  status: "active" | "archived" | "unavailable";
  version: string | null;
  sequence: number;
  /** Unsaved changes (files and folders) the case had when it was hidden. */
  unsavedAtHide?: number;
  error?: string;
}
export interface CaseLifecycleRecord {
  schemaVersion: 1;
  projectId: string;
  branchId: string;
  branchRecordSha256: string;
  sequence: number;
  previousSha256: string | null;
  /** On disk "archived" means hidden; the value is kept so existing records stay valid. */
  status: "active" | "archived";
  changedAt: string;
  /** Hide records only: how many unsaved changes stayed in the case's folder. */
  unsavedAtHide?: number;
  checksum: string;
}
const legacy: CaseLifecycle = { status: "active", version: null, sequence: 0 };
export function caseLifecycle(
  state: VaultState,
  branchId: string,
): CaseLifecycle {
  return (
    state.caseLifecycles?.["*"] ?? state.caseLifecycles?.[branchId] ?? legacy
  );
}
export function caseWriteBlock(
  state: VaultState,
  branchId: string,
): string | undefined {
  const lifecycle = caseLifecycle(state, branchId);
  return lifecycle.status === "archived"
    ? "This case is hidden. Unhide it in History → Design cases before saving or changing its files."
    : lifecycle.status === "unavailable"
      ? `Case lifecycle records are unavailable. Inspect the kept lifecycle records before writing. ${lifecycle.error ?? ""}`
      : undefined;
}
/** Why a case cannot even be opened. A hidden case opens read-only (looking is allowed);
 * only unreadable lifecycle records stop it. */
export function caseOpenBlock(
  state: VaultState,
  branchId: string,
): string | undefined {
  return caseLifecycle(state, branchId).status === "unavailable"
    ? caseWriteBlock(state, branchId)
    : undefined;
}
export function assertCaseWritable(state: VaultState, branchId: string) {
  const reason = caseWriteBlock(state, branchId);
  if (reason) throw new Error(reason);
}
export function caseLabel(state: VaultState, branchId: string) {
  const name =
    state.branches.find((branch) => branch.branchId === branchId)?.name ??
    "Unknown case";
  const status = caseLifecycle(state, branchId).status;
  return `${name}${status === "archived" ? " · Hidden" : status === "unavailable" ? " · Lifecycle unavailable" : ""}`;
}
export function sealLifecycle(
  body: Omit<CaseLifecycleRecord, "checksum">,
): CaseLifecycleRecord {
  return { ...body, checksum: hashString(JSON.stringify(body)) };
}
export function lifecyclePath(branchId: string, sequence: number) {
  if (
    splitAndValidatePath(branchId).length !== 1 ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    sequence > 999999
  )
    throw new Error("Invalid lifecycle identity or sequence.");
  return [
    "case-lifecycle",
    `${branchId}.${String(sequence).padStart(6, "0")}.json`,
  ];
}
/** Legacy absence is Active. Any present malformed, unreadable or ambiguous
 * evidence stays unavailable; it is never folded into that legacy default. */
export async function readCaseLifecycles(
  vault: FileSystemDirectoryAdapter,
  state: VaultState,
): Promise<Record<string, CaseLifecycle>> {
  const result: Record<string, CaseLifecycle> = {};
  const damaged = (error: unknown): CaseLifecycle => ({
    status: "unavailable",
    version: null,
    sequence: 0,
    error: error instanceof Error ? error.message : String(error),
  });
  try {
    if (
      !(await vault.listEntries()).some(
        (entry) => entry.name === "case-lifecycle",
      )
    )
      return result;
    const dir = await vault.getDirectory(["case-lifecycle"]);
    const entries = await dir.listEntries();
    if (!entries.length) {
      result["*"] = damaged(
        "Lifecycle directory exists without records. Inspect the interrupted or missing lifecycle records before writing.",
      );
      return result;
    }
    const groups = new Map<string, string[]>();
    for (const entry of entries) {
      const match = /^(.+)\.(\d{6})\.json$/.exec(entry.name);
      if (
        entry.kind !== "file" ||
        !match ||
        !state.branches.some((branch) => branch.branchId === match[1])
      ) {
        result["*"] = damaged(
          `Unrecognized lifecycle entry: case-lifecycle/${entry.name}.`,
        );
        continue;
      }
      groups.set(match[1], [...(groups.get(match[1]) ?? []), entry.name]);
    }
    for (const [branchId, names] of groups) {
      try {
        const branches = state.branches.filter(
          (branch) => branch.branchId === branchId,
        );
        if (branches.length !== 1 || branches[0].isMain)
          throw new Error(
            "Main cannot have case lifecycle records; case identity must be unique.",
          );
        const branch = branches[0];
        let current = legacy;
        for (const [index, name] of names.sort().entries()) {
          if (name !== lifecyclePath(branchId, index + 1)[1])
            throw new Error("Lifecycle sequence is missing or ambiguous.");
          const record = JSON.parse(
            await dir.readFileText([name]),
          ) as CaseLifecycleRecord;
          const { checksum, ...body } = record;
          if (
            record.schemaVersion !== 1 ||
            record.projectId !== state.project.projectId ||
            record.branchId !== branchId ||
            record.branchRecordSha256 !== branch.payloadSha256 ||
            record.sequence !== index + 1 ||
            record.previousSha256 !== current.version ||
            !["active", "archived"].includes(record.status) ||
            record.status === current.status ||
            typeof record.changedAt !== "string" ||
            (record.unsavedAtHide !== undefined &&
              (record.status !== "archived" ||
                !Number.isSafeInteger(record.unsavedAtHide) ||
                record.unsavedAtHide < 0)) ||
            !Number.isFinite(Date.parse(record.changedAt)) ||
            !checksum ||
            checksum !== hashString(JSON.stringify(body))
          )
            throw new Error(
              `Invalid lifecycle identity, transition or checksum in ${name}.`,
            );
          current = {
            status: record.status,
            version: checksum,
            sequence: record.sequence,
            ...(record.unsavedAtHide !== undefined
              ? { unsavedAtHide: record.unsavedAtHide }
              : {}),
          };
        }
        result[branchId] = current;
      } catch (error) {
        result[branchId] = damaged(error);
      }
    }
  } catch (error) {
    result["*"] = damaged(error);
  }
  return result;
}
