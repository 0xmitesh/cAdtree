import type { FileSystemDirectoryAdapter } from './fs-adapter';
import { splitAndValidatePath } from './fs-adapter';
import { hashString } from './hash';
import { getBranchBaseline } from './branch-state';
import { withProjectWriterLock } from './locks';
import { isFinishedOperation } from './application-records';
import type { ScanResult, VaultState } from './types';

export interface ComponentFile { path: string; componentId: string }
export interface RenameDecision { from: string; to: string }
export interface IdentityReview {
  projectId: string; branchId: string; baselineRevisionId: string | null;
  baselineManifestSha256: string | null; boundarySha256: string; changesSignature: string;
  renames: RenameDecision[]; replacements: string[];
}
interface Boundary {
  schemaVersion: number; projectId: string; createdAt: string;
  legacy: { revisionId: string; manifestSha256: string }[];
  seeds: { revisionId: string; files: ComponentFile[] }[];
  payloadSha256: string;
}
export interface ComponentRecord {
  schemaVersion: number; projectId: string; revisionId: string; branchId: string;
  manifestSha256: string; boundarySha256: string; parentIdentitySha256: string | null;
  files: ComponentFile[]; renames: RenameDecision[]; replacements: string[];
  transfers: { path: string; componentId: string; sourceRevisionId: string; operationId: string }[];
  payloadSha256: string;
}
export interface ComponentEvidence {
  status: 'legacy' | 'available' | 'unavailable' | 'unsupported';
  reason?: string; boundary?: Boundary;
  enrollmentIncomplete?: boolean;
  revisions: Record<string, { files: ComponentFile[]; payloadSha256: string; renames: RenameDecision[] }>;
}
const directory = ['components'];
const boundaryPath = [...directory, 'boundary.json'];
const readyPath = [...directory, 'ready.json'];
const recordPath = (id: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Unsafe version identity.');
  return [...directory, 'revisions', `${id}.json`];
};
export const componentRecordPath = recordPath;
const id = () => `component-${crypto.randomUUID()}`;
export function componentChecksum(value: object): string {
  const { payloadSha256: _, ...payload } = value as Record<string, unknown>;
  return hashString(JSON.stringify(payload));
}
function seal<T extends object>(value: T): T & { payloadSha256: string } {
  return { ...value, payloadSha256: componentChecksum(value) };
}
function validateSeal(value: { schemaVersion: number; projectId: string; payloadSha256: string }, projectId: string) {
  if (value.schemaVersion !== 1) throw new Error(`Unsupported component identity schema (${String(value.schemaVersion)}).`);
  if (value.projectId !== projectId || value.payloadSha256 !== componentChecksum(value)) throw new Error('Component identity checksum or project binding mismatch.');
}
function validateFiles(files: ComponentFile[], manifest: { files: { path: string }[] }) {
  if (!Array.isArray(files) || files.length !== manifest.files.length) throw new Error('Component mapping does not cover the complete snapshot.');
  const paths = new Set<string>(), ids = new Set<string>();
  for (const file of files) {
    splitAndValidatePath(file.path);
    if (!/^component-[0-9a-f-]{36}$/.test(file.componentId) || paths.has(file.path) || ids.has(file.componentId) || !manifest.files.some(f => f.path === file.path)) throw new Error('Duplicate or invalid component identity/path mapping.');
    paths.add(file.path); ids.add(file.componentId);
  }
}
/** Publication and reconstruction must accept the same complete associations. */
function validateAssociations(
  record: Pick<ComponentRecord, 'files' | 'renames' | 'replacements' | 'transfers'>,
  parentFiles: ComponentFile[],
  snapshot: { files: { path: string }[] },
  allocated: Set<string>,
) {
  validateFiles(record.files, snapshot);
  validateDecisions(record.renames, record.replacements, parentFiles, snapshot.files.map(f => f.path));
  if (!Array.isArray(record.transfers) || new Set(record.transfers.map(t => t.path)).size !== record.transfers.length) throw new Error('Invalid applied component transfers.');
  const before = new Map(parentFiles.map(f => [f.path, f.componentId]));
  for (const transfer of record.transfers) {
    const conflict = (reason: string) => new Error(`Component identity conflict at "${transfer.path}": ${reason} Resolve the association in Changes before saving.`);
    if (record.renames.some(r => r.to === transfer.path)) throw conflict('an applied addition cannot also be a confirmed rename target. Cancel the rename association to keep the applied component identity.');
    if (record.replacements.includes(transfer.path) || before.has(transfer.path)) throw conflict('an applied addition cannot also replace a tracked component.');
    if (!record.files.some(f => f.path === transfer.path && f.componentId === transfer.componentId)) throw conflict('the applied component does not match the proposed snapshot mapping.');
  }
  for (const file of record.files) {
    const rename = record.renames.find(r => r.to === file.path);
    const inherited = record.replacements.includes(file.path) ? undefined : before.get(rename?.from ?? file.path);
    const transfer = record.transfers.find(t => t.path === file.path);
    if (inherited ? inherited !== file.componentId : !transfer && allocated.has(file.componentId)) throw new Error(`Component identity conflict at "${file.path}": continuity contradicts the parent mapping or an existing registration. Resolve the association in Changes before saving.`);
  }
}
async function writeVerified(vault: FileSystemDirectoryAdapter, path: string[], value: object) {
  const text = JSON.stringify(value, null, 2);
  await vault.writeFileText(path, text, { exclusive: true });
  if (await vault.readFileText(path) !== text) throw new Error('Component record readback verification failed.');
}

