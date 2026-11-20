import { FileSystemDirectoryAdapter, splitAndValidatePath } from './fs-adapter';
import { hashBytes } from './hash';
import { enumerateWorkingFolder } from './scanner';
import { applyUnderLock, type ApplicationOptions } from './application-service';
import type { ApplicationReview } from './application-records';
import { withProjectWriterLock } from './locks';

/**
 * Generates deterministic binary byte sequences with arbitrary non-UTF8 binary headers
 * to exercise exact binary preservation without claiming genuine SolidWorks geometry validation.
 */
export function generateDeterministicBinaryBytes(
  seedTag: string,
  byteLength: number
): Uint8Array {
  const out = new Uint8Array(byteLength);
  if (byteLength === 0) return out;

  // Binary OLE/compound header signature + deterministic PRNG payload
  const magic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0xff, 0xfe, 0x89];
  for (let i = 0; i < Math.min(byteLength, magic.length); i++) {
    out[i] = magic[i];
  }

  let state = 2166136261 >>> 0;
  for (let i = 0; i < seedTag.length; i++) {
    state ^= seedTag.charCodeAt(i);
    state = Math.imul(state, 16777619) >>> 0;
  }

  for (let i = magic.length; i < byteLength; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = (state >>> 0) & 0xff;
  }

  return out;
}

export interface ExpectedFixtureSnapshot {
  files: Record<string, { size: number; sha256: string; bytes: Uint8Array }>;
  directories: string[];
}

/**
 * Populates a directory adapter with Fixture A:
 * - Binary files (.SLDASM, .SLDPRT, .SLDDRW) with non-UTF8 bytes
 * - Empty file (0 bytes)
 * - Nested directories & empty directories ("Exports/STEP_Pending", "Simulation/Thermal_Empty")
 * - Unicode filename ("Parts/Dichtung_Ø24mm_Übergang.SLDPRT")
 * - Identical bytes at two different paths ("Parts/Fasteners/M6x20_HexBolt_Left.SLDPRT" and "Parts/Fasteners/M6x20_HexBolt_Right.SLDPRT")
 */
export async function populateFixtureA(
  targetDir: FileSystemDirectoryAdapter
): Promise<ExpectedFixtureSnapshot> {
  const filesData: Record<string, Uint8Array> = {
    'Actuator_Assembly_v1.SLDASM': generateDeterministicBinaryBytes('ASM_ROOT_V1', 18432),
    'Parts/Housing_MainBody.SLDPRT': generateDeterministicBinaryBytes('PART_HOUSING_V1', 32768),
    'Parts/Output_Shaft_12mm.SLDPRT': generateDeterministicBinaryBytes('PART_SHAFT_V1', 12288),
    'Parts/Dichtung_Ø24mm_Übergang.SLDPRT': generateDeterministicBinaryBytes('PART_SEAL_UNICODE_V1', 6144),
    'Parts/Fasteners/M6x20_HexBolt_Left.SLDPRT': generateDeterministicBinaryBytes('STD_M6_BOLT_ISO4017', 4096),
    'Parts/Fasteners/M6x20_HexBolt_Right.SLDPRT': generateDeterministicBinaryBytes('STD_M6_BOLT_ISO4017', 4096),
    'Drawings/Actuator_Assembly_v1.SLDDRW': generateDeterministicBinaryBytes('DRW_ROOT_V1', 14336),
    'Specs/Engineering_ZeroByte_Marker.lock': new Uint8Array(0),
    'Specs/Design_Parameters.txt': new TextEncoder().encode(
      'Max Torque: 42 Nm\nHousing Material: EN AW-6061-T6\nShaft Clearance: 0.025 mm H7/g6\n'
    ),
  };

  const explicitDirectories = [
    'Parts',
    'Parts/Fasteners',
    'Drawings',
    'Specs',
    'Exports',
    'Exports/STEP_Pending',
    'Simulation',
    'Simulation/Thermal_Empty',
  ].sort((a, b) => a.localeCompare(b));

  for (const dirPath of explicitDirectories) {
    await targetDir.getDirectory(splitAndValidatePath(dirPath), { create: true });
  }

  const snapshotFiles: Record<string, { size: number; sha256: string; bytes: Uint8Array }> = {};
  for (const [relPath, bytes] of Object.entries(filesData)) {
    const segments = splitAndValidatePath(relPath);
    await targetDir.writeFileBytes(segments, bytes);
    snapshotFiles[relPath] = {
      size: bytes.byteLength,
      sha256: hashBytes(bytes),
      bytes: bytes.slice(),
    };
  }

  return {
    files: snapshotFiles,
    directories: explicitDirectories,
  };
}

