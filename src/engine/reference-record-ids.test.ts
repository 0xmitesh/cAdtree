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
import { matchInternalPath, internalReserve, CRSWAP_CHARS } from './path-budget';
import {
  importReferenceAttachment, retrieveReferenceAttachment, verifyReferenceLibraryContent, createReferenceReview, 
  referenceCatalogMarkerPath,
  MAX_REFERENCE_ID_ATTEMPTS,
} from './references';
import { buildReferenceBrowser } from '../history/reference-browser';
import { buildKnowledgeIndex } from '../knowledge';
import { createKnowledgeRecord, readKnowledgeRecord } from '../knowledge/records';

const main = 'branch-main', notes = { problem: '', modification: '', observations: '' };
const file = (name: string, text: string) => new File([text], name, { type: 'text/plain' });
const meta = (title: string) => ({ title, description: '', tags: [] });
const RECORD = /^\d{8}-\d{6}-[0-9a-z]{6}$/;

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

test('new publication markers are `<recordId>.<compact sha>.done` and 71 characters', () => {
  const sha = hashString('x');
  for (let i = 0; i < 200; i++) {
    const id = newRecordId();
    const marker = referenceCatalogMarkerPath(id, sha).at(-1)!;
    assert.equal(marker, `${id}.${compactHex(sha)}.done`);
    assert.equal(marker.length, 71);
  }
  assert.throws(() => referenceCatalogMarkerPath('reference-catalog-00000000-0000-4000-8000-000000000000', sha), /Invalid reference record ID/);
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

test('new-code reference paths fit internalReserve() and hit no legacy template', async () => {
  const f = await fixture();
  await importReferenceAttachment(f.vault, f.projectId, file('One.txt', 'one'), meta('One'));
  const reserve = internalReserve();
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

test('an old-format (compact UUID) publication directory is rejected, not misread: reference evidence becomes unavailable', async () => {
  const f = await fixture();
  await importReferenceAttachment(f.vault, f.projectId, file('One.txt', 'one'), meta('One'));
  const oldMarker = `${compactHex(crypto.randomUUID().replace(/-/g, ''))}.${compactHex(hashString('y'))}.done`;
  assert.equal(oldMarker.split('.')[0].length, 22);
  await f.vault.getDirectory(['references', 'completed', oldMarker], { create: true, exclusiveCreate: true });
  const state = await openExistingVault(f.vault);
  assert.notEqual(state.references!.status, 'available');
  assert.match(state.references!.reason!, /Unexpected reference publication directory/);
});
