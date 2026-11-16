import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryFileSystemAdapter } from './fs-adapter';
import { initializeProjectVault, openExistingVault } from './vault-service';
import { captureRevision } from './revision-service';
import { scanBranchChanges } from './scanner';
import { createReferenceReview, retrieveReferenceAttachment, importReferenceAttachment } from './references';
import type { CaptureRevisionInput } from './types';
import { inventorySignature, readVerifiedInventory } from './copy-service';

const branchId = 'branch-main', notes = { problem: '', modification: '', observations: '' };
const source = () => new File([new Uint8Array([0, 255, 13, 10, 128])], 'Drawing requirement.pdf');
async function fixture() {
  const working = new InMemoryFileSystemAdapter('Main'), vault = new InMemoryFileSystemAdapter('Vault');
  const state = await initializeProjectVault(working, vault, 'Attachments');
  await working.writeFileText(['Part.SLDPRT'], 'geometry');
  const scan = await scanBranchChanges(working, branchId, null);
  const input: CaptureRevisionInput = { branchId, summary: 'Baseline with sources', notes, reviewedChangesSignature: scan.changesSignature, referenceReview: createReferenceReview(state, scan), referenceAuthor: { id: 'a', displayName: 'Asha' }, referenceAttachments: [{ source: source(), explanation: 'Match the required clearance', component: { kind: 'pending', path: 'Part.SLDPRT' } }] };
  return { working, vault, state, scan, input };
}

test('new baseline saves attachments, exact bytes, author and part mapping together; unchanged CAD can receive a reference-only revision', async () => {
  const f = await fixture();
  const saved = await captureRevision(f.working, f.vault, f.input);
  const id = saved.revision.manifest.revisionId, link = saved.vaultState.references!.contexts[id].record!.links[0];
  assert.equal(link.componentId, saved.vaultState.components!.revisions[id].files[0].componentId);
  assert.equal(link.explanation, 'Match the required clearance');
  const file = await retrieveReferenceAttachment(f.vault, f.state.project.projectId, link.referenceId, link.versionId);
  assert.deepEqual(file.bytes, new Uint8Array(await source().arrayBuffer()));
  assert.equal(file.version.savedBy!.displayName, 'Asha');
  const scan = await scanBranchChanges(f.working, branchId, saved.revision.manifest);
  const next = await captureRevision(f.working, f.vault, { ...f.input, reviewedChangesSignature: scan.changesSignature, referenceReview: createReferenceReview(saved.vaultState, scan), referenceAttachments: [{ source: new File(['Overall intent'], 'Brief.txt'), explanation: 'Client design brief' }] });
  const record = next.vaultState.references!.contexts[next.revision.manifest.revisionId].record!;
  assert.equal(record.contextOnly, true);
  assert.equal(record.links.length, 2);
  assert.equal(record.links[1].componentId, null);
  assert.deepEqual(next.revision.manifest.files, saved.revision.manifest.files);
  assert.equal(next.vaultState.references!.contexts[id].record!.links.length, 1);
});

test('invalid part selections and stale reviews cannot import draft attachments or write capture records', async () => {
  const f = await fixture();
  const inventory = async () => inventorySignature(await readVerifiedInventory(f.vault));
  const before = await inventory();
  await assert.rejects(captureRevision(f.working, f.vault, { ...f.input, referenceAttachments: [{ source: source(), explanation: '', component: { kind: 'pending', path: 'Missing.SLDPRT' } }] }), /reference component is absent/);
  assert.equal(await inventory(), before);
  await importReferenceAttachment(f.vault, f.state.project.projectId, new File(['Unrelated'], 'Other.txt'), { title: 'Other', description: '', tags: [] });
  const changed = await inventory();
  await assert.rejects(captureRevision(f.working, f.vault, f.input), /selections are stale/);
  assert.equal(await inventory(), changed);
});

