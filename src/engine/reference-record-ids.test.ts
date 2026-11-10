import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryFileSystemAdapter, type FileSystemDirectoryAdapter } from './fs-adapter';
import { initializeProjectVault, openExistingVault } from './vault-service';
import { captureRevision } from './revision-service';
import { scanBranchChanges } from './scanner';
import { getBranchBaseline } from './branch-state';
import { isRecordId, newRecordId } from './ids';
import { compactHex } from './path-encoding';
import { hashString } from './hash';
import { writeAndVerifyObject } from './object-store';
import { matchInternalPath, newRecordsReserve, CRSWAP_CHARS } from './path-budget';
import {
  importReferenceAttachment, retrieveReferenceAttachment, verifyReferenceLibraryContent, createReferenceReview, referenceChecksum,
  referenceEnrollmentRecordPath,  referenceCatalogPath, referenceCatalogMarkerPath,
  MAX_REFERENCE_ID_ATTEMPTS, type ProjectReference,
} from './references';
import { buildReferenceBrowser } from '../history/reference-browser';
import { buildKnowledgeIndex } from '../knowledge';
import { createKnowledgeRecord, readKnowledgeRecord } from '../knowledge/records';

const main = 'branch-main', notes = { problem: '', modification: '', observations: '' };
const file = (name: string, text: string) => new File([text], name, { type: 'text/plain' });
const meta = (title: string) => ({ title, description: '', tags: [] });
const RECORD = /^\d{8}-\d{6}-[0-9a-z]{6}$/;
const uuidN = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function fixture() {
  const working = new InMemoryFileSystemAdapter('Main'), vault = new InMemoryFileSystemAdapter('Vault');
  const state = await initializeProjectVault(working, vault, 'Reference IDs');
  return { working, vault, state, projectId: state.project.projectId };
}
const names = async (vault: FileSystemDirectoryAdapter, path: string[]) => (await (await vault.getDirectory(path)).listEntries()).map(e => e.name).sort();
const files = async (vault: FileSystemDirectoryAdapter) => {
  const out: Record<string, string> = {};
  const walk = async (path: string[]) => { for (const e of await (await vault.getDirectory(path)).listEntries()) { const next = [...path, e.name]; if (e.kind === 'directory') await walk(next); else out[next.join('/')] = await vault.readFileText(next); } };
  await walk(['references']);
  return out;
};

/** Builds exactly what pre-P3c code wrote: prefixed UUID IDs, compact marker for catalog 1, full-hex marker for catalog 2. */
async function legacyVault() {
  const f = await fixture();
  const seal = <T extends object>(v: T) => ({ ...v, payloadSha256: referenceChecksum(v) });
  const boundary = seal({ schemaVersion: 1, projectId: f.projectId, createdAt: '2025-01-01T00:00:00.000Z', legacy: [] as { revisionId: string; manifestSha256: string }[] });
  const put = async (path: string[], value: object) => { const text = JSON.stringify(value, null, 2); await f.vault.writeFileText(path, text, { exclusive: true }); return hashString(text); };
  const enrollId = `reference-enrollment-${uuidN(1)}`;
  const enrollSha = await put(referenceEnrollmentRecordPath(enrollId), boundary);
  await f.vault.getDirectory(['references', 'enrollment', `${enrollId}.${enrollSha}.done`], { create: true, exclusiveCreate: true }); // full-hex legacy enrollment marker
  const store = async (name: string, text: string) => {
    const bytes = new TextEncoder().encode(text), sha = hashString(text);
    await writeAndVerifyObject(f.vault, 'legacy-session', sha, bytes.length, async () => new Blob([bytes]).stream());
    return { sha256: sha, size: bytes.length, name };
  };
  const a = await store('A.txt', 'legacy A'), b = await store('B.txt', 'legacy B'), a2 = await store('A2.txt', 'legacy A v2');
  const ver = (referenceId: string, n: number, o: { sha256: string; size: number; name: string }, at: string) => ({ referenceId, versionId: `reference-version-${uuidN(n)}`, originalFilename: o.name, fileType: 'text/plain', size: o.size, sha256: o.sha256, importedAt: at });
  const refA = `reference-${uuidN(10)}`, refB = `reference-${uuidN(11)}`;
  const lib1: ProjectReference[] = [
    { referenceId: refA, title: 'Legacy A', description: '', tags: [], versions: [ver(refA, 20, a, '2025-01-02T00:00:00.000Z')], projectVersionId: null, removed: false },
    { referenceId: refB, title: 'Legacy B', description: '', tags: [], versions: [ver(refB, 21, b, '2025-01-03T00:00:00.000Z')], projectVersionId: null, removed: false },
  ];
  const cat1Id = `reference-catalog-${uuidN(30)}`;
  const cat1 = seal({ schemaVersion: 1, projectId: f.projectId, catalogId: cat1Id, parent: null, references: lib1 });
  const cat1Sha = await put(referenceCatalogPath(cat1Id), cat1);
  await f.vault.getDirectory(referenceCatalogMarkerPath(cat1Id, cat1Sha), { create: true, exclusiveCreate: true }); // compact legacy marker
  const lib2 = structuredClone(lib1); lib2[0].versions.push(ver(refA, 22, a2, '2025-01-04T00:00:00.000Z'));
  const cat2Id = `reference-catalog-${uuidN(31)}`;
  const cat2 = seal({ schemaVersion: 1, projectId: f.projectId, catalogId: cat2Id, parent: { catalogId: cat1Id, sha256: cat1Sha }, references: lib2 });
  const cat2Sha = await put(referenceCatalogPath(cat2Id), cat2);
  await f.vault.getDirectory(['references', 'completed', `${cat2Id}.${cat2Sha}.done`], { create: true, exclusiveCreate: true }); // full-hex legacy marker
  return { ...f, refA, refB, cat1Id, cat2Id, order: lib2.map(r => r.referenceId) };
}

