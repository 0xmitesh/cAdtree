import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { InMemoryFileSystemAdapter } from './fs-adapter';
import { captureRevision } from './revision-service';
import { createProject, createWorkspace, type ManagedProject } from './workspace-service';
import { createReferenceReview } from './references';
import { scanBranchChanges } from './scanner';
import { refreshProjectGuide } from './offline-guide';
import {
  NAME_CAP, OCCURRENCE_CAP, restorePageCsp, restorePageScriptHash, buildRestoreData, buildRestorePage, escapeJsonForScript, restorePageWithoutGenerated,
  type RestoreData,
} from './offline-restore-page';
import { RESTORE_PAGE_SCRIPT } from './offline-restore-page-script';
import { restorePagePath } from './offline-guide-paths';
import type { VaultState } from './types';
import { hashBytes } from './hash';

const RESTORE = '_RESTORE cAdtree.html';
const noNotes = { problem: '', modification: '', observations: '' };
const bytes = (text: string) => new Uint8Array(new TextEncoder().encode(text));
const sha = (n: number) => n.toString(16).padStart(64, '0');
const DATA_BLOCK = /<script type="application\/json" id="cadtree-restore-data">([\s\S]*?)<\/script>/;

/** The embedded data block of a page, parsed back out of the HTML. */
function embeddedData(html: string): RestoreData {
  const match = DATA_BLOCK.exec(html);
  assert.ok(match, 'the page has a data block');
  return JSON.parse(match[1]!) as RestoreData;
}

interface FakeFile { path: string; sha256: string; size?: number }
interface FakeRevision { id: string; number: number; branchId?: string; completedAt?: string; files: FakeFile[]; corrupted?: boolean }

/** A VaultState with only what buildRestoreData reads. */
function fakeState(revisions: FakeRevision[], branches = [{ branchId: 'branch-main', name: 'Main' }]): VaultState {
  return {
    project: { projectId: 'proj-fake' },
    branches,
    references: undefined,
    revisions: revisions.map((revision) => ({
      integrityStatus: revision.corrupted ? 'corrupted' : 'verified',
      manifest: {
        revisionId: revision.id,
        displayNumber: revision.number,
        branchId: revision.branchId ?? 'branch-main',
        captureCompletedAt: revision.completedAt ?? `2026-11-16T09:${String(revision.number).padStart(2, '0')}:00.000Z`,
        files: revision.files.map((file) => ({ path: file.path, sha256: file.sha256, size: file.size ?? 10, lastModified: 0 })),
        directories: [],
      },
    })),
  } as unknown as VaultState;
}

interface Fixture { root: InMemoryFileSystemAdapter; containerPath: string; project: ManagedProject; writes: string[] }

async function fixture(): Promise<Fixture & { ids: string[] }> {
  const root = new InMemoryFileSystemAdapter('Workspace');
  const writes: string[] = [];
  root.setHooks({ onBeforeWrite: (full) => { writes.push(full); } });
  await createWorkspace(root);
  const project = await createProject(root, 'Packaging Gripper');
  const vault = project.vaultDir;
  const main = project.workingFolders['branch-main']!;
  await main.writeFileBytes(['Parts', 'Collar.SLDPRT'], bytes('base collar'));
  await main.writeFileBytes(['Parts', 'Collar copy.SLDPRT'], bytes('base collar'));
  await main.writeFileBytes(['Assembly.SLDASM'], bytes('assembly'));
  await main.getDirectory(['Empty folder'], { create: true });
  const first = await captureRevision(main, vault, { branchId: 'branch-main', summary: 'Base', notes: noNotes, workingFolders: project.workingFolders });
  await main.writeFileBytes(['Parts', 'Collar.SLDPRT'], bytes('collar v2'));
  const scan = await scanBranchChanges(main, 'branch-main', first.revision.manifest);
  const second = await captureRevision(main, vault, {
    branchId: 'branch-main',
    summary: 'Lighter collar',
    notes: noNotes,
    workingFolders: project.workingFolders,
    reviewedChangesSignature: scan.changesSignature,
    referenceReview: createReferenceReview(first.vaultState, scan),
    referenceAuthor: { id: 'a', displayName: 'Asha' },
    referenceAttachments: [{ source: new File([new Uint8Array([1, 2, 3])], 'Load requirement.pdf'), explanation: 'Max load 40 N' }],
  });
  return { root, containerPath: project.record.containerPath, project, writes, ids: [first.revision.manifest.revisionId, second.revision.manifest.revisionId] };
}

