import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryFileSystemAdapter } from '../engine/fs-adapter';
import { initializeProjectVault, openExistingVault } from '../engine/vault-service';
import { captureRevision } from '../engine/revision-service';
import { scanBranchChanges } from '../engine/scanner';
import { getBranchBaseline } from '../engine/branch-state';
import { createIdentityReview } from '../engine/component-identity';
import { createReferenceReview, importReferenceAttachment } from '../engine/references';
import { restoreRevisionToFolder } from '../engine/recovery-service';
import { inventorySignature, readVerifiedInventory } from '../engine/copy-service';
import { hashString } from '../engine/hash';
import { compactHex } from '../engine/path-encoding';
import { newRecordId } from '../engine/ids';
import { buildKnowledgeIndex } from './index';
import { canonicalJson, object } from './records/json';
import { bodyChecksum } from './records/envelope';
import {
  createKnowledgeRecord, readKnowledgeRecord, createKnowledgeSchemaRegistry, KnowledgePublicationError,
  type CreateKnowledgeRecordInput, type CadDesignChangePayload, type JsonObject, type KnowledgeRelationshipInput,
} from './records';

const main = 'branch-main';
const notes = { problem: 'Axial deflection', modification: 'Investigate collar stiffness', observations: '' };
const cad: CadDesignChangePayload = {
  problem: '  Collar bends under axial load.\nKeep this original text. ',
  change: { status: 'proposed', description: 'Increase thickness from 6 mm to 8 mm.' },
  rationale: ' Reduce bending; simulation is still an assertion, not validation. ',
  propertyChanges: [{ property: 'plate thickness', before: 6, after: 8, unit: 'mm' }, { property: 'designation', before: 'A', after: 'B' }],
  assumptions: ['Load is axial.'], observations: ['Prototype validation pending.'],
};
const generic = { description: '  A handwritten note about a non-CAD workflow.\n', attributes: { count: 3, temperature: { value: 22.5, unit: '°C' }, tags: ['trial', null], original: '6.0 mm' } };
const id = (n: number) => `20260101-000000-${String(n).padStart(6, '0')}`;

async function fixture(withRevision = false) {
  const working = new InMemoryFileSystemAdapter('Main'), vault = new InMemoryFileSystemAdapter('Vault');
  let state = await initializeProjectVault(working, vault, 'Disposable knowledge tests');
  const projectId = state.project.projectId;
  const input = (extra: Partial<CreateKnowledgeRecordInput> = {}): CreateKnowledgeRecordInput => ({
    projectId, recordType: 'generic.observation', schemaVersion: 1, payload: generic,
    relationships: [], provenance: { kind: 'user-entered' }, ...extra,
  });
  if (withRevision) {
    state = await importReferenceAttachment(vault, projectId, {
      name: 'load-requirement.pdf', type: 'application/pdf', size: 3, stream: () => new Blob([new Uint8Array([1, 2, 3])]).stream(),
    }, { title: 'Synthetic load requirement', description: '', tags: [] });
    const ref = state.references!.library[0];
    await working.writeFileText(['collar.SLDPRT'], 'disposable geometry');
    const scan = await scanBranchChanges(working, main, getBranchBaseline(state, main));
    state = (await captureRevision(working, vault, { branchId: main, summary: 'Initial collar', notes,
      referenceReview: createReferenceReview(state, scan, [{ referenceId: ref.referenceId, versionId: ref.versions[0].versionId,
        locator: '  Page 4, §2, figure 3\n', explanation: 'Load context only.', component: { kind: 'pending', path: 'collar.SLDPRT' } }]),
    })).vaultState;
  }
  return { working, vault, state, projectId, input };
}

function relationships(f: Awaited<ReturnType<typeof fixture>>): KnowledgeRelationshipInput[] {
  const revisionId = f.state.revisions[0].manifest.revisionId;
  const componentId = f.state.components!.revisions[revisionId].files[0].componentId;
  const association = buildKnowledgeIndex(f.state).revisions[0].referenceContext.attachments[0];
  return [
    { relation: 'context', target: { kind: 'revision', projectId: f.projectId, revisionId } },
    { relation: 'related', target: { kind: 'component', projectId: f.projectId, revisionId, componentId } },
    { relation: 'evidence', target: { kind: 'reference-version', projectId: f.projectId, revisionId,
      referenceId: association.referenceId, versionId: association.versionId, associationPointer: association.source.jsonPointer } },
  ];
}