test('a new reference and a new version use record IDs and new-format markers; every consumer works', async () => {
  const f = await fixture();
  let state = await importReferenceAttachment(f.vault, f.projectId, file('Spec.txt', 'spec v1'), meta('Spec'));
  state = await importReferenceAttachment(f.vault, f.projectId, file('Spec2.txt', 'spec v2'), meta('Spec'), state.references!.library[0].referenceId);
  const ref = state.references!.library[0];
  assert.ok(isRecordId(ref.referenceId) && ref.versions.length === 2 && ref.versions.every(v => isRecordId(v.versionId) && v.referenceId === ref.referenceId));
  assert.equal(new Set([ref.referenceId, ...ref.versions.map(v => v.versionId)]).size, 3);
  assert.equal(state.references!.status, 'available');
  assert.ok(isRecordId(state.references!.catalogId));
  const [enroll] = await names(f.vault, ['references', 'enrollment']);
  assert.equal((await names(f.vault, ['references', 'enrollment'])).length, 2);
  const enrollNames = await names(f.vault, ['references', 'enrollment']);
  const marker = enrollNames.find(n => n.endsWith('.done'))!;
  assert.match(marker, /^\d{8}-\d{6}-[0-9a-z]{6}\.[A-Za-z0-9_-]{43}\.done$/);
  assert.equal(marker.length, 71);
  assert.ok(enroll);
  const catalogs = await names(f.vault, ['references', 'catalogs']), completed = await names(f.vault, ['references', 'completed']);
  assert.equal(catalogs.length, 2); assert.equal(completed.length, 2);
  assert.ok(catalogs.every(n => RECORD.test(n.replace(/\.json$/, ''))));
  assert.ok(completed.every(n => /^\d{8}-\d{6}-[0-9a-z]{6}\.[A-Za-z0-9_-]{43}\.done$/.test(n)));
  // Nothing in the references tree carries the old prefixes.
  assert.ok(!Object.keys(await files(f.vault)).concat(Object.values(await files(f.vault))).some(s => /reference-(enrollment|catalog|version)-/.test(s)));

  await verifyReferenceLibraryContent(f.vault, state);
  const got = await retrieveReferenceAttachment(f.vault, f.projectId, ref.referenceId, ref.versions[1].versionId);
  assert.equal(new TextDecoder().decode(got.bytes as Uint8Array), 'spec v2');

  // Attach to a revision (pending component), then browse and cite.
  await f.working.writeFileText(['Part.SLDPRT'], 'geometry');
  const scan = await scanBranchChanges(f.working, main, getBranchBaseline(state, main));
  const saved = await captureRevision(f.working, f.vault, { branchId: main, summary: 'Base', notes, reviewedChangesSignature: scan.changesSignature,
    referenceReview: createReferenceReview(state, scan, [{ referenceId: ref.referenceId, versionId: ref.versions[1].versionId, locator: 'p1', explanation: 'why', component: { kind: 'pending', path: 'Part.SLDPRT' } }]) });
  const revisionId = saved.revision.manifest.revisionId;
  const reopened = await openExistingVault(f.vault);
  assert.equal(reopened.references!.contexts[revisionId].status, 'available');
  assert.deepEqual(reopened.references!.contexts[revisionId].record!.links.filter(l => l.origin === 'revision').map(l => l.referenceId), [ref.referenceId]);
  const browser = buildReferenceBrowser(reopened);
  assert.equal(browser.entries.length, 2);
  assert.equal(browser.entries.find(e => e.version.versionId === ref.versions[1].versionId)!.uses.length, 1);
  const association = buildKnowledgeIndex(reopened).revisions[0].referenceContext.attachments[0];
  assert.equal(association.referenceId, ref.referenceId);
  const record = await createKnowledgeRecord(f.vault, { projectId: f.projectId, recordType: 'generic.observation', schemaVersion: 1,
    payload: { description: 'cites a new-format reference', attributes: {} }, provenance: { kind: 'user-entered' },
    relationships: [{ relation: 'evidence', target: { kind: 'reference-version', projectId: f.projectId, revisionId, referenceId: association.referenceId, versionId: association.versionId, associationPointer: association.source.jsonPointer } }] });
  const readBack = await readKnowledgeRecord(f.vault, f.projectId, record.record.recordId);
  assert.ok(readBack);
  const relationship = readBack!.record.relationships[0];
  assert.equal(relationship.target.kind, 'reference-version');
  if (relationship.target.kind === 'reference-version') assert.equal(relationship.target.referenceId, ref.referenceId);
});

