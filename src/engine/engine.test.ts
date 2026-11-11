import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashBytes, hashStream, hashString, Sha256Hasher } from './hash';
import {
  checkCaseInsensitiveCollisions,
  FileConflictError,
  InMemoryFileSystemAdapter,
  splitAndValidatePath,
  validateDirectoryIsolation,
} from './fs-adapter';
import {
  applyFixtureBMutations,
  generateDeterministicBinaryBytes,
  populateFixtureA,
  verifyDirectoryMatchesFixture,
} from './fixtures';
import {
  computeManifestPayloadChecksum,
  computeRevisionDiff,
  initializeProjectVault,
  openExistingVault,
  UnsupportedSchemaVersionError,
  verifyRevisionObjects,
} from './vault-service';
import {
  enumerateWorkingFolder,
  isEffectivelyEmpty,
  isSystemClutterName,
  partitionSystemFiles,
  scanBranchChanges,
} from './scanner';
import { captureRevision, ReviewStaleError } from './revision-service';
import {
  restoreRevisionToFolder,
  restoreSelectedFilesToFolder,
} from './recovery-service';
import { CADTREE_SCHEMA_VERSION, MAIN_BRANCH_ID, RevisionManifest } from './types';
import { getObjectPathSegments } from './object-store';

test('Incremental Sha256Hasher matches Node crypto across boundary sizes and chunk splits', async () => {
  const sizes = [0, 1, 55, 56, 57, 63, 64, 65, 127, 128, 129, 4096, 131072];
  for (const size of sizes) {
    const data = generateDeterministicBinaryBytes(`SEED_${size}`, size);
    const expectedHex = crypto.createHash('sha256').update(data).digest('hex');

    assert.equal(hashBytes(data), expectedHex, `Single-buffer mismatch for size ${size}`);

    const hasher = new Sha256Hasher();
    let offset = 0;
    const stepSizes = [7, 61, 1, 19, 128, 33];
    let stepIdx = 0;
    while (offset < data.byteLength) {
      const step = stepSizes[stepIdx % stepSizes.length];
      stepIdx++;
      const end = Math.min(offset + step, data.byteLength);
      hasher.update(data.subarray(offset, end));
      offset = end;
    }
    assert.equal(hasher.digestHex(), expectedHex, `Chunked mismatch for size ${size}`);
  }

  const streamBytes = generateDeterministicBinaryBytes('STREAM_TEST', 90000);
  const expectedStreamHex = crypto.createHash('sha256').update(streamBytes).digest('hex');
  const mem = new InMemoryFileSystemAdapter('stream-root');
  await mem.writeFileBytes(['sample.bin'], streamBytes);
  const stream = await mem.readFileStream(['sample.bin']);
  const res = await hashStream(stream);
  assert.equal(res.size, 90000);
  assert.equal(res.sha256, expectedStreamHex);
});

test('Path validation and directory isolation enforce safety boundaries', async () => {
  assert.deepEqual(splitAndValidatePath('Parts/BasePlate.SLDPRT'), ['Parts', 'BasePlate.SLDPRT']);
  assert.deepEqual(splitAndValidatePath('Parts/Dichtung_Ø24mm_Übergang.SLDPRT'), [
    'Parts',
    'Dichtung_Ø24mm_Übergang.SLDPRT',
  ]);

  assert.throws(() => splitAndValidatePath(''), /non-empty/);
  assert.throws(() => splitAndValidatePath('/etc/passwd'), /absolute paths/);
  assert.throws(() => splitAndValidatePath('Parts/../Secret.SLDPRT'), /traversal/);
  assert.throws(() => splitAndValidatePath('Parts\\Sub\\Part.SLDPRT'), /backslashes/);
  assert.throws(() => splitAndValidatePath('C:/SolidWorks/Part.SLDPRT'), /drive prefixes/);
  assert.throws(() => splitAndValidatePath('Parts/CON.SLDPRT'), /reserved Windows device/);
  assert.throws(() => splitAndValidatePath('Parts/TrailingSpace /Part.SLDPRT'), /ends with space/);

  const collisions = checkCaseInsensitiveCollisions([
    'Parts/Bracket.SLDPRT',
    'parts/bracket.sldprt',
  ]);
  assert.equal(collisions.length, 1);
  assert.match(collisions[0], /Case-insensitive path collision/);

  const root = new InMemoryFileSystemAdapter('workspace');
  const working = await root.getDirectory(['CAD_Working'], { create: true });
  const nestedVault = await working.getDirectory(['Nested_Vault'], { create: true });
  const separateVault = await root.getDirectory(['CAD_Vault'], { create: true });

  await assert.rejects(() => validateDirectoryIsolation(working, working), /exact same directory/);
  await assert.rejects(() => validateDirectoryIsolation(working, nestedVault), /nested inside/);
  await assert.rejects(() => validateDirectoryIsolation(nestedVault, working), /nested inside/);
  await validateDirectoryIsolation(working, separateVault);
});

test('Vault initialization refuses non-empty or existing vault directories', async () => {
  const root = new InMemoryFileSystemAdapter('root');
  const working = await root.getDirectory(['Working'], { create: true });
  const nonEmptyVault = await root.getDirectory(['NonEmpty'], { create: true });
  await nonEmptyVault.writeFileText(['unrelated.txt'], 'hello');

  await assert.rejects(
    () => initializeProjectVault(working, nonEmptyVault, 'Test Project'),
    /not empty/
  );

  const validVault = await root.getDirectory(['CleanVault'], { create: true });
  await initializeProjectVault(working, validVault, 'Test Project');

  await assert.rejects(
    () => initializeProjectVault(working, validVault, 'Second Project'),
    /already contains a cAdtree repository/
  );
});

