import { checkCaseInsensitiveCollisions, splitAndValidatePath, validateDirectoryIsolation, type FileSystemDirectoryAdapter } from './fs-adapter';
import { FolderAccessError } from '../utils/folder-access';
import { validateWorkingFolderBindings, type WorkingFolderBindings } from './branch-state';
import { computeRequiredParentDirectories } from './recovery-service';
import { partitionSystemFiles } from './scanner';
import { readVerifiedInventory, throwIfCancelled, type CopyOptions } from './copy-service';
import { getObjectPathSegments, verifyStoredObject } from './object-store';
import { hashString } from './hash';
import { withProjectWriterLock } from './locks';
import { computeManifestPayloadChecksum, formatRevisionNumber, openExistingVault } from './vault-service';
import { validateWindowsSegments } from '../utils/folder-path';
import { clashKey, folderNameFor, isReservedFolderName, pickFreeName, withCounter } from './folder-names';
import { capturedReferenceLibrary } from './references';
import type { FileEntry, VaultState } from './types';

export interface ReviewExportRequest {
  kind: 'complete' | 'selected';
  selectedPaths: string[];
  labelFilenames: boolean;
  /** Copy the reference attachments that apply to the revision into a `References` subfolder. Off when absent. */
  includeReferences?: boolean;
}
export interface ReviewExportFile extends FileEntry { exportedPath: string; componentId: string | null }
export interface ReviewExportPlan {
  projectId: string; revisionId: string; manifestSha256: string;
  projectName: string; branchId: string; branchName: string; revisionLabel: string;
  folderName: string; request: ReviewExportRequest; directories: string[];
  files: ReviewExportFile[]; summaryName: string; summaryText: string; markerName: string;
  /** Summary text without the references section; `summaryText` is this plus the section for the plan-time state. */
  summaryBase: string;
  /** Name of the references subfolder, or null when no reference attachments apply or they are not requested. */
  referencesDirectory: string | null;
  references: ReviewExportReference[];
  /** Reference attachments that cannot be included, found while planning. Never blocks the export. */
  referencesSkipped: ReviewExportSkippedReference[];
}
export interface ReviewExportReference {
  referenceId: string; versionId: string; title: string; originalFilename: string; exportedPath: string;
  sha256: string; size: number; appliesTo: string[];
}
export interface ReviewExportSkippedReference { label: string; reason: string; versionId?: string }
export interface ReviewExportResult {
  folderName: string; filesCount: number; verifiedBytes: number; summaryName: string;
  referencesCount: number; referencesSkipped: ReviewExportSkippedReference[];
}

function portableLabel(input: string, fallback: string, limit = 60): string {
  const text = input.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '-').trim().replace(/\s+/g, '-').replace(/[ .]+$/, '') || fallback;
  let output = '';
  for (const char of text) {
    if (new TextEncoder().encode(output + char).length > limit) break;
    output += char;
  }
  output = output.replace(/[ .]+$/, '') || fallback;
  try { validateWindowsSegments([output]); } catch { output = '_' + output; }
  return output;
}
/** Cuts to at most `limit` UTF-16 units on a code-point boundary, then strips trailing spaces/dots. */
function capUnits(text: string, limit: number): string {
  let out = '';
  for (const char of text) {
    if (out.length + char.length > limit) break;
    out += char;
  }
  return out.replace(/[ .]+$/, '');
}
/** Readable export folder base: `Project - Case - V3`, at most 64 UTF-16 units. */
function noteLines(notes: { problem: string; modification: string; observations: string }, mainLabel: string): string[] {
  return ([[mainLabel, notes.modification], ['Why', notes.problem], ['What you noticed', notes.observations]] as const)
    .filter(([, value]) => value?.trim())
    .map(([label, value]) => `${label}: ${JSON.stringify(value)}`);
}

