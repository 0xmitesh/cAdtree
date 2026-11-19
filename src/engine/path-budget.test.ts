import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryFileSystemAdapter, type FileSystemDirectoryAdapter } from './fs-adapter';
import { openExistingVault } from './vault-service';
import { RECOVERY_MARKER_FILENAME } from './recovery-service';
import { captureRevision } from './revision-service';
import { createProject, createWorkspace, createManagedBranch } from './workspace-service';
import { prepareApplyPreview, buildApplyPreview, type PreviewChoice } from './apply-preview';
import {
  applicationReview, prepareApplication, applyPreparedApplication, recoverApplication, replaceWorkingFiles, scanForReplace,
} from './application-service';
import { buildReplacePlan, replacePlanHash } from './apply-preview';
import { getBranchBaseline } from './branch-state';
import { DISCARDED_MAX_COUNTER } from './discarded-paths';
import { branchApplications } from './application-records';
import { importReferenceAttachment } from './references';
import { caseLifecycle } from './case-lifecycle';
import { changeCaseLifecycle } from './case-lifecycle-service';
import { createKnowledgeRecord } from '../knowledge/records';
import { refreshProjectGuide } from './offline-guide';
import {
  BLOCK_PATH_CHARS, CASE_ALLOWANCE, CRSWAP_CHARS, INTERNAL_PATH_TEMPLATES, MAX_NAME_BYTES, PROJECT_NAME_ALLOWANCE,
  WARN_PATH_CHARS, classifyPathLength, deepestInternalTemplate, internalReserve, internalReserveLabel,
  matchInternalPath, projectWorstCase, shapePattern,
} from './path-budget';

const notes = { problem: 'Grip too heavy', modification: 'Lighter collar', observations: 'Synthetic only' };
const part = 'Parts/Collar.SLDPRT';
const PROJECT_NAME = 'Packaging Gripper';

// ---------------------------------------------------------------------------
// Constants and pure functions
// ---------------------------------------------------------------------------

test('standard constants', () => {
  assert.equal(WARN_PATH_CHARS, 200);
  assert.equal(BLOCK_PATH_CHARS, 240);
  assert.equal(CRSWAP_CHARS, 7);
  assert.equal(CASE_ALLOWANCE, 32);
  assert.equal(PROJECT_NAME_ALLOWANCE, 24);
  assert.equal(MAX_NAME_BYTES, 255);
});

test('classifyPathLength warns from 200 and blocks above 240', () => {
  assert.equal(classifyPathLength(0), 'ok');
  assert.equal(classifyPathLength(199), 'ok');
  assert.equal(classifyPathLength(200), 'warn');
  assert.equal(classifyPathLength(240), 'warn');
  assert.equal(classifyPathLength(241), 'block');
});

const EXAMPLE = 'C:\\Users\\Mitesh\\Documents\\Cadtree\\Acme Rigs\\projects\\Packaging Gripper';

test('projectWorstCase for the example project path', () => {
  assert.equal(EXAMPLE.length, 70);
  const reserve = internalReserve();
  // No user files: the internal reserve decides.
  assert.equal(projectWorstCase({ projectPath: EXAMPLE }), 70 + 1 + reserve);
  assert.equal(projectWorstCase({ projectPath: EXAMPLE, longestUserPath: 0 }), 70 + 1 + reserve);
  // A very long CAD path is under working/<32>/ (42): 70 + 42 + 200 + 7 = 319.
  assert.equal(projectWorstCase({ projectPath: EXAMPLE, longestUserPath: 200 }), 70 + 42 + 200 + 7);
  // A short one is dominated by the internal reserve.
  assert.equal(projectWorstCase({ projectPath: EXAMPLE, longestUserPath: 40 }), 70 + 1 + reserve);
  // The case allowance is configurable, but never below 4 ("main").
  assert.equal(projectWorstCase({ projectPath: EXAMPLE, longestUserPath: 250, caseAllowance: 10 }), 70 + 9 + 10 + 1 + 250 + 7);
  assert.equal(projectWorstCase({ projectPath: EXAMPLE, longestUserPath: 250, caseAllowance: 0 }), 70 + 9 + 4 + 1 + 250 + 7);
  // Classification of the results.
  assert.equal(classifyPathLength(projectWorstCase({ projectPath: EXAMPLE })), 'ok');
  assert.equal(classifyPathLength(projectWorstCase({ projectPath: 95 })), 'warn');
  // Exact boundaries: projectPath + 1 + internalReserve() (110) is 111 more than the project path.
  const at = (projectPath: number) => projectWorstCase({ projectPath });
  assert.deepEqual([88, 89, 129, 130].map(at), [199, 200, 240, 241]);
  assert.deepEqual([88, 89, 129, 130].map((n) => classifyPathLength(at(n))), ['ok', 'warn', 'warn', 'block']);
  assert.equal(classifyPathLength(projectWorstCase({ projectPath: EXAMPLE, longestUserPath: 200 })), 'block');
});

