import { FileConflictError, type FileSystemDirectoryAdapter } from './fs-adapter';
import { isRecordId, newRecordId } from './ids';
import { hashStream, hashString } from './hash';
import { compactHex, expandHex } from './path-encoding';
import { getObjectPathSegments, verifyStoredObject, writeAndVerifyObject } from './object-store';
import { withProjectWriterLock } from './locks';
import { throwIfCancelled, type CopyOptions } from './copy-service';
import type { ComponentFile } from './component-identity';
import type { RevisionManifest, ScanResult, VaultState } from './types';

export interface ReferenceAuthor { id: string; displayName: string }
export interface ReferenceVersion { referenceId: string; versionId: string; originalFilename: string; fileType: string; size: number; sha256: string; importedAt: string; savedBy?: ReferenceAuthor }
export interface ProjectReference { referenceId: string; title: string; description: string; tags: string[]; versions: ReferenceVersion[]; projectVersionId: string | null; removed: boolean }
interface Boundary { schemaVersion: number; projectId: string; createdAt: string; legacy: { revisionId: string; manifestSha256: string }[]; payloadSha256: string }
export interface ReferenceCatalog { schemaVersion: number; projectId: string; catalogId: string; parent: { catalogId: string; sha256: string } | null; references: ProjectReference[]; payloadSha256: string }
export interface ReferenceLinkInput { referenceId: string; versionId: string; locator: string; explanation: string; component?: { kind: 'existing'; componentId: string } | { kind: 'pending'; path: string } }
export interface PendingReferenceAttachment { source: AttachmentSource; explanation: string; component?: ReferenceLinkInput['component'] }
export interface ReferenceLink { referenceId: string; versionId: string; origin: 'project' | 'revision'; locator: string; explanation: string; componentId: string | null; componentPath: string | null }
export interface ReferenceReview { projectId: string; branchId: string; baselineRevisionId: string | null; baselineManifestSha256: string | null; changesSignature: string; boundarySha256: string | null; catalogId: string | null; catalogSha256: string | null; explicit: ReferenceLinkInput[] }
export interface RevisionReferenceContext { schemaVersion: number; projectId: string; revisionId: string; branchId: string; parentRevisionId: string | null; manifestSha256: string; boundarySha256: string; catalogId: string | null; catalogSha256: string | null; links: ReferenceLink[]; contextOnly: boolean; payloadSha256: string }
export interface ReferenceEvidence {
  status: 'legacy' | 'available' | 'unavailable' | 'unsupported'; reason?: string;
  boundary?: Boundary; library: ProjectReference[]; catalogId: string | null; catalogSha256: string | null;
  enrollmentIncomplete?: boolean;
  catalogs: Record<string, { record: ReferenceCatalog; sha256: string }>;
  contexts: Record<string, { status: 'legacy' | 'available' | 'unavailable'; record?: RevisionReferenceContext; reason?: string }>;
}
const ROOT = ['reference-context.json'];
const DATA = ['references'];
/** Bounded retries when a freshly drawn record ID is already taken on disk. */
export const MAX_REFERENCE_ID_ATTEMPTS = 20;
/**
 * New reference records (enrollment, catalog, reference, version, import session) use the short record ID.
 * Existing ones keep `<prefix>-<uuid>`. Which KIND an ID is follows from where it appears (field or folder),
 * never from its text, because new IDs carry no prefix.
 */