export function exportFolderBaseName(projectName: string, branchName: string, revisionLabel: string): string {
  const branch = capUnits(folderNameFor(branchName, 'Case'), 24) || 'Case';
  // "V3" is 2 to 4 characters for the first 999 versions; a longer label takes its extra characters from the project part.
  const extra = Math.max(0, revisionLabel.length - 4);
  const build = (projectLimit: number) => {
    const project = capUnits(folderNameFor(projectName, 'Project'), projectLimit) || 'Project';
    return folderNameFor(`${project} - ${branch} - ${revisionLabel}`, 'Export');
  };
  const base = build(28 - extra);
  if (!isReservedFolderName(base)) return base;
  // "CON.x - …" is a reserved device name: the standard counter goes before the first dot.
  // The project part gives up 4 units so " (2)" keeps the whole base within 64.
  const shorter = build(24 - extra);
  return isReservedFolderName(shorter) ? withCounter(shorter, 2) : shorter;
}
export function acceptsExportFolderName(base: string, name: string): boolean {
  if (name === base) return true;
  for (const prefix of [base + ' (']) {
    if (!name.startsWith(prefix) || !name.endsWith(')')) continue;
    const digits = name.slice(prefix.length, -1);
    if (!/^[1-9]\d*$/.test(digits)) continue;
    const n = Number(digits);
    if (Number.isSafeInteger(n) && n >= 2 && withCounter(base, n) === name) return true;
  }
  return false;
}
function portablePath(path: string) {
  const parts = splitAndValidatePath(path);
  validateWindowsSegments(parts);
  if (parts.some(p => new TextEncoder().encode(p).length > 240)) throw new Error(`Export name is too long: ${path}`);
}
function metadataName(stem: string, occupied: string[]): string {
  const names = new Set(occupied.map(p => p.toLowerCase()));
  for (let n = 1; n <= 1000; n++) {
    const name = `${stem}${n === 1 ? '' : '-' + n}.txt`;
    if (!names.has(name.toLowerCase())) return name;
  }
  throw new Error('No free review-summary filename. Select fewer files or resolve the naming conflict.');
}