/**
 * Mutates a working directory from Fixture A into Fixture B:
 * - Modifies `Parts/Housing_MainBody.SLDPRT` with new size (36864 bytes)
 * - Modifies `Parts/Output_Shaft_12mm.SLDPRT` with IDENTICAL byte size (12288 bytes) but different binary content (tests same-size modification detection via SHA-256!)
 * - Adds `Parts/Bearing_Retainer_Plate.SLDPRT`
 * - Deletes `Specs/Engineering_ZeroByte_Marker.lock`
 * - Adds empty directory `Exports/IGES_Archive`
 * - Leaves `Actuator_Assembly_v1.SLDASM`, `Parts/Dichtung_Ø24mm_Übergang.SLDPRT`, and bolts unchanged (tests object deduplication & verification!)
 */
export async function applyFixtureBMutations(
  workingDir: FileSystemDirectoryAdapter
): Promise<void> {
  // 1. Modify Housing_MainBody.SLDPRT (size changes 32768 -> 36864)
  const modifiedHousing = generateDeterministicBinaryBytes('PART_HOUSING_V2_RIBBED', 36864);
  await workingDir.writeFileBytes(
    splitAndValidatePath('Parts/Housing_MainBody.SLDPRT'),
    modifiedHousing
  );

  // 2. Modify Output_Shaft_12mm.SLDPRT with EXACT SAME SIZE (12288 bytes) to verify SHA-256 detection
  const sameSizeModifiedShaft = generateDeterministicBinaryBytes('PART_SHAFT_V2_KEYWAY_SAMESIZE', 12288);
  await workingDir.writeFileBytes(
    splitAndValidatePath('Parts/Output_Shaft_12mm.SLDPRT'),
    sameSizeModifiedShaft
  );

  // 3. Add a new part
  const newRetainer = generateDeterministicBinaryBytes('PART_BEARING_RETAINER_V1', 8192);
  await workingDir.writeFileBytes(
    splitAndValidatePath('Parts/Bearing_Retainer_Plate.SLDPRT'),
    newRetainer
  );

  // 4. Delete zero-byte marker file
  await workingDir.removeEntry(splitAndValidatePath('Specs/Engineering_ZeroByte_Marker.lock'));

  // 5. Add new empty directory
  await workingDir.getDirectory(splitAndValidatePath('Exports/IGES_Archive'), { create: true });
}

/**
 * Compares every file and directory in a target directory against an expected fixture snapshot,
 * verifying exact byte equality for every file and exact directory hierarchy match.
 */
export async function verifyDirectoryMatchesFixture(
  dir: FileSystemDirectoryAdapter,
  expected: ExpectedFixtureSnapshot
): Promise<{ matches: boolean; mismatches: string[] }> {
  const mismatches: string[] = [];
  const enumerated = await enumerateWorkingFolder(dir);

  if (enumerated.errors.length > 0) {
    for (const err of enumerated.errors) {
      mismatches.push(`Scan error at ${err.path}: ${err.error}`);
    }
  }

  const expectedDirs = [...expected.directories].sort((a, b) => a.localeCompare(b));
  const actualDirs = [...enumerated.directories].sort((a, b) => a.localeCompare(b));

  if (JSON.stringify(expectedDirs) !== JSON.stringify(actualDirs)) {
    mismatches.push(
      `Directory hierarchy mismatch. Expected [${expectedDirs.join(', ')}], got [${actualDirs.join(', ')}]`
    );
  }

  const expectedFilePaths = Object.keys(expected.files).sort((a, b) => a.localeCompare(b));
  const actualFilePaths = enumerated.files.map((f) => f.path).sort((a, b) => a.localeCompare(b));

  if (JSON.stringify(expectedFilePaths) !== JSON.stringify(actualFilePaths)) {
    mismatches.push(
      `File list mismatch. Expected [${expectedFilePaths.join(', ')}], got [${actualFilePaths.join(', ')}]`
    );
  }

  for (const relPath of expectedFilePaths) {
    const exp = expected.files[relPath];
    const segments = splitAndValidatePath(relPath);
    if (!(await dir.hasFile(segments))) {
      mismatches.push(`Missing expected file: ${relPath}`);
      continue;
    }
    const actualBytes = await dir.readFileBytes(segments);
    if (actualBytes.byteLength !== exp.size) {
      mismatches.push(
        `Byte length mismatch on ${relPath}: expected ${exp.size}, got ${actualBytes.byteLength}`
      );
      continue;
    }
    for (let i = 0; i < exp.bytes.byteLength; i++) {
      if (actualBytes[i] !== exp.bytes[i]) {
        mismatches.push(
          `Byte mismatch on ${relPath} at byte offset ${i}: expected 0x${exp.bytes[i].toString(
            16
          )}, got 0x${actualBytes[i].toString(16)}`
        );
        break;
      }
    }
  }

  return {
    matches: mismatches.length === 0,
    mismatches,
  };
}

/**
 * Test helper: the apply steps of `applyAndSave` without the save, leaving an
 * `applied` operation (or throwing exactly as `applyAndSave` would before it).
 */
export function applyReviewed(
  vault: FileSystemDirectoryAdapter,
  review: ApplicationReview,
  options: ApplicationOptions,
) {
  return withProjectWriterLock(review.projectId, async (lock) =>
    (await applyUnderLock(vault, review, options, lock)).op,
  );
}