async function inventoryWithoutKnowledge(dir: InMemoryFileSystemAdapter) {
  const inventory = await readVerifiedInventory(dir);
  return inventorySignature({ ...inventory, files: inventory.files.filter(f => !f.path.startsWith('knowledge/')), directories: inventory.directories.filter(p => p !== 'knowledge' && !p.startsWith('knowledge/')) });
}

// Test-only disk tampering/publication of unsupported bytes; never an edit API.
async function publishRaw(vault: InMemoryFileSystemAdapter, value: object) {
  const raw = canonicalJson(value), record = value as { recordId: string };
  await vault.writeFileText(['knowledge', 'records', `${record.recordId}.json`], raw);
  await vault.getDirectory(['knowledge', 'completed', `${record.recordId}.${compactHex(hashString(raw))}.done`], { create: true });
  return raw;
}

test('CAD and generic records share immutable storage; exact payloads, source pointers, timestamps and M1A survive reopen', async () => {
  const f = await fixture(true), before = buildKnowledgeIndex(f.state);
  const inventory = await inventoryWithoutKnowledge(f.vault), working = inventorySignature(await readVerifiedInventory(f.working));
  const started = Date.now();
  const first = await createKnowledgeRecord(f.vault, f.input({ recordId: id(1), recordType: 'cad.design-change', payload: cad, relationships: relationships(f) }));
  assert.ok(Date.parse(first.record.createdAt) >= started && Date.parse(first.record.createdAt) <= Date.now());
  assert.equal(Object.hasOwn(first.record, 'author'), false);
  assert.deepEqual(first.record.payload, cad);
  assert.equal((first.record.payload.propertyChanges as { before: number; after: number; unit: string }[])[0].unit, 'mm');
  const observation = await createKnowledgeRecord(f.vault, f.input({ recordId: id(2), relationships: [{ relation: 'related', target: { kind: 'record', projectId: f.projectId, recordId: id(1) } }], provenance: { kind: 'imported', source: 'local notes', locator: 'Page 2' } }));
  assert.deepEqual(observation.record.payload, generic);
  assert.deepEqual(first.verification, { metadata: 'checksum_verified', attachmentBytes: 'not_checked', claims: 'not_verified' });
  assert.equal(observation.record.relationships[0].binding.kind, 'record');
  assert.equal(first.record.relationships[1].binding.kind, 'component');
  const binding = first.record.relationships[2].binding;
  assert.equal(binding.kind, 'reference-version');
  if (binding.kind === 'reference-version') {
    const { metadata, content, scope, ...association } = before.revisions[0].referenceContext.attachments[0];
    assert.deepEqual(binding.association, association);
    assert.equal(content.status, 'unavailable');
    assert.equal(Object.hasOwn(binding.association, 'content'), false, 'durable provenance excludes transient availability messages');
  }
  const reopened = await openExistingVault(f.vault);
  assert.deepEqual(reopened.knowledge!.records, [first, observation]);
  assert.deepEqual(await readKnowledgeRecord(f.vault, f.projectId, id(1)), first);
  const projected = buildKnowledgeIndex(reopened);
  assert.deepEqual(projected.records, before.records);
  assert.deepEqual(projected.revisions, before.revisions, 'F1 note-independent revision associations are unchanged');
  assert.deepEqual(projected.branches, before.branches);
  assert.deepEqual(projected.persistedRecords, [first, observation]);
  projected.persistedRecords[0].record.payload.problem = 'consumer change';
  assert.deepEqual(reopened.knowledge!.records, [first, observation], 'projection does not expose mutable aliases');
  for (const stored of [first, observation]) {
    const raw = await f.vault.readFileText(stored.source.recordPath.split('/'));
    assert.equal(hashString(raw), stored.source.recordSha256);
    assert.deepEqual(JSON.parse(raw), stored.record);
    assert.equal(stored.source.schemaVersion, 1);
    assert.equal(stored.source.jsonPointer, '');
    assert.deepEqual(await (await f.vault.getDirectory(stored.source.publicationPath.split('/'))).listEntries(), []);
  }
  assert.equal(await inventoryWithoutKnowledge(f.vault), inventory);
  assert.equal(inventorySignature(await readVerifiedInventory(f.working)), working);
  assert.deepEqual(reopened.references, f.state.references);
  assert.deepEqual(reopened.components, f.state.components);
  assert.deepEqual(reopened.revisions, f.state.revisions);
  // Read/reconstruction perform no writes, even on a vault without write permission.
  f.vault.setHooks({ writePermission: 'denied' });
  assert.deepEqual((await openExistingVault(f.vault)).knowledge!.records, [first, observation]);
});