const readPage = async (f: Fixture) => (await f.root.getDirectory(f.containerPath.split('/'))).readFileText(restorePagePath());

test('data table: files and references keyed by checksum, with names, places, de-duplication and order', async () => {
  const f = await fixture();
  const state = (await refreshAndState(f)).state;
  const data = buildRestoreData({ generatedAt: '2026-11-16T10:00:00.000Z', projectName: 'Packaging Gripper', state });
  assert.equal(data.projectName, 'Packaging Gripper');
  assert.equal(data.projectId, state.project.projectId);
  assert.equal(data.generatedAt, '2026-11-16T10:00:00.000Z');
  assert.deepEqual(Object.keys(data.files), [...Object.keys(data.files)].sort(), 'keys are sorted, so the page is deterministic');

  const baseCollar = data.files[sha256Of('base collar')]!;
  assert.ok(baseCollar, 'the bytes of the first collar are listed');
  assert.equal(baseCollar.size, 'base collar'.length);
  assert.deepEqual(baseCollar.names, ['Collar copy.SLDPRT', 'Collar.SLDPRT'], 'the same bytes under two names');
  assert.deepEqual(baseCollar.occurrences.map((o) => [o.kind, o.path, o.revisionNumber, o.branchName]), [
    ['file', 'Parts/Collar copy.SLDPRT', 1, 'Main'],
    ['file', 'Parts/Collar.SLDPRT', 1, 'Main'],
  ]);
  assert.equal(baseCollar.more, 0);

  // Unchanged across both revisions: one place, at its first revision.
  const assembly = data.files[sha256Of('assembly')]!;
  assert.deepEqual(assembly.occurrences.map((o) => [o.path, o.revisionNumber, o.revisionId]), [['Assembly.SLDASM', 1, f.ids[0]]]);
  // Changed in the second revision: its own entry.
  assert.deepEqual(data.files[sha256Of('collar v2')]!.occurrences.map((o) => [o.path, o.revisionNumber]), [['Parts/Collar.SLDPRT', 2]]);
  // A reference version.
  const reference = Object.values(data.files).find((entry) => entry.occurrences.some((o) => o.kind === 'reference'))!;
  assert.ok(reference, 'the reference version is listed');
  assert.equal(reference.size, 3);
  assert.deepEqual(reference.names, ['Load requirement.pdf']);
  assert.equal(reference.occurrences[0]!.version, 1);
  assert.equal(reference.occurrences[0]!.path, undefined);
  assert.ok(reference.occurrences[0]!.title);
});

function sha256Of(text: string): string {
  return hashBytes(bytes(text));
}

async function refreshAndState(f: Fixture) {
  const result = await refreshProjectGuide(f.root, f.containerPath);
  assert.equal(result.status, 'written', JSON.stringify(result.failed));
  const { openWorkspace } = await import('./workspace-service');
  const project = (await openWorkspace(f.root)).projects[0]!.project!;
  return { state: project.vaultState, result };
}