test('a vault with OLD references (compact and full-hex markers) loads unchanged; new and new-version imports append in order', async () => {
  const f = await legacyVault();
  const before = await openExistingVault(f.vault);
  assert.equal(before.references!.status, 'available', before.references!.reason);
  assert.deepEqual(before.references!.library.map(r => r.referenceId), f.order);
  assert.equal(before.references!.catalogId, f.cat2Id);
  await verifyReferenceLibraryContent(f.vault, before);
  const oldBrowser = buildReferenceBrowser(before).entries.map(e => e.version.versionId);
  assert.equal(oldBrowser.length, 3);
  const snapshot = await files(f.vault);

  // New version of an OLD reference.
  let state = await importReferenceAttachment(f.vault, f.projectId, file('A3.txt', 'legacy A v3'), meta('Legacy A'), f.refA);
  const refA = state.references!.library[0];
  assert.equal(refA.referenceId, f.refA);
  assert.equal(refA.versions.length, 3);
  assert.match(refA.versions[0].versionId, /^reference-version-/);
  assert.ok(isRecordId(refA.versions[2].versionId));
  // A brand-new reference is appended.
  state = await importReferenceAttachment(f.vault, f.projectId, file('N.txt', 'new one'), meta('New one'));
  assert.deepEqual(state.references!.library.map(r => r.referenceId).slice(0, 2), f.order);
  assert.ok(isRecordId(state.references!.library[2].referenceId));
  assert.equal(state.references!.status, 'available');
  assert.ok(isRecordId(state.references!.catalogId));
  await verifyReferenceLibraryContent(f.vault, state);
  // Browser order of the old entries is unchanged by adding new-format entries.
  const after = buildReferenceBrowser(state).entries.map(e => e.version.versionId);
  assert.deepEqual(after.filter(id => oldBrowser.includes(id)), oldBrowser.slice().sort((x, y) => after.indexOf(x) - after.indexOf(y)));
  // Old files are untouched; the old chain is still readable from the new head.
  const now = await files(f.vault);
  for (const [path, text] of Object.entries(snapshot)) assert.equal(now[path], text, path);
  assert.ok((await names(f.vault, ['references', 'completed'])).some(n => n.startsWith(`${f.cat2Id}.`) && n.length > 71));
  // Reopening from scratch gives the same library.
  assert.deepEqual((await openExistingVault(f.vault)).references!.library, state.references!.library);
});

