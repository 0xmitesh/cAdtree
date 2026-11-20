import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryFileSystemAdapter } from './fs-adapter';
import { openExistingVault } from './vault-service';
import { captureRevision } from './revision-service';
import { copyVerifiedTree } from './copy-service';
import { createManagedBranch, createProject, createWorkspace, openWorkspace, type ManagedProject } from './workspace-service';
import { caseLifecycle } from './case-lifecycle';
import { changeCaseLifecycle } from './case-lifecycle-service';
import { createReferenceReview } from './references';
import { scanBranchChanges } from './scanner';
import {
  OFFLINE_GUIDE_FORMAT_VERSION, buildProjectMap, buildRevisionListing, projectMapPath, refreshProjectGuide,
  revisionListingPath,
} from './offline-guide';
import { INTERNAL_PATH_TEMPLATES, internalReserve } from './path-budget';
import type { VaultState } from './types';

const noNotes = { problem: '', modification: '', observations: '' };
const notes = { problem: 'Grip too heavy', modification: 'Lighter collar', observations: 'Synthetic only\nsecond line   ' };
const GENERATED = '2026-11-16T09:30:00.000Z';
const MAP = '_MAP cAdtree.txt';
const RESTORE = '_RESTORE cAdtree.html';
const bytes = (text: string) => new Uint8Array(new TextEncoder().encode(text));

interface Fixture {
  root: InMemoryFileSystemAdapter;
  containerPath: string;
  project: ManagedProject;
  revisionIds: string[];
  caseId: string;
  writes: string[];
}

/** Workspace, project, two captures on Main (the second with notes, file notes and a reference), a design case, archived. */
async function fixture(options: { archive?: boolean } = {}): Promise<Fixture> {
  const root = new InMemoryFileSystemAdapter('Workspace');
  const writes: string[] = [];
  root.setHooks({ onBeforeWrite: (full) => { writes.push(full); } });
  await createWorkspace(root);
  const project = await createProject(root, 'Packaging Gripper');
  const containerPath = project.record.containerPath;
  const vault = project.vaultDir;
  const main = project.workingFolders['branch-main']!;
  await main.writeFileBytes(['Parts', 'Collar.SLDPRT'], bytes('base collar'));
  await main.writeFileBytes(['Assembly.SLDASM'], bytes('assembly'));
  await main.getDirectory(['Empty folder'], { create: true });
  const first = await captureRevision(main, vault, { branchId: 'branch-main', summary: 'Base', notes: noNotes, workingFolders: project.workingFolders });
  await main.writeFileBytes(['Parts', 'Collar.SLDPRT'], bytes('collar v2'));
  const scan = await scanBranchChanges(main, 'branch-main', first.revision.manifest);
  const second = await captureRevision(main, vault, {
    branchId: 'branch-main',
    summary: 'Lighter collar with a very long summary that goes on and on and on past the eighty character limit',
    notes,
    fileNotes: [{ path: 'Parts/Collar.SLDPRT', problem: 'Too thick', modification: 'Thinner wall', observations: '' }],
    workingFolders: project.workingFolders,
    reviewedChangesSignature: scan.changesSignature,
    referenceReview: createReferenceReview(first.vaultState, scan),
    referenceAuthor: { id: 'a', displayName: 'Asha' },
    referenceAttachments: [{ source: new File([new Uint8Array([1, 2, 3])], 'Load requirement.pdf'), explanation: 'Max load 40 N' }],
  });
  const withCase = await createManagedBranch(root, containerPath, {
    sourceRevisionId: first.revision.manifest.revisionId, name: 'Lighter collar', reason: 'Reduce mass',
  });
  const caseId = withCase.createdBranchId;
  if (options.archive !== false) {
    const state = await openExistingVault(vault);
    await changeCaseLifecycle(vault, {
      projectId: project.record.projectId, branchId: caseId, activeBranchId: 'branch-main', status: 'archived',
      expectedVersion: caseLifecycle(state, caseId).version,
    }, { workingFolders: withCase.workingFolders });
  }
  const opened = (await openWorkspace(root)).projects[0]!.project!;
  return {
    root, containerPath, project: opened, caseId, writes,
    revisionIds: [first.revision.manifest.revisionId, second.revision.manifest.revisionId],
  };
}