test('data table: occurrences are capped (oldest first, with a count of the rest), names are sorted, corrupted versions are left out', () => {
  const shared = sha(7);
  const revisions: FakeRevision[] = [];
  for (let n = 1; n <= 30; n++) revisions.push({ id: `rev-${String(n).padStart(2, '0')}`, number: n, files: [{ path: `Folder ${String(n).padStart(2, '0')}/part ${n % 2 ? 'b' : 'a'}.bin`, sha256: shared }] });
  revisions.push({ id: 'rev-bad', number: 31, corrupted: true, files: [{ path: 'Damaged/only.bin', sha256: sha(8) }] });
  const data = buildRestoreData({ generatedAt: 'x', projectName: 'P', state: fakeState(revisions) });
  assert.deepEqual(Object.keys(data.files), [shared], 'a corrupted version contributes nothing');
  const entry = data.files[shared]!;
  assert.equal(entry.occurrences.length, OCCURRENCE_CAP);
  assert.equal(entry.more, 30 - OCCURRENCE_CAP);
  assert.deepEqual(entry.occurrences.map((o) => o.revisionNumber), Array.from({ length: OCCURRENCE_CAP }, (_, i) => i + 1));
  assert.deepEqual(entry.names, ['part a.bin', 'part b.bin']);
  assert.ok(NAME_CAP >= 2);
});

test('data table: the same path on another case is another place, and an unknown case is named as such', () => {
  const shared = sha(1);
  const state = fakeState(
    [
      { id: 'r1', number: 1, files: [{ path: 'A/x.bin', sha256: shared }] },
      { id: 'r2', number: 2, branchId: 'case-1', files: [{ path: 'A/x.bin', sha256: shared }] },
      { id: 'r3', number: 3, branchId: 'ghost', files: [{ path: 'A/x.bin', sha256: shared }] },
    ],
    [{ branchId: 'branch-main', name: 'Main' }, { branchId: 'case-1', name: 'Lighter collar' }],
  );
  const entry = buildRestoreData({ generatedAt: 'x', projectName: 'P', state }).files[shared]!;
  assert.deepEqual(entry.occurrences.map((o) => [o.revisionNumber, o.branchName]), [[1, 'Main'], [2, 'Lighter collar'], [3, 'Unknown case']]);
});

test('escaping: no name or title can break out of the data block, and the data reads back exactly', () => {
  const evil = '</script><script>alert(1)</script>.txt';
  const state = fakeState([
    { id: 'r1', number: 1, files: [{ path: `Dir <!-- & "q"/${evil}`, sha256: sha(1) }, { path: '<img src=x onerror=alert(1)>.txt', sha256: sha(3) }, { path: 'line\u2028sep\u2029.txt', sha256: sha(2) }] },
  ]);
  const input = { generatedAt: '2026-11-16T10:00:00.000Z', projectName: '<!-- Gripper --> & "co" </title><b>', state };
  const html = buildRestorePage(input);
  const expected = JSON.parse(JSON.stringify(buildRestoreData(input))) as RestoreData;
  assert.deepEqual(embeddedData(html), expected);
  // (A file name can't hold a "/", so the evil text is split into path segments; the path field keeps it verbatim.)
  assert.equal(expected.files[sha(1)]!.occurrences[0]!.path, `Dir <!-- & "q"/${evil}`);
  assert.equal(expected.files[sha(3)]!.names[0], '<img src=x onerror=alert(1)>.txt');
  // The data block holds no markup characters at all.
  const block = DATA_BLOCK.exec(html)![1]!;
  assert.ok(!/[<>&\u2028\u2029]/.test(block));
  // Exactly two script elements close (the data block and the code), and no comment opener or injected element survives.
  assert.equal(html.split('</script>').length - 1, 2);
  assert.ok(!html.includes('<!--'), 'no comment opener anywhere');
  assert.ok(!html.includes('<script>alert'), 'the injected script is not in the page');
  const title = /<title>([^<]*)<\/title>/.exec(html)![1]!;
  assert.equal(title, 'Your files without cAdtree: &lt;!-- Gripper --&gt; &amp; &quot;co&quot; &lt;/title&gt;&lt;b&gt;');
  assert.equal(escapeJsonForScript('{"a":"<>&\u2028"}'), '{"a":"\\u003c\\u003e\\u0026\\u2028"}');
});

