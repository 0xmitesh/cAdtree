import {
  FileSystemDirectoryAdapter,
  validateDirectoryIsolation,
} from './fs-adapter';
import { hashString } from './hash';
import { compareSnapshotContents } from './snapshot-comparison';
import { verifyStoredObject } from './object-store';
import { branchNameKey, getBranchBaseline } from './branch-state';
import {
  BranchRecord,
  CADTREE_SCHEMA_VERSION,
  CompletionRecord,
  CorruptedVaultRecord,
  FileEntry,
  FileSpecificNote,
  IncompleteAttemptRecord,
  MAIN_BRANCH_ID,
  ProjectIdentity,
  ReconstructedRevision,
  RevisionDiffResult,
  RevisionManifest,
  VaultState,
} from './types';

export class UnsupportedSchemaVersionError extends Error {
  readonly foundVersion: unknown;
  constructor(foundVersion: unknown) {
    super(
      `Unsupported vault schema version (${String(foundVersion)}). This build of cAdtree supports schemaVersion ${CADTREE_SCHEMA_VERSION} and will not modify or migrate newer/unknown vault records.`
    );
    this.name = 'UnsupportedSchemaVersionError';
    this.foundVersion = foundVersion;
  }
}

export function computeProjectIdentityChecksum(
  payload: Omit<ProjectIdentity, 'payloadSha256'>
): string {
  const canonical = JSON.stringify({
    schemaVersion: payload.schemaVersion,
    projectId: payload.projectId,
    name: payload.name,
    createdAt: payload.createdAt,
  });
  return hashString(canonical);
}

export function computeBranchRecordChecksum(
  payload: Omit<BranchRecord, 'payloadSha256'>
): string {
  const canonical = JSON.stringify({
    schemaVersion: payload.schemaVersion,
    branchId: payload.branchId,
    projectId: payload.projectId,
    name: payload.name,
    reason: payload.reason,
    startingRevisionId: payload.startingRevisionId,
    createdAt: payload.createdAt,
    isMain: payload.isMain,
  });
  return hashString(canonical);
}

/**
 * Computes the canonical payload SHA-256 of a RevisionManifest.
 * Backward-compatibility strategy:
 * - Existing manifests (or manifests without fileNotes) have `fileNotes === undefined`
 *   and serialize using the exact original field layout so existing vault checksums
 *   remain 100% valid without rewriting history.
 * - When `fileNotes` is present and non-empty, `fileNotes` is included in canonical order
 *   so file-specific engineering notes are cryptographically integrity-protected.
 */
export function computeManifestPayloadChecksum(
  payload: Omit<RevisionManifest, 'manifestPayloadSha256'>
): string {
  const baseObj: Record<string, unknown> = {
    schemaVersion: payload.schemaVersion,
    projectId: payload.projectId,
    revisionId: payload.revisionId,
    branchId: payload.branchId,
    parentRevisionId: payload.parentRevisionId,
    displayNumber: payload.displayNumber,
    captureStartedAt: payload.captureStartedAt,
    captureCompletedAt: payload.captureCompletedAt,
    summary: payload.summary,
    notes: {
      problem: payload.notes.problem,
      modification: payload.notes.modification,
      observations: payload.notes.observations,
    },
  };

  if (Array.isArray(payload.fileNotes) && payload.fileNotes.length > 0) {
    baseObj.fileNotes = [...payload.fileNotes]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((fn) => ({
        path: fn.path,
        problem: fn.problem,
        modification: fn.modification,
        observations: fn.observations,
      }));
  }

  baseObj.directories = [...payload.directories];
  baseObj.files = payload.files.map((f) => ({
    path: f.path,
    size: f.size,
    sha256: f.sha256,
    lastModified: f.lastModified,
  }));

  return hashString(JSON.stringify(baseObj));
}

/**
 * Validates that a parsed JSON object has all required RevisionManifest structural fields
 * before checksum calculation or property access.
 */