test('Milestone 1 end-to-end acceptance: Capture A -> Mutate to B -> Capture B -> Restore A -> Reopen without metadata', async () => {
  const root = new InMemoryFileSystemAdapter('test-disk');
  const workingDir = await root.getDirectory(['Project_Actuator_Working'], { create: true });
  const vaultDir = await root.getDirectory(['Project_Actuator_Vault'], { create: true });

  const expectedFixtureA = await populateFixtureA(workingDir);
  const initState = await initializeProjectVault(workingDir, vaultDir, 'Linear Actuator Housing');
  assert.equal(initState.project.name, 'Linear Actuator Housing');
  assert.equal(initState.branches.length, 1);
  assert.equal(initState.branches[0].branchId, MAIN_BRANCH_ID);
  assert.equal(initState.revisions.length, 0);

  const scanA = await scanBranchChanges(workingDir, MAIN_BRANCH_ID, null);
  assert.equal(scanA.canCapture, true);
  assert.equal(scanA.added.length, 9);
  assert.equal(scanA.directories.length, 8);
  assert.equal(scanA.errors.length, 0);

  const capA = await captureRevision(workingDir, vaultDir, {
    branchId: MAIN_BRANCH_ID,
    summary: 'Initial baseline capture of actuator housing assembly',
    notes: {
      problem: 'Need baseline before adding stiffening ribs and shaft keyway',
      modification: 'Captured initial 9 files and 8 directories including empty export folders',
      observations: 'Clearance verified at 0.025mm nominal',
    },
  });

  assert.equal(capA.revision.manifest.displayNumber, 1);
  assert.equal(capA.revision.manifest.parentRevisionId, null);
  assert.equal(capA.revision.manifest.branchId, MAIN_BRANCH_ID);
  assert.equal(capA.revision.manifest.files.length, 9);
  assert.equal(capA.revision.manifest.directories.length, 8);

  const scanNoChange = await scanBranchChanges(
    workingDir,
    MAIN_BRANCH_ID,
    capA.revision.manifest
  );
  assert.equal(scanNoChange.hasChanges, false);
  assert.equal(scanNoChange.canCapture, false);
  assert.equal(scanNoChange.unchanged.length, 9);

  await assert.rejects(
    () =>
      captureRevision(workingDir, vaultDir, {
        branchId: MAIN_BRANCH_ID,
        summary: 'Redundant save',
        notes: { problem: '', modification: '', observations: '' },
      }),
    /No changes detected/
  );

  await applyFixtureBMutations(workingDir);
  const expectedFixtureB = await verifyDirectoryMatchesFixture(workingDir, expectedFixtureA);
  assert.equal(expectedFixtureB.matches, false);

  const scanB = await scanBranchChanges(workingDir, MAIN_BRANCH_ID, capA.revision.manifest);
  assert.equal(scanB.hasChanges, true);
  assert.equal(scanB.canCapture, true);
  assert.equal(scanB.added.length, 1);
  assert.equal(scanB.added[0].path, 'Parts/Bearing_Retainer_Plate.SLDPRT');
  assert.equal(scanB.modified.length, 2);
  assert.equal(scanB.deleted.length, 1);
  assert.equal(scanB.deleted[0].path, 'Specs/Engineering_ZeroByte_Marker.lock');
  assert.equal(scanB.unchanged.length, 6);
  assert.deepEqual(scanB.addedDirectories, ['Exports/IGES_Archive']);

  const capB = await captureRevision(workingDir, vaultDir, {
    branchId: MAIN_BRANCH_ID,
    summary: 'Added bearing retainer plate, housing ribs, and shaft keyway',
    notes: {
      problem: 'Housing deflection exceeded 0.08mm under 42 Nm peak torque',
      modification: 'Added 4mm ribs to Housing_MainBody and keyway to Output_Shaft_12mm',
      observations: 'Mass increased by 48g; FEA deflection reduced to 0.03mm',
    },
  });

  assert.equal(capB.revision.manifest.displayNumber, 2);
  assert.equal(capB.revision.manifest.parentRevisionId, capA.revision.manifest.revisionId);
  assert.equal(capB.revision.manifest.files.length, 9);
  assert.equal(capB.revision.manifest.directories.length, 9);

  const recoveryDirA = await root.getDirectory(['Recovered_Rev001_Clean'], { create: true });
  const restoreRes = await restoreRevisionToFolder({
    vaultDir,
    destinationDir: recoveryDirA,
    workingDir,
    revisionId: capA.revision.manifest.revisionId,
  });

  assert.equal(restoreRes.kind, 'full_project');
  assert.equal(restoreRes.displayNumber, 1);
  assert.equal(restoreRes.restoredFilesCount, 9);
  assert.equal(restoreRes.restoredDirectoriesCount, 8);

  const matchA = await verifyDirectoryMatchesFixture(recoveryDirA, expectedFixtureA);
  assert.equal(matchA.matches, true, `Recovered folder mismatches: ${matchA.mismatches.join('; ')}`);

  const postRestoreScanOnWorking = await scanBranchChanges(
    workingDir,
    MAIN_BRANCH_ID,
    capB.revision.manifest
  );
  assert.equal(postRestoreScanOnWorking.hasChanges, false);
  assert.equal(postRestoreScanOnWorking.unchanged.length, 9);

  const reopenedState = await openExistingVault(vaultDir);
  assert.equal(reopenedState.project.projectId, initState.project.projectId);
  assert.equal(reopenedState.revisions.length, 2);
  assert.equal(reopenedState.revisions[0].manifest.displayNumber, 1);
  assert.equal(reopenedState.revisions[1].manifest.displayNumber, 2);
});