test('registering a new domain schema requires no persistence changes; unknown types/versions remain preserved and unsupported', async () => {
  const f = await fixture(), registry = createKnowledgeSchemaRegistry();
  registry.register('biology.field-note', 3, (payload): payload is JsonObject => object(payload) && typeof payload.species === 'string' && typeof payload.count === 'number');
  const payload = { species: '  Acacia  ', count: 4 };
  const stored = await createKnowledgeRecord(f.vault, f.input({ recordType: 'biology.field-note', schemaVersion: 3, payload }), registry);
  const raw = await f.vault.readFileText(stored.source.recordPath.split('/'));
  const unsupported = (await openExistingVault(f.vault)).knowledge!;
  assert.deepEqual(unsupported.records, []);
  assert.equal(unsupported.diagnostics[0].status, 'unsupported');
  assert.equal(unsupported.diagnostics[0].recordType, 'biology.field-note');
  assert.equal(unsupported.diagnostics[0].schemaVersion, 3);
  await assert.rejects(readKnowledgeRecord(f.vault, f.projectId, stored.record.recordId), /unsupported/);
  assert.deepEqual((await openExistingVault(f.vault, { knowledgeSchemas: registry })).knowledge!.records, [stored]);
  assert.equal(await f.vault.readFileText(stored.source.recordPath.split('/')), raw);
  assert.throws(() => registry.register('biology.field-note', 3, (_): _ is JsonObject => true), /cannot be overwritten/);
  registry.register('generic.observation', 2, (p): p is JsonObject => object(p) && typeof p.message === 'string');
  const future = await createKnowledgeRecord(f.vault, f.input({ schemaVersion: 2, payload: { message: 'future observation' } }), registry);
  assert.ok((await openExistingVault(f.vault)).knowledge!.diagnostics.some(d => d.recordId === future.record.recordId && d.status === 'unsupported' && d.schemaVersion === 2));
});

test('invalid payloads, lossy JS values, provenance, timestamps and forged verification are rejected before any write', async () => {
  const f = await fixture(), before = inventorySignature(await readVerifiedInventory(f.vault));
  const invalid: unknown[] = [
    f.input({ recordType: 'cad.design-change', payload: { ...cad, change: { status: 'validated', description: 'invented' } } }),
    f.input({ recordType: 'cad.design-change', payload: { ...cad, change: { status: ['proposed'], description: 'invalid coercible enum' } } }),
    f.input({ recordType: 'cad.design-change', payload: { ...cad, propertyChanges: [{ property: 'x', before: 1, after: 2, unit: 7 }] } }),
    f.input({ payload: { description: '' } }), f.input({ payload: { description: 'ok', extra: true } }),
    f.input({ payload: { description: 'ok', attributes: { value: Infinity } } }),
    { ...f.input(), payload: { description: 'ok', attributes: { missing: undefined } } },
    { ...f.input(), createdAt: '1990-01-01T00:00:00.000Z' },
    { ...f.input(), provenance: { kind: 'independently-verified' } },
    { ...f.input(), provenance: { kind: 'machine-extracted', source: 'local draft', method: 'model', verified: true } },
    { ...f.input(), author: null }, { ...f.input(), recordId: null },
    f.input({ author: { id: '' } }), f.input({ recordType: 'future.unknown' }),
  ];
  for (const input of invalid) await assert.rejects(createKnowledgeRecord(f.vault, input as CreateKnowledgeRecordInput));
  assert.equal(inventorySignature(await readVerifiedInventory(f.vault)), before);
  const registry = createKnowledgeSchemaRegistry();
  registry.register('generic.mutating-test', 1, (payload): payload is JsonObject => {
    if (!object(payload)) return false; payload.original = 'validator mutation'; return true;
  });
  const record = await createKnowledgeRecord(f.vault, f.input({ recordType: 'generic.mutating-test', payload: { original: 'keep me' } }), registry);
  assert.equal(record.record.payload.original, 'keep me');
});