test('the page is self-contained: a strict CSP, no network references, no eval or HTML injection in its script', () => {
  const html = buildRestorePage({ generatedAt: 'x', projectName: 'P', state: fakeState([{ id: 'r1', number: 1, files: [{ path: 'a.bin', sha256: sha(1) }] }]) });
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${restorePageCsp()}">`));
  // The inline script is allowed by its hash only; the hash is of exactly the text between the script tags.
  const inline = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  assert.equal(inline, RESTORE_PAGE_SCRIPT);
  const expectedHash = `sha256-${createHash('sha256').update(inline, 'utf8').digest('base64')}`;
  assert.equal(restorePageScriptHash(), expectedHash);
  assert.equal(
    restorePageCsp(),
    `default-src 'none'; script-src '${expectedHash}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`,
  );
  assert.ok(!/script-src[^;]*unsafe-inline/.test(restorePageCsp()));
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'), 'the policy comes before any script');
  assert.ok(!/https?:\/\//i.test(html), 'no http(s) URL anywhere');
  assert.ok(!/\b(src|href)=/i.test(html), 'no src or href attribute (the download link is made by the script from a blob URL)');
  assert.ok(!/@import|url\(/i.test(/<style>([\s\S]*?)<\/style>/.exec(html)![1]!), 'no CSS that loads anything');
  for (const banned of ['eval(', 'new Function', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'fetch(', 'XMLHttpRequest', 'importScripts', 'WebSocket']) {
    assert.ok(!RESTORE_PAGE_SCRIPT.includes(banned), `the script must not use ${banned}`);
  }
  assert.ok(!RESTORE_PAGE_SCRIPT.includes('`') && !RESTORE_PAGE_SCRIPT.includes('${'), 'the script is a raw template: no backticks or ${');
  // The script parses (it is run for real in tests/browser/restore-page.spec.ts).
  assert.doesNotThrow(() => new Function(RESTORE_PAGE_SCRIPT));
  // The three things Mode 2 never does to the vault.
  assert.ok(!/vault\.(getDirectoryHandle|getFileHandle)\([^)]*create/.test(RESTORE_PAGE_SCRIPT));
  assert.ok(!/vault\.removeEntry|vault\.createWritable/.test(RESTORE_PAGE_SCRIPT));
  assert.ok(!/mode: 'readwrite'[^;]*vault|vault[^;]*mode: 'readwrite'/.test(RESTORE_PAGE_SCRIPT));
});

test('the page is deterministic, and only its generated time changes with the clock', () => {
  const state = fakeState([{ id: 'r1', number: 1, files: [{ path: 'a.bin', sha256: sha(1) }] }]);
  const a = buildRestorePage({ generatedAt: '2026-11-16T10:00:00.000Z', projectName: 'P', state });
  assert.equal(a, buildRestorePage({ generatedAt: '2026-11-16T10:00:00.000Z', projectName: 'P', state }));
  const b = buildRestorePage({ generatedAt: '2026-11-17T08:00:00.000Z', projectName: 'P', state });
  assert.notEqual(a, b);
  assert.equal(restorePageWithoutGenerated(a), restorePageWithoutGenerated(b));
  const c = buildRestorePage({ generatedAt: '2026-11-16T10:00:00.000Z', projectName: 'Other', state });
  assert.notEqual(restorePageWithoutGenerated(a), restorePageWithoutGenerated(c));
  // A name that imitates the time field can't hide a change: the first match is the real one.
  const sneaky = fakeState([{ id: 'r1', number: 1, files: [{ path: 'x"generatedAt":"y.bin', sha256: sha(1) }] }]);
  const s1 = buildRestorePage({ generatedAt: 't1', projectName: 'P', state: sneaky });
  const s2 = buildRestorePage({ generatedAt: 't2', projectName: 'P', state: sneaky });
  assert.equal(restorePageWithoutGenerated(s1), restorePageWithoutGenerated(s2));
  assert.ok(embeddedData(s1).files[sha(1)]!.names[0]!.includes('generatedAt'));
});

test('refresh writes the page next to the Map, leaves an unchanged page alone and restores a deleted or edited one', async () => {
  const f = await fixture();
  f.writes.length = 0;
  const first = await refreshProjectGuide(f.root, f.containerPath, { now: () => new Date('2026-11-16T10:00:00.000Z') });
  assert.equal(first.status, 'written');
  assert.ok(first.written.includes(RESTORE));
  const html = await readPage(f);
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.equal(embeddedData(html).projectName, 'Packaging Gripper');
  assert.equal(embeddedData(html).generatedAt, '2026-11-16T10:00:00.000Z');
  assert.equal(f.writes.filter((w) => w.endsWith(RESTORE)).length, 1);
  assert.ok(f.writes.find((w) => w.endsWith(RESTORE))!.endsWith(`${f.containerPath}/${RESTORE}`), 'directly in the project folder');

  f.writes.length = 0;
  const second = await refreshProjectGuide(f.root, f.containerPath, { now: () => new Date('2026-11-17T10:00:00.000Z') });
  assert.ok(!second.written.includes(RESTORE));
  assert.deepEqual(f.writes.filter((w) => w.endsWith(RESTORE)), [], 'a new time alone does not rewrite the page');
  assert.equal(await readPage(f), html);

  const container = await f.root.getDirectory(f.containerPath.split('/'));
  await container.writeFileText(restorePagePath(), 'edited by hand');
  const third = await refreshProjectGuide(f.root, f.containerPath, { now: () => new Date('2026-11-16T10:00:00.000Z') });
  assert.ok(third.written.includes(RESTORE));
  assert.equal(await readPage(f), html);
  await container.removeEntry(restorePagePath());
  const fourth = await refreshProjectGuide(f.root, f.containerPath, { now: () => new Date('2026-11-16T10:00:00.000Z') });
  assert.ok(fourth.written.includes(RESTORE));
  assert.equal(await readPage(f), html);
});

test('a new saved file changes the page', async () => {
  const f = await fixture();
  await refreshProjectGuide(f.root, f.containerPath);
  const before = await readPage(f);
  const main = f.project.workingFolders['branch-main']!;
  await main.writeFileBytes(['Parts', 'Pin.SLDPRT'], bytes('pin'));
  const { openExistingVault } = await import('./vault-service');
  const state = await openExistingVault(f.project.vaultDir);
  const head = state.revisions.find((r) => r.manifest.displayNumber === 2)!;
  const scan = await scanBranchChanges(main, 'branch-main', head.manifest);
  await captureRevision(main, f.project.vaultDir, {
    branchId: 'branch-main', summary: 'Pin', notes: noNotes, workingFolders: f.project.workingFolders,
    reviewedChangesSignature: scan.changesSignature, referenceReview: createReferenceReview(state, scan),
  });
  const result = await refreshProjectGuide(f.root, f.containerPath);
  assert.ok(result.written.includes(RESTORE));
  const after = await readPage(f);
  assert.notEqual(after, before);
  assert.ok(embeddedData(after).files[sha256Of('pin')]);
});

test('a failing page write yields partial, never throws, and the Map and listings are still written', async () => {
  const f = await fixture();
  f.root.setHooks({ onBeforeWrite: (full) => { if (full.endsWith(RESTORE)) throw new Error('disk full'); } });
  const realWarn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = await refreshProjectGuide(f.root, f.containerPath);
  } finally {
    console.warn = realWarn;
  }
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.failed.map((item) => item.path), [RESTORE]);
  assert.match(result.failed[0]!.error, /disk full/);
  assert.equal(result.written.length, 3, 'the Map and both listings');
  const container = await f.root.getDirectory(f.containerPath.split('/'));
  assert.equal(await container.hasFile(restorePagePath()), false);
  assert.equal(await container.hasFile(['_MAP cAdtree.txt']), true);
});

test('a skipped project gets no restore page', async () => {
  const f = await fixture();
  const container = await f.root.getDirectory(f.containerPath.split('/'));
  await container.removeEntry(['.cadtree', 'ready.json']);
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await refreshProjectGuide(f.root, f.containerPath);
    assert.equal(result.status, 'skipped');
  } finally {
    console.warn = realWarn;
  }
  assert.equal(await container.hasFile(restorePagePath()), false);
  assert.deepEqual(f.writes.filter((w) => w.endsWith(RESTORE)), []);
});