/** Read-only reconstruction. Completion publication commits a capture sidecar;
 * the boundary ready marker commits the deliberate legacy enrollment. */
export async function readComponentEvidence(vault: FileSystemDirectoryAdapter, state: VaultState): Promise<ComponentEvidence> {
  const result: ComponentEvidence = { status: 'legacy', revisions: {} };
  try {
    const entry = (await vault.listEntries()).find(e => e.name === 'components');
    if (!entry) return result;
    result.status = 'unavailable';
    if (entry.kind !== 'directory') throw new Error('Component storage is not a directory.');
    if (!await vault.hasFile(readyPath)) {
      result.enrollmentIncomplete = true;
      throw new Error('Component enrollment is incomplete. Retry the explicit upgrade; no identities were regenerated.');
    }
    if (!await vault.hasFile(boundaryPath)) throw new Error('The published component boundary is missing. It cannot be regenerated.');
    const text = await vault.readFileText(boundaryPath);
    const boundary: Boundary = JSON.parse(text);
    validateSeal(boundary, state.project.projectId);
    const ready = JSON.parse(await vault.readFileText(readyPath));
    if (ready.schemaVersion !== 1) throw new Error('Unsupported component publication schema.');
    if (ready.projectId !== state.project.projectId || ready.recordSha256 !== hashString(text)) throw new Error('Component enrollment publication mismatch.');
    if (!Array.isArray(boundary.legacy) || !Array.isArray(boundary.seeds) || new Set(boundary.legacy.map(r => r.revisionId)).size !== boundary.legacy.length || new Set(boundary.seeds.map(r => r.revisionId)).size !== boundary.seeds.length) throw new Error('Ambiguous component enrollment.');
    result.boundary = boundary;
    const revisions = new Map(state.revisions.map(r => [r.manifest.revisionId, r]));
    const legacy = new Map(boundary.legacy.map(r => [r.revisionId, r.manifestSha256]));
    for (const [revisionId, checksum] of legacy) {
      const revision = revisions.get(revisionId);
      if (!revision || revision.integrityStatus === 'corrupted' || revision.completion.manifestSha256 !== checksum) throw new Error('Legacy component boundary no longer matches saved history.');
    }
    const allocated = new Set<string>();
    for (const seed of boundary.seeds) {
      const revision = revisions.get(seed.revisionId);
      if (!revision || !legacy.has(seed.revisionId)) throw new Error('Component baseline is outside its legacy boundary.');
      validateFiles(seed.files, revision.manifest);
      for (const file of seed.files) {
        if (allocated.has(file.componentId)) throw new Error('Independent legacy baselines have duplicate component IDs.');
        allocated.add(file.componentId);
      }
      result.revisions[seed.revisionId] = { files: seed.files, renames: [], payloadSha256: hashString(JSON.stringify(seed)) };
    }
    const pending = state.revisions.filter(r => !legacy.has(r.manifest.revisionId));
    const componentRevisions = await vault.getDirectory([...directory, 'revisions']);
    for (const entry of await componentRevisions.listEntries()) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) throw new Error('Unexpected component version records.');
      const revisionId = entry.name.slice(0, -5);
      if (legacy.has(revisionId)) throw new Error('Component record conflicts with the legacy boundary.');
      if (!revisions.has(revisionId)) state.incompleteAttempts.push({ id: revisionId, kind: 'uncompleted_component', path: `components/revisions/${entry.name}`, detail: 'Component mapping has no committed version; it is not published identity history.' });
    }
    const loaded: ComponentRecord[] = [];
    // Parent order is structural, never inferred from revision numbering.
    while (pending.length) {
      const index = pending.findIndex(r => !r.manifest.parentRevisionId || legacy.has(r.manifest.parentRevisionId) || result.revisions[r.manifest.parentRevisionId]);
      if (index < 0) throw new Error('Component parent records are missing or cyclic.');
      const revision = pending.splice(index, 1)[0];
      if (revision.integrityStatus === 'corrupted') throw new Error('Component snapshot manifest is damaged.');
      const record: ComponentRecord = JSON.parse(await vault.readFileText(recordPath(revision.manifest.revisionId)));
      validateSeal(record, state.project.projectId);
      if (record.revisionId !== revision.manifest.revisionId || record.branchId !== revision.manifest.branchId || record.manifestSha256 !== revision.completion.manifestSha256 || record.boundarySha256 !== boundary.payloadSha256) throw new Error('Component record does not bind to the exact committed manifest.');
      const parent = revision.manifest.parentRevisionId ? result.revisions[revision.manifest.parentRevisionId] : undefined;
      if (record.parentIdentitySha256 !== (parent?.payloadSha256 ?? null)) throw new Error('Component parent mapping checksum mismatch.');
      validateAssociations(record, parent?.files ?? [], revision.manifest, allocated);
      for (const file of record.files) allocated.add(file.componentId);
      result.revisions[record.revisionId] = record;
      loaded.push(record);
    }
    for (const record of loaded) for (const transfer of record.transfers) {
      const source = result.revisions[transfer.sourceRevisionId]?.files.find(f => f.path === transfer.path);
      const applied = state.applicationOperations?.find(op => op.operationId === transfer.operationId && op.status === 'captured' && op.capturedRevisionId === record.revisionId);
      const ok = !!source && source.componentId === transfer.componentId && (applied
        ? applied.record?.plan.sourceRevisionId === transfer.sourceRevisionId && applied.record.plan.actions.some(a => a.path === transfer.path && a.operation === 'add')
        : restoreProvenance(state, record, transfer, revisions.get(record.revisionId)!.manifest));
      if (!ok) throw new Error('The copied file has no verified record of where it came from.');
    }
    result.status = 'available';
  } catch (error) {
    result.reason = `Component identity unavailable: ${error instanceof Error ? error.message : String(error)}`;
    result.status = /Unsupported/.test(result.reason) ? 'unsupported' : 'unavailable';
    // Do not expose a partial map as trustworthy history.
    result.revisions = {};
  }
  return result;
}