const readText = async (f: Fixture, path: string[]) => (await f.root.getDirectory(f.containerPath.split('/'))).readFileText(path);
const listingPath = (id: string) => ['vault', ...revisionListingPath(id)];
const guideWrites = (f: Fixture) =>
  f.writes.filter((w) => (w.endsWith('.txt') && (w.includes('/vault/revisions/') || w.endsWith(MAP))) || w.endsWith(RESTORE));

function listing(f: Fixture, state: VaultState, index: number) {
  return buildRevisionListing({
    generatedAt: GENERATED, projectName: 'Packaging Gripper', state, revision: state.revisions.find((r) => r.manifest.revisionId === f.revisionIds[index])!,
  });
}

/** Runs `fn` with console.warn captured. */
async function warnings<T>(fn: () => Promise<T>): Promise<{ value: T; warned: string[] }> {
  const original = console.warn;
  const warned: string[] = [];
  console.warn = (...args: unknown[]) => { warned.push(args.join(' ')); };
  try {
    return { value: await fn(), warned };
  } finally {
    console.warn = original;
  }
}

function assertPlainText(text: string) {
  assert.ok(text.endsWith('\r\n') && !text.endsWith('\r\n\r\n'), 'ends with a single CRLF');
  assert.ok(!text.includes('﻿'), 'no BOM');
  assert.ok(!/(?<!\r)\n/.test(text), 'no lone LF');
  assert.ok(!/\r(?!\n)/.test(text), 'no lone CR');
  for (const line of text.split('\r\n')) assert.equal(line, line.replace(/[ \t]+$/, ''), `trailing whitespace: "${line}"`);
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

test('version listing: header, identity, notes, folders, files with object paths, references and rebuild steps', async () => {
  const f = await fixture();
  const state = f.project.vaultState;
  const text = listing(f, state, 1);
  const lines = text.split('\r\n');
  assert.deepEqual(lines.slice(0, 6), [
    'cAdtree offline guide — version listing',
    `Describes version saved at: ${GENERATED}`,
    `Guide format: ${OFFLINE_GUIDE_FORMAT_VERSION}`,
    '',
    'This file is a guide generated by cAdtree. If it disagrees with the vault records, the vault is correct.',
    'Do not edit files inside the vault folder. Copy them elsewhere first.',
  ]);
  assert.ok(!text.includes('Generated:'), 'a listing carries no generation time');
  assert.equal(OFFLINE_GUIDE_FORMAT_VERSION, 2);
  assertPlainText(text);
  const manifest = state.revisions.find((r) => r.manifest.revisionId === f.revisionIds[1])!.manifest;
  assert.ok(lines.includes('Project: Packaging Gripper'));
  assert.ok(lines.includes('Version: V2'));
  assert.ok(lines.includes(`Version ID: ${f.revisionIds[1]}`));
  assert.ok(lines.includes('Branch: Main (branch ID: branch-main)'));
  assert.ok(lines.includes(`Parent version: V1 (${f.revisionIds[0]})`));
  assert.ok(lines.includes(`Saved: ${manifest.captureCompletedAt}`));
  assert.ok(lines.includes('    Why: Grip too heavy'));
  assert.ok(lines.includes('    What you noticed: Synthetic only'));
  assert.ok(lines.includes('        second line'), 'multi-line values continue indented, without trailing spaces');
  // Per-file notes: empty fields are omitted.
  assert.ok(lines.includes('    Parts/Collar.SLDPRT'));
  assert.ok(lines.includes('        Note: Thinner wall'));
  assert.ok(!lines.includes('        What you noticed: (none)'));
  assert.ok(!lines.some((l) => l.includes('Observations')));
  // Folders and files.
  assert.deepEqual(manifest.directories.slice().sort(), ['Empty folder', 'Parts']);
  assert.ok(lines.includes('FOLDERS (2)'));
  assert.ok(lines.includes('    Parts'));
  assert.ok(lines.includes('    Empty folder'));
  assert.ok(lines.includes('FILES (2)'));
  const collar = manifest.files.find((file) => file.path === 'Parts/Collar.SLDPRT')!;
  assert.ok(lines.includes(`        Size: ${collar.size} bytes`));
  assert.ok(lines.includes(`        SHA-256: ${collar.sha256}`));
  assert.ok(lines.includes(`        Object file: vault/objects/${collar.sha256.slice(0, 2)}/${collar.sha256}.bin`));
  // References captured with this revision.
  const refStart = lines.indexOf('REFERENCES CAPTURED WITH THIS VERSION');
  assert.ok(refStart > 0);
  const refText = lines.slice(refStart).join('\n');
  assert.match(refText, /1\. Load requirement\.pdf/);
  assert.match(refText, /Original file: Load requirement\.pdf/);
  assert.match(refText, /Object file: vault\/objects\/[0-9a-f]{2}\/[0-9a-f]{64}\.bin/);
  assert.match(refText, /Explanation: Max load 40 N/);
  // Rebuild instructions.
  assert.match(text, /HOW TO REBUILD THIS VERSION\r\n/);
  // The restore page first, then the manual steps, which begin with the Windows file name extension tip.
  assert.ok(text.indexOf('Easiest: open _RESTORE cAdtree.html') > text.indexOf('HOW TO REBUILD THIS VERSION'));
  assert.ok(text.indexOf('Easiest: open _RESTORE cAdtree.html') < text.indexOf('By hand (without the page)'));
  assert.ok(text.includes('1. On Windows, turn on View → Show → File name extensions first; the renamed copy must not end in .bin.'));
  assert.ok(text.indexOf('File name extensions') < text.indexOf('2. Make an empty folder'));
  assert.match(text, /certutil -hashfile "<file>" SHA256/);
  assert.match(text, /shasum -a 256 "<file>"/);
  assert.match(text, /whole folder tree/);
  assert.doesNotMatch(text, /geometry|convert/i);
});

test('version listing: empty notes, no per-file notes and no references read "(none)"', async () => {
  const f = await fixture();
  const text = listing(f, f.project.vaultState, 0);
  const lines = text.split('\r\n');
  assert.ok(lines.includes('Parent version: none'));
  const notes = lines.indexOf('NOTES');
  assert.equal(lines[notes + 1], '    (none)');
  const fileNotes = lines.indexOf('NOTES ON INDIVIDUAL FILES');
  assert.equal(lines[fileNotes + 1], '    (none)');
  const refs = lines.indexOf('REFERENCES CAPTURED WITH THIS VERSION');
  assert.equal(lines[refs + 1], '    (none)');
  assertPlainText(text);
});

test('builders are deterministic and normalise line endings, BOMs and trailing spaces in user text', async () => {
  const f = await fixture();
  const state = structuredClone(f.project.vaultState);
  assert.equal(listing(f, state, 1), listing(f, state, 1));
  const revision = state.revisions.find((r) => r.manifest.revisionId === f.revisionIds[1])!;
  revision.manifest.summary = '﻿First  \r\nsecond\rthird\n  ';
  revision.manifest.notes.problem = 'a\r\n\r\nb\t';
  const text = buildRevisionListing({ generatedAt: GENERATED, projectName: 'P', state, revision });
  assertPlainText(text);
  assert.ok(text.includes('Summary: First\r\n    second\r\n    third\r\n'));
  assert.equal(
    buildProjectMap({ generatedAt: GENERATED, projectName: 'P', projectFolder: 'P', state, workingLeaves: {} }),
    buildProjectMap({ generatedAt: GENERATED, projectName: 'P', projectFolder: 'P', state, workingLeaves: {} }),
  );
});

test('project map: header, latest files, branches, versions, references, integrity and recovery', async () => {
  const f = await fixture();
  const state = f.project.vaultState;
  const leaves = Object.fromEntries(Object.entries(f.project.workingPaths).map(([id, path]) => [id, path.split('/').pop()!]));
  const text = buildProjectMap({ generatedAt: GENERATED, projectName: 'Packaging Gripper', projectFolder: 'Packaging Gripper', state, workingLeaves: leaves });
  assertPlainText(text);
  const lines = text.split('\r\n');
  assert.equal(lines[0], 'cAdtree offline guide — project map');
  assert.equal(lines[1], `Generated: ${GENERATED}`);
  assert.equal(lines[2], `Guide format: ${OFFLINE_GUIDE_FORMAT_VERSION}`);
  assert.ok(lines.includes('Project: Packaging Gripper'));
  assert.ok(lines.includes(`Project ID: ${f.project.record.projectId}`));
  assert.ok(lines.includes('Project folder: Packaging Gripper'));
  const latest = state.revisions.find((r) => r.manifest.revisionId === f.revisionIds[1])!.manifest;
  assert.ok(lines.includes(`Covers up to: V2 (${f.revisionIds[1]}), saved ${latest.captureCompletedAt}`));
  // Latest files.
  assert.ok(lines.includes('    Main (Main): working/main'));
  assert.ok(lines.includes('    Lighter collar: working/Lighter collar'));
  // Branches and cases.
  assert.ok(lines.includes('    Branch ID: branch-main'));
  assert.ok(lines.includes(`    Branch ID: ${f.caseId}`));
  assert.ok(lines.includes('    Status: hidden'));
  assert.ok(lines.includes('    Status: active'));
  assert.ok(lines.includes(`    Started from: V1 (${f.revisionIds[0]})`));
  assert.ok(lines.includes('    Reason: Reduce mass'));
  // Revisions: ordered, one block each, summary truncated to 80 characters.
  assert.ok(lines.some((l) => l.startsWith(`V1   ${f.revisionIds[0]}   `) && l.endsWith('   Main')));
  assert.ok(lines.indexOf(lines.find((l) => l.startsWith('V1'))!) < lines.indexOf(lines.find((l) => l.startsWith('V2'))!));
  const summary = lines.find((l) => l.startsWith('    Summary: Lighter collar'))!;
  assert.equal(summary.length, '    Summary: '.length + 80);
  assert.ok(summary.endsWith('…'));
  assert.ok(lines.includes(`    Listing: vault/revisions/${f.revisionIds[1]}.txt`));
  assert.ok(lines.includes(`    Parent: ${f.revisionIds[0]}`));
  assert.ok(lines.includes('    Parent: none'));
  // References.
  assert.match(text, /REFERENCES\r\n {4}Load requirement\.pdf\r\n {8}Version 1, imported /);
  assert.match(text, /Original file: Load requirement\.pdf/);
  assert.match(text, /Object file: vault\/objects\/[0-9a-f]{2}\/[0-9a-f]{64}\.bin/);
  // Integrity and recovery.
  assert.match(text, /INTEGRITY\r\n/);
  assert.match(text, /HOW TO RECOVER WITHOUT cAdtree/);
  const recover = text.slice(text.indexOf('HOW TO RECOVER WITHOUT cAdtree'));
  assert.ok(recover.indexOf('Easiest: open _RESTORE cAdtree.html') > 0 && recover.indexOf('Easiest') < recover.indexOf('By hand:'));
  assert.match(recover, /View → Show → File name extensions first; the renamed copy must not end in \.bin\./);
  assert.match(text, /certutil -hashfile "<file>" SHA256/);
  assert.match(text, /shasum -a 256 "<file>"/);
  // Engine-supplied detail sentences are quoted as they are; everything cAdtree lays out stays within 120.
  assert.ok(lines.filter((l) => !l.trim().startsWith('Detail:')).every((l) => l.length <= 120), 'no laid-out line is wider than 120 characters');
});

test('project map: an empty project, incomplete attempts and an unlistable version are described plainly', async () => {
  const root = new InMemoryFileSystemAdapter('Workspace');
  await createWorkspace(root);
  const project = await createProject(root, 'New design');
  const empty = buildProjectMap({ generatedAt: GENERATED, projectName: 'New design', projectFolder: 'New design', state: project.vaultState, workingLeaves: { 'branch-main': 'main' } });
  assert.match(empty, /Covers up to: no saved versions yet/);
  assert.match(empty, /VERSIONS \(0\), oldest first\r\n {4}\(none\)/);
  assert.match(empty, /INTEGRITY\r\n {4}None found when this file was written\./);

  const f = await fixture();
  const state = structuredClone(f.project.vaultState);
  state.incompleteAttempts.push({ id: 'a', kind: 'staging_artifact', path: 'staging/a', detail: 'Interrupted write' });
  state.revisions[0]!.integrityStatus = 'corrupted';
  const text = buildProjectMap({ generatedAt: GENERATED, projectName: 'P', projectFolder: 'P', state, workingLeaves: {} });
  assert.doesNotMatch(text, /None found when this file was written/);
  assert.match(text, /Incomplete attempt: staging\/a/);
  assert.match(text, /Listing: none \(this version record is damaged\)/);
  assert.match(text, /Working folder: not found/);
});

test('path builders and internal path templates', () => {
  assert.deepEqual(projectMapPath(), [MAP]);
  assert.deepEqual(revisionListingPath('20260101-000000-abcdef'), ['revisions', '20260101-000000-abcdef.txt']);
  const map = INTERNAL_PATH_TEMPLATES.find((t) => t.label === 'project offline map')!;
  const listingTemplate = INTERNAL_PATH_TEMPLATES.find((t) => t.label === 'vault version listing')!;
  assert.equal(map.shape, MAP);
  assert.equal(map.reserveLength, MAP.length + 7);
  assert.equal(listingTemplate.shape, 'vault/revisions/{rev}.txt');
  assert.equal(listingTemplate.relativeLength, 'vault/revisions/20260101-000000-abcdef.txt'.length);
  assert.equal(internalReserve(), 110);
});

// ---------------------------------------------------------------------------
// refreshProjectGuide
// ---------------------------------------------------------------------------

test('refresh writes the Map and one listing per version; a second refresh rewrites only the Map', async () => {
  const f = await fixture();
  const fixedNow = () => new Date('2026-11-16T10:00:00.000Z');
  f.writes.length = 0;
  const first = await refreshProjectGuide(f.root, f.containerPath, { now: fixedNow });
  assert.equal(first.status, 'written');
  assert.deepEqual(first.failed, []);
  assert.deepEqual(
    [...first.written].sort(),
    [MAP, RESTORE, ...f.revisionIds.map((id) => `vault/revisions/${id}.txt`)].sort(),
  );
  const map = await readText(f, [MAP]);
  assert.match(map, /Generated: 2026-11-16T10:00:00\.000Z/);
  assert.match(map, new RegExp(`Covers up to: V2 \\(${f.revisionIds[1]}\\)`));
  assert.match(map, /Status: hidden/);
  assert.match(map, /Lighter collar: working\/Lighter collar/);
  for (const [index, id] of f.revisionIds.entries()) {
    const text = await readText(f, listingPath(id));
    assert.match(text, new RegExp(`Version ID: ${id}`));
    assert.match(text, /\r\nFILES \(/);
    // A listing's Generated time is the revision's own completion time, so it never changes.
    const state = await openExistingVault(f.project.vaultDir);
    const completed = state.revisions.find((r) => r.manifest.revisionId === id)!.manifest.captureCompletedAt;
    assert.match(text, new RegExp(`Describes version saved at: ${completed.replace(/\./g, '\\.')}`), `listing ${index}`);
    assertPlainText(text);
  }
  assertPlainText(map);
  assert.equal(guideWrites(f).length, 4);

  f.writes.length = 0;
  const second = await refreshProjectGuide(f.root, f.containerPath, { now: () => new Date('2026-11-16T11:00:00.000Z') });
  assert.equal(second.status, 'written');
  // The restore page is not rewritten for a new generated time alone.
  assert.deepEqual(second.written, [MAP]);
  assert.deepEqual(guideWrites(f).map((w) => w.split('/').pop()), [MAP]);
  assert.match(await readText(f, [MAP]), /Generated: 2026-11-16T11:00:00\.000Z/);
});

test('refresh never writes outside the Map, the restore page and vault/revisions', async () => {
  const f = await fixture();
  f.writes.length = 0;
  await refreshProjectGuide(f.root, f.containerPath);
  assert.equal(f.writes.length, 4);
  for (const write of f.writes) {
    const relative = write.slice(`Workspace/${f.containerPath}/`.length);
    assert.ok(relative === MAP || relative === RESTORE || /^vault\/revisions\/[^/]+\.txt$/.test(relative), relative);
  }
});

test('a hand-edited or deleted listing is restored; a correct one is left alone', async () => {
  const f = await fixture();
  await refreshProjectGuide(f.root, f.containerPath);
  const [firstId, secondId] = f.revisionIds as [string, string];
  const original = await readText(f, listingPath(firstId));
  await f.project.vaultDir.writeFileText(revisionListingPath(firstId), 'edited by hand\r\n');
  await f.project.vaultDir.removeEntry(revisionListingPath(secondId));
  f.writes.length = 0;
  const result = await refreshProjectGuide(f.root, f.containerPath);
  assert.equal(result.status, 'written');
  assert.deepEqual(
    [...result.written].sort(),
    [MAP, `vault/revisions/${firstId}.txt`, `vault/revisions/${secondId}.txt`].sort(),
  );
  assert.equal(await readText(f, listingPath(firstId)), original);
  assert.equal(guideWrites(f).length, 3);
});

test('opening the vault with listings present yields the same state and no new problems', async () => {
  const f = await fixture();
  const before = await openExistingVault(f.project.vaultDir);
  await refreshProjectGuide(f.root, f.containerPath);
  const entries = (await (await f.project.vaultDir.getDirectory(['revisions'])).listEntries()).map((e) => e.name);
  assert.equal(entries.filter((name) => name.endsWith('.txt')).length, 2);
  const after = await openExistingVault(f.project.vaultDir);
  assert.deepEqual(after.corruptedRecords, before.corruptedRecords);
  assert.deepEqual(after.incompleteAttempts, before.incompleteAttempts);
  assert.deepEqual(after.revisions, before.revisions);
  assert.deepEqual(after.branches, before.branches);
  assert.deepEqual(after.branchHeads, before.branchHeads);
  assert.equal(JSON.stringify(after), JSON.stringify(before));
  const reopened = (await openWorkspace(f.root)).projects[0]!;
  assert.equal(reopened.status, 'ready');
  assert.deepEqual(reopened.issues, []);
});

test('a failing write yields partial, never throws, and the other files are still written', async () => {
  const f = await fixture();
  const firstId = f.revisionIds[0]!;
  f.root.setHooks({
    onBeforeWrite: (full) => { if (full.endsWith(`${firstId}.txt`)) throw new Error('disk full'); },
  });
  const warned: unknown[][] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args); };
  let result;
  try {
    result = await refreshProjectGuide(f.root, f.containerPath);
  } finally {
    console.warn = realWarn;
  }
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.failed.map((item) => item.path), [`vault/revisions/${firstId}.txt`]);
  assert.match(result.failed[0]!.error, /disk full/);
  assert.ok(result.written.includes(MAP));
  assert.ok(result.written.includes(`vault/revisions/${f.revisionIds[1]}.txt`));
  assert.equal(warned.length, 1);
  assert.equal(await f.project.vaultDir.hasFile(revisionListingPath(firstId)), false);
  // The Map says so next to the listing that is missing, and only there.
  const map = await readText(f, [MAP]);
  assert.ok(map.includes(`    Listing: vault/revisions/${firstId}.txt (listing could not be written; see the manifest)\r\n`));
  assert.ok(map.includes(`    Listing: vault/revisions/${f.revisionIds[1]}.txt\r\n`));
  // The project still opens identically.
  const state = await openExistingVault(f.project.vaultDir);
  assert.deepEqual(state.corruptedRecords, []);
  assert.equal((await openWorkspace(f.root)).projects[0]!.status, 'ready');
});