const safeId = (value: unknown, prefix: string) => typeof value === 'string' && (isRecordId(value) || new RegExp(`^${prefix}-[0-9a-f-]{36}$`).test(value));
/** A record ID not already used by a reference or version of this library (or by this batch). */
function freshLibraryId(taken: Set<string>, draw: () => string = newRecordId) {
  for (let attempt = 1; attempt <= MAX_REFERENCE_ID_ATTEMPTS; attempt++) {
    const candidate = draw();
    if (!isRecordId(candidate)) throw new Error('Invalid reference record ID. Nothing was written.');
    if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
  }
  throw new Error(`No free reference record ID after ${MAX_REFERENCE_ID_ATTEMPTS} attempts. Nothing was written. Try again.`);
}
const libraryIds = (library: ProjectReference[]) => new Set(library.flatMap(r => [r.referenceId, ...r.versions.map(v => v.versionId)]));
const checksum = /^[0-9a-f]{64}$/;
export function referenceChecksum(value: object) { const { payloadSha256: _, ...body } = value as Record<string, unknown>; return hashString(JSON.stringify(body)); }
function seal<T extends object>(value: T): T & { payloadSha256: string } { return { ...value, payloadSha256: referenceChecksum(value) }; }
function validateSeal(value: { schemaVersion: number; projectId: string; payloadSha256: string }, projectId: string) {
  if (value.schemaVersion !== 1) throw new Error('Unsupported reference metadata schema.');
  if (value.projectId !== projectId || value.payloadSha256 !== referenceChecksum(value)) throw new Error('Reference checksum or project binding mismatch.');
}
function text(value: unknown, limit = 16000): asserts value is string { if (typeof value !== 'string' || value.length > limit || value.includes('\0')) throw new Error('Invalid reference text metadata.'); }
function validateReferenceAuthor(author: ReferenceAuthor) {
  if (!author || typeof author !== 'object' || Array.isArray(author)) throw new Error('Invalid reference author.');
  text(author.id, 1000); text(author.displayName, 1000);
  if (!author.id.trim() || !author.displayName.trim()) throw new Error('Invalid reference author.');
}
function validateLibrary(library: ProjectReference[], previous: ProjectReference[] = []) {
  if (!Array.isArray(library)) throw new Error('Invalid reference library.');
  const refs = new Set<string>(), versions = new Set<string>();
  for (const ref of library) {
    if (!safeId(ref.referenceId, 'reference') || refs.has(ref.referenceId)) throw new Error('Duplicate or invalid reference identity.');
    refs.add(ref.referenceId); text(ref.title, 1000); text(ref.description);
    if (!ref.title.trim() || !Array.isArray(ref.tags) || ref.tags.length > 50 || new Set(ref.tags).size !== ref.tags.length || typeof ref.removed !== 'boolean') throw new Error('Invalid reference metadata.');
    ref.tags.forEach(tag => text(tag, 128));
    if (!Array.isArray(ref.versions) || !ref.versions.length) throw new Error('A reference must preserve its versions.');
    for (const v of ref.versions) {
      // New IDs have no kind prefix: a version ID must never equal any reference ID.
      if (v.referenceId !== ref.referenceId || !safeId(v.versionId, 'reference-version') || versions.has(v.versionId) || library.some(r => r.referenceId === v.versionId) || !Number.isSafeInteger(v.size) || v.size < 0 || !checksum.test(v.sha256) || !Number.isFinite(Date.parse(v.importedAt))) throw new Error('Invalid attachment version metadata.');
      text(v.originalFilename, 1024); text(v.fileType, 256);
      if (v.savedBy !== undefined) validateReferenceAuthor(v.savedBy);
      if (!v.originalFilename || /[\x00-\x1f\x7f]/.test(v.originalFilename)) throw new Error('Invalid original attachment filename.');
      versions.add(v.versionId);
    }
    if (ref.projectVersionId !== null && (ref.removed || !ref.versions.some(v => v.versionId === ref.projectVersionId))) throw new Error('Invalid project reference version.');
  }
  for (const old of previous) {
    const current = library.find(r => r.referenceId === old.referenceId);
    if (!current || JSON.stringify(current.versions.slice(0, old.versions.length)) !== JSON.stringify(old.versions)) throw new Error('Published reference versions were removed or rewritten.');
  }
}
async function writeVerified(vault: FileSystemDirectoryAdapter, path: string[], value: object) {
  const content = JSON.stringify(value, null, 2);
  await vault.writeFileText(path, content, { exclusive: true });
  if (await vault.readFileText(path) !== content) throw new Error('Reference publication readback failed.');
  return hashString(content);
}
// The browser creates files before writing them. Only directory creation is the
// final publication step: its name binds the already verified immutable bytes.
async function commitDirectory(vault: FileSystemDirectoryAdapter, path: string[]) {
  const marker = await vault.getDirectory(path, { create: true, exclusiveCreate: true });
  if ((await marker.listEntries()).length) throw new Error('Reference publication directory is not empty.');
}
const isNewRecordId = (value: string): boolean => isRecordId(value);
function publicationDirectoryName(id: string, sha256: string) {
  // New record IDs are 22 characters and already short: `<recordId>.<compact sha>.done`.
  if (isNewRecordId(id)) return `${id}.${compactHex(sha256)}.done`;
  // Preserve every UUID/checksum bit, but omit the redundant record prefix and
  // encode the bytes as base64url. The old enrollment marker made
  // ordinary managed Windows project paths exceed the directory creation limit.
  const uuid = id.slice(-36).replace(/-/g, '');
  return `${compactHex(uuid)}.${compactHex(sha256)}.done`;
}
export const referenceEnrollmentRecordPath = (id: string): string[] => [...DATA, 'enrollment', `${id}.json`];
export const referenceEnrollmentMarkerPath = (id: string, sha256: string): string[] => [...DATA, 'enrollment', publicationDirectoryName(id, sha256)];
export const referenceCatalogPath = (catalogId: string): string[] => [...DATA, 'catalogs', `${catalogId}.json`];
export const referenceCatalogMarkerPath = (catalogId: string, sha256: string): string[] => [...DATA, 'completed', publicationDirectoryName(catalogId, sha256)];
export const referenceContextPath = (revisionId: string): string[] => [...DATA, 'contexts', `${revisionId}.json`];
function directoryPublication(name: string, prefix: string) {
  // A new record ID and a legacy compact UUID are both 22 characters. Legacy IDs come from
  // crypto.randomUUID() (v4): byte 6 is 0x4_, so base64url character 8 (bits 48-53) is one of Q/R/S/T and
  // can never be '-'. A record ID always has '-' at index 8, so this test cleanly separates the two.
  const fresh = /^(\d{8}-\d{6}-[0-9a-z]{6})\.([A-Za-z0-9_-]{43})\.done$/.exec(name);
  if (fresh && isRecordId(fresh[1])) return { id: fresh[1], sha256: expandHex(fresh[2]) };
  const compact = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})\.done$/.exec(name);
  if (compact) {
    const uuid = expandHex(compact[1]).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    return { id: `${prefix}-${uuid}`, sha256: expandHex(compact[2]) };
  }
  // Retain the original directory format for already-published vaults.
  const match = /^(.+)\.([a-f0-9]{64})\.done$/.exec(name);
  if (!match || !safeId(match[1], prefix)) throw new Error('Unexpected reference publication directory.');
  return { id: match[1], sha256: match[2] };
}
async function readDirectoryPublication(vault: FileSystemDirectoryAdapter, markerPath: string[], recordPath: string[], sha256: string) {
  if ((await (await vault.getDirectory(markerPath)).listEntries()).length) throw new Error('Reference publication directory was modified.');
  const content = await vault.readFileText(recordPath);
  if (hashString(content) !== sha256) throw new Error('Committed reference record checksum mismatch.');
  return JSON.parse(content);
}
async function readEnrollment(vault: FileSystemDirectoryAdapter, state: VaultState) {
  const path = [...DATA, 'enrollment'];
  const published: Boundary[] = [], prepared: string[] = [], completed = new Set<string>();
  const pending = await vault.hasDirectory(path);
  if (pending) for (const entry of await (await vault.getDirectory(path)).listEntries()) {
    if (entry.kind === 'file' && entry.name.endsWith('.json') && safeId(entry.name.slice(0, -5), 'reference-enrollment')) prepared.push(entry.name);
    else {
      const marker = directoryPublication(entry.name, 'reference-enrollment');
      if (entry.kind !== 'directory' || completed.has(marker.id)) throw new Error('Invalid or competing reference enrollment publication.');
      completed.add(marker.id);
      published.push(await readDirectoryPublication(vault, [...path, entry.name], [...path, `${marker.id}.json`], marker.sha256));
    }
  }
  for (const name of prepared) if (!completed.has(name.slice(0, -5))) state.incompleteAttempts.push({ id: name.slice(0, -5), kind: 'uncompleted_reference', path: [...path, name].join('/'), detail: 'Reference enrollment was interrupted before publication; a fresh enrollment may be retried.' });
  if (pending && !prepared.length && !published.length) state.incompleteAttempts.push({ id: 'reference-enrollment', kind: 'uncompleted_reference', path: path.join('/'), detail: 'Reference enrollment stopped before its record was written; a fresh enrollment may be retried.' });
  if (await vault.hasFile(ROOT)) published.push(JSON.parse(await vault.readFileText(ROOT)));
  if (published.length > 1) throw new Error('Competing reference enrollment evidence.');
  return { boundary: published[0], pending };
}
function versionIn(library: ProjectReference[], referenceId: string, versionId: string) {
  const ref = library.find(r => r.referenceId === referenceId);
  const version = ref?.versions.find(v => v.versionId === versionId);
  if (!ref || !version) throw new Error('The selected reference version is missing or not published.');
  return { ref, version };
}
export function referenceContextSignature(links: ReferenceLink[]): string {
  return hashString(JSON.stringify(links.map(({ componentPath: _, ...link }) => link).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))));
}
function validateLinks(links: ReferenceLink[], library: ProjectReference[], components: ComponentFile[], manifest?: RevisionManifest) {
  if (!Array.isArray(links)) throw new Error('Invalid reference associations.');
  const seen = new Set<string>();
  for (const link of links) {
    const { ref } = versionIn(library, link.referenceId, link.versionId);
    text(link.locator, 2000); text(link.explanation, 8000);
    if (!['project', 'revision'].includes(link.origin)) throw new Error('Invalid reference association origin.');
    if (link.origin === 'project' && (ref.projectVersionId !== link.versionId || link.componentId !== null || link.componentPath !== null || link.locator || link.explanation)) throw new Error('Inherited project reference does not match its captured defaults.');
    if (link.componentId !== null) {
      const file = components.find(f => f.componentId === link.componentId);
      if (!file || file.path !== link.componentPath || (manifest && !manifest.files.some(f => f.path === file.path))) throw new Error('Reference component association does not match the committed component mapping.');
    } else if (link.componentPath !== null) throw new Error('A component path cannot establish identity by itself.');
    const key = JSON.stringify(link);
    if (seen.has(key)) throw new Error('Duplicate reference association.');
    seen.add(key);
  }
  const inherited = library.filter(r => r.projectVersionId !== null && !r.removed);
  if (inherited.length !== links.filter(l => l.origin === 'project').length || inherited.some(r => !links.some(l => l.origin === 'project' && l.referenceId === r.referenceId && l.versionId === r.projectVersionId))) throw new Error('The recorded project reference defaults are incomplete.');
}