test('invalid, cross-project and unavailable relationships cannot publish', async () => {
  const f = await fixture(true), links = relationships(f), before = inventorySignature(await readVerifiedInventory(f.vault));
  const invalid = links.map(link => ({ ...link, target: { ...link.target, projectId: 'different-project' } }));
  invalid.push({ relation: 'context', target: { kind: 'revision', projectId: f.projectId, revisionId: 'missing' } });
  invalid.push({ relation: 'related', target: { kind: 'component', projectId: f.projectId, revisionId: f.state.revisions[0].manifest.revisionId, componentId: 'collar.SLDPRT' } });
  invalid.push({ relation: 'evidence', target: { ...links[2].target, versionId: 'wrong-version' } } as KnowledgeRelationshipInput);
  invalid.push({ relation: 'evidence', target: { ...links[2].target, associationPointer: '/links/99' } } as KnowledgeRelationshipInput);
  invalid.push({ relation: 'related', target: { kind: 'record', projectId: f.projectId, recordId: id(999) } });
  for (const link of invalid) await assert.rejects(createKnowledgeRecord(f.vault, f.input({ relationships: [link] })));
  await assert.rejects(createKnowledgeRecord(f.vault, f.input({ relationships: [{ ...links[0], relation: ['context'] } as unknown as KnowledgeRelationshipInput] })), /Invalid knowledge relationship/);
  await assert.rejects(createKnowledgeRecord(f.vault, f.input({ projectId: 'other-project' })), /owner/);
  await assert.rejects(createKnowledgeRecord(f.vault, f.input({ recordId: id(4), relationships: [{ relation: 'related', target: { kind: 'record', projectId: f.projectId, recordId: id(4) } }] })), /cyclic/);
  assert.equal(inventorySignature(await readVerifiedInventory(f.vault)), before);
});

test('machine-extracted and user assertions remain unverified; author is supplied explicitly', async () => {
  const f = await fixture();
  const provenance = { kind: 'machine-extracted', source: 'local experimental notes', locator: 'Paragraph 2', method: 'synthetic test extractor' } as const;
  const stored = await createKnowledgeRecord(f.vault, f.input({ provenance, author: { id: 'test-operator', displayName: 'Synthetic operator' } }));
  assert.deepEqual(stored.record.provenance, provenance);
  assert.deepEqual(stored.record.author, { id: 'test-operator', displayName: 'Synthetic operator' });
  assert.equal(stored.verification.claims, 'not_verified');
  assert.equal(stored.verification.attachmentBytes, 'not_checked');
});

