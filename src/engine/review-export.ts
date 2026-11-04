import { checkCaseInsensitiveCollisions, splitAndValidatePath, validateDirectoryIsolation, type FileSystemDirectoryAdapter } from './fs-adapter';
import { validateWorkingFolderBindings, type WorkingFolderBindings } from './branch-state';
import { computeRequiredParentDirectories } from './recovery-service';
import { readVerifiedInventory, throwIfCancelled, type CopyOptions } from './copy-service';
import { getObjectPathSegments, verifyStoredObject } from './object-store';
import { hashString } from './hash';
import { withProjectWriterLock } from './locks';
import { computeManifestPayloadChecksum, openExistingVault } from './vault-service';
import { validateWindowsSegments } from '../utils/folder-path';
import type { FileEntry, VaultState } from './types';

export interface ReviewExportRequest {
  kind: 'complete' | 'selected';
  selectedPaths: string[];
  labelFilenames: boolean;
}
export interface ReviewExportFile extends FileEntry { exportedPath: string; componentId: string | null }
export interface ReviewExportPlan {
  projectId: string; revisionId: string; manifestSha256: string;
  projectName: string; branchId: string; branchName: string; revisionLabel: string;
  folderName: string; request: ReviewExportRequest; directories: string[];
  files: ReviewExportFile[]; summaryName: string; summaryText: string; markerName: string;
}
export interface ReviewExportResult {
  folderName: string; filesCount: number; verifiedBytes: number; summaryName: string;
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

/** Pure preview: recorded revision context only; no working files or absolute locations. */
export function prepareReviewExport(state: VaultState, revisionId: string, request: ReviewExportRequest): ReviewExportPlan {
  const revision = state.revisions.find(r => r.manifest.revisionId === revisionId);
  if (!revision || revision.integrityStatus === 'corrupted') throw new Error('Choose an intact saved revision to export.');
  const manifest = revision.manifest;
  if (manifest.projectId !== state.project.projectId || computeManifestPayloadChecksum(manifest) !== manifest.manifestPayloadSha256) throw new Error('The saved revision manifest is invalid.');
  const branch = state.branches.find(b => b.branchId === manifest.branchId);
  if (!branch) throw new Error('The selected revision’s recorded branch is unavailable; its review label cannot be established.');
  if (!['complete', 'selected'].includes(request.kind) || (request.kind === 'complete' && request.labelFilenames)) throw new Error('Filename labels are available only for selected-file review copies.');
  if (request.kind === 'selected' && (!request.selectedPaths.length || new Set(request.selectedPaths).size !== request.selectedPaths.length)) throw new Error('Select at least one file, with each path selected once.');
  const selected = request.kind === 'complete' ? manifest.files : request.selectedPaths.map(path => {
    splitAndValidatePath(path);
    const file = manifest.files.find(f => f.path === path);
    if (!file) throw new Error(`Selected file is absent from this snapshot: ${path}`);
    return file;
  });
  const revisionLabel = `R${String(manifest.displayNumber).padStart(2, '0')}`;
  const branchLabel = portableLabel(branch.name, 'Branch');
  const folderName = `${portableLabel(state.project.name, 'Project')}_${branchLabel}_${revisionLabel}`;
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
  const directories = [...new Set([...(request.kind === 'complete' ? manifest.directories : []), ...computeRequiredParentDirectories(files.map(f => f.exportedPath))])].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const paths = [...directories, ...files.map(f => f.exportedPath)];
  const collisions = checkCaseInsensitiveCollisions(paths);
  if (collisions.length) throw new Error(`Export naming collision: ${collisions.join('; ')}. Change the selection or filename option; nothing was exported.`);
  for (const path of paths) {
    try { portablePath(path); } catch { throw new Error(`Cannot export a portable path: ${path}. Change the selection or filename option; nothing was exported.`); }
  }
  portablePath(folderName);
  const summaryName = metadataName('_CADTREE_REVIEW', paths);
  const markerName = metadataName('_CADTREE_EXPORT_INCOMPLETE', [...paths, summaryName]);
  const quote = (value: unknown) => JSON.stringify(value);
  const summaryText = [
    'cAdtree review copy',
    request.kind === 'selected' ? 'PARTIAL — selected files only. CAD dependencies are not discovered or included automatically.' : 'COMPLETE — all files and directories recorded in this saved snapshot. External CAD dependencies are not discovered automatically.',
    `Project: ${quote(state.project.name)} (${state.project.projectId})`,
    `Branch: ${quote(branch.name)} (${branch.branchId})`,
    `Revision: ${revisionLabel} (${manifest.revisionId})`,
    `Saved date: ${manifest.captureCompletedAt}`,
    `Revision summary: ${quote(manifest.summary)}`,
    `Problem or intent: ${quote(manifest.notes.problem)}`,
    `Engineering change: ${quote(manifest.notes.modification)}`,
    `Observations: ${quote(manifest.notes.observations)}`,
    'These are ordinary review copies. Editing them does not update saved history.',
    'Project reference attachments are not included in this review export.',
    request.labelFilenames ? 'Filenames were labelled for standalone review. Other documents may require reference repair. Native references were not rewritten.' : 'Original internal filenames and relative paths were preserved.',
    '', 'Exported files (original -> exported; content verified against the saved hash):',
    ...files.flatMap(file => [
      `${quote(file.path)} -> ${quote(file.exportedPath)}`,
      `  SHA-256: ${file.sha256}; bytes: ${file.size}; component ID: ${file.componentId ?? 'unavailable for this snapshot'}`,
      ...manifest.fileNotes?.filter(n => n.path === file.path).map(n => `  File notes: ${quote({ problem: n.problem, modification: n.modification, observations: n.observations })}`) ?? [],
    ]),
    '', 'Recorded export directories:', ...directories.map(quote), '',
  ].join('\n');
  return { projectId: state.project.projectId, revisionId, manifestSha256: revision.completion.manifestSha256, projectName: state.project.name, branchId: branch.branchId, branchName: branch.name, revisionLabel, folderName, request: { ...request, selectedPaths: request.kind === 'selected' ? [...request.selectedPaths].sort() : [] }, directories, files, summaryName, summaryText, markerName };
}

/** Read-only proposal. Execution never silently changes the name confirmed here. */
export async function suggestReviewExportFolder(parent: FileSystemDirectoryAdapter, folderName: string): Promise<string> {
  portablePath(folderName);
  if (splitAndValidatePath(folderName).length !== 1) throw new Error('Expected one review-folder name.');
  const occupied = new Set((await parent.listEntries()).map(e => e.name.toLowerCase()));
  for (let n = 1; n <= 10000; n++) {
    const candidate = folderName + (n === 1 ? '' : '-' + n);
    if (!occupied.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error('No fresh labelled folder is available. Choose another destination.');
}

export class ReviewExportError extends Error {
  constructor(message: string, readonly incompleteFolder?: string, readonly cancelled = false) {
    super(`${cancelled ? 'Export cancelled. ' : ''}${message} ${incompleteFolder ? `Incomplete output: "${incompleteFolder}" under the selected destination. It was retained; retry creates a fresh folder.` : 'No export folder was created.'}`);
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
      if (JSON.stringify(current) !== JSON.stringify(plan)) throw new Error('The saved revision or export preview changed. Reopen the review dialog.');
      if (folderName !== plan.folderName && !(/^\d+$/.test(folderName.slice(plan.folderName.length + 1)) && folderName.startsWith(plan.folderName + '-') && Number(folderName.slice(plan.folderName.length + 1)) >= 2)) throw new Error('The destination name no longer matches the labelled preview.');
      portablePath(folderName);
      if (splitAndValidatePath(folderName).length !== 1) throw new Error('The export must be one fresh child folder.');
      const bindings = options.resolveWorkingFolders ? await options.resolveWorkingFolders(state) : options.workingFolders;
      await validateWorkingFolderBindings(state, vaultDir, bindings);
      if (await parent.queryPermission('readwrite') !== 'granted') throw new Error('Allow read/write access to the export destination, then choose it again.');
      // An ancestor parent is allowed when the proposed child is a separate sibling.
      // Never create anything in a protected vault or working tree.
      const protectedRoots = [vaultDir, ...state.branches.map(b => bindings[b.branchId]!)];
      for (const root of protectedRoots) {
        if (await root.isSameEntry(parent) || await root.resolveRelativePath(parent) !== null) throw new Error('Choose an export destination outside the vault and every working folder.');
        const insideParent = await parent.resolveRelativePath(root);
        if (insideParent?.[0]?.toLowerCase() === folderName.toLowerCase()) throw new Error('The proposed export folder overlaps a protected project location. Choose another destination.');
      }
      if ((await parent.listEntries()).some(e => e.name.toLowerCase() === folderName.toLowerCase())) throw new Error('The proposed folder already exists. Choose the destination again for a fresh proposal.');
      const totalBytes = plan.files.reduce((sum, file) => sum + file.size, 0);
      const progress = (phase: 'verifying_objects' | 'restoring_directories' | 'restoring_files' | 'verifying_restored_files', message: string, processedFiles = 0, processedBytes = 0, currentFile?: string) => onProgress?.({ phase, message, processedFiles, processedBytes, totalFiles: plan.files.length, totalBytes, ...(currentFile ? { currentFile } : {}) });
      for (const [index, file] of plan.files.entries()) {
        progress('verifying_objects', 'Verifying saved content before export.', index, 0, file.path);
        throwIfCancelled(signal);
        const checked = await verifyStoredObject(vaultDir, file.sha256, file.size, signal);
        if (!checked.valid) throw new Error(`Saved content failed verification for "${file.path}": ${checked.reason}`);
      }
      throwIfCancelled(signal);
      creationAttempted = true;
      destination = await parent.getDirectory([folderName], { create: true, exclusiveCreate: true });
      for (const root of protectedRoots) await validateDirectoryIsolation(destination, root, 'Review export', 'Protected project folder');
      const markerText = `INCOMPLETE cAdtree review export: ${plan.revisionLabel} (${plan.revisionId}).\nDo not distribute or use this folder. Retry into a fresh labelled child folder.\n`;
      await destination.writeFileText([plan.markerName], markerText, { exclusive: true });
      progress('restoring_directories', 'Creating review-copy directories.');
      for (const directory of plan.directories) {
        throwIfCancelled(signal);
        await destination.getDirectory(splitAndValidatePath(directory), { create: true, exclusiveCheck: true });
      }
      let writtenBytes = 0;
      for (const [index, file] of plan.files.entries()) {
        progress('restoring_files', 'Exporting verified saved bytes.', index, writtenBytes, file.exportedPath);
        throwIfCancelled(signal);
        const written = await destination.writeFileStream(splitAndValidatePath(file.exportedPath), await vaultDir.readFileStream(getObjectPathSegments(file.sha256)), { exclusive: true, signal });
        if (written.bytesWritten !== file.size) throw new Error(`Incomplete exported file: ${file.exportedPath}`);
        writtenBytes += written.bytesWritten;
      }
      throwIfCancelled(signal);
      await destination.writeFileText([plan.summaryName], plan.summaryText, { exclusive: true });
      progress('verifying_restored_files', 'Verifying exported bytes, summary and complete directory structure.', plan.files.length, writtenBytes);
      const inventory = await readVerifiedInventory(destination, { signal });
      const expected = new Map([
        ...plan.files.map(f => [f.exportedPath, { sha256: f.sha256, size: f.size }] as const),
        [plan.summaryName, { sha256: hashString(plan.summaryText), size: new TextEncoder().encode(plan.summaryText).length }] as const,
        [plan.markerName, { sha256: hashString(markerText), size: new TextEncoder().encode(markerText).length }] as const,
      ]);
      if (inventory.files.length !== expected.size || inventory.files.some(f => expected.get(f.path)?.sha256 !== f.sha256 || expected.get(f.path)?.size !== f.size) || JSON.stringify([...inventory.directories].sort()) !== JSON.stringify([...plan.directories].sort())) throw new Error('Export verification failed: output does not match the reviewed files and directories.');
      throwIfCancelled(signal);
      await destination.removeEntry([plan.markerName]);
      if (await destination.hasFile([plan.markerName]) || await destination.hasDirectory([plan.markerName])) throw new Error('The incomplete marker could not be cleared after verification.');
      return { folderName, filesCount: plan.files.length, verifiedBytes: totalBytes, summaryName: plan.summaryName };
    } catch (error) {
      if (destination) {
        try {
          if (!await destination.hasFile([plan.markerName]) && !await destination.hasDirectory([plan.markerName])) await destination.writeFileText([plan.markerName], 'INCOMPLETE cAdtree review export. Do not distribute or use. Retry into a fresh folder.\n', { exclusive: true });
        } catch { /* The retained folder is also identified in the caller's error. */ }
      }
      throw new ReviewExportError(error instanceof Error ? error.message : String(error), creationAttempted ? folderName : undefined, Boolean(signal?.aborted) || (error instanceof DOMException && error.name === 'AbortError'));
    }
  });
}
