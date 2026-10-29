import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hashBytes, hashStream, Sha256Hasher } from './hash';
import {
  checkCaseInsensitiveCollisions,
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
  initializeProjectVault,
  openExistingVault,
  UnsupportedSchemaVersionError,
  verifyRevisionObjects,
} from './vault-service';
import { scanBranchChanges } from './scanner';
import { captureRevision } from './revision-service';
import { restoreRevisionToFolder } from './recovery-service';
import { MAIN_BRANCH_ID } from './types';
import { getObjectPathSegments } from './object-store';

test('Incremental Sha256Hasher matches Node crypto across boundary sizes and chunk splits', async () => {
  const sizes = [0, 1, 55, 56, 57, 63, 64, 65, 127, 128, 129, 4096, 131072];
  for (const size of sizes) {
    const data = generateDeterministicBinaryBytes(`SEED_${size}`, size);
    const expectedHex = crypto.createHash('sha256').update(data).digest('hex');

    // Single buffer hash
    assert.equal(hashBytes(data), expectedHex, `Single-buffer mismatch for size ${size}`);

    // Multi-chunk irregular splits (e.g., 7 bytes, 61 bytes, 19 bytes...)
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

  // Stream hashing check
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
  // Valid paths
  assert.deepEqual(splitAndValidatePath('Parts/BasePlate.SLDPRT'), ['Parts', 'BasePlate.SLDPRT']);
  assert.deepEqual(splitAndValidatePath('Parts/Dichtung_Ø24mm_Übergang.SLDPRT'), [
    'Parts',
    'Dichtung_Ø24mm_Übergang.SLDPRT',
  ]);

  // Unsafe paths
  assert.throws(() => splitAndValidatePath(''), /non-empty/);
  assert.throws(() => splitAndValidatePath('/etc/passwd'), /absolute paths/);
  assert.throws(() => splitAndValidatePath('Parts/../Secret.SLDPRT'), /traversal/);
  assert.throws(() => splitAndValidatePath('Parts\\Sub\\Part.SLDPRT'), /backslashes/);
  assert.throws(() => splitAndValidatePath('C:/SolidWorks/Part.SLDPRT'), /drive prefixes/);
  assert.throws(() => splitAndValidatePath('Parts/CON.SLDPRT'), /reserved Windows device/);
  assert.throws(() => splitAndValidatePath('Parts/TrailingSpace /Part.SLDPRT'), /ends with space/);

  // Case-insensitive collisions
  const collisions = checkCaseInsensitiveCollisions([
    'Parts/Bracket.SLDPRT',
    'parts/bracket.sldprt',
  ]);
  assert.equal(collisions.length, 1);
  assert.match(collisions[0], /Case-insensitive path collision/);

  // Directory isolation: same directory & nested directories
  const root = new InMemoryFileSystemAdapter('workspace');
  const working = await root.getDirectory(['CAD_Working'], { create: true });
  const nestedVault = await working.getDirectory(['Nested_Vault'], { create: true });
  const separateVault = await root.getDirectory(['CAD_Vault'], { create: true });

  await assert.rejects(
    () => validateDirectoryIsolation(working, working),
    /exact same directory/
  );
  await assert.rejects(
    () => validateDirectoryIsolation(working, nestedVault),
    /nested inside/
  );
  await assert.rejects(
    () => validateDirectoryIsolation(nestedVault, working),
    /nested inside/
  );
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

  // Attempting to initialize again over an existing repository must fail
  await assert.rejects(
    () => initializeProjectVault(working, validVault, 'Second Project'),
    /already contains a cAdtree repository/
  );
});

test('Milestone 1 end-to-end acceptance: Capture A -> Mutate to B -> Capture B -> Restore A -> Reopen without metadata', async () => {
  const root = new InMemoryFileSystemAdapter('test-disk');
  const workingDir = await root.getDirectory(['Project_Actuator_Working'], { create: true });
  const vaultDir = await root.getDirectory(['Project_Actuator_Vault'], { create: true });

  // 1. Populate Fixture A into working folder
  const expectedFixtureA = await populateFixtureA(workingDir);

  // 2. Initialize project vault
  const initState = await initializeProjectVault(workingDir, vaultDir, 'Linear Actuator Housing');
  assert.equal(initState.project.name, 'Linear Actuator Housing');
  assert.equal(initState.branches.length, 1);
  assert.equal(initState.branches[0].branchId, MAIN_BRANCH_ID);
  assert.equal(initState.revisions.length, 0);

  // 3. Scan initial working folder
  const scanA = await scanBranchChanges(workingDir, MAIN_BRANCH_ID, null);
  assert.equal(scanA.canCapture, true);
  assert.equal(scanA.added.length, 9);
  assert.equal(scanA.directories.length, 8);
  assert.equal(scanA.errors.length, 0);

  // 4. Capture Revision 001 (Snapshot A)
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

  // Verify no-change scan after Revision 001
  const scanNoChange = await scanBranchChanges(
    workingDir,
    MAIN_BRANCH_ID,
    capA.revision.manifest
  );
  assert.equal(scanNoChange.hasChanges, false);
  assert.equal(scanNoChange.canCapture, false);
  assert.equal(scanNoChange.unchanged.length, 9);

  // Attempting to capture when no changes exist must reject
  await assert.rejects(
    () =>
      captureRevision(workingDir, vaultDir, {
        branchId: MAIN_BRANCH_ID,
        summary: 'Redundant save',
        notes: { problem: '', modification: '', observations: '' },
      }),
    /No changes detected/
  );

  // 5. Externally mutate working folder to Fixture B
  await applyFixtureBMutations(workingDir);
  const expectedFixtureB = await verifyDirectoryMatchesFixture(workingDir, expectedFixtureA);
  assert.equal(expectedFixtureB.matches, false);

  // 6. Scan changes for B against Revision 001
  const scanB = await scanBranchChanges(
    workingDir,
    MAIN_BRANCH_ID,
    capA.revision.manifest
  );
  assert.equal(scanB.hasChanges, true);
  assert.equal(scanB.canCapture, true);
  assert.equal(scanB.added.length, 1);
  assert.equal(scanB.added[0].path, 'Parts/Bearing_Retainer_Plate.SLDPRT');
  assert.equal(scanB.modified.length, 2); // Housing (size changed) + Output_Shaft (same size, different SHA-256!)
  assert.equal(scanB.deleted.length, 1);
  assert.equal(scanB.deleted[0].path, 'Specs/Engineering_ZeroByte_Marker.lock');
  assert.equal(scanB.unchanged.length, 6);
  assert.deepEqual(scanB.addedDirectories, ['Exports/IGES_Archive']);

  // 7. Capture Revision 002 (Snapshot B)
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

  // 8. Restore Revision 001 into a fresh folder and compare every byte against Fixture A
  const recoveryDirA = await root.getDirectory(['Recovered_Rev001_Clean'], { create: true });
  const restoreRes = await restoreRevisionToFolder({
    vaultDir,
    destinationDir: recoveryDirA,
    workingDir,
    revisionId: capA.revision.manifest.revisionId,
  });

  assert.equal(restoreRes.displayNumber, 1);
  assert.equal(restoreRes.restoredFilesCount, 9);
  assert.equal(restoreRes.restoredDirectoriesCount, 8);

  const matchA = await verifyDirectoryMatchesFixture(recoveryDirA, expectedFixtureA);
  assert.equal(matchA.matches, true, `Recovered folder mismatches: ${matchA.mismatches.join('; ')}`);

  // Ensure workingDir still has Fixture B untouched!
  const postRestoreScanOnWorking = await scanBranchChanges(
    workingDir,
    MAIN_BRANCH_ID,
    capB.revision.manifest
  );
  assert.equal(postRestoreScanOnWorking.hasChanges, false);
  assert.equal(postRestoreScanOnWorking.unchanged.length, 9);

  // 9. Reopen vault purely from vaultDir (simulating browser metadata cleared)
  const reopenedState = await openExistingVault(vaultDir);
  assert.equal(reopenedState.project.projectId, initState.project.projectId);
  assert.equal(reopenedState.project.name, 'Linear Actuator Housing');
  assert.equal(reopenedState.branches.length, 1);
  assert.equal(reopenedState.revisions.length, 2);
  assert.equal(reopenedState.revisions[0].manifest.displayNumber, 1);
  assert.equal(reopenedState.revisions[1].manifest.displayNumber, 2);
  assert.equal(
    reopenedState.revisions[1].manifest.parentRevisionId,
    reopenedState.revisions[0].manifest.revisionId
  );
  assert.equal(
    reopenedState.revisions[0].manifest.notes.problem,
    'Need baseline before adding stiffening ribs and shaft keyway'
  );
  assert.equal(
    reopenedState.branchHeads[MAIN_BRANCH_ID],
    reopenedState.revisions[1].manifest.revisionId
  );
});

test('Failure & safety handling: unreadable files, interrupted publication, source instability, corruption, and concurrency', async () => {
  const root = new InMemoryFileSystemAdapter('fault-disk');
  const workingDir = (await root.getDirectory(['Working'], {
    create: true,
  })) as InMemoryFileSystemAdapter;
  const vaultDir = (await root.getDirectory(['Vault'], {
    create: true,
  })) as InMemoryFileSystemAdapter;

  await populateFixtureA(workingDir);
  await initializeProjectVault(workingDir, vaultDir, 'Fault Tolerance Project');

  // 1. Unreadable file must fail capture rather than disappear from snapshot
  workingDir.markFileUnreadable(
    ['Parts', 'Housing_MainBody.SLDPRT'],
    'File locked exclusively by SolidWorks'
  );
  const scanWithLockedFile = await scanBranchChanges(workingDir, MAIN_BRANCH_ID, null);
  assert.equal(scanWithLockedFile.canCapture, false);
  assert.equal(scanWithLockedFile.errors.length, 1);
  assert.match(scanWithLockedFile.errors[0].error, /locked exclusively/);

  await assert.rejects(
    () =>
      captureRevision(workingDir, vaultDir, {
        branchId: MAIN_BRANCH_ID,
        summary: 'Should fail on unreadable file',
        notes: { problem: '', modification: '', observations: '' },
      }),
    /unreadable or invalid source file/
  );

  // Restore readability
  workingDir.markFileUnreadable(['Parts', 'Housing_MainBody.SLDPRT'], '');

  // 2. Source instability mid-capture must abort before publication
  let mutatedDuringCapture = false;
  vaultDir.setHooks({
    onAfterWrite: async (fullPath) => {
      if (!mutatedDuringCapture && fullPath.includes('/objects/')) {
        mutatedDuringCapture = true;
        // External process modifies an already-scanned source file while capture is in progress
        await workingDir.writeFileBytes(
          ['Actuator_Assembly_v1.SLDASM'],
          new TextEncoder().encode('Modified externally mid-capture!')
        );
      }
    },
  });

  await assert.rejects(
    () =>
      captureRevision(workingDir, vaultDir, {
        branchId: MAIN_BRANCH_ID,
        summary: 'Instability test',
        notes: { problem: '', modification: '', observations: '' },
      }),
    /Source instability/
  );
  vaultDir.setHooks({ onAfterWrite: undefined });

  // Restore clean Fixture A bytes after the instability test
  await populateFixtureA(workingDir);

  // Verify no revision was published
  const stateAfterInstability = await openExistingVault(vaultDir);
  assert.equal(stateAfterInstability.revisions.length, 0);

  // 3. Interrupted publication (manifest written, completion record fails) must NOT appear as committed revision
  vaultDir.setHooks({
    onBeforeWrite: async (fullPath) => {
      if (fullPath.includes('/completed/')) {
        throw new Error('Simulated power loss before writing completion record');
      }
    },
  });

  await assert.rejects(
    () =>
      captureRevision(workingDir, vaultDir, {
        branchId: MAIN_BRANCH_ID,
        summary: 'Interrupted before completion record',
        notes: { problem: '', modification: '', observations: '' },
      }),
    /Simulated power loss/
  );
  vaultDir.setHooks({ onBeforeWrite: undefined });

  const stateAfterInterrupt = await openExistingVault(vaultDir);
  assert.equal(stateAfterInterrupt.revisions.length, 0);
  assert.ok(
    stateAfterInterrupt.incompleteAttempts.some((a) => a.kind === 'uncompleted_manifest'),
    'Uncompleted manifest should be reported in incompleteAttempts'
  );

  // 4. Subsequent capture succeeds cleanly as Rev 001
  const validRev1 = await captureRevision(workingDir, vaultDir, {
    branchId: MAIN_BRANCH_ID,
    summary: 'Clean Revision 1 after interrupted attempt',
    notes: { problem: '', modification: '', observations: '' },
  });
  assert.equal(validRev1.revision.manifest.displayNumber, 1);

  // 5. Corrupted vault object blocks restore and leaves visible incomplete marker
  const firstFile = validRev1.revision.manifest.files.find((f) => f.size > 0)!;
  const objSegments = getObjectPathSegments(firstFile.sha256);
  await vaultDir.writeFileBytes(objSegments, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));

  const verifiedRev = await verifyRevisionObjects(vaultDir, validRev1.revision);
  assert.equal(verifiedRev.integrityStatus, 'corrupted');

  const badRestoreDir = await root.getDirectory(['Bad_Restore'], { create: true });
  await assert.rejects(
    () =>
      restoreRevisionToFolder({
        vaultDir,
        destinationDir: badRestoreDir,
        revisionId: validRev1.revision.manifest.revisionId,
      }),
    /integrity failure/
  );
  assert.equal(await badRestoreDir.hasFile(['_CADTREE_RECOVERY_INCOMPLETE.txt']), true);

  // 6. Unknown schema version is rejected cleanly
  const futureVault = await root.getDirectory(['Future_Vault'], { create: true });
  await futureVault.writeFileText(
    ['project.json'],
    JSON.stringify({
      schemaVersion: 99,
      projectId: 'proj-future',
      name: 'Future CAD Project',
      createdAt: new Date().toISOString(),
      payloadSha256: 'abc',
    })
  );
  await assert.rejects(
    () => openExistingVault(futureVault),
    (err: unknown) => err instanceof UnsupportedSchemaVersionError && err.foundVersion === 99
  );
});

test('Same-origin writer lock serializes concurrent captures without duplicate revision numbers', async () => {
  const root = new InMemoryFileSystemAdapter('concurrency-disk');
  const workingDir = await root.getDirectory(['Working'], { create: true });
  const vaultDir = await root.getDirectory(['Vault'], { create: true });

  await populateFixtureA(workingDir);
  await initializeProjectVault(workingDir, vaultDir, 'Concurrency Test');

  // Launch two concurrent captures on the same project; the first captures Rev 001,
  // and the second (which runs after the lock releases) sees no changes and rejects cleanly
  // rather than creating a duplicate Rev 001!
  const results = await Promise.allSettled([
    captureRevision(workingDir, vaultDir, {
      branchId: MAIN_BRANCH_ID,
      summary: 'Writer 1 capture',
      notes: { problem: '', modification: '', observations: '' },
    }),
    captureRevision(workingDir, vaultDir, {
      branchId: MAIN_BRANCH_ID,
      summary: 'Writer 2 concurrent capture',
      notes: { problem: '', modification: '', observations: '' },
    }),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);

  const finalVault = await openExistingVault(vaultDir);
  assert.equal(finalVault.revisions.length, 1);
  assert.equal(finalVault.revisions[0].manifest.displayNumber, 1);
});