/** A transfer from a finished Get this version: same case, made on the saved
 * revision's parent, the recorded component, and the saved bytes it wrote. */
function restoreProvenance(state: VaultState, record: ComponentRecord, transfer: ComponentRecord['transfers'][number], manifest: { parentRevisionId?: string | null; files: { path: string; sha256: string; size: number }[] }) {
  const op = state.applicationOperations?.find(op => op.operationId === transfer.operationId && op.destinationBranchId === record.branchId && op.status === 'done');
  const plan = op?.record?.plan;
  const action = plan?.actions.find(a => a.path === transfer.path);
  const saved = manifest.files.find(f => f.path === transfer.path);
  return !!plan && plan.mode === 'restore-file' && plan.componentId === transfer.componentId && plan.sourceRevisionId === transfer.sourceRevisionId &&
    plan.destinationRevisionId === (manifest.parentRevisionId ?? null) && !!action?.after && !!saved && saved.sha256 === action.after.sha256 && saved.size === action.after.size;
}
/** Initial heads are separate registration boundaries. No equivalence is guessed
 * between distinct pre-upgrade branches or earlier reused filenames. */
export async function writeComponentBoundary(vault: FileSystemDirectoryAdapter, state: VaultState) {
  if (state.corruptedRecords.length || Object.keys(state.damagedBranchHeads).length || Object.keys(state.competingHeads).length || state.applicationOperations?.some(op => !isFinishedOperation(op))) throw new Error('Resolve the history and Bring back or Copy records before turning on rename tracking.');
  if (state.components?.status === 'available') return;
  if (await vault.hasFile(readyPath)) throw new Error('Existing component records are damaged or unsupported; they cannot be replaced.');
  let boundary: Boundary;
  if (await vault.hasFile(boundaryPath)) {
    boundary = JSON.parse(await vault.readFileText(boundaryPath));
    validateSeal(boundary, state.project.projectId);
    if (JSON.stringify(boundary.legacy) !== JSON.stringify(state.revisions.map(r => ({ revisionId: r.manifest.revisionId, manifestSha256: r.completion.manifestSha256 })))) throw new Error('History changed during interrupted component enrollment.');
    for (const seed of boundary.seeds) {
      const revision = state.revisions.find(r => r.manifest.revisionId === seed.revisionId);
      if (!revision) throw new Error('Enrollment baseline is missing.');
      validateFiles(seed.files, revision.manifest);
    }
  } else {
    if (await vault.hasDirectory(directory) && (await (await vault.getDirectory(directory)).listEntries()).length) throw new Error('Incomplete component records cannot be regenerated.');
    const heads = new Set(state.branches.map(b => getBranchBaseline(state, b.branchId)?.revisionId).filter(Boolean));
    boundary = seal({ schemaVersion: 1, projectId: state.project.projectId, createdAt: new Date().toISOString(),
      legacy: state.revisions.map(r => ({ revisionId: r.manifest.revisionId, manifestSha256: r.completion.manifestSha256 })),
      seeds: state.revisions.filter(r => heads.has(r.manifest.revisionId)).map(r => ({ revisionId: r.manifest.revisionId, files: r.manifest.files.map(f => ({ path: f.path, componentId: id() })) })),
    });
    await vault.getDirectory(directory, { create: true });
    await writeVerified(vault, boundaryPath, boundary);
  }
  await vault.getDirectory([...directory, 'revisions'], { create: true });
  const text = await vault.readFileText(boundaryPath);
  await writeVerified(vault, readyPath, { schemaVersion: 1, projectId: state.project.projectId, recordSha256: hashString(text) });
}
export async function enableComponentTracking(vault: FileSystemDirectoryAdapter): Promise<VaultState> {
  const { openExistingVault } = await import('./vault-service');
  const initial = await openExistingVault(vault);
  return withProjectWriterLock(initial.project.projectId, async () => {
    const state = await openExistingVault(vault);
    if (state.project.projectId !== initial.project.projectId) throw new Error('Project changed before component enrollment.');
    await writeComponentBoundary(vault, state);
    const updated = await openExistingVault(vault);
    if (updated.components?.status !== 'available') throw new Error(updated.components?.reason ?? 'Component enrollment failed.');
    return updated;
  });
}
export function componentWriteBlock(state: VaultState): string | undefined {
  if (!state.components || state.components.status === 'legacy') return undefined;
  return state.components.status === 'available' ? undefined : state.components.reason;
}
export function createIdentityReview(state: VaultState, scan: ScanResult, renames: RenameDecision[], replacements: string[]): IdentityReview {
  if (state.components?.status !== 'available') throw new Error('Enable component tracking before confirming identity decisions.');
  return { projectId: state.project.projectId, branchId: scan.branchId, baselineRevisionId: scan.baselineRevisionId,
    baselineManifestSha256: state.revisions.find(r => r.manifest.revisionId === scan.baselineRevisionId)?.completion.manifestSha256 ?? null,
    boundarySha256: state.components.boundary!.payloadSha256, changesSignature: scan.changesSignature,
    renames: renames.map(r => ({ ...r })), replacements: [...replacements] };
}
function validateDecisions(renames: RenameDecision[], replacements: string[], before: ComponentFile[], paths: string[]) {
  if (!Array.isArray(renames) || !Array.isArray(replacements)) throw new Error('Invalid component decisions.');
  const from = new Set<string>(), to = new Set<string>();
  for (const rename of renames) {
    if (!before.some(f => f.path === rename.from) || paths.includes(rename.from) || before.some(f => f.path === rename.to) || !paths.includes(rename.to) || from.has(rename.from) || to.has(rename.to)) throw new Error('Rename decisions must associate one missing tracked path with one new path.');
    from.add(rename.from); to.add(rename.to);
  }
  if (new Set(replacements).size !== replacements.length || replacements.some(p => !paths.includes(p) || !before.some(f => f.path === p) || to.has(p))) throw new Error('Invalid replacement decision.');
}
export function prepareComponentRecord(state: VaultState, scan: ScanResult, review?: IdentityReview): Omit<ComponentRecord, 'revisionId' | 'manifestSha256' | 'payloadSha256'> | undefined {
  const block = componentWriteBlock(state);
  if (block) throw new Error(block);
  if (state.components?.status !== 'available') {
    if (review) throw new Error('Component tracking has not been enabled.');
    return undefined;
  }
  const parent = scan.baselineRevisionId ? state.components.revisions[scan.baselineRevisionId] : undefined;
  if (review) {
    const expected = createIdentityReview(state, scan, review.renames, review.replacements);
    if (expected.projectId !== review.projectId || expected.branchId !== review.branchId || expected.baselineRevisionId !== review.baselineRevisionId || expected.baselineManifestSha256 !== review.baselineManifestSha256 || expected.boundarySha256 !== review.boundarySha256 || expected.changesSignature !== review.changesSignature) throw new Error('Component decisions are stale. Scan and confirm again.');
  }
  const files = [...scan.added, ...scan.modified.map(m => m.current), ...scan.unchanged].sort((a,b) => a.path.localeCompare(b.path));
  const renames = (review?.renames ?? []).map(r => ({ ...r })), replacements = [...(review?.replacements ?? [])];
  validateDecisions(renames, replacements, parent?.files ?? [], files.map(f => f.path));
  const application = state.applicationOperations?.find(op => op.destinationBranchId === scan.branchId && op.status === 'applied');
  const transfers: ComponentRecord['transfers'] = (application?.record?.plan.actions ?? []).filter(a => a.operation === 'add' && files.some(f => f.path === a.path)).map(a => {
    const sourceRevisionId = application!.record!.plan.sourceRevisionId;
    const component = state.components!.revisions[sourceRevisionId]?.files.find(f => f.path === a.path);
    if (!component) throw new Error('Applied source component records are unavailable.');
    return { path: a.path, componentId: component.componentId, sourceRevisionId, operationId: application!.operationId };
  });
  // Get this version: a file put back at a path the baseline lacks keeps the
  // component recorded by the finished operation, but only while that file is
  // byte-for-byte what was written (recorded evidence, never guessed). If two
  // such operations disagree on the component of a path, or put the same
  // component back at two paths, none of them is used (no order is inferred);
  // those files then get a new identity like any other added file.
  // A path the baseline has keeps its identity by path (no transfer needed).
  const restored = (state.applicationOperations ?? []).map(op => restoredTransfer(state, op, scan.branchId, scan.baselineRevisionId, files)).filter(t => t !== undefined).filter(t => !parent?.files.some(f => f.path === t.path || f.componentId === t.componentId));
  for (const transfer of restored) {
    if (restored.some(t => (t.path === transfer.path) !== (t.componentId === transfer.componentId))) continue;
    if (transfers.some(t => t.path === transfer.path || t.componentId === transfer.componentId)) continue;
    if (renames.some(r => r.to === transfer.path)) throw new Error(`Component identity conflict at "${transfer.path}": this file was just put back with Get this version; save it first, then rename.`);
    transfers.push(transfer);
  }
  const draft = { schemaVersion: 1, projectId: state.project.projectId, branchId: scan.branchId, boundarySha256: state.components.boundary!.payloadSha256,
    parentIdentitySha256: parent?.payloadSha256 ?? null, renames, replacements, transfers,
    files: files.map(file => ({ path: file.path, componentId: replacements.includes(file.path) ? id() : transfers.find(t => t.path === file.path)?.componentId ?? parent?.files.find(f => f.path === (renames.find(r => r.to === file.path)?.from ?? file.path))?.componentId ?? id() })),
  };
  // Check the whole proposed snapshot while still read-only, before capture can
  // write application provenance, component evidence or a completion marker.
  const allocated = new Set(Object.values(state.components.revisions).flatMap(r => r.files.map(f => f.componentId)));
  validateAssociations(draft, parent?.files ?? [], { files }, allocated);
  return draft;
}
/**
 * The identity transfer a finished Get this version operation supports for a
 * save on `baselineRevisionId` (the caller drops paths the baseline has): it
 * was made on that same baseline, it recorded the
 * file's component (equal to the target revision's evidence), and the file to
 * be saved still has exactly the bytes it wrote. Otherwise undefined.
 */