test('confirmed renames preserve historical component bindings and pinned reference versions', async () => {
  const f = await fixture(true), links = relationships(f);
  const first = await createKnowledgeRecord(f.vault, f.input({ recordType: 'cad.design-change', payload: cad, relationships: links }));
  await f.working.removeEntry(['collar.SLDPRT']);
  await f.working.writeFileText(['collar-plate.SLDPRT'], 'renamed synthetic geometry');
  let state = await openExistingVault(f.vault);
  const scan = await scanBranchChanges(f.working, main, getBranchBaseline(state, main));
  state = (await captureRevision(f.working, f.vault, { branchId: main, summary: 'Confirmed rename', notes,
    identityReview: createIdentityReview(state, scan, [{ from: 'collar.SLDPRT', to: 'collar-plate.SLDPRT' }], []),
  })).vaultState;
  const revisionId = state.revisions.find(r => r.manifest.summary === 'Confirmed rename')!.manifest.revisionId;
  const component = links[1].target;
  assert.equal(component.kind, 'component');
  const second = await createKnowledgeRecord(f.vault, f.input({ relationships: [{ relation: 'context', target: { ...component, revisionId } as typeof component }] }));
  assert.deepEqual(await readKnowledgeRecord(f.vault, f.projectId, first.record.recordId), first);
  const binding = second.record.relationships[0].binding;
  assert.equal(binding.kind, 'component');
  if (binding.kind === 'component') assert.equal(binding.historicalPath, 'collar-plate.SLDPRT');
  const historical = first.record.relationships[1].binding;
  if (historical.kind === 'component') assert.equal(historical.historicalPath, 'collar.SLDPRT');
  // Adding a new reference version never retargets an existing record to that version.
  const old = first.record.relationships[2].target;
  if (old.kind !== 'reference-version') throw new Error('Expected reference target');
  await importReferenceAttachment(f.vault, f.projectId, { name: 'new-loads.pdf', type: 'application/pdf', size: 1, stream: () => new Blob([new Uint8Array([9])]).stream() }, { title: 'Updated load', description: '', tags: [] }, old.referenceId);
  assert.deepEqual(await readKnowledgeRecord(f.vault, f.projectId, first.record.recordId), first);
});

test('duplicate identities, competing publications, corruption and dependent records fail conservatively', async () => {
  const f = await fixture();
  const first = await createKnowledgeRecord(f.vault, f.input({ recordId: id(1) }));
  const dependent = await createKnowledgeRecord(f.vault, f.input({ recordId: id(2), relationships: [{ relation: 'related', target: { kind: 'record', projectId: f.projectId, recordId: id(1) } }] }));
  const independent = await createKnowledgeRecord(f.vault, f.input({ recordId: id(3) }));
  const original = await f.vault.readFileText(first.source.recordPath.split('/'));
  const duplicates = await Promise.allSettled([createKnowledgeRecord(f.vault, f.input({ recordId: id(4) })), createKnowledgeRecord(f.vault, f.input({ recordId: id(4) }))]);
  assert.equal(duplicates.filter(r => r.status === 'fulfilled').length, 1, 'writer lock serializes identity reservation');
  await assert.rejects(createKnowledgeRecord(f.vault, f.input({ recordId: id(1) })), /already exists/);
  assert.equal(await f.vault.readFileText(first.source.recordPath.split('/')), original);
  await f.vault.writeFileText(first.source.recordPath.split('/'), original.replace('handwritten', 'tampered'));
  let state = await openExistingVault(f.vault);
  assert.ok(!state.knowledge!.records.some(r => [id(1), dependent.record.recordId].includes(r.record.recordId)));
  assert.ok(state.knowledge!.records.some(r => r.record.recordId === independent.record.recordId));
  assert.ok(state.knowledge!.diagnostics.some(d => /SHA-256/.test(d.reason)));
  await assert.rejects(readKnowledgeRecord(f.vault, f.projectId, id(1)), /unavailable/);
  assert.match(await f.vault.readFileText(first.source.recordPath.split('/')), /tampered/);
  await f.vault.getDirectory(['knowledge', 'completed', `${id(3)}.${compactHex('b'.repeat(64))}.done`], { create: true });
  state = await openExistingVault(f.vault);
  assert.ok(state.knowledge!.diagnostics.some(d => d.recordId === id(3) && /Competing/.test(d.reason)));
  assert.equal(state.corruptedRecords.length, 0);
});

for (const after of [false, true]) test(`interruption ${after ? 'after' : 'before'} final marker creation reconstructs the actual publication boundary`, async () => {
  const f = await fixture(), getDirectory = f.vault.getDirectory.bind(f.vault);
  let inject = true;
  f.vault.getDirectory = async (path, options) => {
    if (inject && path[0] === 'knowledge' && path[1] === 'completed' && options?.exclusiveCreate) {
      inject = false;
      if (after) await getDirectory(path, options);
      throw new Error('Injected publication interruption');
    }
    return getDirectory(path, options);
  };
  await assert.rejects(createKnowledgeRecord(f.vault, f.input({ recordId: id(1) })), error => error instanceof KnowledgePublicationError && error.publicationMayExist && error.recordId === id(1));
  const state = await openExistingVault(f.vault);
  assert.equal(state.knowledge!.records.length, after ? 1 : 0);
  if (!after) assert.equal(state.knowledge!.diagnostics[0].status, 'incomplete');
  await assert.rejects(createKnowledgeRecord(f.vault, f.input({ recordId: id(1) })), /reserved/);
  await createKnowledgeRecord(f.vault, f.input({ recordId: id(2) }));
});