test('a read-back mismatch is a failure, and a Map failure is reported', async () => {
  const f = await fixture();
  // Simulate a path failure on the Map using the adapter's own fault injection.
  f.root.setAddress('/ws');
  f.root.simulateFailureAt(`/ws/${f.containerPath}/${MAP}`, new DOMException('too long', 'InvalidStateError'));
  const originalWarn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = await refreshProjectGuide(f.root, f.containerPath);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.failed.map((item) => item.path), [MAP]);
  assert.equal(result.written.length, 3);
});

test('a duplicated project is skipped without any write, and the skip is logged', async () => {
  const f = await fixture();
  const original = await f.root.getDirectory(f.containerPath.split('/'));
  const copy = await f.root.getDirectory(['projects', 'explicit-duplicate'], { create: true });
  await copyVerifiedTree(original, copy);
  f.writes.length = 0;
  for (const path of [f.containerPath, 'projects/explicit-duplicate']) {
    const { value: result, warned } = await warnings(() => refreshProjectGuide(f.root, path));
    assert.equal(result.status, 'skipped');
    assert.match(result.reason ?? '', /more than one location/);
    assert.deepEqual(result.written, []);
    assert.equal(warned.length, 1);
    assert.match(warned[0]!, /skipped .*more than one location/);
  }
  assert.deepEqual(f.writes, []);
});