test('an interrupted capture retains stored attachments for retry without importing duplicate sources', async () => {
  const f = await fixture(), write = f.vault.writeFileText.bind(f.vault);
  let fail = true, retry = { ...f.input };
  f.vault.writeFileText = async (path, text, options) => {
    if (fail && path[0] === 'completed') { fail = false; throw new Error('Interrupted revision save'); }
    return write(path, text, options);
  };
  await assert.rejects(captureRevision(f.working, f.vault, { ...f.input, onReferenceAttachmentsStored: review => { retry = { ...f.input, referenceReview: review, referenceAttachments: [] }; } }), /Interrupted revision save/);
  assert.equal(retry.referenceAttachments!.length, 0);
  const interrupted = await openExistingVault(f.vault);
  assert.equal(interrupted.revisions.length, 0);
  assert.equal(interrupted.references!.library.length, 1);
  const saved = await captureRevision(f.working, f.vault, retry);
  assert.equal(saved.vaultState.references!.library.length, 1);
  assert.equal(saved.vaultState.references!.contexts[saved.revision.manifest.revisionId].record!.links.length, 1);
});

test('a lost attachment publication acknowledgement is reconciled, while cancellation keeps the published batch ready for retry', async () => {
  for (const cancel of [false, true]) {
    const f = await fixture(), directory = f.vault.getDirectory.bind(f.vault), abort = new AbortController();
    let loseAcknowledgement = true, retry = { ...f.input };
    f.vault.getDirectory = async (path, options) => {
      const result = await directory(path, options);
      if (loseAcknowledgement && options?.exclusiveCreate && path[0] === 'references' && path[1] === 'completed') {
        loseAcknowledgement = false;
        throw new Error('Lost attachment acknowledgement');
      }
      return result;
    };
    const capture = captureRevision(f.working, f.vault, { ...f.input, signal: abort.signal, onReferenceAttachmentsStored: review => {
      retry = { ...f.input, referenceReview: review, referenceAttachments: [] };
      if (cancel) abort.abort();
    } });
    if (cancel) {
      await assert.rejects(capture, error => error instanceof DOMException && error.name === 'AbortError');
      assert.equal((await openExistingVault(f.vault)).revisions.length, 0);
      await captureRevision(f.working, f.vault, retry);
    } else await capture;
    const final = await openExistingVault(f.vault);
    assert.equal(final.revisions.length, 1);
    assert.equal(final.references!.library.length, 1);
    assert.equal(final.references!.contexts[final.revisions[0].manifest.revisionId].record!.links.length, 1);
  }
});

const stagingEntries = async (vault: InMemoryFileSystemAdapter) => (await vault.hasDirectory(['staging'])) ? (await (await vault.getDirectory(['staging'])).listEntries()).map(e => e.name) : [];

test('a capture with a new reference file and a standalone reference import leave no staging folder and no incomplete attempt', async () => {
  const f = await fixture();
  const saved = await captureRevision(f.working, f.vault, f.input);
  assert.deepEqual(await stagingEntries(f.vault), []);
  assert.deepEqual((await openExistingVault(f.vault)).incompleteAttempts, []);
  await importReferenceAttachment(f.vault, f.state.project.projectId, new File(['Another new file'], 'Other.txt'), { title: 'Other', description: '', tags: [] });
  assert.deepEqual(await stagingEntries(f.vault), []);
  const reopened = await openExistingVault(f.vault);
  assert.deepEqual(reopened.incompleteAttempts, []);
  assert.equal(reopened.references!.library.length, 2);
  assert.equal(saved.vaultState.references!.library.length, 1);
});

test('a failed reference import keeps its staging folder, which is reported as an incomplete attempt', async () => {
  const f = await fixture(), write = f.vault.writeFileStream.bind(f.vault);
  // Fail while publishing the verified staged bytes into objects/: the .tmp file survives.
  f.vault.writeFileStream = async (path, stream, signal) => { if (path[0] === 'objects') throw new Error('Interrupted object write'); return write(path, stream, signal); };
  await assert.rejects(importReferenceAttachment(f.vault, f.state.project.projectId, new File(['Doomed'], 'Doomed.txt'), { title: 'Doomed', description: '', tags: [] }), /Interrupted object write/);
  const left = await stagingEntries(f.vault);
  assert.equal(left.length, 1);
  assert.equal((await (await f.vault.getDirectory(['staging', left[0]])).listEntries()).filter(e => e.name.endsWith('.tmp')).length, 1);
  assert.deepEqual((await openExistingVault(f.vault)).incompleteAttempts.map(a => a.id), left);
  await assert.rejects(captureRevision(f.working, f.vault, f.input), /Interrupted object write/);
  assert.equal((await stagingEntries(f.vault)).length, 2);
});