test('empty partial files, malformed JSON, missing/nonempty markers and future storage formats preserve bytes without trust', async () => {
  const f = await fixture();
  await f.vault.writeFileText(['knowledge', 'records', `${id(1)}.json`], '');
  await f.vault.writeFileText(['knowledge', 'records', `${id(2)}.json`], '{broken');
  const healthy = await createKnowledgeRecord(f.vault, f.input({ recordId: id(3) }));
  await f.vault.writeFileText([...healthy.source.publicationPath.split('/'), 'unexpected'], 'modified marker');
  const future = { ...healthy.record, recordId: id(4), formatVersion: 99 };
  const raw = await publishRaw(f.vault, future);
  await f.vault.getDirectory(['knowledge', 'completed', `${id(5)}.${compactHex('b'.repeat(64))}.done`], { create: true });
  const state = await openExistingVault(f.vault);
  assert.equal(state.knowledge!.records.length, 0);
  for (const number of [1, 2]) assert.equal(state.knowledge!.diagnostics.find(d => d.recordId === id(number))?.status, 'incomplete');
  assert.ok(state.knowledge!.diagnostics.some(d => d.recordId === id(3) && /not empty/.test(d.reason)));
  assert.equal(state.knowledge!.diagnostics.find(d => d.recordId === id(4))?.status, 'unsupported');
  assert.ok(state.knowledge!.diagnostics.some(d => d.recordId === id(5) && /missing/.test(d.reason)));
  assert.equal(await f.vault.readFileText(['knowledge', 'records', `${id(4)}.json`]), raw);
});

test('checksummed relationship forgery and cyclic record links remain unavailable', async () => {
  const f = await fixture(true), stored = await createKnowledgeRecord(f.vault, f.input({ relationships: relationships(f) }));
  const forged = structuredClone(stored.record); forged.recordId = id(1);
  if (forged.relationships[1].binding.kind === 'component') forged.relationships[1].binding.historicalPath = 'made-up.SLDPRT';
  forged.integrity.bodySha256 = bodyChecksum(forged);
  await publishRaw(f.vault, forged);
  const state = await openExistingVault(f.vault);
  assert.ok(state.knowledge!.diagnostics.some(d => d.recordId === id(1) && /provenance/.test(d.reason)));
  for (const [a, b] of [[2, 3], [3, 2]]) {
    const cycle = { ...structuredClone(stored.record), recordId: id(a), relationships: [{ relation: 'related', target: { kind: 'record', projectId: f.projectId, recordId: id(b) }, binding: { kind: 'record', source: stored.source } }] };
    cycle.integrity.bodySha256 = bodyChecksum(cycle as unknown as typeof stored.record);
    await publishRaw(f.vault, cycle);
  }
  const reopened = await openExistingVault(f.vault);
  assert.ok(reopened.knowledge!.diagnostics.filter(d => /Cyclic/.test(d.reason)).length === 2);
  assert.equal(reopened.knowledge!.records.length, 1);
});

test('runtime payload validation still rejects a correctly checksummed invalid record during reconstruction', async () => {
  const f = await fixture(), stored = await createKnowledgeRecord(f.vault, f.input());
  const forged = { ...stored.record, recordId: id(1), payload: { description: 42 } };
  forged.integrity = { ...forged.integrity, bodySha256: bodyChecksum(forged) };
  const raw = await publishRaw(f.vault, forged);
  const reopened = await openExistingVault(f.vault);
  assert.equal(reopened.knowledge!.records.length, 1);
  assert.ok(reopened.knowledge!.diagnostics.some(d => d.recordId === id(1) && /Invalid payload/.test(d.reason)));
  assert.equal(await f.vault.readFileText(['knowledge', 'records', `${id(1)}.json`]), raw);
});