export function validateManifestStructure(raw: unknown): {
  valid: boolean;
  errors: string[];
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['Manifest root must be a JSON object.'] };
  }
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof obj.projectId !== 'string' || !obj.projectId) {
    errors.push('Missing or invalid string field "projectId".');
  }
  if (typeof obj.revisionId !== 'string' || !obj.revisionId) {
    errors.push('Missing or invalid string field "revisionId".');
  }
  if (typeof obj.branchId !== 'string' || !obj.branchId) {
    errors.push('Missing or invalid string field "branchId".');
  }
  if (obj.parentRevisionId !== null && typeof obj.parentRevisionId !== 'string') {
    errors.push('Field "parentRevisionId" must be a string or null.');
  }
  if (
    typeof obj.displayNumber !== 'number' ||
    !Number.isInteger(obj.displayNumber) ||
    obj.displayNumber < 1
  ) {
    errors.push('Field "displayNumber" must be a positive integer.');
  }
  if (typeof obj.captureStartedAt !== 'string' || !obj.captureStartedAt) {
    errors.push('Missing or invalid string field "captureStartedAt".');
  }
  if (typeof obj.captureCompletedAt !== 'string' || !obj.captureCompletedAt) {
    errors.push('Missing or invalid string field "captureCompletedAt".');
  }
  if (typeof obj.summary !== 'string') {
    errors.push('Missing or invalid string field "summary".');
  }
  if (typeof obj.manifestPayloadSha256 !== 'string' || !obj.manifestPayloadSha256) {
    errors.push('Missing or invalid string field "manifestPayloadSha256".');
  }

  if (!obj.notes || typeof obj.notes !== 'object' || Array.isArray(obj.notes)) {
    errors.push('Missing or invalid object field "notes".');
  } else {
    const notes = obj.notes as Record<string, unknown>;
    if (
      typeof notes.problem !== 'string' ||
      typeof notes.modification !== 'string' ||
      typeof notes.observations !== 'string'
    ) {
      errors.push('Manifest "notes" must contain string fields problem, modification, and observations.');
    }
  }

  if (obj.fileNotes !== undefined) {
    if (!Array.isArray(obj.fileNotes)) {
      errors.push('Optional field "fileNotes" must be an array when present.');
    } else {
      for (let i = 0; i < obj.fileNotes.length; i++) {
        const fn = obj.fileNotes[i] as Record<string, unknown> | null;
        if (
          !fn ||
          typeof fn !== 'object' ||
          typeof fn.path !== 'string' ||
          !fn.path ||
          typeof fn.problem !== 'string' ||
          typeof fn.modification !== 'string' ||
          typeof fn.observations !== 'string'
        ) {
          errors.push(`Invalid fileNotes entry at index ${i}.`);
          break;
        }
      }
    }
  }

  if (!Array.isArray(obj.directories)) {
    errors.push('Missing or invalid array field "directories".');
  } else if (!obj.directories.every((d) => typeof d === 'string' && d.length > 0)) {
    errors.push('All entries in "directories" must be non-empty strings.');
  }

  if (!Array.isArray(obj.files)) {
    errors.push('Missing or invalid array field "files".');
  } else {
    for (let i = 0; i < obj.files.length; i++) {
      const f = obj.files[i] as Record<string, unknown> | null;
      if (
        !f ||
        typeof f !== 'object' ||
        typeof f.path !== 'string' ||
        !f.path ||
        typeof f.size !== 'number' ||
        !Number.isInteger(f.size) ||
        f.size < 0 ||
        typeof f.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(f.sha256) ||
        typeof f.lastModified !== 'number'
      ) {
        errors.push(`Invalid file entry at index ${i} in manifest "files".`);
        break;
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function createDamagedPlaceholderManifest(
  projectId: string,
  completion: CompletionRecord,
  summaryLabel: string
): RevisionManifest {
  return {
    schemaVersion: CADTREE_SCHEMA_VERSION,
    projectId,
    revisionId: completion.revisionId,
    branchId: completion.branchId,
    parentRevisionId: null,
    displayNumber: completion.displayNumber,
    captureStartedAt: completion.completedAt,
    captureCompletedAt: completion.completedAt,
    summary: summaryLabel,
    notes: { problem: '', modification: '', observations: '' },
    directories: [],
    files: [],
    manifestPayloadSha256: '',
  };
}

function generateId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  const rand = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `${prefix}-${rand}`;
}

/**
 * Initializes a brand-new revision vault in an empty directory, separated from the working folder.
 * Never initializes over an existing repository or unrelated files.
 */
export async function initializeProjectVault(
  workingDir: FileSystemDirectoryAdapter,
  vaultDir: FileSystemDirectoryAdapter,
  projectName: string
): Promise<VaultState> {
  const cleanName = projectName.trim();
  if (!cleanName) {
    throw new Error('Project name is required.');
  }

  await validateDirectoryIsolation(workingDir, vaultDir, 'Working folder', 'Revision vault');

  const existingEntries = await vaultDir.listEntries();
  if (existingEntries.length > 0) {
    const hasProjectJson = existingEntries.some((e) => e.name === 'project.json');
    if (hasProjectJson) {
      throw new Error(
        `Vault directory "${vaultDir.name}" already contains a cAdtree repository. Use "Open existing vault" instead.`
      );
    }
    throw new Error(
      `Vault directory "${vaultDir.name}" is not empty (contains ${existingEntries.length} item(s)). Select a dedicated new or empty folder for the revision vault.`
    );
  }

  const now = new Date().toISOString();
  const projectId = generateId('proj');

  const projectDraft: Omit<ProjectIdentity, 'payloadSha256'> = {
    schemaVersion: CADTREE_SCHEMA_VERSION,
    projectId,
    name: cleanName,
    createdAt: now,
  };
  const project: ProjectIdentity = {
    ...projectDraft,
    payloadSha256: computeProjectIdentityChecksum(projectDraft),
  };

  const mainBranchDraft: Omit<BranchRecord, 'payloadSha256'> = {
    schemaVersion: CADTREE_SCHEMA_VERSION,
    branchId: MAIN_BRANCH_ID,
    projectId,
    name: 'Main',
    reason: 'Initial primary engineering design baseline',
    startingRevisionId: null,
    createdAt: now,
    isMain: true,
  };
  const mainBranch: BranchRecord = {
    ...mainBranchDraft,
    payloadSha256: computeBranchRecordChecksum(mainBranchDraft),
  };

  // Create vault structure
  await vaultDir.getDirectory(['branches'], { create: true });
  await vaultDir.getDirectory(['revisions'], { create: true });
  await vaultDir.getDirectory(['completed'], { create: true });
  await vaultDir.getDirectory(['objects'], { create: true });
  await vaultDir.getDirectory(['staging'], { create: true });
  await vaultDir.getDirectory(['cache'], { create: true });

  const projectJson = JSON.stringify(project, null, 2);
  await vaultDir.writeFileText(['project.json'], projectJson);
  const readBackProject = await vaultDir.readFileText(['project.json']);
  if (hashString(readBackProject) !== hashString(projectJson)) {
    throw new Error('Failed to verify project.json after initialization.');
  }

  const branchJson = JSON.stringify(mainBranch, null, 2);
  await vaultDir.writeFileText(['branches', `${MAIN_BRANCH_ID}.json`], branchJson);
  const readBackBranch = await vaultDir.readFileText(['branches', `${MAIN_BRANCH_ID}.json`]);
  if (hashString(readBackBranch) !== hashString(branchJson)) {
    throw new Error('Failed to verify Main branch record after initialization.');
  }

  return openExistingVault(vaultDir);
}

/**
 * Opens an existing vault and reconstructs project identity, branches, committed revisions,
 * branch heads, competing heads, damaged heads, and incomplete/corrupted records purely from vault files.
 * Preserves damaged committed revisions explicitly using validated completion metadata so
 * history is never silently omitted or overwritten.
 */
export async function openExistingVault(
  vaultDir: FileSystemDirectoryAdapter
): Promise<VaultState> {
  const hasProject = await vaultDir.hasFile(['project.json']);
  if (!hasProject) {
    throw new Error(
      `Directory "${vaultDir.name}" is not a valid cAdtree vault (missing project.json).`
    );
  }

  const rawProjectText = await vaultDir.readFileText(['project.json']);
  let parsedProject: ProjectIdentity;
  try {
    parsedProject = JSON.parse(rawProjectText) as ProjectIdentity;
  } catch {
    throw new Error('Corrupted project.json: file is not valid JSON.');
  }

  if (!parsedProject || typeof parsedProject !== 'object') {
    throw new Error('Corrupted project.json: root must be an object.');
  }

  if (parsedProject.schemaVersion !== CADTREE_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(parsedProject.schemaVersion);
  }

  if (
    typeof parsedProject.projectId !== 'string' ||
    !parsedProject.projectId ||
    typeof parsedProject.name !== 'string' ||
    typeof parsedProject.createdAt !== 'string'
  ) {
    throw new Error('Vault integrity failure: project.json is missing required identity fields.');
  }

  const expectedProjectHash = computeProjectIdentityChecksum(parsedProject);
  if (parsedProject.payloadSha256 !== expectedProjectHash) {
    throw new Error('Vault integrity failure: project.json checksum mismatch.');
  }

  const corruptedRecords: CorruptedVaultRecord[] = [];
  const incompleteAttempts: IncompleteAttemptRecord[] = [];

  // 1. Load completion records: committed branch identities survive damaged ready markers
  const completionMap = new Map<string, { record: CompletionRecord; rawPath: string }>();
  if (await vaultDir.hasDirectory(['completed'])) {
    const completedDir = await vaultDir.getDirectory(['completed']);
    const completedEntries = await completedDir.listEntries();
    for (const entry of completedEntries) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.done.json')) continue;
      const recordPath = `completed/${entry.name}`;
      try {
        const text = await completedDir.readFileText([entry.name]);
        const done = JSON.parse(text) as CompletionRecord;
        if (!done || typeof done !== 'object') {
          corruptedRecords.push({ recordPath, reason: 'Completion record is not a JSON object.' });
          continue;
        }
        if (done.schemaVersion !== CADTREE_SCHEMA_VERSION) {
          throw new UnsupportedSchemaVersionError(done.schemaVersion);
        }
        if (
          typeof done.revisionId !== 'string' ||
          !done.revisionId ||
          typeof done.branchId !== 'string' ||
          !done.branchId ||
          typeof done.displayNumber !== 'number' ||
          !Number.isInteger(done.displayNumber) ||
          done.displayNumber < 1 ||
          done.projectId !== parsedProject.projectId ||
          typeof done.manifestSha256 !== 'string' ||
          typeof done.completedAt !== 'string'
        ) {
          corruptedRecords.push({
            recordPath,
            revisionId: typeof done?.revisionId === 'string' ? done.revisionId : undefined,
            reason: 'Invalid completion record fields.',
          });
          continue;
        }
        completionMap.set(done.revisionId, { record: done, rawPath: recordPath });
      } catch (err) {
        if (err instanceof UnsupportedSchemaVersionError) throw err;
        corruptedRecords.push({
          recordPath,
          reason: `Malformed completion record: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  // 2. Load branches after committed identities are known
  const branches: BranchRecord[] = [];
  const establishedBranchIds = new Set(Array.from(completionMap.values(), ({ record }) => record.branchId));
  const damagedBranchPublications: Record<string, string> = {};
  if (await vaultDir.hasDirectory(['branches'])) {
    const branchDir = await vaultDir.getDirectory(['branches']);
    const branchEntries = await branchDir.listEntries();
    for (const entry of branchEntries) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue;
      if (entry.name.endsWith('.ready.json')) {
        const branchId = entry.name.slice(0, -'.ready.json'.length);
        if (!branchEntries.some((candidate) => candidate.kind === 'file' && candidate.name === `${branchId}.branch.json`)) {
          corruptedRecords.push({ recordPath: `branches/${entry.name}`, reason: 'Branch ready marker has no matching branch record. Restore the missing branch record.' });
        }
        continue;
      }
      const recordPath = `branches/${entry.name}`;
      try {
        // New branch publications use a separate final marker. Legacy *.json records
        // retain their original checksum and publication rules, including Main.
        let expectedRecordHash: string | undefined;
        let readyMarkerError: string | undefined;
        if (entry.name.endsWith('.branch.json')) {
          const branchId = entry.name.slice(0, -'.branch.json'.length);
          try {
            const marker = JSON.parse(await branchDir.readFileText([`${branchId}.ready.json`]));
            if (marker.projectId !== parsedProject.projectId || marker.branchId !== branchId || !/^[a-f0-9]{64}$/.test(marker.recordSha256)) throw new Error('Invalid branch completion marker.');
            expectedRecordHash = marker.recordSha256;
          } catch (error) {
            readyMarkerError = `Branch ready marker is missing, unreadable, or malformed: ${error instanceof Error ? error.message : String(error)}`;
            if (!establishedBranchIds.has(branchId)) {
              incompleteAttempts.push({ id: branchId, kind: 'uncompleted_branch', path: recordPath, detail: 'Branch publication has no valid ready marker and no committed revision. Its working copy may be incomplete; it is excluded from ready branches. Retry into a fresh folder.' });
              continue;
            }
          }
        }
        const text = await branchDir.readFileText([entry.name]);
        if (expectedRecordHash && hashString(text) !== expectedRecordHash) {
          readyMarkerError = 'Branch ready marker checksum does not match the branch record.';
          if (!establishedBranchIds.has(entry.name.slice(0, -'.branch.json'.length))) throw new Error(readyMarkerError);
        }
        const branch = JSON.parse(text) as BranchRecord;
        if (!branch || typeof branch !== 'object') {
          corruptedRecords.push({ recordPath, reason: 'Branch record is not a JSON object.' });
          continue;
        }
        if (branch.schemaVersion !== CADTREE_SCHEMA_VERSION) {
          throw new UnsupportedSchemaVersionError(branch.schemaVersion);
        }
        if (
          typeof branch.branchId !== 'string' ||
          typeof branch.projectId !== 'string' ||
          typeof branch.name !== 'string' ||
          typeof branch.reason !== 'string' ||
          typeof branch.createdAt !== 'string' ||
          typeof branch.isMain !== 'boolean' ||
          !branch.branchId || !branch.name.trim() ||
          (entry.name !== `${branch.branchId}.json` && entry.name !== `${branch.branchId}.branch.json`) ||
          (branch.startingRevisionId !== null && typeof branch.startingRevisionId !== 'string')
        ) {
          corruptedRecords.push({
            recordPath,
            reason: 'Branch record is missing required structural fields.',
          });
          continue;
        }
        const expectedBranchHash = computeBranchRecordChecksum(branch);
        if (
          branch.payloadSha256 !== expectedBranchHash ||
          branch.projectId !== parsedProject.projectId
        ) {
          corruptedRecords.push({
            recordPath,
            reason: 'Branch record checksum or projectId mismatch.',
          });
          continue;
        }
        branches.push(branch);
        if (readyMarkerError) {
          const reason = `Established branch "${branch.name}" has a damaged ready marker. ${readyMarkerError} Its identity and working-folder connection remain required; saving on this branch is blocked.`;
          damagedBranchPublications[branch.branchId] = reason;
          corruptedRecords.push({ recordPath: `branches/${branch.branchId}.ready.json`, reason });
        }
      } catch (err) {
        if (err instanceof UnsupportedSchemaVersionError) throw err;
        corruptedRecords.push({
          recordPath,
          reason: `Malformed branch record: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  if (branches.length === 0) {
    throw new Error('Vault integrity failure: no valid branch records found in branches/.');
  }

  branches.sort((a, b) =>
    a.isMain === b.isMain ? a.name.localeCompare(b.name) : a.isMain ? -1 : 1
  );

  for (const branchId of establishedBranchIds) {
    if (!branches.some((branch) => branch.branchId === branchId)) {
      corruptedRecords.push({ recordPath: `branches/${branchId}`, reason: `Committed branch identity "${branchId}" has no validated branch record. Folder isolation cannot be established; write operations are blocked until the record is restored.` });
    }
  }

  // 3. Inspect staging directory for interrupted work
  if (await vaultDir.hasDirectory(['staging'])) {
    const stagingDir = await vaultDir.getDirectory(['staging']);
    const stagingEntries = await stagingDir.listEntries();
    for (const entry of stagingEntries) {
      incompleteAttempts.push({
        id: entry.name,
        kind: 'staging_artifact',
        path: `staging/${entry.name}`,
        detail: `Uncommitted staging data from an interrupted write session (${entry.name}). Ignored by committed history.`,
      });
    }
  }

  // 4. Load manifests and pair with completion records
  const revisions: ReconstructedRevision[] = [];
  const seenManifestRevisionIds = new Set<string>();

  if (await vaultDir.hasDirectory(['revisions'])) {
    const revisionsDir = await vaultDir.getDirectory(['revisions']);
    const manifestEntries = await revisionsDir.listEntries();

    for (const entry of manifestEntries) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.manifest.json')) continue;
      const recordPath = `revisions/${entry.name}`;
      const revIdFromFilename = entry.name.replace(/\.manifest\.json$/, '');
      seenManifestRevisionIds.add(revIdFromFilename);

      const completionEntry = completionMap.get(revIdFromFilename);

      let rawManifestText = '';
      try {
        rawManifestText = await revisionsDir.readFileText([entry.name]);
      } catch (err) {
        const readErrMsg = `Unreadable committed manifest: ${
          err instanceof Error ? err.message : String(err)
        }`;
        if (completionEntry) {
          corruptedRecords.push({
            recordPath,
            revisionId: revIdFromFilename,
            reason: readErrMsg,
          });
          // CRITICAL FIX: Preserve the damaged committed revision in history using validated completion metadata
          revisions.push({
            manifest: createDamagedPlaceholderManifest(
              parsedProject.projectId,
              completionEntry.record,
              '[DAMAGED MANIFEST — UNREADABLE FILE]'
            ),
            completion: completionEntry.record,
            integrityStatus: 'corrupted',
            integrityErrors: [readErrMsg],
          });
        } else {
          incompleteAttempts.push({
            id: revIdFromFilename,
            kind: 'uncompleted_manifest',
            path: recordPath,
            detail: 'Unreadable manifest without completion record.',
          });
        }
        continue;
      }

      const rawManifestFileSha256 = hashString(rawManifestText);

      if (!completionEntry) {
        // Manifest exists without a completion record -> interrupted / unpublished attempt
        incompleteAttempts.push({
          id: revIdFromFilename,
          kind: 'uncompleted_manifest',
          path: recordPath,
          detail: `Unpublished manifest ${entry.name} has no completion record and is excluded from committed history.`,
        });
        continue;
      }

      // It has a completion record! Parse JSON first
      let parsedRaw: unknown;
      try {
        parsedRaw = JSON.parse(rawManifestText);
      } catch {
        const jsonErrMsg = 'Committed manifest file is not valid JSON.';
        corruptedRecords.push({
          recordPath,
          revisionId: revIdFromFilename,
          reason: jsonErrMsg,
        });
        revisions.push({
          manifest: createDamagedPlaceholderManifest(
            parsedProject.projectId,
            completionEntry.record,
            '[DAMAGED MANIFEST — INVALID JSON]'
          ),
          completion: completionEntry.record,
          integrityStatus: 'corrupted',
          integrityErrors: [jsonErrMsg],
        });
        continue;
      }

      // Check schemaVersion before structural validation so genuinely unsupported newer schema versions throw UnsupportedSchemaVersionError
      if (
        parsedRaw &&
        typeof parsedRaw === 'object' &&
        !Array.isArray(parsedRaw) &&
        'schemaVersion' in parsedRaw &&
        (parsedRaw as { schemaVersion: unknown }).schemaVersion !== CADTREE_SCHEMA_VERSION
      ) {
        throw new UnsupportedSchemaVersionError(
          (parsedRaw as { schemaVersion: unknown }).schemaVersion
        );
      }

      // Validate manifest structure before accessing fields or computing checksums
      const structuralValidation = validateManifestStructure(parsedRaw);
      if (!structuralValidation.valid) {
        const structErrMsg = `Malformed manifest structure: ${structuralValidation.errors.join(' ')}`;
        corruptedRecords.push({
          recordPath,
          revisionId: revIdFromFilename,
          reason: structErrMsg,
        });
        revisions.push({
          manifest: createDamagedPlaceholderManifest(
            parsedProject.projectId,
            completionEntry.record,
            '[DAMAGED MANIFEST — MISSING REQUIRED FIELDS]'
          ),
          completion: completionEntry.record,
          integrityStatus: 'corrupted',
          integrityErrors: structuralValidation.errors,
        });
        continue;
      }

      const manifest = parsedRaw as RevisionManifest;
      const integrityErrors: string[] = [];

      if (manifest.projectId !== parsedProject.projectId) {
        integrityErrors.push('Manifest projectId does not match vault projectId.');
      }
      if (manifest.revisionId !== revIdFromFilename) {
        integrityErrors.push('Manifest revisionId does not match filename.');
      }
      if (manifest.branchId !== completionEntry.record.branchId) {
        integrityErrors.push('Manifest branchId does not match completion record branchId.');
      }
      if (manifest.displayNumber !== completionEntry.record.displayNumber) {
        integrityErrors.push('Manifest displayNumber does not match completion record displayNumber.');
      }

      const computedPayloadHash = computeManifestPayloadChecksum(manifest);
      if (manifest.manifestPayloadSha256 !== computedPayloadHash) {
        integrityErrors.push('Manifest internal payload SHA-256 checksum mismatch.');
      }
      if (completionEntry.record.manifestSha256 !== rawManifestFileSha256) {
        integrityErrors.push('Completion record manifestSha256 does not match manifest file SHA-256.');
      }

      if (integrityErrors.length > 0) {
        corruptedRecords.push({
          recordPath,
          revisionId: manifest.revisionId,
          reason: integrityErrors.join(' '),
        });
      }

      revisions.push({
        manifest,
        completion: completionEntry.record,
        integrityStatus: integrityErrors.length > 0 ? 'corrupted' : 'manifest_verified',
        integrityErrors,
      });
    }
  }

  // Check for orphan completion records whose manifest file is completely missing
  for (const [revId, comp] of completionMap.entries()) {
    if (!seenManifestRevisionIds.has(revId)) {
      const errReason = `Committed revision ${revId} has a completion record (${comp.rawPath}) but its manifest file is missing.`;
      corruptedRecords.push({
        recordPath: comp.rawPath,
        revisionId: revId,
        reason: errReason,
      });
      revisions.push({
        manifest: createDamagedPlaceholderManifest(
          parsedProject.projectId,
          comp.record,
          '[MISSING MANIFEST FILE]'
        ),
        completion: comp.record,
        integrityStatus: 'corrupted',
        integrityErrors: [errReason],
      });
    }
  }

  // Sort revisions by displayNumber ascending
  revisions.sort((a, b) => a.manifest.displayNumber - b.manifest.displayNumber);

  // 5. Reconstruct branch heads, competing heads, and damaged branch heads
  const branchHeads: Record<string, string | null> = {};
  const competingHeads: Record<string, string[]> = {};
  const damagedBranchHeads: Record<string, string> = {};

  for (const branch of branches) {
    const branchRevs = revisions.filter((r) => r.manifest.branchId === branch.branchId);
    if (branchRevs.length === 0) {
      branchHeads[branch.branchId] = branch.startingRevisionId;
      continue;
    }

    // If any committed revision on this branch has a damaged manifest/completion record,
    // its parent lineage or baseline state cannot be trusted for new captures.
    const damagedRevsOnBranch = branchRevs.filter((r) => r.integrityStatus === 'corrupted');
    if (damagedRevsOnBranch.length > 0) {
      const damagedLabels = damagedRevsOnBranch
        .map((r) => `${formatRevisionNumber(r.manifest.displayNumber)} (${r.manifest.revisionId})`)
        .join(', ');
      damagedBranchHeads[branch.branchId] =
        `Branch "${branch.name}" contains damaged committed revision(s): ${damagedLabels}. ` +
        `The intended branch head cannot be safely established; new captures are blocked to prevent history loss or duplicate numbering.`;
      // Point branchHeads to the highest displayNumber revision on the branch so UI never silently falls back to an older head
      branchHeads[branch.branchId] =
        branchRevs[branchRevs.length - 1]?.manifest.revisionId ?? null;
      continue;
    }

    const parentIdsReferencedInBranch = new Set<string>();
    const byParent = new Map<string, string[]>();

    for (const r of branchRevs) {
      const pKey = r.manifest.parentRevisionId ?? '__ROOT__';
      const list = byParent.get(pKey) ?? [];
      list.push(r.manifest.revisionId);
      byParent.set(pKey, list);
      if (r.manifest.parentRevisionId) {
        parentIdsReferencedInBranch.add(r.manifest.parentRevisionId);
      }
    }

    // Verify every non-null parentRevisionId exists in the vault
    const allVaultRevIds = new Set(revisions.map((r) => r.manifest.revisionId));
    const missingParentRev = branchRevs.find(
      (r) => r.manifest.parentRevisionId !== null && !allVaultRevIds.has(r.manifest.parentRevisionId)
    );
    if (missingParentRev) {
      damagedBranchHeads[branch.branchId] =
        `Revision ${formatRevisionNumber(missingParentRev.manifest.displayNumber)} references missing parent revision "${missingParentRev.manifest.parentRevisionId}".`;
      branchHeads[branch.branchId] =
        branchRevs[branchRevs.length - 1]?.manifest.revisionId ?? null;
      continue;
    }

    const leaves = branchRevs
      .map((r) => r.manifest.revisionId)
      .filter((id) => !parentIdsReferencedInBranch.has(id));

    const hasForkOnSameBranch = Array.from(byParent.values()).some(
      (children) => children.length > 1
    );

    if (leaves.length > 1 || hasForkOnSameBranch) {
      competingHeads[branch.branchId] =
        leaves.length > 0 ? leaves : branchRevs.map((r) => r.manifest.revisionId);
      branchHeads[branch.branchId] = leaves[leaves.length - 1] ?? null;
    } else if (leaves.length === 1) {
      branchHeads[branch.branchId] = leaves[0];
    } else {
      competingHeads[branch.branchId] = branchRevs.map((r) => r.manifest.revisionId);
      branchHeads[branch.branchId] = null;
    }
  }

  for (const [branchId, reason] of Object.entries(damagedBranchPublications)) {
    damagedBranchHeads[branchId] = [reason, damagedBranchHeads[branchId]].filter(Boolean).join(' ');
  }

  const state: VaultState = {
    project: parsedProject,
    branches,
    revisions,
    branchHeads,
    competingHeads,
    damagedBranchHeads,
    incompleteAttempts,
    corruptedRecords,
  };
  for (const branch of branches) {
    if (branches.some((other) => other !== branch && (other.branchId === branch.branchId || branchNameKey(other.name) === branchNameKey(branch.name)))) {
      damagedBranchHeads[branch.branchId] = `Branch "${branch.name}" has a duplicate identity or name. Operations are blocked.`;
    }
    try { getBranchBaseline(state, branch.branchId); }
    catch (error) { damagedBranchHeads[branch.branchId] = error instanceof Error ? error.message : String(error); }
  }
  return state;
}

/**
 * Computes the file and directory changes introduced in `revision` compared to its
 * recorded `parentRevisionId` (never whichever revision happens to be newest).
 * - If `revision` is the initial baseline (`parentRevisionId === null`), returns `status: 'baseline'`.
 * - If `revision` is damaged or its recorded parent manifest is missing or damaged,
 *   returns `status: 'unavailable'` with an explicit reason (never substituting zero changes).
 */
export function computeRevisionDiff(
  revision: ReconstructedRevision,
  vaultState: VaultState
): RevisionDiffResult {
  if (revision.integrityStatus === 'corrupted') {
    return {
      status: 'unavailable',
      unavailableReason: `Comparison unavailable: ${formatRevisionNumber(
        revision.manifest.displayNumber
      )} manifest is damaged and cannot be validated.`,
      parentRevisionId: revision.manifest.parentRevisionId,
      parentDisplayNumber: null,
      added: [],
      modified: [],
      deleted: [],
      unchanged: [],
      addedDirectories: [],
      deletedDirectories: [],
      unchangedDirectories: [],
    };
  }

  const parentId = revision.manifest.parentRevisionId;
  if (parentId === null) {
    return {
      status: 'baseline',
      parentRevisionId: null,
      parentDisplayNumber: null,
      ...compareSnapshotContents({ files: [], directories: [] }, revision.manifest),
    };
  }

  const parentRev = vaultState.revisions.find((r) => r.manifest.revisionId === parentId);
  if (!parentRev) {
    return {
      status: 'unavailable',
      unavailableReason: `Comparison unavailable: recorded parent revision (${parentId}) was not found in vault.`,
      parentRevisionId: parentId,
      parentDisplayNumber: null,
      added: [],
      modified: [],
      deleted: [],
      unchanged: [],
      addedDirectories: [],
      deletedDirectories: [],
      unchangedDirectories: [],
    };
  }

  if (parentRev.integrityStatus === 'corrupted') {
    return {
      status: 'unavailable',
      unavailableReason: `Comparison unavailable: recorded parent ${formatRevisionNumber(
        parentRev.manifest.displayNumber
      )} (${parentId}) is damaged and its manifest cannot be validated.`,
      parentRevisionId: parentId,
      parentDisplayNumber: parentRev.manifest.displayNumber,
      added: [],
      modified: [],
      deleted: [],
      unchanged: [],
      addedDirectories: [],
      deletedDirectories: [],
      unchangedDirectories: [],
    };
  }

  return {
    status: 'compared',
    parentRevisionId: parentId,
    parentDisplayNumber: parentRev.manifest.displayNumber,
    ...compareSnapshotContents(parentRev.manifest, revision.manifest),
  };
}

/**
 * Explicitly verifies all content objects referenced by a revision (or all revisions in the vault).
 * Reopening a vault only labels revisions as 'manifest_verified'; full byte verification happens
 * either explicitly via this function or before reuse/restore.
 */
export async function verifyRevisionObjects(
  vaultDir: FileSystemDirectoryAdapter,
  revision: ReconstructedRevision,
  signal?: AbortSignal
): Promise<ReconstructedRevision> {
  if (revision.integrityStatus === 'corrupted') {
    return revision;
  }

  const errors: string[] = [...revision.integrityErrors];
  for (const file of revision.manifest.files) {
    const res = await verifyStoredObject(vaultDir, file.sha256, file.size, signal);
    if (!res.valid && res.reason) {
      errors.push(`File "${file.path}": ${res.reason}`);
    }
  }

  return {
    ...revision,
    integrityStatus: errors.length > 0 ? 'corrupted' : 'objects_verified',
    integrityErrors: errors,
  };
}

export function formatRevisionNumber(displayNumber: number): string {
  return `Rev ${String(displayNumber).padStart(3, '0')}`;
}

export function sanitizeFileSpecificNotes(
  notes: FileSpecificNote[] | undefined
): FileSpecificNote[] | undefined {
  if (!notes || notes.length === 0) return undefined;
  const byPath = new Map<string, FileSpecificNote>();
  for (const n of notes) {
    const path = n.path.trim();
    const problem = n.problem.trim();
    const modification = n.modification.trim();
    const observations = n.observations.trim();
    if (!path) continue;
    if (!problem && !modification && !observations) continue;
    byPath.set(path, { path, problem, modification, observations });
  }
  if (byPath.size === 0) return undefined;
  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}