test('legacy compact UUID markers can never be mistaken for record IDs (v4 byte 6 property), and new markers round-trip', () => {
  for (let i = 0; i < 50000; i++) {
    const compact = compactHex(crypto.randomUUID().replace(/-/g, ''));
    assert.equal(compact.length, 22);
    assert.ok(!RECORD.test(compact), compact);
    assert.ok('QRST'.includes(compact[8]), compact);
  }
  const sha = hashString('x');
  for (let i = 0; i < 200; i++) {
    const id = newRecordId();
    const marker = referenceCatalogMarkerPath(id, sha).at(-1)!;
    assert.equal(marker, `${id}.${compactHex(sha)}.done`);
    assert.equal(marker.length, 71);
  }
});

test('a clashing catalog ID draws a new ID and never touches the existing reference; exhaustion writes nothing new', async () => {
  const f = await fixture();
  const first = await importReferenceAttachment(f.vault, f.projectId, file('One.txt', 'one'), meta('One'));
  const takenCatalog = first.references!.catalogId!;
  const snapshot = await files(f.vault);
  const queue = [takenCatalog, takenCatalog];
  const state = await importReferenceAttachment(f.vault, f.projectId, file('Two.txt', 'two'), meta('Two'), undefined, { newRecordId: () => queue.shift() ?? newRecordId() });
  assert.equal(queue.length, 0);
  assert.equal(state.references!.library.length, 2);
  assert.notEqual(state.references!.catalogId, takenCatalog);
  const now = await files(f.vault);
  for (const [path, text] of Object.entries(snapshot)) assert.equal(now[path], text, path);
  assert.equal(state.references!.status, 'available');

  const before = await files(f.vault);
  await assert.rejects(importReferenceAttachment(f.vault, f.projectId, file('Three.txt', 'three'), meta('Three'), undefined, { newRecordId: () => takenCatalog }), new RegExp(`${MAX_REFERENCE_ID_ATTEMPTS} attempts`));
  assert.deepEqual(await files(f.vault), before);
  assert.equal((await openExistingVault(f.vault)).references!.library.length, 2);
});

test('a clashing enrollment ID (leftover attempt) draws a new ID and leaves the leftover alone', async () => {
  const f = await fixture();
  const leftover = newRecordId();
  await f.vault.writeFileText(['references', 'enrollment', `${leftover}.json`], '{"interrupted":');
  const queue = [leftover];
  const state = await importReferenceAttachment(f.vault, f.projectId, file('One.txt', 'one'), meta('One'), undefined, { newRecordId: () => queue.shift() ?? newRecordId() });
  assert.equal(state.references!.status, 'available');
  assert.equal(await f.vault.readFileText(['references', 'enrollment', `${leftover}.json`]), '{"interrupted":');
  assert.equal(state.references!.library.length, 1);
});

test('new-code reference paths fit newRecordsReserve() and hit no legacy template', async () => {
  const f = await fixture();
  await importReferenceAttachment(f.vault, f.projectId, file('One.txt', 'one'), meta('One'));
  const reserve = newRecordsReserve();
  const checked: string[] = [];
  const walk = async (path: string[]) => {
    for (const e of await (await f.vault.getDirectory(path)).listEntries()) {
      const next = [...path, e.name], rel = `vault/${next.join('/')}`;
      if (e.kind === 'directory' && !e.name.endsWith('.done')) { await walk(next); continue; }
      const kind = e.kind === 'directory' ? 'dir' : 'file';
      const label = matchInternalPath(rel, kind);
      assert.ok(label && !label.includes('legacy'), `${rel} -> ${label}`);
      assert.ok(rel.length + (kind === 'file' ? CRSWAP_CHARS : 0) <= reserve, rel);
      checked.push(rel);
    }
  };
  await walk(['references']);
  assert.equal(checked.length, 4); // enrollment record + marker, catalog record + marker
});

test('a record ID with a full-hex checksum marker never existed and is rejected as unexpected', async () => {
  const f = await fixture();
  await importReferenceAttachment(f.vault, f.projectId, file('One.txt', 'one'), meta('One'));
  await f.vault.getDirectory(['references', 'completed', `${newRecordId()}.${hashString('y')}.done`], { create: true, exclusiveCreate: true });
  const state = await openExistingVault(f.vault);
  assert.notEqual(state.references!.status, 'available');
  assert.match(state.references!.reason!, /Unexpected reference publication directory/);
});