test('Regression Fix 1: Unreadable or structurally malformed committed manifests are preserved as damaged and block unsafe branch captures', async () => {
  const root = new InMemoryFileSystemAdapter('fix1-disk');
  const workingDir = await root.getDirectory(['Working'], { create: true });
  const vaultDir = (await root.getDirectory(['Vault'], {
    create: true,
  })) as InMemoryFileSystemAdapter;

  await workingDir.writeFileBytes(
    ['Part1.SLDPRT'],
    generateDeterministicBinaryBytes('P1_V1', 2048)
  );
  await initializeProjectVault(workingDir, vaultDir, 'Damaged History Test');

  // Capture Revision 001
  const rev1 = await captureRevision(workingDir, vaultDir, {
    branchId: MAIN_BRANCH_ID,
    summary: 'Revision 1 baseline',
    notes: { problem: '', modification: '', observations: '' },
  });
  assert.equal(rev1.revision.manifest.displayNumber, 1);

  // Modify Part1 and capture Revision 002
  await workingDir.writeFileBytes(
    ['Part1.SLDPRT'],
    generateDeterministicBinaryBytes('P1_V2', 2048)
  );
  const rev2 = await captureRevision(workingDir, vaultDir, {
    branchId: MAIN_BRANCH_ID,
    summary: 'Revision 2 edit',
    notes: { problem: '', modification: '', observations: '' },
  });
  assert.equal(rev2.revision.manifest.displayNumber, 2);

  // Make Revision 002's committed manifest unreadable
  const rev2Id = rev2.revision.manifest.revisionId;
  vaultDir.markFileUnreadable(
    ['revisions', `${rev2Id}.manifest.json`],
    'Simulated disk read error on committed manifest 2'
  );

  // Reopen vault: Revision 002 MUST be preserved in reconstructed revisions as corrupted!
  const stateWithUnreadableRev2 = await openExistingVault(vaultDir);
  assert.equal(stateWithUnreadableRev2.revisions.length, 2);
  assert.equal(stateWithUnreadableRev2.revisions[0].manifest.displayNumber, 1);
  assert.equal(stateWithUnreadableRev2.revisions[0].integrityStatus, 'manifest_verified');
  assert.equal(stateWithUnreadableRev2.revisions[1].manifest.displayNumber, 2);
  assert.equal(stateWithUnreadableRev2.revisions[1].manifest.revisionId, rev2Id);
  assert.equal(stateWithUnreadableRev2.revisions[1].integrityStatus, 'corrupted');
  assert.ok(stateWithUnreadableRev2.damagedBranchHeads[MAIN_BRANCH_ID]);

  // Attempting to capture another revision on Main MUST be blocked (never falling back to Rev 1 or reusing displayNumber 2!)
  await workingDir.writeFileBytes(
    ['Part1.SLDPRT'],
    generateDeterministicBinaryBytes('P1_V3', 2048)
  );
  await assert.rejects(
    () =>
      captureRevision(workingDir, vaultDir, {
        branchId: MAIN_BRANCH_ID,
        summary: 'Should be blocked due to unreadable Rev 2 head',
        notes: { problem: '', modification: '', observations: '' },
      }),
    /damaged committed revision/
  );

  // Restore readability, then replace Rev 2 manifest with valid JSON missing required fields (e.g. missing files/notes/directories)
  vaultDir.markFileUnreadable(['revisions', `${rev2Id}.manifest.json`], '');
  await vaultDir.writeFileText(
    ['revisions', `${rev2Id}.manifest.json`],
    JSON.stringify({
      schemaVersion: CADTREE_SCHEMA_VERSION,
      projectId: stateWithUnreadableRev2.project.projectId,
      revisionId: rev2Id,
      // Missing notes, files, directories, etc.
    })
  );

  // Vault must still open without crashing, keeping Rev 1 inspectable and marking Rev 2 corrupted
  const stateWithMalformedJson = await openExistingVault(vaultDir);
  assert.equal(stateWithMalformedJson.revisions.length, 2);
  assert.equal(stateWithMalformedJson.revisions[0].integrityStatus, 'manifest_verified');
  assert.equal(stateWithMalformedJson.revisions[1].integrityStatus, 'corrupted');
  assert.ok(
    stateWithMalformedJson.revisions[1].integrityErrors.some((e) =>
      e.includes('Missing or invalid')
    )
  );

  // Revision 1 remains fully restorable!
  const recoverRev1Dir = await root.getDirectory(['Recover_Rev1_While_Rev2_Damaged'], {
    create: true,
  });
  const restoreRev1Res = await restoreRevisionToFolder({
    vaultDir,
    destinationDir: recoverRev1Dir,
    revisionId: rev1.revision.manifest.revisionId,
  });
  assert.equal(restoreRev1Res.displayNumber, 1);
  assert.equal(restoreRev1Res.restoredFilesCount, 1);
});

test('Regression Fix 2: Same-count directory rename/replacement during capture aborts publication', async () => {
  const root = new InMemoryFileSystemAdapter('fix2-disk');
  const workingDir = (await root.getDirectory(['Working'], {
    create: true,
  })) as InMemoryFileSystemAdapter;
  const vaultDir = (await root.getDirectory(['Vault'], {
    create: true,
  })) as InMemoryFileSystemAdapter;

  await workingDir.writeFileBytes(
    ['Part1.SLDPRT'],
    generateDeterministicBinaryBytes('PART1', 1024)
  );
  await workingDir.getDirectory(['EmptyDir_Alpha'], { create: true });
  await initializeProjectVault(workingDir, vaultDir, 'Directory Stability Test');

  let swappedDirs = false;
  vaultDir.setHooks({
    onAfterWrite: async (fullPath) => {
      if (!swappedDirs && fullPath.includes('/objects/')) {
        swappedDirs = true;
        // Replace EmptyDir_Alpha with EmptyDir_Beta (directory count remains 1, but path set changed!)
        await workingDir.removeEntry(['EmptyDir_Alpha']);
        await workingDir.getDirectory(['EmptyDir_Beta'], { create: true });
      }
    },
  });

  await assert.rejects(
    () =>
      captureRevision(workingDir, vaultDir, {
        branchId: MAIN_BRANCH_ID,
        summary: 'Should abort on same-count directory swap',
        notes: { problem: '', modification: '', observations: '' },
      }),
    /directory path set changed during capture/
  );
  vaultDir.setHooks({ onAfterWrite: undefined });

  const state = await openExistingVault(vaultDir);
  assert.equal(state.revisions.length, 0);
});