test('invalid numeric input throws instead of classifying as ok', () => {
  for (const bad of [NaN, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => classifyPathLength(bad), /Invalid path length/, String(bad));
    assert.throws(() => projectWorstCase({ projectPath: bad }), /Invalid project path length/, String(bad));
    assert.throws(() => projectWorstCase({ projectPath: 70, longestUserPath: bad }), /Invalid longest user path/, String(bad));
    assert.throws(() => projectWorstCase({ projectPath: 70, caseAllowance: bad }), /Invalid case allowance/, String(bad));
  }
  assert.equal(classifyPathLength(0), 'ok');
});

test('projectWorstCase covers user files under working/<case>/', () => {
  const workingPrefix = '/working/'.length + 32 + 1;
  assert.equal(workingPrefix, 42);
  assert.equal(projectWorstCase({ projectPath: EXAMPLE, longestUserPath: 200 }), 70 + 42 + 200 + 7);
  // A larger case allowance can still win.
  assert.equal(projectWorstCase({ projectPath: EXAMPLE, longestUserPath: 200, caseAllowance: 100 }), 70 + 9 + 100 + 1 + 200 + 7);
});

test('the incomplete marker of a failed design case is a covered internal path within the reserve', () => {
  const marker = INTERNAL_PATH_TEMPLATES.find((t) => t.label === 'design case incomplete marker')!;
  assert.equal(marker.segments.join('/'), `working/${'x'.repeat(32)}/_CADTREE_RECOVERY_INCOMPLETE.txt`);
  assert.equal(marker.reserveLength, 'working/'.length + 32 + 1 + '_CADTREE_RECOVERY_INCOMPLETE.txt'.length + CRSWAP_CHARS);
  // The on-disk name is pinned by literal above; the engine's own constant must agree.
  assert.equal(RECOVERY_MARKER_FILENAME, '_CADTREE_RECOVERY_INCOMPLETE.txt');
  assert.ok(marker.reserveLength <= internalReserve());
  assert.ok(INTERNAL_PATH_TEMPLATES.every((t) => !/recoveries\//.test(t.shape)));
});

test('internal templates are self-consistent', () => {
  for (const t of INTERNAL_PATH_TEMPLATES) {
    const rel = t.segments.join('/');
    assert.equal(t.relativeLength, rel.length, t.label);
    assert.equal(t.reserveLength, rel.length + (t.kind === 'file' ? CRSWAP_CHARS : 0), t.label);
    assert.ok(shapePattern(t.shape).test(rel), `${t.label}: sample does not match its own shape (${rel})`);
    assert.ok(t.segments.every((s) => new TextEncoder().encode(s).length <= MAX_NAME_BYTES), t.label);
  }
  assert.equal(new Set(INTERNAL_PATH_TEMPLATES.map((t) => t.label)).size, INTERNAL_PATH_TEMPLATES.length);
});

// ---------------------------------------------------------------------------
// Drift test: a real workflow may only write paths that are listed
// ---------------------------------------------------------------------------

async function walk(dir: FileSystemDirectoryAdapter, prefix: string, out: { path: string; kind: 'file' | 'dir' }[]) {
  for (const entry of await dir.listEntries()) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    out.push({ path, kind: entry.kind === 'directory' ? 'dir' : 'file' });
    if (entry.kind === 'directory') await walk(await dir.getDirectory([entry.name]), path, out);
  }
}

test('drift: every path written by a full workflow is covered by a template and fits the internal reserve', async () => {
  const root = new InMemoryFileSystemAdapter('Workspace');
  let containerPath = '';
  const files = new Set<string>();
  const dirs = new Set<string>();
  let failEvent4 = false;
  let failCaseFile = false;
  const rel = (full: string) => {
    const prefix = `Workspace/${containerPath}/`;
    return containerPath && full.startsWith(prefix) ? full.slice(prefix.length) : undefined;
  };
  root.setHooks({
    onBeforeWrite: (full) => {
      const r = rel(full);
      if (r !== undefined) files.add(r);
      if (failCaseFile && full.includes('/working/Failing case/') && full.endsWith('Bracket.SLDPRT')) throw new Error('disk full while restoring');
      if (failEvent4 && full.includes('/events/') && full.endsWith('000004.json')) throw new Error('lost final publication');
    },
  });
  const snapshot = async () => {
    if (!containerPath) return;
    const found: { path: string; kind: 'file' | 'dir' }[] = [];
    await walk(await root.getDirectory(containerPath.split('/')), '', found);
    for (const f of found) (f.kind === 'dir' ? dirs : files).add(f.path);
  };

  // Step 1: workspace and project.
  await createWorkspace(root);
  const project = await createProject(root, PROJECT_NAME);
  containerPath = project.record.containerPath;
  await snapshot();
  const vault = project.vaultDir;
  const projectId = project.record.projectId;
  const main = project.workingFolders['branch-main']!;
  await main.writeFileText(part.split('/'), 'base collar');
  await main.writeFileText(['Assembly.SLDASM'], 'assembly');
  await main.writeFileText(['Other', 'Bracket.SLDPRT'], 'bracket');

  // Step 2: first revision on Main.
  const first = await captureRevision(main, vault, {
    branchId: 'branch-main', summary: 'Base', notes, workingFolders: project.workingFolders,
  });
  const firstId = first.revision.manifest.revisionId;
  await snapshot();

  // Step 3: reference import, then a second revision that carries reference context.
  await importReferenceAttachment(vault, projectId, {
    name: 'load-requirement.pdf', type: 'application/pdf', size: 3, stream: () => new Blob([new Uint8Array([1, 2, 3])]).stream(),
  }, { title: 'Synthetic load requirement', description: '', tags: [] });
  await main.writeFileText(['Other', 'Bracket.SLDPRT'], 'bracket v2');
  await captureRevision(main, vault, { branchId: 'branch-main', summary: 'Bracket', notes, workingFolders: project.workingFolders });
  await snapshot();

  // Step 4: design case, a revision on it, and a newer Main revision.
  const withCase = await createManagedBranch(root, containerPath, { sourceRevisionId: firstId, name: 'Lighter collar', reason: 'Reduce mass' });
  const caseId = withCase.createdBranchId;
  const caseDir = withCase.workingFolders[caseId]!;
  await caseDir.writeFileText(part.split('/'), 'lighter collar');
  const caseSave = await captureRevision(caseDir, vault, { branchId: caseId, summary: 'Lighter', notes, workingFolders: withCase.workingFolders });
  await main.writeFileText(['Other', 'Bracket.SLDPRT'], 'bracket v3');
  await captureRevision(main, vault, { branchId: 'branch-main', summary: 'Newer bracket', notes, workingFolders: withCase.workingFolders });
  await snapshot();

  // Step 5: apply the case revision onto Main; the final event write is lost (interrupted apply).
  const options = { workingFolders: withCase.workingFolders };
  const state = await openExistingVault(vault);
  const prepared = prepareApplyPreview(state, caseSave.revision.manifest.revisionId, 'branch-main');
  if (prepared.status !== 'available') throw new Error(prepared.reason);
  const selection: Record<string, PreviewChoice> = Object.fromEntries(
    prepared.context.rows.filter((r) => r.kind === 'available' || r.kind === 'conflict')
      .map((r) => [r.path, { selected: true, decision: 'use-source' as const }]),
  );
  assert.ok(Object.keys(selection).length > 0, 'the scripted apply must change something');
  const review = applicationReview(buildApplyPreview(prepared.context, selection, 'Reuse lighter collar'), selection);
  const plan = await prepareApplication(vault, review, options);
  failEvent4 = true;
  await assert.rejects(applyPreparedApplication(vault, plan, options), /lost final/);
  failEvent4 = false;
  await snapshot();

  // Step 6: recovery meets an unexpected later CAD edit, so it keeps a copy under unexpected/<recovery>/.
  await main.writeFileText(part.split('/'), 'unexpected later CAD edit');
  const op = branchApplications(await openExistingVault(vault), 'branch-main').at(-1)!;
  const recovered = await recoverApplication(vault, projectId, 'branch-main', op.operationId, options);
  assert.deepEqual(recovered.manualPaths, [part]);
  await snapshot();
  // Put the file back and recover again so the operation completes.
  await main.writeFileText(part.split('/'), 'base collar');
  await recoverApplication(vault, projectId, 'branch-main', op.operationId, options);
  await snapshot();

  // Step 6b: discard unsaved changes on Main twice in the same minute (readable copy, then its "(2)").
  for (const content of ['discarded edit 1', 'discarded edit 2']) {
    await main.writeFileText(part.split('/'), content);
    await main.writeFileText(['New folder', 'Sketch.SLDPRT'], content);
    const s = await openExistingVault(vault);
    const baseline = getBranchBaseline(s, 'branch-main')!;
    const paths = [part, 'New folder'];
    const replacePlan = buildReplacePlan(s, await scanForReplace(main, 'branch-main', baseline), baseline.revisionId, paths);
    assert.ok(replacePlan.ready, replacePlan.blockers.join(' '));
    await replaceWorkingFiles(vault, await root.getDirectory(containerPath.split('/')), {
      mode: 'discard', projectId, branchId: 'branch-main', targetRevisionId: baseline.revisionId, paths,
      expectedPlanHash: replacePlanHash(replacePlan), now: () => new Date(2026, 0, 1, 0, 0, 30), ...options,
    });
  }
  await snapshot();

  // Step 7: Knowledge Lab record.
  await createKnowledgeRecord(vault, {
    projectId, recordType: 'generic.observation', schemaVersion: 1,
    payload: { description: 'Handwritten note', attributes: {} }, relationships: [], provenance: { kind: 'user-entered' },
  });
  await snapshot();

  // Step 8: archive the design case (case lifecycle record).
  const latest = await openExistingVault(vault);
  await changeCaseLifecycle(vault, {
    projectId, branchId: caseId, activeBranchId: 'branch-main', status: 'archived',
    expectedVersion: caseLifecycle(latest, caseId).version,
  }, options);
  await snapshot();

  // Step 8b: the offline guide writes the Map and one listing per revision.
  const guide = await refreshProjectGuide(root, containerPath);
  assert.equal(guide.status, 'written', JSON.stringify(guide.failed));
  await snapshot();

  // Step 9: a design case whose creation fails part-way keeps its folder and writes the incomplete marker.
  failCaseFile = true;
  await assert.rejects(
    createManagedBranch(root, containerPath, { sourceRevisionId: firstId, name: 'Failing case', reason: 'Disk fills up' }),
  );
  failCaseFile = false;
  await snapshot();

  // Assertions.
  const isUserContent = (p: string) =>
    (/^working\/[^/]+\/.+/.test(p) && !/^working\/[^/]+\/_CADTREE_RECOVERY_INCOMPLETE\.txt$/.test(p)) ||
    (/^Discarded\/[^/]+\/.+/.test(p) && !/^Discarded\/[^/]+\/_DISCARDED cAdtree( \(2\))?\.txt$/.test(p));
  const internalFiles = [...files].filter((p) => !isUserContent(p));
  const internalDirs = [...dirs].filter((p) => !isUserContent(p));
  assert.ok(internalFiles.length > 40 && internalDirs.length > 10, 'the workflow must have written a realistic number of paths');

  const unmatched: string[] = [];
  const used = new Set<string>();
  const reserve = internalReserve();
  const tooLong: string[] = [];
  for (const [kind, list] of [['file', internalFiles], ['dir', internalDirs]] as const) {
    for (const path of list) {
      const label = matchInternalPath(path, kind);
      if (!label) unmatched.push(`${kind}: ${path}`);
      else used.add(label);
      const length = path.length + (kind === 'file' ? CRSWAP_CHARS : 0);
      if (length > reserve) tooLong.push(`${length} > ${reserve}: ${path}`);
    }
  }
  assert.deepEqual(unmatched, [], 'a path was written that no INTERNAL_PATH_TEMPLATES entry covers; add a template');
  assert.deepEqual(tooLong, [], 'a path is longer than internalReserve()');

  const unexercised = INTERNAL_PATH_TEMPLATES.filter((t) => !used.has(t.label)).map((t) => t.label);
  console.log(`path-budget: ${internalFiles.length} files, ${internalDirs.length} folders checked; unexercised templates: ${unexercised.join('; ') || 'none'}`);
  // The deepest templates must actually be reached by this workflow.
  assert.ok(dirs.has('Discarded/2026-01-01 00.00') && dirs.has('Discarded/2026-01-01 00.00 (2)'), 'two discarded copies');
  for (const label of ['discarded copy folder', 'discarded copy note', 'application unexpected-recovery copy', 'application event', 'knowledge publication marker', 'vault content object', 'design case incomplete marker', 'project offline map', 'project offline restore page', 'vault revision listing']) {
    assert.ok(used.has(label), `workflow did not exercise: ${label}`);
  }
});

test('the Discarded/ prefix stays within 30 characters, under the design-case prefix, so the reserve stays 110', () => {
  const folder = INTERNAL_PATH_TEMPLATES.find((t) => t.label === 'discarded copy folder')!;
  assert.equal(folder.segments.join('/'), `Discarded/2026-01-01 00.00 (${DISCARDED_MAX_COUNTER})`);
  assert.ok(folder.relativeLength <= 30, `${folder.relativeLength}`);
  // "Discarded/<name>/" before a user path is shorter than "working/<case allowance>/" (41).
  assert.ok(folder.relativeLength + 1 < 'working/'.length + CASE_ALLOWANCE + 1);
  assert.ok(shapePattern(folder.shape).test('Discarded/2026-11-19 14.05'));
  assert.ok(shapePattern(folder.shape).test('Discarded/2026-11-19 14.05 (2)'));
  assert.ok(!shapePattern(folder.shape).test('Discarded/2026-11-19 14.05 (10)'));
  assert.equal(internalReserve(), 110);
});

test('internalReserve equals the deepest template and today\'s value is reported', () => {
  const deepest = deepestInternalTemplate();
  assert.equal(internalReserve(), deepest.reserveLength);
  assert.equal(internalReserveLabel(), deepest.label);
  for (const t of INTERNAL_PATH_TEMPLATES) assert.ok(t.reserveLength <= internalReserve(), t.label);
  assert.equal(deepest.label, 'application unexpected-recovery copy');
  assert.ok(INTERNAL_PATH_TEMPLATES.every((t) => !/legacy/i.test(t.label)));
  console.log(`path-budget: internalReserve() = ${internalReserve()} (${internalReserveLabel()})`);
});

test('staging session folder is 22 chars, deterministic and collision-free over many session IDs', async () => {
  const { getStagingSessionPathSegments, getStagingObjectPathSegments } = await import('./object-store');
  const a = getStagingSessionPathSegments('session-x');
  assert.equal(a[0], 'staging');
  assert.equal(a[1]!.length, 22);
  assert.match(a[1]!, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(getStagingSessionPathSegments('session-x'), a);
  const seen = new Set<string>();
  for (let i = 0; i < 20000; i++) seen.add(getStagingSessionPathSegments(`session-20260101-000000-${i.toString(16)}`)[1]!);
  assert.equal(seen.size, 20000);
  const sha = 'a'.repeat(64);
  assert.equal(getStagingObjectPathSegments('session-x', sha)[2]!.length, 43 + 4);
  const staged = INTERNAL_PATH_TEMPLATES.find((t) => t.label === 'vault staged object')!;
  assert.equal(staged.reserveLength, 91);
  const marker = INTERNAL_PATH_TEMPLATES.find((t) => t.label === 'knowledge publication marker')!;
  assert.equal(marker.relativeLength, 97);
  assert.equal(marker.reserveLength, 97);
});