const REFERENCES_FOLDER = 'References';
const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;
/** A portable file name for a reference attachment: unsafe characters become `-`; the extension survives the length cap. */
function referenceFileName(original: string): string {
  const cleaned = folderNameFor(original, 'Reference');
  if (byteLength(cleaned) <= 200) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && byteLength(cleaned.slice(dot)) <= 20 ? cleaned.slice(dot) : '';
  let stem = '';
  for (const char of extension ? cleaned.slice(0, dot) : cleaned) {
    if (byteLength(stem + char + extension) > 200) break;
    stem += char;
  }
  return (stem.replace(/[ .]+$/, '') || 'Reference') + extension;
}
/** `name`, then `stem (2).ext`, `stem (3).ext`, ... Never a reserved device name; clashes compare like a case-insensitive disk. */
function freeReferenceFileName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name, extension = dot > 0 ? name.slice(dot) : '';
  // A reserved device name ("CON.tar.gz") takes the standard counter before its first dot; others before the extension.
  const reserved = isReservedFolderName(name);
  for (let n = 1; n <= 10000; n++) {
    const candidate = reserved ? withCounter(name, n) : n === 1 ? name : `${stem} (${n})${extension}`;
    if (isReservedFolderName(candidate) || taken.has(clashKey(candidate))) continue;
    taken.add(clashKey(candidate));
    return candidate;
  }
  throw new Error(`No free filename for reference attachment "${name}".`);
}
function referencesSection(plan: Pick<ReviewExportPlan, 'references' | 'referencesDirectory' | 'referencesSkipped' | 'request'>, skipped: ReviewExportSkippedReference[]): string[] {
  if (!plan.request.includeReferences) return [];
  const missing = [...plan.referencesSkipped, ...skipped];
  const included = plan.references.filter(r => !skipped.some(s => s.versionId === r.versionId));
  const quote = (value: unknown) => JSON.stringify(value);
  return [
    '', plan.referencesDirectory && included.length ? `Reference attachments (copied to ${quote(plan.referencesDirectory + '/')}; content verified against the saved hash):` : 'Reference attachments:',
    ...(!included.length && !missing.length ? ['None apply to this saved version.'] : []),
    ...included.flatMap(ref => [
      `${quote(ref.originalFilename)} -> ${quote(ref.exportedPath)}`,
      `  Title: ${quote(ref.title)}; SHA-256: ${ref.sha256}; bytes: ${ref.size}`,
      `  Applies to: ${ref.appliesTo.map(quote).join(', ')}`,
    ]),
    ...missing.map(m => `Not included: ${quote(m.label)}: ${m.reason}`),
    '',
  ];
}
function composeSummary(plan: Pick<ReviewExportPlan, 'summaryBase' | 'references' | 'referencesDirectory' | 'referencesSkipped' | 'request'>, skipped: ReviewExportSkippedReference[]): string {
  return plan.summaryBase + referencesSection(plan, skipped).join('\n');
}
function planReferences(state: VaultState, revisionId: string, selected: { path: string; componentId: string | null }[], complete: boolean): { references: Omit<ReviewExportReference, 'exportedPath'>[]; skipped: ReviewExportSkippedReference[] } {
  const context = state.references?.contexts[revisionId];
  if (!context || context.status === 'legacy') return { references: [], skipped: [] };
  if (context.status !== 'available' || !context.record) return { references: [], skipped: [{ label: 'All reference attachments', reason: context.reason ?? 'Reference information for this version is unavailable.' }] };
  const library = capturedReferenceLibrary(state, revisionId);
  const paths = new Set(selected.map(f => f.path)), ids = new Set(selected.flatMap(f => f.componentId ? [f.componentId] : []));
  const byVersion = new Map<string, Omit<ReviewExportReference, 'exportedPath'>>(), skipped: ReviewExportSkippedReference[] = [];
  for (const link of context.record.links) {
    const applies = link.componentId === null && link.componentPath === null;
    if (!complete && !applies && !(link.componentId && ids.has(link.componentId)) && !(link.componentPath && paths.has(link.componentPath))) continue;
    const reference = library.find(r => r.referenceId === link.referenceId), version = reference?.versions.find(v => v.versionId === link.versionId);
    if (!reference || !version) { skipped.push({ label: `Reference ${link.referenceId}`, reason: 'its saved version is missing from the reference library.' }); continue; }
    const target = applies ? 'whole project' : link.componentPath ?? 'a file in this project';
    const existing = byVersion.get(version.versionId);
    if (existing) { if (!existing.appliesTo.includes(target)) existing.appliesTo.push(target); continue; }
    byVersion.set(version.versionId, { referenceId: reference.referenceId, versionId: version.versionId, title: reference.title, originalFilename: version.originalFilename, sha256: version.sha256, size: version.size, appliesTo: [target] });
  }
  return { references: [...byVersion.values()].sort((a, b) => a.originalFilename.toLowerCase().localeCompare(b.originalFilename.toLowerCase()) || a.versionId.localeCompare(b.versionId)), skipped };
}