test('Regression Fix 3: Destination file appearing after initial check is never overwritten during full or selected-file recovery', async () => {
  const root = new InMemoryFileSystemAdapter('fix3-disk');
  const workingDir = await root.getDirectory(['Working'], { create: true });
  const vaultDir = await root.getDirectory(['Vault'], { create: true });

  const partBytes = generateDeterministicBinaryBytes('PART1_ORIGINAL', 4096);
  await workingDir.writeFileBytes(['Parts', 'Part1.SLDPRT'], partBytes);
  await initializeProjectVault(workingDir, vaultDir, 'No Overwrite Test');

  const cap = await captureRevision(workingDir, vaultDir, {
    branchId: MAIN_BRANCH_ID,
    summary: 'Rev 1',
    notes: { problem: '', modification: '', observations: '' },
  });

  // Scenario A: A conflicting file appears at Parts/Part1.SLDPRT right before writeFileStream
  const destDirA = (await root.getDirectory(['Dest_Race_Full'], {
    create: true,
  })) as InMemoryFileSystemAdapter;
  const preciousExistingBytes = new TextEncoder().encode('DO_NOT_OVERWRITE_ME');

  let injectedConflict = false;
  destDirA.setHooks({
    onBeforeWrite: async (fullPath) => {
      if (!injectedConflict && fullPath.endsWith('Parts/Part1.SLDPRT')) {
        injectedConflict = true;
        // Inject existing file before recovery stream writes
        destDirA.setHooks({ onBeforeWrite: undefined });
        await destDirA.writeFileBytes(['Parts', 'Part1.SLDPRT'], preciousExistingBytes);
      }
    },
  });

  await assert.rejects(
    () =>
      restoreRevisionToFolder({
        vaultDir,
        destinationDir: destDirA,
        revisionId: cap.revision.manifest.revisionId,
      }),
    /Destination conflict/
  );

  // Verify preciousExistingBytes was NOT overwritten!
  const survivingBytesA = await destDirA.readFileBytes(['Parts', 'Part1.SLDPRT']);
  assert.deepEqual(survivingBytesA, preciousExistingBytes);

  // Scenario B: Same race during selected-file recovery, plus pre-existing _CADTREE_RECOVERY_INCOMPLETE.txt must not be overwritten
  const destDirB = (await root.getDirectory(['Dest_Race_Selected'], {
    create: true,
  })) as InMemoryFileSystemAdapter;
  const existingMarkerBytes = new TextEncoder().encode('USER_EXISTING_MARKER_CONTENT');

  let injectedSelectedConflict = false;
  destDirB.setHooks({
    onBeforeWrite: async (fullPath) => {
      if (!injectedSelectedConflict && fullPath.endsWith('Parts/Part1.SLDPRT')) {
        injectedSelectedConflict = true;
        destDirB.setHooks({ onBeforeWrite: undefined });
        await destDirB.writeFileBytes(['Parts', 'Part1.SLDPRT'], preciousExistingBytes);
        await destDirB.writeFileBytes(
          ['_CADTREE_RECOVERY_INCOMPLETE.txt'],
          existingMarkerBytes
        );
      }
    },
  });

  await assert.rejects(
    () =>
      restoreSelectedFilesToFolder({
        vaultDir,
        destinationDir: destDirB,
        revisionId: cap.revision.manifest.revisionId,
        selectedPaths: ['Parts/Part1.SLDPRT'],
      }),
    /Destination conflict/
  );

  assert.deepEqual(
    await destDirB.readFileBytes(['Parts', 'Part1.SLDPRT']),
    preciousExistingBytes
  );
  assert.deepEqual(
    await destDirB.readFileBytes(['_CADTREE_RECOVERY_INCOMPLETE.txt']),
    existingMarkerBytes
  );
});

test('FileConflictError: a file appearing in the destination after the initial emptiness check is rejected as FileConflictError and writes no partial-recovery marker', async () => {
  const root = new InMemoryFileSystemAdapter('fce-a-disk');
  const workingDir = await root.getDirectory(['Working'], { create: true });
  const vaultDir = await root.getDirectory(['Vault'], { create: true });
  await workingDir.writeFileBytes(['Parts', 'Part1.SLDPRT'], generateDeterministicBinaryBytes('FCE_A', 2048));
  await initializeProjectVault(workingDir, vaultDir, 'FCE A');
  const cap = await captureRevision(workingDir, vaultDir, {
    branchId: MAIN_BRANCH_ID,
    summary: 'Rev 1',
    notes: { problem: '', modification: '', observations: '' },
  });

  const dest = (await root.getDirectory(['Dest_A'], { create: true })) as InMemoryFileSystemAdapter;
  const existing = new TextEncoder().encode('DO_NOT_OVERWRITE_ME');
  // The initial emptiness check throws a plain "not empty" error, so inject the file at the
  // second root listing (the pre-write recheck) to reach the Destination-conflict path.
  let listings = 0;
  dest.setHooks({
    onBeforeListEntries: async () => {
      listings++;
      if (listings === 2) {
        dest.setHooks({ onBeforeListEntries: undefined });
        await dest.writeFileBytes(['Parts', 'Part1.SLDPRT'], existing);
      }
    },
  });

  await assert.rejects(
    () =>
      restoreRevisionToFolder({
        vaultDir,
        destinationDir: dest,
        revisionId: cap.revision.manifest.revisionId,
      }),
    (err: unknown) => {
      assert.ok(err instanceof FileConflictError);
      assert.match((err as Error).message, /Destination conflict/);
      return true;
    }
  );
  assert.deepEqual(await dest.readFileBytes(['Parts', 'Part1.SLDPRT']), existing);
  assert.equal(await dest.hasFile(['_CADTREE_RECOVERY_INCOMPLETE.txt']), false);
});