test('write/readback interruptions leave identity-reserved incomplete files and can be followed by a new identity', async () => {
  const f = await fixture(), write = f.vault.writeFileText.bind(f.vault);
  let inject = true;
  f.vault.writeFileText = async (path, raw, options) => {
    if (inject && path[0] === 'knowledge') {
      inject = false;
      // Native browsers can create a file before opening its writable stream.
      await write(path, '', options);
      throw new Error('Interrupted after creating the native file');
    }
    return write(path, raw, options);
  };
  await assert.rejects(createKnowledgeRecord(f.vault, f.input({ recordId: id(1) })), error => error instanceof KnowledgePublicationError && !error.publicationMayExist);
  const reopened = await openExistingVault(f.vault);
  assert.equal(reopened.knowledge!.diagnostics.find(d => d.recordId === id(1))?.status, 'incomplete');
  await assert.rejects(createKnowledgeRecord(f.vault, f.input({ recordId: id(1) })), /reserved/);
  await createKnowledgeRecord(f.vault, f.input({ recordId: id(2) }));
  const read = f.vault.readFileBytes.bind(f.vault);
  f.vault.readFileBytes = async path => {
    const bytes = await read(path);
    if (path.join('/') === `knowledge/records/${id(3)}.json`) return new Uint8Array([1]);
    return bytes;
  };
  await assert.rejects(createKnowledgeRecord(f.vault, f.input({ recordId: id(3) })), /readback/);
  f.vault.readFileBytes = read;
  assert.equal((await openExistingVault(f.vault)).knowledge!.diagnostics.find(d => d.recordId === id(3))?.status, 'incomplete');
});

test('legacy projects and CAD capture/recovery remain usable with a broken knowledge store', async () => {
  const f = await fixture(true);
  assert.equal(f.state.knowledge!.status, 'not_recorded');
  assert.equal(await f.vault.hasDirectory(['knowledge']), false);
  assert.deepEqual(buildKnowledgeIndex(f.state).persistedRecords, []);
  await f.vault.writeFileText(['knowledge'], 'not a directory');
  const opened = await openExistingVault(f.vault);
  assert.equal(opened.knowledge!.status, 'unavailable');
  assert.equal(opened.corruptedRecords.length, 0);
  assert.deepEqual(opened.revisions, f.state.revisions);
  await f.working.writeFileText(['collar.SLDPRT'], 'next CAD geometry');
  const saved = await captureRevision(f.working, f.vault, { branchId: main, summary: 'CAD independent of knowledge', notes });
  const recovered = new InMemoryFileSystemAdapter('Recovery');
  await restoreRevisionToFolder({ vaultDir: f.vault, destinationDir: recovered, workingDir: f.working, revisionId: saved.revision.manifest.revisionId });
  assert.equal(await recovered.readFileText(['collar.SLDPRT']), 'next CAD geometry');
  await assert.rejects(createKnowledgeRecord(f.vault, f.input()), /cannot be inspected/);
});

test('new-format records use short record IDs and compact publication markers, and reopen', async () => {
  const f = await fixture(true);
  const created = await createKnowledgeRecord(f.vault, f.input({ recordType: 'cad.design-change', payload: cad, relationships: relationships(f) }));
  assert.match(created.record.recordId, /^\d{8}-\d{6}-[0-9a-z]{6}$/);
  assert.equal(created.source.publicationPath, `knowledge/completed/${created.record.recordId}.${compactHex(created.source.recordSha256)}.done`);
  assert.equal(created.source.publicationPath.split('/').pop()!.length, 22 + 1 + 43 + 5);
  const dependent = await createKnowledgeRecord(f.vault, f.input({ relationships: [{ relation: 'related', target: { kind: 'record', projectId: f.projectId, recordId: created.record.recordId } }] }));
  const reopened = await openExistingVault(f.vault);
  assert.deepEqual(reopened.knowledge!.records.map(r => r.record.recordId).sort(), [created.record.recordId, dependent.record.recordId].sort());
  assert.deepEqual(reopened.knowledge!.diagnostics, []);
  assert.deepEqual(await readKnowledgeRecord(f.vault, f.projectId, dependent.record.recordId), dependent);
  assert.equal(dependent.record.relationships[0].binding.kind, 'record');
  for (const old of ['knowledge-00000000-0000-4000-8000-000000000001', 'KNOWLEDGE', '20260101-000000-ABCDEF', '20260101-000000-abcde']) {
    await assert.rejects(readKnowledgeRecord(f.vault, f.projectId, old), /Invalid permanent knowledge record ID/);
    await assert.rejects(createKnowledgeRecord(f.vault, f.input({ recordId: old })), /Invalid permanent knowledge record ID/);
  }
});