test('a copy that does not open cleanly is not a duplicate: the app rule decides, so the original is still written', async () => {
  const f = await fixture();
  const original = await f.root.getDirectory(f.containerPath.split('/'));
  const copy = await f.root.getDirectory(['projects', 'half-copy'], { create: true });
  await copyVerifiedTree(original, copy);
  // The copy's record no longer validates, so the workspace scan can't read its identity.
  await copy.writeFileText(['.cadtree', 'project.json'], '{ "broken": true }');
  const scan = await openWorkspace(f.root);
  assert.deepEqual(scan.projects.map((p) => p.status).sort(), ['damaged', 'ready']);
  const ok = await refreshProjectGuide(f.root, f.containerPath);
  assert.equal(ok.status, 'written');
  const { value: broken, warned } = await warnings(() => refreshProjectGuide(f.root, 'projects/half-copy'));
  assert.equal(broken.status, 'skipped');
  assert.match(broken.reason ?? '', /read-only \(damaged\)/);
  assert.equal(warned.length, 1);
});

test('a read-only, damaged or missing project, or a read-only workspace, is skipped without any write', async () => {
  const f = await fixture();
  f.writes.length = 0;
  // Damaged: the project's ready marker disappears.
  const container = await f.root.getDirectory(f.containerPath.split('/'));
  await container.removeEntry(['.cadtree', 'ready.json']);
  const { value: damaged, warned } = await warnings(() => refreshProjectGuide(f.root, f.containerPath));
  assert.equal(damaged.status, 'skipped');
  assert.match(damaged.reason ?? '', /read-only/);
  assert.equal(warned.length, 1);
  // Missing: a container that doesn't exist. Never throws.
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const missing = await refreshProjectGuide(f.root, 'projects/Nothing here');
    assert.equal(missing.status, 'skipped');
    assert.deepEqual(missing.written, []);
  } finally {
    console.warn = originalWarn;
  }
  // Read-only workspace.
  f.root.setHooks({ writePermission: 'denied' });
  const { value: denied } = await warnings(() => refreshProjectGuide(f.root, f.containerPath));
  assert.equal(denied.status, 'skipped');
  assert.match(denied.reason ?? '', /not writable/);
  assert.deepEqual(f.writes, []);
});