test('FileConflictError: a file occupying a path that must become a directory is rejected as FileConflictError without a marker', async () => {
  const root = new InMemoryFileSystemAdapter('fce-b-disk');
  const workingDir = await root.getDirectory(['Working'], { create: true });
  const vaultDir = await root.getDirectory(['Vault'], { create: true });
  // A directory with an OS-clutter name: a same-named root file leaves the destination
  // "effectively empty", so the failure is reached in the step-2 directory check.
  await workingDir.writeFileBytes(['Thumbs.db', 'Part1.SLDPRT'], generateDeterministicBinaryBytes('FCE_B', 1024));
  await initializeProjectVault(workingDir, vaultDir, 'FCE B');
  const cap = await captureRevision(workingDir, vaultDir, {
    branchId: MAIN_BRANCH_ID,
    summary: 'Rev 1',
    notes: { problem: '', modification: '', observations: '' },
  });

  const dest = (await root.getDirectory(['Dest_B'], { create: true })) as InMemoryFileSystemAdapter;
  await dest.writeFileBytes(['Thumbs.db'], new TextEncoder().encode('I_AM_A_FILE'));

  await assert.rejects(
    () =>
      restoreRevisionToFolder({
        vaultDir,
        destinationDir: dest,
        revisionId: cap.revision.manifest.revisionId,
      }),
    (err: unknown) => {
      assert.ok(err instanceof FileConflictError);
      assert.match((err as Error).message, /a file already exists at directory path/);
      return true;
    }
  );
  assert.equal(await dest.hasFile(['_CADTREE_RECOVERY_INCOMPLETE.txt']), false);
  assert.equal(await dest.hasDirectory(['Thumbs.db']), false);
});

test('FileConflictError: InMemoryFileSystemAdapter.getDirectory exclusiveCheck rejects an exact-case or case-differing colliding file', async () => {
  for (const [fileName, dirName] of [['x', 'x'], ['X', 'x']]) {
    const root = new InMemoryFileSystemAdapter('fce-c-disk');
    await root.writeFileBytes([fileName], new Uint8Array([1]));
    await assert.rejects(
      () => root.getDirectory([dirName], { create: true, exclusiveCheck: true }),
      (err: unknown) => err instanceof FileConflictError && /Destination conflict/.test(err.message)
    );
  }
});

test('FileConflictError: a write-time conflict from the adapter sets the conflict flag and still leaves the partial-recovery marker', async () => {
  const root = new InMemoryFileSystemAdapter('fce-d-disk');
  const workingDir = await root.getDirectory(['Working'], { create: true });
  const vaultDir = await root.getDirectory(['Vault'], { create: true });
  await workingDir.writeFileBytes(['Parts', 'Part1.SLDPRT'], generateDeterministicBinaryBytes('FCE_D', 2048));
  await initializeProjectVault(workingDir, vaultDir, 'FCE D');
  const cap = await captureRevision(workingDir, vaultDir, {
    branchId: MAIN_BRANCH_ID,
    summary: 'Rev 1',
    notes: { problem: '', modification: '', observations: '' },
  });

  const dest = (await root.getDirectory(['Dest_D'], { create: true })) as InMemoryFileSystemAdapter;
  const existing = new TextEncoder().encode('RACED_IN');
  let injected = false;
  dest.setHooks({
    onBeforeWrite: async (fullPath) => {
      if (!injected && fullPath.endsWith('Parts/Part1.SLDPRT')) {
        injected = true;
        await dest.writeFileBytes(['Parts', 'Part1.SLDPRT'], existing);
      }
    },
  });

  await assert.rejects(
    () =>
      restoreRevisionToFolder({
        vaultDir,
        destinationDir: dest,
        revisionId: cap.revision.manifest.revisionId,
      }),
    (err: unknown) => err instanceof FileConflictError && /Destination conflict/.test(err.message)
  );
  assert.ok(injected);
  assert.deepEqual(await dest.readFileBytes(['Parts', 'Part1.SLDPRT']), existing);
  // Something was written (the Parts directory) before the conflict, so the marker must exist.
  assert.equal(await dest.hasFile(['_CADTREE_RECOVERY_INCOMPLETE.txt']), true);
});

test('In-memory getDirectory without exclusiveCheck keeps the plain Error for a file in the way', async () => {
  const root = new InMemoryFileSystemAdapter('fce-c2-disk');
  await root.writeFileBytes(['x'], new Uint8Array([1]));
  for (const options of [{ create: true }, { exclusiveCheck: true }, undefined]) {
    await assert.rejects(
      () => root.getDirectory(['x'], options),
      (err: unknown) =>
        err instanceof Error && !(err instanceof FileConflictError) && /is a file, not a directory/.test(err.message)
    );
  }
});