test('markers with a non-canonical or mismatched checksum, or a non-record-ID name, are reported and never trusted', async () => {
  const f = await fixture();
  const made = await createKnowledgeRecord(f.vault, f.input({ recordId: id(1) }));
  const marker = made.source.publicationPath.split('/');
  const compact = marker[2].split('.')[1];
  // Non-canonical: flip the last character so trailing bits are non-zero but the length stays 43.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const other = alphabet[(alphabet.indexOf(compact[42]) + 1) % 64];
  const variants = [`${id(2)}.${compact.slice(0, 42)}${other}.done`, `${id(3)}.${compactHex('c'.repeat(64))}.done`, `${id(4)}.${'b'.repeat(64)}.done`, `knowledge-${id(5)}.${compact}.done`];
  for (const name of variants) await f.vault.getDirectory(['knowledge', 'completed', name], { create: true });
  const raw2 = canonicalJson({ ...made.record, recordId: id(3) });
  await f.vault.writeFileText(['knowledge', 'records', `${id(3)}.json`], raw2);
  const raw2b = canonicalJson({ ...made.record, recordId: id(2) });
  await f.vault.writeFileText(['knowledge', 'records', `${id(2)}.json`], raw2b);
  const raw4 = canonicalJson({ ...made.record, recordId: id(4) });
  await f.vault.writeFileText(['knowledge', 'records', `${id(4)}.json`], raw4);
  const state = await openExistingVault(f.vault);
  assert.deepEqual(state.knowledge!.records.map(r => r.record.recordId), [id(1)]);
  const d = state.knowledge!.diagnostics;
  assert.ok(d.some(x => x.recordId === id(2) && x.status === 'unavailable' && /Invalid knowledge publication marker/.test(x.reason)));
  assert.ok(d.some(x => x.recordId === id(3) && /do not match the published SHA-256/.test(x.reason)));
  assert.ok(d.some(x => x.recordId === id(4) && /Invalid knowledge publication marker/.test(x.reason)));
  assert.ok(d.some(x => x.status === 'unsupported' && x.recordPath.endsWith(variants[3])));
});

test('a clash on a generated record ID draws a new ID and never overwrites the other record', async () => {
  const f = await fixture();
  const taken = newRecordId();
  await f.vault.writeFileText(['knowledge', 'records', `${taken}.json`], 'someone else\'s bytes');
  const drawn: string[] = [];
  const ids = [taken, taken, '20260101-000000-zzzzzz'];
  const created = await createKnowledgeRecord(f.vault, f.input(), undefined, () => { const next = ids.shift()!; drawn.push(next); return next; });
  assert.equal(created.record.recordId, '20260101-000000-zzzzzz');
  assert.equal(drawn.length, 3);
  assert.equal(await f.vault.readFileText(['knowledge', 'records', `${taken}.json`]), 'someone else\'s bytes');
  await assert.rejects(createKnowledgeRecord(f.vault, f.input(), undefined, () => taken), /No free knowledge record ID/);
  await assert.rejects(createKnowledgeRecord(f.vault, f.input({ recordId: taken })), /already exists or is reserved/);
  assert.equal(await f.vault.readFileText(['knowledge', 'records', `${taken}.json`]), 'someone else\'s bytes');
  await assert.rejects(createKnowledgeRecord(f.vault, f.input(), undefined, () => 'not-a-record-id'), /Invalid permanent knowledge record ID/);
});