/** Metadata reconstruction stays independent of CAD manifest/recovery validity. */
export async function readReferenceEvidence(vault: FileSystemDirectoryAdapter, state: VaultState): Promise<ReferenceEvidence> {
  const result: ReferenceEvidence = { status: 'legacy', library: [], catalogId: null, catalogSha256: null, catalogs: {}, contexts: Object.fromEntries(state.revisions.map(r => [r.manifest.revisionId, { status: 'legacy' }])) };
  try {
    for (const key of Object.keys(result.contexts)) result.contexts[key] = { status: 'unavailable', reason: 'Reference enrollment is unavailable.' };
    const enrollment = await readEnrollment(vault, state);
    if (!enrollment.boundary) {
      for (const revision of state.revisions.filter(r => r.completion.referenceContext !== undefined)) result.contexts[revision.manifest.revisionId] = { status: 'unavailable', reason: 'Committed reference context evidence is missing.' };
      if (state.revisions.some(r => r.completion.referenceContext !== undefined)) throw new Error('Committed reference enrollment evidence is missing; it cannot be regenerated as legacy history.');
      const entries = await vault.listEntries();
      const dataEntry = entries.find(e => e.name === DATA[0]);
      const dataEntries = dataEntry?.kind === 'directory' ? await (await vault.getDirectory(DATA)).listEntries() : undefined;
      const emptyParent = dataEntries?.length === 0;
      const onlyPendingEnrollment = emptyParent || (enrollment.pending && Boolean(dataEntries?.every(e => e.name === 'enrollment' && e.kind === 'directory')));
      if (entries.some(e => e.name === ROOT[0]) || (entries.some(e => e.name === DATA[0]) && !onlyPendingEnrollment)) throw new Error('Reference enrollment evidence is missing; existing storage cannot be regenerated.');
      if (onlyPendingEnrollment) result.enrollmentIncomplete = true;
      if (emptyParent) state.incompleteAttempts.push({ id: 'reference-setup', kind: 'uncompleted_reference', path: DATA.join('/'), detail: 'Reference setup stopped after creating its empty parent folder; enrollment may be retried.' });
      for (const key of Object.keys(result.contexts)) result.contexts[key] = { status: 'legacy' };
      return result;
    }
    result.status = 'unavailable';
    for (const key of Object.keys(result.contexts)) result.contexts[key] = { status: 'unavailable', reason: 'Reference enrollment is unavailable.' };
    const boundary = enrollment.boundary; validateSeal(boundary, state.project.projectId);
    if (!Array.isArray(boundary.legacy) || new Set(boundary.legacy.map(r => r.revisionId)).size !== boundary.legacy.length) throw new Error('Invalid reference enrollment boundary.');
    result.boundary = boundary;
    const legacy = new Set<string>();
    for (const old of boundary.legacy) {
      const revision = state.revisions.find(r => r.manifest.revisionId === old.revisionId);
      if (typeof old.revisionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(old.revisionId) || !checksum.test(old.manifestSha256) || revision?.completion.manifestSha256 !== old.manifestSha256 || revision.completion.referenceContext !== undefined) throw new Error('Reference legacy boundary differs from committed history.');
      legacy.add(old.revisionId); result.contexts[old.revisionId] = { status: 'legacy' };
    }
    const catalogs: { record: ReferenceCatalog; sha256: string }[] = [];
    if (await vault.hasDirectory([...DATA, 'completed'])) for (const entry of await (await vault.getDirectory([...DATA, 'completed'])).listEntries()) {
      if (entry.kind === 'directory') {
        const marker = directoryPublication(entry.name, 'reference-catalog');
        const record: ReferenceCatalog = await readDirectoryPublication(vault, [...DATA, 'completed', entry.name], [...DATA, 'catalogs', `${marker.id}.json`], marker.sha256);
        validateSeal(record, state.project.projectId);
        if (record.catalogId !== marker.id) throw new Error('Reference catalog publication mismatch.');
        catalogs.push({ record, sha256: marker.sha256 });
        continue;
      }
      // Existing file markers remain strict: malformed committed evidence is
      // not reclassified as an interrupted attempt or silently discarded.
      const catalogId = entry.name.replace(/\.done\.json$/, '');
      if (entry.kind !== 'file' || !safeId(catalogId, 'reference-catalog') || entry.name !== `${catalogId}.done.json`) throw new Error('Unexpected reference catalog publication.');
      const marker = JSON.parse(await vault.readFileText([...DATA, 'completed', entry.name])); validateSeal(marker, state.project.projectId);
      const content = await vault.readFileText([...DATA, 'catalogs', `${catalogId}.json`]);
      const record: ReferenceCatalog = JSON.parse(content); validateSeal(record, state.project.projectId);
      if (marker.catalogId !== catalogId || record.catalogId !== catalogId || marker.recordSha256 !== hashString(content)) throw new Error('Reference catalog publication mismatch.');
      catalogs.push({ record, sha256: marker.recordSha256 });
    }
    let current: { record: ReferenceCatalog; sha256: string } | undefined;
    while (catalogs.length) {
      const next = catalogs.filter(c => current ? c.record.parent?.catalogId === current.record.catalogId && c.record.parent.sha256 === current.sha256 : c.record.parent === null);
      if (next.length !== 1) throw new Error('Reference library has missing, competing or cyclic catalog evidence.');
      const candidate = next[0]; validateLibrary(candidate.record.references, current?.record.references);
      catalogs.splice(catalogs.indexOf(candidate), 1); result.catalogs[candidate.record.catalogId] = candidate; current = candidate;
    }
    if (current) { result.library = current.record.references; result.catalogId = current.record.catalogId; result.catalogSha256 = current.sha256; }
    if (await vault.hasDirectory([...DATA, 'catalogs'])) for (const entry of await (await vault.getDirectory([...DATA, 'catalogs'])).listEntries()) {
      const id = entry.name.replace(/\.json$/, '');
      if (entry.kind !== 'file' || !safeId(id, 'reference-catalog')) throw new Error('Unexpected reference catalog evidence.');
      if (!result.catalogs[id]) state.incompleteAttempts.push({ id, kind: 'uncompleted_reference', path: `references/catalogs/${entry.name}`, detail: 'Reference import/edit has no verified publication marker.' });
    }
    let contextError = '';
    for (const revision of state.revisions) {
      const revisionId = revision.manifest.revisionId;
      if (legacy.has(revisionId)) {
        if (await vault.hasFile([...DATA, 'contexts', `${revisionId}.json`])) throw new Error('Reference context conflicts with the legacy boundary.');
        continue;
      }
      try {
        const publication = revision.completion.referenceContext;
        if (publication?.schemaVersion !== 1) throw new Error(publication ? 'Unsupported committed reference context schema.' : 'Revision completion has no required reference context binding.');
        const content = await vault.readFileText([...DATA, 'contexts', `${revisionId}.json`]);
        if (publication.contextSha256 !== hashString(content) || publication.boundarySha256 !== boundary.payloadSha256) throw new Error('Committed reference context checksum or enrollment binding mismatch.');
        const record: RevisionReferenceContext = JSON.parse(content); validateSeal(record, state.project.projectId);
        if (record.revisionId !== revisionId || record.branchId !== revision.manifest.branchId || record.parentRevisionId !== revision.manifest.parentRevisionId || record.manifestSha256 !== revision.completion.manifestSha256 || record.boundarySha256 !== boundary.payloadSha256 || typeof record.contextOnly !== 'boolean') throw new Error('Reference context does not bind to the exact committed revision.');
        const catalog = record.catalogId === null ? undefined : result.catalogs[record.catalogId];
        if (record.catalogId === null ? record.catalogSha256 !== null : !catalog || catalog.sha256 !== record.catalogSha256) throw new Error('Reference context catalog is missing or mismatched.');
        validateLinks(record.links, catalog?.record.references ?? [], state.components?.status === 'available' ? state.components.revisions[revisionId]?.files ?? [] : [], revision.manifest);
        result.contexts[revisionId] = { status: 'available', record };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        result.contexts[revisionId] = { status: 'unavailable', reason };
        contextError ||= reason;
      }
    }
    if (await vault.hasDirectory([...DATA, 'contexts'])) for (const entry of await (await vault.getDirectory([...DATA, 'contexts'])).listEntries()) {
      const id = entry.name.replace(/\.json$/, '');
      if (entry.kind !== 'file' || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Unexpected reference context evidence.');
      if (!state.revisions.some(r => r.manifest.revisionId === id)) state.incompleteAttempts.push({ id, kind: 'uncompleted_reference', path: `references/contexts/${entry.name}`, detail: 'Reference context has no committed revision and is not historical context.' });
    }
    for (const ref of result.library) for (const v of ref.versions) if (!await vault.hasFile(getObjectPathSegments(v.sha256))) throw new Error(`Attachment content is missing: ${v.originalFilename} (${v.versionId}).`);
    if (contextError) throw new Error(contextError);
    result.status = 'available';
  } catch (error) {
    result.reason = `Reference evidence unavailable: ${error instanceof Error ? error.message : String(error)}`;
    result.status = /Unsupported/.test(result.reason) ? 'unsupported' : 'unavailable';
  }
  return result;
}
export function referenceWriteBlock(state: VaultState): string | undefined { return state.references && !['legacy', 'available'].includes(state.references.status) ? state.references.reason ?? 'Reference evidence is unavailable.' : undefined; }
export async function ensureReferenceStore(vault: FileSystemDirectoryAdapter, state: VaultState, newId: () => string = newRecordId): Promise<Boundary> {
  const block = referenceWriteBlock(state); if (block) throw new Error(block);
  if (state.references?.boundary) return state.references.boundary;
  if (await vault.hasFile(ROOT) || (await vault.hasDirectory(DATA) && !state.references?.enrollmentIncomplete)) throw new Error('Existing reference evidence cannot be regenerated.');
  const boundary = seal({ schemaVersion: 1, projectId: state.project.projectId, createdAt: new Date().toISOString(), legacy: state.revisions.map(r => ({ revisionId: r.manifest.revisionId, manifestSha256: r.completion.manifestSha256 })) });
  // The enrollment record file is the first exclusive write; a clash draws a new ID before anything else is written.
  let id = '', sha256 = '';
  for (let attempt = 1; ; attempt++) {
    const candidate = newId();
    if (!isRecordId(candidate)) throw new Error('Invalid reference record ID. Nothing was written.');
    try { sha256 = await writeVerified(vault, referenceEnrollmentRecordPath(candidate), boundary); id = candidate; break; }
    catch (error) { if (!(error instanceof FileConflictError)) throw error; }
    if (attempt >= MAX_REFERENCE_ID_ATTEMPTS) throw new Error(`No free reference record ID after ${MAX_REFERENCE_ID_ATTEMPTS} attempts. Nothing was written. Try again.`);
  }
  await commitDirectory(vault, referenceEnrollmentMarkerPath(id, sha256));
  return boundary;
}
async function publishCatalog(vault: FileSystemDirectoryAdapter, state: VaultState, library: ProjectReference[], signal?: AbortSignal, importedVersions: ReferenceVersion[] = [], newId: () => string = newRecordId) {
  validateLibrary(library, state.references?.library);
  await ensureReferenceStore(vault, state, newId);
  // The catalog record file is the first exclusive write for this record; a clash draws a new ID first.
  let record!: ReferenceCatalog, recordSha256 = '';
  for (let attempt = 1; ; attempt++) {
    const candidate = newId();
    if (!isRecordId(candidate)) throw new Error('Invalid reference record ID. Nothing was written.');
    record = seal({ schemaVersion: 1, projectId: state.project.projectId, catalogId: candidate, parent: state.references?.catalogId ? { catalogId: state.references.catalogId, sha256: state.references.catalogSha256! } : null, references: library });
    try { recordSha256 = await writeVerified(vault, referenceCatalogPath(candidate), record); break; }
    catch (error) { if (!(error instanceof FileConflictError)) throw error; }
    if (attempt >= MAX_REFERENCE_ID_ATTEMPTS) throw new Error(`No free reference record ID after ${MAX_REFERENCE_ID_ATTEMPTS} attempts. No reference catalog was written. Try again.`);
  }
  throwIfCancelled(signal);
  for (const importedVersion of importedVersions) {
    const checked = await verifyStoredObject(vault, importedVersion.sha256, importedVersion.size, signal);
    if (!checked.valid) throw new Error('Attachment changed before reference publication.');
  }
  throwIfCancelled(signal);
  await commitDirectory(vault, referenceCatalogMarkerPath(record.catalogId, recordSha256));
}
export interface ReferenceMetadata { title: string; description: string; tags: string[] }
function cleanMetadata(input: ReferenceMetadata): ReferenceMetadata { return { title: input.title.trim(), description: input.description, tags: [...new Set(input.tags.map(t => t.trim()).filter(Boolean))] }; }
export interface AttachmentSource { name: string; type: string; size: number; stream: () => ReadableStream<Uint8Array> }
export interface ReferenceImportOptions extends CopyOptions {
  savedBy?: ReferenceAuthor;
  /** Test seam: supplies each candidate record ID for the enrollment and catalog files (the exclusive claims). Defaults to newRecordId(). */
  newRecordId?: () => string;
}
export async function importReferenceAttachment(vault: FileSystemDirectoryAdapter, projectId: string, source: AttachmentSource, metadata: ReferenceMetadata, referenceId?: string, options: ReferenceImportOptions = {}): Promise<VaultState> {
  return withProjectWriterLock(projectId, async () => {
    const { openExistingVault } = await import('./vault-service'); const state = await openExistingVault(vault);
    if (state.project.projectId !== projectId) throw new Error('Project changed before reference import.');
    const block = referenceWriteBlock(state); if (block) throw new Error(block);
    throwIfCancelled(options.signal);
    if (options.savedBy !== undefined) validateReferenceAuthor(options.savedBy);
    const savedBy = options.savedBy ? { id: options.savedBy.id, displayName: options.savedBy.displayName } : undefined;
    const measured = await hashStream(source.stream(), { signal: options.signal });
    if (measured.size !== source.size) throw new Error('Attachment changed while being imported.');
    const library = structuredClone(state.references?.library ?? []);
    const existing = referenceId ? library.find(r => r.referenceId === referenceId) : undefined;
    if (referenceId && !existing) throw new Error('Choose a published reference before adding a version.');
    const taken = libraryIds(library);
    const id = existing?.referenceId ?? freshLibraryId(taken);
    const version: ReferenceVersion = { referenceId: id, versionId: freshLibraryId(taken), originalFilename: source.name, fileType: source.type || 'application/octet-stream', size: measured.size, sha256: measured.sha256, importedAt: new Date().toISOString(), ...(savedBy ? { savedBy } : {}) };
    if (existing) { existing.versions.push(version); Object.assign(existing, cleanMetadata(metadata)); }
    else library.push({ referenceId: id, ...cleanMetadata(metadata), versions: [version], projectVersionId: null, removed: false });
    validateLibrary(library, state.references?.library);
    options.onProgress?.({ phase: 'writing_objects', processedFiles: 0, totalFiles: 1, processedBytes: 0, totalBytes: measured.size, message: 'Copying and verifying the original reference attachment.' });
    await writeAndVerifyObject(vault, newRecordId(), measured.sha256, measured.size, async () => source.stream(), options.signal);
    throwIfCancelled(options.signal);
    await publishCatalog(vault, state, library, options.signal, [version], options.newRecordId);
    return openExistingVault(vault);
  });
}
/** Capture already owns the project writer lock. Validate the entire batch before publication. */
export async function storeCaptureReferenceAttachments(vault: FileSystemDirectoryAdapter, state: VaultState, scan: ScanResult, files: ComponentFile[], review: ReferenceReview | undefined, attachments: PendingReferenceAttachment[], options: ReferenceImportOptions = {}) {
  prepareReferenceContext(state, scan, files, review);
  if (options.savedBy !== undefined) validateReferenceAuthor(options.savedBy);
  const library = structuredClone(state.references?.library ?? []);
  const explicit = structuredClone(review?.explicit ?? baselineReferenceInputs(state, scan.baselineRevisionId));
  const versions: ReferenceVersion[] = [];
  const taken = libraryIds(library);
  for (const attachment of attachments) {
    throwIfCancelled(options.signal);
    const measured = await hashStream(attachment.source.stream(), { signal: options.signal });
    if (measured.size !== attachment.source.size) throw new Error('Reference file changed while saving. Choose it again.');
    const referenceId = freshLibraryId(taken);
    const version: ReferenceVersion = { referenceId, versionId: freshLibraryId(taken), originalFilename: attachment.source.name, fileType: attachment.source.type || 'application/octet-stream', ...measured, importedAt: new Date().toISOString(), ...(options.savedBy ? { savedBy: { ...options.savedBy } } : {}) };
    library.push({ referenceId, title: attachment.source.name, description: '', tags: [], versions: [version], projectVersionId: null, removed: false });
    versions.push(version);
    explicit.push({ referenceId, versionId: version.versionId, locator: '', explanation: attachment.explanation, ...(attachment.component ? { component: attachment.component } : {}) });
  }
  validateLibrary(library, state.references?.library);
  const proposed = { ...state, references: { ...state.references!, library } };
  // Missing parts and invalid notes must fail before storing any selected file.
  prepareReferenceContext(proposed, scan, files, createReferenceReview(proposed, scan, explicit));
  for (const [index, version] of versions.entries()) {
    options.onProgress?.({ phase: 'writing_objects', currentFile: version.originalFilename, processedFiles: index, totalFiles: versions.length, processedBytes: 0, totalBytes: version.size, message: `Saving reference file ${version.originalFilename}…` });
    await writeAndVerifyObject(vault, newRecordId(), version.sha256, version.size, async () => attachments[index].source.stream(), options.signal);
  }
  const { openExistingVault } = await import('./vault-service');
  try { await publishCatalog(vault, state, library, options.signal, versions, options.newRecordId); }
  catch (error) {
    // A completed directory can be durable even if the filesystem loses its
    // acknowledgement. Reconcile only this exact batch, never a partial import.
    const recovered = await openExistingVault(vault);
    if (recovered.references?.status !== 'available' || JSON.stringify(recovered.references.library) !== JSON.stringify(library)) throw error;
    return { state: recovered, review: createReferenceReview(recovered, scan, explicit) };
  }
  const next = await openExistingVault(vault);
  return { state: next, review: createReferenceReview(next, scan, explicit) };
}
export async function updateProjectReference(vault: FileSystemDirectoryAdapter, projectId: string, referenceId: string, changes: Partial<ReferenceMetadata> & { projectVersionId?: string | null; removed?: boolean }, options: CopyOptions = {}): Promise<VaultState> {
  return withProjectWriterLock(projectId, async () => {
    const { openExistingVault } = await import('./vault-service'); const state = await openExistingVault(vault);
    if (state.project.projectId !== projectId) throw new Error('Project changed before reference edit.');
    const block = referenceWriteBlock(state); if (block) throw new Error(block);
    const library = structuredClone(state.references?.library ?? []), ref = library.find(r => r.referenceId === referenceId);
    if (!ref) throw new Error('Reference is missing or unpublished.');
    const previous = JSON.stringify(ref);
    Object.assign(ref, cleanMetadata({ ...ref, ...changes }));
    if ('projectVersionId' in changes) ref.projectVersionId = changes.projectVersionId!;
    if ('removed' in changes) { ref.removed = changes.removed!; if (ref.removed) ref.projectVersionId = null; }
    throwIfCancelled(options.signal);
    // Compare normalized values after rereading under the writer lock. Repeated
    // selections or unchanged details must not append another catalogue.
    if (JSON.stringify(ref) === previous) return state;
    await publishCatalog(vault, state, library, options.signal);
    return openExistingVault(vault);
  });
}
export async function verifyReferenceLibraryContent(vault: FileSystemDirectoryAdapter, state: VaultState, signal?: AbortSignal) {
  const block = referenceWriteBlock(state); if (block) throw new Error(block);
  for (const ref of state.references?.library ?? []) for (const version of ref.versions) {
    throwIfCancelled(signal);
    const checked = await verifyStoredObject(vault, version.sha256, version.size, signal);
    if (!checked.valid) throw new Error(`Reference attachment verification failed for ${version.originalFilename}: ${checked.reason}`);
  }
}
export async function retrieveReferenceAttachment(vault: FileSystemDirectoryAdapter, projectId: string, referenceId: string, versionId: string) {
  const { openExistingVault } = await import('./vault-service'); const state = await openExistingVault(vault);
  if (state.project.projectId !== projectId) throw new Error('Project identity changed.');
  const block = referenceWriteBlock(state); if (block) throw new Error(block);
  const { version } = versionIn(state.references?.library ?? [], referenceId, versionId);
  const bytes = await vault.readFileBytes(getObjectPathSegments(version.sha256));
  const actual = await hashStream(new Blob([bytes as BlobPart]).stream());
  if (actual.sha256 !== version.sha256 || actual.size !== version.size) throw new Error('Attachment content is corrupt; an exact copy could not be retrieved.');
  return { version, bytes };
}

export function baselineReferenceInputs(state: VaultState, baselineId: string | null): ReferenceLinkInput[] {
  return (baselineId ? state.references?.contexts[baselineId]?.record?.links ?? [] : []).filter(l => l.origin === 'revision').map(l => ({ referenceId: l.referenceId, versionId: l.versionId, locator: l.locator, explanation: l.explanation, ...(l.componentId ? { component: { kind: 'existing' as const, componentId: l.componentId } } : {}) }));
}
export function createReferenceReview(state: VaultState, scan: ScanResult, explicit = baselineReferenceInputs(state, scan.baselineRevisionId)): ReferenceReview {
  return { projectId: state.project.projectId, branchId: scan.branchId, baselineRevisionId: scan.baselineRevisionId, baselineManifestSha256: state.revisions.find(r => r.manifest.revisionId === scan.baselineRevisionId)?.completion.manifestSha256 ?? null, changesSignature: scan.changesSignature, boundarySha256: state.references?.boundary?.payloadSha256 ?? null, catalogId: state.references?.catalogId ?? null, catalogSha256: state.references?.catalogSha256 ?? null, explicit: structuredClone(explicit) };
}
function inheritedLinks(library: ProjectReference[]): ReferenceLink[] { return library.filter(r => !r.removed && r.projectVersionId !== null).map(r => ({ referenceId: r.referenceId, versionId: r.projectVersionId!, origin: 'project', locator: '', explanation: '', componentId: null, componentPath: null })); }
export function referenceSelectionChanged(state: VaultState, scan: ScanResult, review?: ReferenceReview): boolean {
  const links = inheritedLinks(state.references?.library ?? []);
  for (const input of review?.explicit ?? baselineReferenceInputs(state, scan.baselineRevisionId)) links.push({ referenceId: input.referenceId, versionId: input.versionId, origin: 'revision', locator: input.locator, explanation: input.explanation, componentId: input.component?.kind === 'existing' ? input.component.componentId : input.component?.kind === 'pending' ? `pending:${input.component.path}` : null, componentPath: null });
  return referenceContextSignature(links) !== referenceContextSignature(scan.baselineRevisionId ? state.references?.contexts[scan.baselineRevisionId]?.record?.links ?? [] : []);
}
export interface ReferenceContextDraft { catalogId: string | null; catalogSha256: string | null; links: ReferenceLink[] }
export function prepareReferenceContext(state: VaultState, scan: ScanResult, files: ComponentFile[], review?: ReferenceReview): ReferenceContextDraft {
  const block = referenceWriteBlock(state); if (block) throw new Error(block);
  if (review) {
    const { explicit: _, ...expected } = createReferenceReview(state, scan, review.explicit);
    const { explicit: __, ...actual } = review;
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Reference selections are stale. Review the current references and scan again before saving.');
  }
  const links = inheritedLinks(state.references?.library ?? []);
  for (const input of review?.explicit ?? baselineReferenceInputs(state, scan.baselineRevisionId)) {
    const selection = input.component;
    const component = selection?.kind === 'existing' ? files.find(f => f.componentId === selection.componentId) : selection?.kind === 'pending' ? files.find(f => f.path === selection.path) : undefined;
    if (input.component && !component) throw new Error('The reference component is absent from the proposed committed identity mapping. Clear or change that component association.');
    links.push({ referenceId: input.referenceId, versionId: input.versionId, origin: 'revision', locator: input.locator.trim(), explanation: input.explanation.trim(), componentId: component?.componentId ?? null, componentPath: component?.path ?? null });
  }
  validateLinks(links, state.references?.library ?? [], files);
  return { catalogId: state.references?.catalogId ?? null, catalogSha256: state.references?.catalogSha256 ?? null, links };
}
export async function verifyReferenceContextContent(vault: FileSystemDirectoryAdapter, state: VaultState, draft: ReferenceContextDraft, signal?: AbortSignal) {
  for (const link of draft.links) {
    throwIfCancelled(signal); const { version } = versionIn(state.references?.library ?? [], link.referenceId, link.versionId);
    const checked = await verifyStoredObject(vault, version.sha256, version.size, signal);
    if (!checked.valid) throw new Error(`Required reference attachment is unavailable (${version.originalFilename}): ${checked.reason}`);
  }
}
/** Re-read the evidence after copying CAD objects, before publishing any capture sidecars. */
export async function verifyReferencePublication(vault: FileSystemDirectoryAdapter, state: VaultState, boundary: Boundary, draft: ReferenceContextDraft, signal?: AbortSignal) {
  const evidence = await readReferenceEvidence(vault, { ...state, incompleteAttempts: [] });
  if (evidence.status !== 'available' || evidence.boundary?.payloadSha256 !== boundary.payloadSha256 || evidence.catalogId !== draft.catalogId || evidence.catalogSha256 !== draft.catalogSha256) throw new Error(evidence.reason ?? 'Reference library changed during capture. Review the current references before retrying.');
  await verifyReferenceContextContent(vault, { ...state, references: evidence }, draft, signal);
}
export async function publishReferenceContext(vault: FileSystemDirectoryAdapter, boundary: Boundary, draft: ReferenceContextDraft, manifest: RevisionManifest, manifestSha256: string, contextOnly: boolean) {
  const record = seal({ schemaVersion: 1, projectId: manifest.projectId, revisionId: manifest.revisionId, branchId: manifest.branchId, parentRevisionId: manifest.parentRevisionId, manifestSha256, boundarySha256: boundary.payloadSha256, ...draft, contextOnly });
  return writeVerified(vault, referenceContextPath(manifest.revisionId), record);
}
export function capturedReferenceLibrary(state: VaultState, revisionId: string): ProjectReference[] {
  const record = state.references?.contexts[revisionId]?.record;
  return record?.catalogId ? state.references?.catalogs[record.catalogId]?.record.references ?? [] : [];
}