test('Refinements 1, 2, 3, 5 & 6: 5-part SolidWorks scenario (1 modified, 4 unchanged), file-specific notes, directory-count consistency, and selected-file recovery', async () => {
  const root = new InMemoryFileSystemAdapter('refinement-disk');
  const workingDir = await root.getDirectory(['SolidWorks_Project'], { create: true });
  const vaultDir = await root.getDirectory(['SolidWorks_Vault'], { create: true });

  // Create 5 part files and 1 empty subdirectory
  const part1V1 = generateDeterministicBinaryBytes('PART1_BASE', 8192);
  const part2 = generateDeterministicBinaryBytes('PART2_BRACKET', 4096);
  const part3 = generateDeterministicBinaryBytes('PART3_PIN', 2048);
  const part4 = generateDeterministicBinaryBytes('PART4_CAP', 3072);
  const part5 = generateDeterministicBinaryBytes('PART5_BASEPLATE', 6144);

  await workingDir.writeFileBytes(['Part1.SLDPRT'], part1V1);
  await workingDir.writeFileBytes(['Part2.SLDPRT'], part2);
  await workingDir.writeFileBytes(['Subparts', 'Part3.SLDPRT'], part3);
  await workingDir.writeFileBytes(['Subparts', 'Part4.SLDPRT'], part4);
  await workingDir.writeFileBytes(['Part5.SLDPRT'], part5);
  await workingDir.getDirectory(['Empty_Reference_Folder'], { create: true });

  await initializeProjectVault(workingDir, vaultDir, 'Five Part Assembly');

  // Capture Revision 001 (Baseline: 5 files, 2 subdirectories: Empty_Reference_Folder & Subparts)
  const cap1 = await captureRevision(workingDir, vaultDir, {
    branchId: MAIN_BRANCH_ID,
    summary: 'Baseline 5 parts and 2 subdirectories',
    notes: { problem: 'Initial baseline', modification: '', observations: '' },
  });

  assert.equal(cap1.revision.manifest.files.length, 5);
  assert.deepEqual(cap1.revision.manifest.directories, ['Empty_Reference_Folder', 'Subparts']);

  const diff1 = computeRevisionDiff(cap1.revision, cap1.vaultState);
  assert.equal(diff1.status, 'baseline');
  assert.equal(diff1.added.length, 5);
  assert.equal(diff1.modified.length, 0);
  assert.equal(diff1.unchanged.length, 0);

  // Modify ONLY Part1.SLDPRT, keeping Empty_Reference_Folder and Subparts untouched
  const part1V2 = generateDeterministicBinaryBytes('PART1_EXTRUDED_BOSS', 9216);
  await workingDir.writeFileBytes(['Part1.SLDPRT'], part1V2);

  const scanBeforeRev2 = await scanBranchChanges(
    workingDir,
    MAIN_BRANCH_ID,
    cap1.revision.manifest
  );
  assert.equal(scanBeforeRev2.modified.length, 1);
  assert.equal(scanBeforeRev2.modified[0].current.path, 'Part1.SLDPRT');
  assert.equal(scanBeforeRev2.unchanged.length, 4);
  assert.deepEqual(scanBeforeRev2.directories, ['Empty_Reference_Folder', 'Subparts']);

  // Verify ReviewStaleError if working folder changes after user reviewed scanBeforeRev2
  await workingDir.writeFileBytes(['Part2.SLDPRT'], generateDeterministicBinaryBytes('PART2_SURPRISE', 4096));
  await assert.rejects(
    () =>
      captureRevision(workingDir, vaultDir, {
        branchId: MAIN_BRANCH_ID,
        summary: 'Should trigger ReviewStaleError',
        notes: { problem: '', modification: '', observations: '' },
        fileNotes: [
          {
            path: 'Part1.SLDPRT',
            problem: 'Needed boss extrusion',
            modification: 'Added 12mm extrusion',
            observations: 'Verified clearance',
          },
        ],
        reviewedChangesSignature: scanBeforeRev2.changesSignature,
      }),
    (err: unknown) => err instanceof ReviewStaleError
  );

  // Restore Part2.SLDPRT back to original so only Part1.SLDPRT is modified
  await workingDir.writeFileBytes(['Part2.SLDPRT'], part2);

  // Capture Revision 002 with file-specific note on Part1.SLDPRT
  const cap2 = await captureRevision(workingDir, vaultDir, {
    branchId: MAIN_BRANCH_ID,
    summary: 'Added base extrusion to Part1',
    notes: { problem: '', modification: '', observations: '' },
    fileNotes: [
      {
        path: 'Part1.SLDPRT',
        problem: 'Mounting face needed 12mm boss standoff',
        modification: 'Added Boss-Extrude2 to Part1.SLDPRT',
        observations: 'Mass +14g; fits bracket mate',
      },
    ],
    reviewedChangesSignature: scanBeforeRev2.changesSignature,
  });

  // Both subdirectories (including Empty_Reference_Folder) MUST remain recorded in Revision 002!
  assert.equal(cap2.revision.manifest.files.length, 5);
  assert.deepEqual(cap2.revision.manifest.directories, ['Empty_Reference_Folder', 'Subparts']);
  assert.equal(cap2.revision.manifest.fileNotes?.length, 1);
  assert.equal(cap2.revision.manifest.fileNotes?.[0].path, 'Part1.SLDPRT');
  assert.equal(
    cap2.revision.manifest.fileNotes?.[0].modification,
    'Added Boss-Extrude2 to Part1.SLDPRT'
  );

  // Verify parent-relative diff on Revision 002: 1 modified, 4 unchanged
  const diff2 = computeRevisionDiff(cap2.revision, cap2.vaultState);
  assert.equal(diff2.status, 'compared');
  assert.equal(diff2.parentDisplayNumber, 1);
  assert.equal(diff2.modified.length, 1);
  assert.equal(diff2.modified[0].current.path, 'Part1.SLDPRT');
  assert.equal(diff2.unchanged.length, 4);
  assert.equal(diff2.added.length, 0);
  assert.equal(diff2.deleted.length, 0);

  // Deliberately delete Empty_Reference_Folder and Part5.SLDPRT in Revision 003
  await workingDir.removeEntry(['Empty_Reference_Folder']);
  await workingDir.removeEntry(['Part5.SLDPRT']);
  const cap3 = await captureRevision(workingDir, vaultDir, {
    branchId: MAIN_BRANCH_ID,
    summary: 'Removed empty reference folder and obsolete Part5',
    notes: { problem: '', modification: '', observations: '' },
  });
  assert.deepEqual(cap3.revision.manifest.directories, ['Subparts']);
  const diff3 = computeRevisionDiff(cap3.revision, cap3.vaultState);
  assert.equal(diff3.deleted.length, 1);
  assert.equal(diff3.deleted[0].path, 'Part5.SLDPRT');
  assert.deepEqual(diff3.deletedDirectories, ['Empty_Reference_Folder']);

  // Selected-file recovery: recover ONLY Part1.SLDPRT from Revision 001 into a fresh folder
  const singleFileDest = await root.getDirectory(['Recover_Single_Part1_Rev001'], {
    create: true,
  });
  const singleRes = await restoreSelectedFilesToFolder({
    vaultDir,
    destinationDir: singleFileDest,
    workingDir,
    revisionId: cap1.revision.manifest.revisionId,
    selectedPaths: ['Part1.SLDPRT'],
  });

  assert.equal(singleRes.kind, 'selected_files');
  assert.equal(singleRes.restoredFilesCount, 1);
  assert.equal(singleRes.restoredDirectoriesCount, 0);
  assert.deepEqual(singleRes.selectedPaths, ['Part1.SLDPRT']);

  const enumSingle = await enumerateWorkingFolder(singleFileDest);
  assert.equal(enumSingle.files.length, 1);
  assert.equal(enumSingle.files[0].path, 'Part1.SLDPRT');
  assert.equal(enumSingle.directories.length, 0); // Empty_Reference_Folder & Subparts were NOT created
  assert.deepEqual(await singleFileDest.readFileBytes(['Part1.SLDPRT']), part1V1);

  // Multi-file recovery with nested paths: recover Subparts/Part3.SLDPRT and Part5.SLDPRT from Rev 002
  const multiFileDest = await root.getDirectory(['Recover_Multi_Nested_Rev002'], {
    create: true,
  });
  const multiRes = await restoreSelectedFilesToFolder({
    vaultDir,
    destinationDir: multiFileDest,
    workingDir,
    revisionId: cap2.revision.manifest.revisionId,
    selectedPaths: ['Subparts/Part3.SLDPRT', 'Part5.SLDPRT'],
  });

  assert.equal(multiRes.kind, 'selected_files');
  assert.equal(multiRes.restoredFilesCount, 2);
  assert.equal(multiRes.restoredDirectoriesCount, 1); // Only 'Subparts' directory created!
  const enumMulti = await enumerateWorkingFolder(multiFileDest);
  assert.deepEqual(
    enumMulti.files.map((f) => f.path),
    ['Part5.SLDPRT', 'Subparts/Part3.SLDPRT']
  );
  assert.deepEqual(enumMulti.directories, ['Subparts']);
  assert.deepEqual(await multiFileDest.readFileBytes(['Subparts', 'Part3.SLDPRT']), part3);
  assert.deepEqual(await multiFileDest.readFileBytes(['Part5.SLDPRT']), part5);
});