function restoredTransfer(state: VaultState, op: NonNullable<VaultState['applicationOperations']>[number], branchId: string, baselineRevisionId: string | null, files: { path: string; sha256: string; size: number }[]) {
  const plan = op.record?.plan;
  if (op.status !== 'done' || op.destinationBranchId !== branchId || plan?.mode !== 'restore-file' || !plan.componentId || plan.destinationRevisionId !== baselineRevisionId) return undefined;
  // Its one file (written over an unsaved new file or into an empty place alike).
  const action = plan.actions.find(a => a.after);
  const file = action && files.find(f => f.path === action.path);
  if (!action?.after || !file || file.sha256 !== action.after.sha256 || file.size !== action.after.size) return undefined;
  const evidence = state.components?.revisions[plan.sourceRevisionId]?.files.find(f => f.path === action.path);
  if (evidence?.componentId !== plan.componentId) return undefined;
  return { path: action.path, componentId: plan.componentId, sourceRevisionId: plan.sourceRevisionId, operationId: op.operationId };
}
export async function publishComponentRecord(vault: FileSystemDirectoryAdapter, draft: NonNullable<ReturnType<typeof prepareComponentRecord>>, revisionId: string, manifestSha256: string) {
  await writeVerified(vault, recordPath(revisionId), seal({ ...draft, revisionId, manifestSha256 }));
}
export function possibleRenames(scan: ScanResult): { from: string; candidates: string[] }[] {
  return scan.deleted.map(f => ({ from: f.path, candidates: scan.added.filter(n => n.sha256 === f.sha256).map(n => n.path) }));
}