test('a project with corrupted history is skipped', async () => {
  const f = await fixture();
  const secondId = f.revisionIds[1]!;
  await f.project.vaultDir.writeFileText(['revisions', `${secondId}.manifest.json`], '{ not json');
  f.writes.length = 0;
  const { value: result } = await warnings(() => refreshProjectGuide(f.root, f.containerPath));
  assert.equal(result.status, 'skipped');
  assert.deepEqual(f.writes, []);
});

test('the guide stays out of strict vault folders and simultaneous refreshes are serialised', async () => {
  const f = await fixture();
  const results = await Promise.all([
    refreshProjectGuide(f.root, f.containerPath),
    refreshProjectGuide(f.root, f.containerPath),
  ]);
  assert.deepEqual(results.map((r) => r.status), ['written', 'written']);
  for (const strict of ['staging', 'components', 'references', 'case-lifecycle', 'applications']) {
    const hits = f.writes.filter((w) => w.includes(`/vault/${strict}/`) && w.endsWith('.txt'));
    assert.deepEqual(hits, [], strict);
  }
  const state: VaultState = await openExistingVault(f.project.vaultDir);
  assert.deepEqual(state.corruptedRecords, []);
});

test('workspace discovery is unaffected by the Map in the project folder', async () => {
  const f = await fixture();
  await refreshProjectGuide(f.root, f.containerPath);
  const state = await openWorkspace(f.root);
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0]!.status, 'ready');
  const entries = (await (await f.root.getDirectory(f.containerPath.split('/'))).listEntries()).map((e: { name: string }) => e.name);
  assert.ok(entries.includes(MAP));
});