test('Backward compatibility: existing vault manifests without fileNotes open and verify without rewriting history, while tampered fileNotes fail checksum', async () => {
  const root = new InMemoryFileSystemAdapter('compat-disk');
  const workingDir = await root.getDirectory(['Working'], { create: true });
  const vaultDir = await root.getDirectory(['Vault'], { create: true });

  await workingDir.writeFileBytes(['Bracket.SLDPRT'], generateDeterministicBinaryBytes('BRK', 1024));
  await initializeProjectVault(workingDir, vaultDir, 'Legacy Vault');

  // Capture a revision WITHOUT fileNotes (matches pre-refinement schema format)
  const capLegacy = await captureRevision(workingDir, vaultDir, {
    branchId: MAIN_BRANCH_ID,
    summary: 'Legacy revision without fileNotes field',
    notes: {
      problem: 'Overall problem',
      modification: 'Overall modification',
      observations: 'Overall observations',
    },
  });

  const rawLegacyText = await vaultDir.readFileText([
    'revisions',
    `${capLegacy.revision.manifest.revisionId}.manifest.json`,
  ]);
  const rawLegacyJson = JSON.parse(rawLegacyText) as Record<string, unknown>;
  assert.equal('fileNotes' in rawLegacyJson, false);

  // Reopen vault and ensure raw file is untouched and checksum passes
  const reopened = await openExistingVault(vaultDir);
  assert.equal(reopened.revisions.length, 1);
  assert.equal(reopened.revisions[0].integrityStatus, 'manifest_verified');
  assert.equal(reopened.revisions[0].manifest.fileNotes, undefined);
  assert.equal(
    await vaultDir.readFileText([
      'revisions',
      `${capLegacy.revision.manifest.revisionId}.manifest.json`,
    ]),
    rawLegacyText
  );

  // Capture a second revision WITH fileNotes, then tamper with the fileNote text on disk and confirm checksum fails
  await workingDir.writeFileBytes(
    ['Bracket.SLDPRT'],
    generateDeterministicBinaryBytes('BRK_V2', 1024)
  );
  const capWithFileNote = await captureRevision(workingDir, vaultDir, {
    branchId: MAIN_BRANCH_ID,
    summary: 'Revision with integrity-protected fileNotes',
    notes: { problem: '', modification: '', observations: '' },
    fileNotes: [
      {
        path: 'Bracket.SLDPRT',
        problem: 'Original problem',
        modification: 'Original mod',
        observations: 'Original obs',
      },
    ],
  });

  const rev2Id = capWithFileNote.revision.manifest.revisionId;
  const tamperedManifest: RevisionManifest = {
    ...capWithFileNote.revision.manifest,
    fileNotes: [
      {
        path: 'Bracket.SLDPRT',
        problem: 'TAMPERED PROBLEM',
        modification: 'Original mod',
        observations: 'Original obs',
      },
    ],
  };
  assert.notEqual(
    computeManifestPayloadChecksum(tamperedManifest),
    capWithFileNote.revision.manifest.manifestPayloadSha256
  );

  await vaultDir.writeFileText(
    ['revisions', `${rev2Id}.manifest.json`],
    JSON.stringify(tamperedManifest, null, 2)
  );
  const reopenedAfterTamper = await openExistingVault(vaultDir);
  const rev2Reopened = reopenedAfterTamper.revisions.find(
    (r) => r.manifest.revisionId === rev2Id
  )!;
  assert.equal(rev2Reopened.integrityStatus, 'corrupted');
});

test('Production UI files do not import fixture generators, InMemoryFileSystemAdapter, or expose Fixture Lab controls', () => {
  const uiFiles = [
    'src/App.tsx',
    'src/components/HomeWorkspacesView.tsx',
    'src/components/WorkspaceProjectsView.tsx',
    'src/components/ChangesCaptureView.tsx',
    'src/components/HistoryRecoveryView.tsx',
    'src/components/DiagnosticsView.tsx',
  ];

  for (const rel of uiFiles) {
    const abs = path.resolve(process.cwd(), rel);
    const content = fs.readFileSync(abs, 'utf8');
    assert.equal(
      content.includes('InMemoryFileSystemAdapter'),
      false,
      `${rel} must not reference InMemoryFileSystemAdapter`
    );
    assert.equal(
      content.includes('fixtures'),
      false,
      `${rel} must not import fixtures module`
    );
    assert.equal(
      content.includes('Fixture Verification Lab'),
      false,
      `${rel} must not expose Fixture Verification Lab UI`
    );
    assert.equal(
      content.includes('Launch Fixture Lab'),
      false,
      `${rel} must not expose Launch Fixture Lab button`
    );
  }
});

