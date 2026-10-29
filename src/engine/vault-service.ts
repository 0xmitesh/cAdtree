import {
  FileSystemDirectoryAdapter,
  validateDirectoryIsolation,
} from './fs-adapter';
import { hashString } from './hash';
import { verifyStoredObject } from './object-store';
import {
  BranchRecord,
  CADTREE_SCHEMA_VERSION,
  CompletionRecord,
  CorruptedVaultRecord,
  IncompleteAttemptRecord,
  MAIN_BRANCH_ID,
  ProjectIdentity,
  ReconstructedRevision,
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

export function computeManifestPayloadChecksum(
  payload: Omit<RevisionManifest, 'manifestPayloadSha256'>
): string {
  const canonical = JSON.stringify({
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
    directories: [...payload.directories],
    files: payload.files.map((f) => ({
      path: f.path,
      size: f.size,
      sha256: f.sha256,
      lastModified: f.lastModified,
    })),
  });
  return hashString(canonical);
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
 * branch heads, competing heads, and incomplete/corrupted records purely from vault files.
 * Does not require IndexedDB or browser metadata.
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

  if (parsedProject.schemaVersion !== CADTREE_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(parsedProject.schemaVersion);
  }

  const expectedProjectHash = computeProjectIdentityChecksum(parsedProject);
  if (parsedProject.payloadSha256 !== expectedProjectHash) {
    throw new Error('Vault integrity failure: project.json checksum mismatch.');
  }

  const corruptedRecords: CorruptedVaultRecord[] = [];
  const incompleteAttempts: IncompleteAttemptRecord[] = [];

  // 1. Load branches
  const branches: BranchRecord[] = [];
  if (await vaultDir.hasDirectory(['branches'])) {
    const branchDir = await vaultDir.getDirectory(['branches']);
    const branchEntries = await branchDir.listEntries();
    for (const entry of branchEntries) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue;
      const recordPath = `branches/${entry.name}`;
      try {
        const text = await branchDir.readFileText([entry.name]);
        const branch = JSON.parse(text) as BranchRecord;
        if (branch.schemaVersion !== CADTREE_SCHEMA_VERSION) {
          throw new UnsupportedSchemaVersionError(branch.schemaVersion);
        }
        const expectedBranchHash = computeBranchRecordChecksum(branch);
        if (branch.payloadSha256 !== expectedBranchHash || branch.projectId !== parsedProject.projectId) {
          corruptedRecords.push({
            recordPath,
            reason: 'Branch record checksum or projectId mismatch.',
          });
          continue;
        }
        branches.push(branch);
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

  branches.sort((a, b) => (a.isMain === b.isMain ? a.name.localeCompare(b.name) : a.isMain ? -1 : 1));

  // 2. Load completion records
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
        if (done.schemaVersion !== CADTREE_SCHEMA_VERSION) {
          throw new UnsupportedSchemaVersionError(done.schemaVersion);
        }
        if (
          !done.revisionId ||
          done.projectId !== parsedProject.projectId ||
          typeof done.manifestSha256 !== 'string'
        ) {
          corruptedRecords.push({
            recordPath,
            revisionId: done.revisionId,
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
        if (completionEntry) {
          corruptedRecords.push({
            recordPath,
            revisionId: revIdFromFilename,
            reason: `Unreadable committed manifest: ${err instanceof Error ? err.message : String(err)}`,
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

      // It has a completion record! Validate manifest JSON and checksums
      let manifest: RevisionManifest;
      try {
        manifest = JSON.parse(rawManifestText) as RevisionManifest;
      } catch {
        corruptedRecords.push({
          recordPath,
          revisionId: revIdFromFilename,
          reason: 'Committed manifest contains invalid JSON.',
        });
        // Surface a damaged revision placeholder so committed corruption is never hidden
        revisions.push({
          manifest: {
            schemaVersion: CADTREE_SCHEMA_VERSION,
            projectId: parsedProject.projectId,
            revisionId: revIdFromFilename,
            branchId: completionEntry.record.branchId,
            parentRevisionId: null,
            displayNumber: completionEntry.record.displayNumber,
            captureStartedAt: completionEntry.record.completedAt,
            captureCompletedAt: completionEntry.record.completedAt,
            summary: '[DAMAGED MANIFEST — INVALID JSON]',
            notes: { problem: '', modification: '', observations: '' },
            directories: [],
            files: [],
            manifestPayloadSha256: '',
          },
          completion: completionEntry.record,
          integrityStatus: 'corrupted',
          integrityErrors: ['Committed manifest file is not valid JSON.'],
        });
        continue;
      }

      if (manifest.schemaVersion !== CADTREE_SCHEMA_VERSION) {
        throw new UnsupportedSchemaVersionError(manifest.schemaVersion);
      }

      const integrityErrors: string[] = [];
      if (manifest.projectId !== parsedProject.projectId) {
        integrityErrors.push('Manifest projectId does not match vault projectId.');
      }
      if (manifest.revisionId !== revIdFromFilename) {
        integrityErrors.push('Manifest revisionId does not match filename.');
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
        manifest: {
          schemaVersion: CADTREE_SCHEMA_VERSION,
          projectId: parsedProject.projectId,
          revisionId: revId,
          branchId: comp.record.branchId,
          parentRevisionId: null,
          displayNumber: comp.record.displayNumber,
          captureStartedAt: comp.record.completedAt,
          captureCompletedAt: comp.record.completedAt,
          summary: '[MISSING MANIFEST FILE]',
          notes: { problem: '', modification: '', observations: '' },
          directories: [],
          files: [],
          manifestPayloadSha256: '',
        },
        completion: comp.record,
        integrityStatus: 'corrupted',
        integrityErrors: [errReason],
      });
    }
  }

  // Sort revisions by displayNumber ascending
  revisions.sort((a, b) => a.manifest.displayNumber - b.manifest.displayNumber);

  // 5. Reconstruct branch heads and detect competing heads from parentRevisionId lineage
  const branchHeads: Record<string, string | null> = {};
  const competingHeads: Record<string, string[]> = {};

  for (const branch of branches) {
    const branchRevs = revisions.filter((r) => r.manifest.branchId === branch.branchId);
    if (branchRevs.length === 0) {
      branchHeads[branch.branchId] = branch.startingRevisionId;
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

    // Leaf revisions on this branch are those not referenced as parentRevisionId by another revision on this branch
    const leaves = branchRevs
      .map((r) => r.manifest.revisionId)
      .filter((id) => !parentIdsReferencedInBranch.has(id));

    // Check if any parent has multiple children on the same branch or if there are multiple leaves
    const hasForkOnSameBranch = Array.from(byParent.values()).some((children) => children.length > 1);

    if (leaves.length > 1 || hasForkOnSameBranch) {
      competingHeads[branch.branchId] = leaves.length > 0 ? leaves : branchRevs.map((r) => r.manifest.revisionId);
      branchHeads[branch.branchId] = leaves[leaves.length - 1] ?? null;
    } else if (leaves.length === 1) {
      branchHeads[branch.branchId] = leaves[0];
    } else {
      // Cycle or corrupted parent links
      competingHeads[branch.branchId] = branchRevs.map((r) => r.manifest.revisionId);
      branchHeads[branch.branchId] = null;
    }
  }

  return {
    project: parsedProject,
    branches,
    revisions,
    branchHeads,
    competingHeads,
    incompleteAttempts,
    corruptedRecords,
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