/** Pure preview: recorded revision context only; no working files or absolute locations. */
export function prepareReviewExport(state: VaultState, revisionId: string, request: ReviewExportRequest): ReviewExportPlan {
  const revision = state.revisions.find(r => r.manifest.revisionId === revisionId);
  if (!revision || revision.integrityStatus === 'corrupted') throw new Error('Choose an intact saved version to export.');
  const manifest = revision.manifest;
  if (manifest.projectId !== state.project.projectId || computeManifestPayloadChecksum(manifest) !== manifest.manifestPayloadSha256) throw new Error('The saved version manifest is invalid.');
  const branch = state.branches.find(b => b.branchId === manifest.branchId);
  if (!branch) throw new Error('The selected version’s recorded case is unavailable; its review label cannot be established.');
  if (!['complete', 'selected'].includes(request.kind) || (request.kind === 'complete' && request.labelFilenames)) throw new Error('Filename labels are available only for selected-file copies.');
  if (request.kind === 'selected' && (!request.selectedPaths.length || new Set(request.selectedPaths).size !== request.selectedPaths.length)) throw new Error('Select at least one file, with each path selected once.');
  const selected = request.kind === 'complete' ? manifest.files : request.selectedPaths.map(path => {
    splitAndValidatePath(path);
    const file = manifest.files.find(f => f.path === path);
    if (!file) throw new Error(`The selected file is not in this version: ${path}`);
    return file;
  });
  const revisionLabel = formatRevisionNumber(manifest.displayNumber);
  const branchLabel = portableLabel(branch.name, 'Case');
  const folderName = exportFolderBaseName(state.project.name, branch.name, revisionLabel);
  const evidence = state.components?.status === 'available' ? state.components.revisions[revisionId] : undefined;
  const files = selected.map(file => {
    let exportedPath = file.path;
    if (request.labelFilenames) {
      const segments = splitAndValidatePath(file.path), leaf = segments.pop()!;
      const dot = leaf.lastIndexOf('.');
      const stem = dot > 0 ? leaf.slice(0, dot) : leaf, extension = dot > 0 ? leaf.slice(dot) : '';
      exportedPath = [...segments, `${portableLabel(stem, 'File', 100)}_${branchLabel}_${revisionLabel}${extension}`].join('/');
    }
    return { ...file, exportedPath, componentId: evidence?.files.find(f => f.path === file.path)?.componentId ?? null };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const includeReferences = Boolean(request.includeReferences);
  const planned = includeReferences ? planReferences(state, revisionId, files, request.kind === 'complete') : { references: [], skipped: [] };
  const directories = [...new Set([...(request.kind === 'complete' ? manifest.directories : []), ...computeRequiredParentDirectories(files.map(f => f.exportedPath))])].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  let referencesDirectory: string | null = null;
  if (planned.references.length) {
    // The folder never merges into a saved folder or file that already has the same name.
    const topLevel = new Set([...directories, ...files.map(f => f.exportedPath)].map(p => clashKey(p.split('/')[0])));
    for (let n = 1; !referencesDirectory; n++) { const candidate = withCounter(REFERENCES_FOLDER, n); if (!topLevel.has(clashKey(candidate))) referencesDirectory = candidate; }
  }
  const taken = new Set<string>();
  const references: ReviewExportReference[] = [], referencesSkipped = [...planned.skipped];
  for (const ref of planned.references) {
    // A name that cannot be made portable leaves that attachment out; it never blocks the export.
    try { references.push({ ...ref, exportedPath: `${referencesDirectory}/${freeReferenceFileName(referenceFileName(ref.originalFilename), taken)}` }); }
    catch (e) { referencesSkipped.push({ label: ref.originalFilename, reason: e instanceof Error ? e.message : String(e), versionId: ref.versionId }); }
  }
  const paths = [...directories, ...(referencesDirectory ? [referencesDirectory] : []), ...files.map(f => f.exportedPath), ...references.map(r => r.exportedPath)];
  const collisions = checkCaseInsensitiveCollisions(paths);
  if (collisions.length) throw new Error(`Export naming collision: ${collisions.join('; ')}. Change the selection or filename option; nothing was exported.`);
  for (const path of paths) {
    try { portablePath(path); } catch { throw new Error(`Cannot export a portable path: ${path}. Change the selection or filename option; nothing was exported.`); }
  }
  portablePath(folderName);
  const summaryName = metadataName('_CADTREE_REVIEW', paths);
  const markerName = metadataName('_CADTREE_EXPORT_INCOMPLETE', [...paths, summaryName]);
  const quote = (value: unknown) => JSON.stringify(value);
  const summaryBase = [
    'cAdtree exported copy',
    request.kind === 'selected' ? 'PARTIAL — selected files only. CAD dependencies are not discovered or included automatically.' : 'COMPLETE — all files and folders recorded in this saved version. External CAD dependencies are not discovered automatically.',
    `Project: ${quote(state.project.name)} (${state.project.projectId})`,
    `Case: ${quote(branch.name)} (${branch.branchId})`,
    `Version: ${revisionLabel} (${manifest.revisionId})`,
    `Saved date: ${manifest.captureCompletedAt}`,
    `What changed: ${quote(manifest.summary)}`,
    ...noteLines(manifest.notes, 'Description'),
    'These are ordinary copies of the saved files. Editing them does not update saved history.',
    ...(includeReferences ? [] : ['Project reference attachments are not included in this exported copy.']),
    request.labelFilenames ? 'Filenames were labelled for standalone review. Other documents may require reference repair. Native references were not rewritten.' : 'Original internal filenames and relative paths were preserved.',
    '', 'Exported files (original -> exported; content verified against the saved hash):',
    ...files.flatMap(file => [
      `${quote(file.path)} -> ${quote(file.exportedPath)}`,
      `  SHA-256: ${file.sha256}; bytes: ${file.size}; component ID: ${file.componentId ?? 'unavailable for this version'}`,
      ...manifest.fileNotes?.filter(n => n.path === file.path).map(n => `  File notes: ${quote(Object.fromEntries(([['Note', n.modification], ['Why', n.problem], ['What you noticed', n.observations]] as const).filter(([, v]) => v?.trim())))}`) ?? [],
    ]),
    '', 'Recorded export directories:', ...directories.map(quote), '',
  ].join('\n');
  const referenceParts = { references, referencesDirectory, referencesSkipped, request: { ...request, includeReferences } };
  const summaryText = composeSummary({ summaryBase, ...referenceParts }, []);
  return { projectId: state.project.projectId, revisionId, manifestSha256: revision.completion.manifestSha256, projectName: state.project.name, branchId: branch.branchId, branchName: branch.name, revisionLabel, folderName, request: { ...request, includeReferences, selectedPaths: request.kind === 'selected' ? [...request.selectedPaths].sort() : [] }, directories, files, summaryName, summaryText, summaryBase, markerName, references, referencesDirectory, referencesSkipped };
}

/** Read-only proposal. Execution never silently changes the name confirmed here. */
export async function suggestReviewExportFolder(parent: FileSystemDirectoryAdapter, folderName: string): Promise<string> {
  portablePath(folderName);
  if (splitAndValidatePath(folderName).length !== 1) throw new Error('Expected one review-folder name.');
  return pickFreeName(parent, folderName, { maxAttempts: 10000 });
}

export class ReviewExportError extends Error {
  constructor(message: string, readonly incompleteFolder?: string, readonly cancelled = false) {
    super(`${cancelled ? 'Export cancelled. ' : ''}${message} ${incompleteFolder ? `Incomplete output: "${incompleteFolder}" under the selected destination. It was kept; retry creates a fresh folder.` : 'No export folder was created.'}`);
    this.name = 'ReviewExportError';
  }
}
export interface ReviewExportOptions extends CopyOptions {
  vaultDir: FileSystemDirectoryAdapter; parent: FileSystemDirectoryAdapter;
  plan: ReviewExportPlan; folderName: string; workingFolders: WorkingFolderBindings;
  resolveWorkingFolders?: (state: VaultState) => Promise<WorkingFolderBindings>;
}

export async function exportRevisionForReview(options: ReviewExportOptions): Promise<ReviewExportResult> {
  const { vaultDir, parent, plan, folderName, signal, onProgress } = options;
  return withProjectWriterLock(plan.projectId, async () => {
    let destination: FileSystemDirectoryAdapter | undefined, creationAttempted = false;
    try {
      throwIfCancelled(signal);
      const state = await openExistingVault(vaultDir);
      const current = prepareReviewExport(state, plan.revisionId, plan.request);
      if (JSON.stringify(current) !== JSON.stringify(plan)) throw new Error('The saved version or export preview changed. Reopen the review dialog.');
      if (!acceptsExportFolderName(plan.folderName, folderName)) throw new Error('The destination name no longer matches the labelled preview.');
      portablePath(folderName);
      if (splitAndValidatePath(folderName).length !== 1) throw new Error('The export must be one fresh child folder.');
      const bindings = options.resolveWorkingFolders ? await options.resolveWorkingFolders(state) : options.workingFolders;
      await validateWorkingFolderBindings(state, vaultDir, bindings);
      if (await parent.queryPermission('readwrite') !== 'granted') throw new FolderAccessError('Allow read/write access to the export destination, then choose it again.');
      // An ancestor parent is allowed when the proposed child is a separate sibling.
      // Never create anything in a protected vault or working tree.
      const protectedRoots = [vaultDir, ...state.branches.map(b => bindings[b.branchId]!)];
      for (const root of protectedRoots) {
        if (await root.isSameEntry(parent) || await root.resolveRelativePath(parent) !== null) throw new Error('Choose an export destination outside the vault and every working folder.');
        const insideParent = await parent.resolveRelativePath(root);
        if (insideParent?.[0]?.toLowerCase() === folderName.toLowerCase()) throw new Error('The proposed export folder overlaps a protected project location. Choose another destination.');
      }
      if ((await parent.listEntries()).some(e => e.name.toLowerCase() === folderName.toLowerCase())) throw new Error('The proposed folder already exists. Choose the destination again for a fresh proposal.');
      const totalBytes = plan.files.reduce((sum, file) => sum + file.size, 0) + plan.references.reduce((sum, ref) => sum + ref.size, 0);
      const progress = (phase: 'verifying_objects' | 'restoring_directories' | 'restoring_files' | 'verifying_restored_files', message: string, processedFiles = 0, processedBytes = 0, currentFile?: string) => onProgress?.({ phase, message, processedFiles, processedBytes, totalFiles: plan.files.length + plan.references.length, totalBytes, ...(currentFile ? { currentFile } : {}) });
      for (const [index, file] of plan.files.entries()) {
        progress('verifying_objects', 'Verifying saved content before export.', index, 0, file.path);
        throwIfCancelled(signal);
        const checked = await verifyStoredObject(vaultDir, file.sha256, file.size, signal);
        if (!checked.valid) throw new Error(`Saved content failed verification for "${file.path}": ${checked.reason}`);
      }
      // A reference attachment that cannot be verified is left out and listed in the summary; it never fails the export.
      const skipped: ReviewExportSkippedReference[] = [];
      for (const ref of plan.references) {
        progress('verifying_objects', 'Verifying reference attachments before export.', plan.files.length, 0, ref.originalFilename);
        throwIfCancelled(signal);
        let reason = '';
        try { const checked = await verifyStoredObject(vaultDir, ref.sha256, ref.size, signal); if (!checked.valid) reason = checked.reason ?? 'its saved content failed verification.'; }
        catch (e) { throwIfCancelled(signal); reason = e instanceof Error ? e.message : String(e); }
        if (reason) skipped.push({ label: ref.originalFilename, reason, versionId: ref.versionId });
      }
      const references = plan.references.filter(r => !skipped.some(s => s.versionId === r.versionId));
      const summaryText = composeSummary(plan, skipped);
      throwIfCancelled(signal);
      creationAttempted = true;
      destination = await parent.getDirectory([folderName], { create: true, exclusiveCreate: true });
      for (const root of protectedRoots) await validateDirectoryIsolation(destination, root, 'Export a copy', 'Protected project folder');
      const markerText = `INCOMPLETE cAdtree exported copy: ${plan.revisionLabel} (${plan.revisionId}).\nDo not distribute or use this folder. Retry into a fresh labelled child folder.\n`;
      await destination.writeFileText([plan.markerName], markerText, { exclusive: true });
      progress('restoring_directories', 'Creating review-copy directories.');
      for (const directory of plan.directories) {
        throwIfCancelled(signal);
        await destination.getDirectory(splitAndValidatePath(directory), { create: true, exclusiveCheck: true });
      }
      if (references.length && plan.referencesDirectory) await destination.getDirectory([plan.referencesDirectory], { create: true, exclusiveCheck: true });
      let writtenBytes = 0;
      for (const [index, file] of plan.files.entries()) {
        progress('restoring_files', 'Exporting verified saved bytes.', index, writtenBytes, file.exportedPath);
        throwIfCancelled(signal);
        const written = await destination.writeFileStream(splitAndValidatePath(file.exportedPath), await vaultDir.readFileStream(getObjectPathSegments(file.sha256)), { exclusive: true, signal });
        if (written.bytesWritten !== file.size) throw new Error(`Incomplete exported file: ${file.exportedPath}`);
        writtenBytes += written.bytesWritten;
      }
      for (const [index, ref] of references.entries()) {
        progress('restoring_files', 'Exporting verified reference attachments.', plan.files.length + index, writtenBytes, ref.exportedPath);
        throwIfCancelled(signal);
        const written = await destination.writeFileStream(splitAndValidatePath(ref.exportedPath), await vaultDir.readFileStream(getObjectPathSegments(ref.sha256)), { exclusive: true, signal });
        if (written.bytesWritten !== ref.size) throw new Error(`Incomplete exported reference attachment: ${ref.exportedPath}`);
        writtenBytes += written.bytesWritten;
      }
      throwIfCancelled(signal);
      await destination.writeFileText([plan.summaryName], summaryText, { exclusive: true });
      progress('verifying_restored_files', 'Verifying exported bytes, summary and complete directory structure.', plan.files.length + references.length, writtenBytes);
      const rawInventory = await readVerifiedInventory(destination, { signal });
      const expected = new Map([
        ...plan.files.map(f => [f.exportedPath, { sha256: f.sha256, size: f.size }] as const),
        ...references.map(r => [r.exportedPath, { sha256: r.sha256, size: r.size }] as const),
        [plan.summaryName, { sha256: hashString(summaryText), size: new TextEncoder().encode(summaryText).length }] as const,
        [plan.markerName, { sha256: hashString(markerText), size: new TextEncoder().encode(markerText).length }] as const,
      ]);
      const inventory = { ...rawInventory, files: partitionSystemFiles(rawInventory.files, new Set(expected.keys())).files };
      if (inventory.files.length !== expected.size || inventory.files.some(f => expected.get(f.path)?.sha256 !== f.sha256 || expected.get(f.path)?.size !== f.size) || JSON.stringify([...inventory.directories].sort()) !== JSON.stringify([...plan.directories, ...(references.length && plan.referencesDirectory ? [plan.referencesDirectory] : [])].sort())) throw new Error('Export verification failed: output does not match the reviewed files and directories.');
      throwIfCancelled(signal);
      await destination.removeEntry([plan.markerName]);
      if (await destination.hasFile([plan.markerName]) || await destination.hasDirectory([plan.markerName])) throw new Error('The incomplete marker could not be cleared after verification.');
      return { folderName, filesCount: plan.files.length, verifiedBytes: plan.files.reduce((sum, file) => sum + file.size, 0) + references.reduce((sum, ref) => sum + ref.size, 0), summaryName: plan.summaryName, referencesCount: references.length, referencesSkipped: [...plan.referencesSkipped, ...skipped] };
    } catch (error) {
      if (destination) {
        try {
          if (!await destination.hasFile([plan.markerName]) && !await destination.hasDirectory([plan.markerName])) await destination.writeFileText([plan.markerName], 'INCOMPLETE cAdtree exported copy. Do not distribute or use. Retry into a fresh folder.\n', { exclusive: true });
        } catch { /* The retained folder is also identified in the caller's error. */ }
      }
      throw new ReviewExportError(error instanceof Error ? error.message : String(error), creationAttempted ? folderName : undefined, Boolean(signal?.aborted) || (error instanceof DOMException && error.name === 'AbortError'));
    }
  });
}