test('untracked OS clutter is skipped in scans and never captured, but listed as skipped', async () => {
  const root = new InMemoryFileSystemAdapter('clutter');
  const working = await root.getDirectory(['w'], { create: true });
  const vault = await root.getDirectory(['v'], { create: true });
  await initializeProjectVault(working, vault, 'Clutter');
  const b = new Uint8Array([1, 2, 3]);
  for (const p of [
    ['bracket.SLDPRT'],
    ['sub', 'frame.SLDASM'],
    ['.DS_Store'],
    ['sub', '.DS_Store'],
    ['._bracket.SLDPRT'],
    ['THUMBS.DB'],
    ['Desktop.ini'],
    ['._config.json'],
  ])
    await working.writeFileBytes(p, b);
  const scan = await scanBranchChanges(working, MAIN_BRANCH_ID, null);
  assert.deepEqual(
    scan.added.map((f) => f.path).sort(),
    ['._config.json', 'bracket.SLDPRT', 'sub/frame.SLDASM'],
    '._config.json has no config.json companion, so it is kept'
  );
  assert.deepEqual((scan.skippedSystemFiles ?? []).sort(), [
    '.DS_Store',
    '._bracket.SLDPRT',
    'Desktop.ini',
    'THUMBS.DB',
    'sub/.DS_Store',
  ]);
  const cap = await captureRevision(working, vault, {
    branchId: MAIN_BRANCH_ID,
    summary: 'clutter',
    notes: { problem: '', modification: '', observations: '' },
    workingFolders: { [MAIN_BRANCH_ID]: working },
  });
  assert.deepEqual(
    cap.revision.manifest.files.map((f) => f.path).sort(),
    ['._config.json', 'bracket.SLDPRT', 'sub/frame.SLDASM']
  );
});

test('enumerateWorkingFolder still returns every file; partitionSystemFiles never hides expected paths', async () => {
  const root = new InMemoryFileSystemAdapter('clutter2');
  const dir = await root.getDirectory(['w'], { create: true });
  await dir.writeFileBytes(['.DS_Store'], new Uint8Array([9]));
  await dir.writeFileBytes(['sub', '._x.txt'], new Uint8Array([9]));
  const res = await enumerateWorkingFolder(dir);
  assert.deepEqual(res.files.map((f) => f.path), ['.DS_Store', 'sub/._x.txt']);
  assert.deepEqual(partitionSystemFiles(res.files, new Set(['.DS_Store'])).skipped, []);
  // ._x.txt without a sibling x.txt is kept; with the sibling expected it is a companion.
  assert.deepEqual(partitionSystemFiles(res.files, new Set()).skipped, ['.DS_Store']);
  assert.deepEqual(partitionSystemFiles(res.files, new Set(['sub/x.txt'])).skipped, ['.DS_Store', 'sub/._x.txt']);
  assert.equal(isSystemClutterName('desktop.INI'), true);
  assert.equal(isSystemClutterName('._x'), false);
});

test('a tracked .DS_Store deleted from the working folder is reported as deleted', async () => {
  const root = new InMemoryFileSystemAdapter('clutter3');
  const dir = await root.getDirectory(['w'], { create: true });
  const bytes = new Uint8Array([1, 2, 3]);
  await dir.writeFileBytes(['.DS_Store'], bytes);
  const entry = (await enumerateWorkingFolder(dir)).files[0];
  const manifest = { revisionId: 'r', displayNumber: 1, files: [entry], directories: [] } as unknown as RevisionManifest;
  const same = await scanBranchChanges(dir, MAIN_BRANCH_ID, manifest);
  assert.equal(same.unchanged.length, 1);
  assert.deepEqual(same.skippedSystemFiles, []);
  await dir.removeEntry(['.DS_Store']);
  const gone = await scanBranchChanges(dir, MAIN_BRANCH_ID, manifest);
  assert.deepEqual(gone.deleted.map((f) => f.path), ['.DS_Store']);
});

test('isEffectivelyEmpty accepts only clutter files', () => {
  assert.equal(isEffectivelyEmpty([]), true);
  assert.equal(isEffectivelyEmpty([{ name: '.DS_Store', kind: 'file' }]), true);
  assert.equal(isEffectivelyEmpty([{ name: '.DS_Store', kind: 'directory' }]), false);
  assert.equal(isEffectivelyEmpty([{ name: '.DS_Store', kind: 'file' }, { name: 'a.txt', kind: 'file' }]), false);
  assert.equal(isEffectivelyEmpty([{ name: '._x', kind: 'file' }]), false);
});

test('read failures on untracked clutter never block capture; the same failure on tracked clutter does', async () => {
  let failClutter = false;
  const root = new InMemoryFileSystemAdapter('clutter-err', null, {
    onBeforeRead: (p) => {
      if (failClutter && p.endsWith('/.DS_Store')) throw new Error('locked by Finder');
    },
  });
  const working = await root.getDirectory(['w'], { create: true });
  const vault = await root.getDirectory(['v'], { create: true });
  await initializeProjectVault(working, vault, 'ClutterErr');
  await working.writeFileBytes(['bracket.SLDPRT'], new Uint8Array([1]));
  await working.writeFileBytes(['.DS_Store'], new Uint8Array([2]));
  failClutter = true;
  const scan = await scanBranchChanges(working, MAIN_BRANCH_ID, null);
  assert.deepEqual(scan.errors, []);
  assert.equal(scan.canCapture, true);
  assert.deepEqual(scan.skippedSystemFiles, ['.DS_Store']);
  const cap = await captureRevision(working, vault, {
    branchId: MAIN_BRANCH_ID,
    summary: 'despite locked clutter',
    notes: { problem: '', modification: '', observations: '' },
    workingFolders: { [MAIN_BRANCH_ID]: working },
  });
  assert.deepEqual(cap.revision.manifest.files.map((f) => f.path), ['bracket.SLDPRT']);
  // Tracked: the baseline contains .DS_Store, so its read failure must still block.
  const tracked = {
    revisionId: 'r', displayNumber: 1, directories: [],
    files: [{ path: '.DS_Store', size: 1, sha256: 'x', lastModified: 0 }],
  } as unknown as RevisionManifest;
  const blocked = await scanBranchChanges(working, MAIN_BRANCH_ID, tracked);
  assert.equal(blocked.errors.length, 1);
  assert.equal(blocked.canCapture, false);
});
