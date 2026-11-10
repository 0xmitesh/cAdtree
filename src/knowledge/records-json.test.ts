import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { InMemoryFileSystemAdapter } from '../engine/fs-adapter';
import { initializeProjectVault, openExistingVault, computeProjectIdentityChecksum, computeBranchRecordChecksum } from '../engine/vault-service';
import { inventorySignature, readVerifiedInventory } from '../engine/copy-service';
import { hashString } from '../engine/hash';
import { canonicalJson } from './records/json';
import { bodyChecksum, validateEnvelope } from './records/envelope';
import { createKnowledgeRecord, defaultKnowledgeSchemas, type CreateKnowledgeRecordInput, type PublishedKnowledgeRecord } from './records';

const malformedArrays: { name: string; make: (called: () => void) => unknown[] }[] = [
  { name: 'subclass overriding map to discard Infinity and undefined', make: called => {
    class DiscardingArray extends Array<unknown> { map<U>(): U[] { called(); return []; } }
    const values = new DiscardingArray(); values.push(Infinity, undefined); return values;
  } },
  { name: 'array subclass containing only ordinary valid values', make: () => {
    class OrdinarySubclass extends Array<unknown> {}
    const values = new OrdinarySubclass(); values.push(1, 'keep me', null); return values;
  } },
  { name: 'array with null prototype', make: () => Object.setPrototypeOf([1, 2], null) },
  { name: 'array with an inherited indexed accessor', make: called => {
    const values = new Array(1);
    return Object.setPrototypeOf(values, Object.create(Array.prototype, {
      '0': { get() { called(); return 5; }, enumerable: true },
    }));
  } },
  { name: 'Infinity element', make: () => [1, Infinity] },
  { name: 'undefined element', make: () => [1, undefined] },
  { name: 'NaN element', make: () => [NaN] },
  { name: 'sparse array', make: () => [1, , 3] },
  { name: 'own indexed accessor', make: called => Object.defineProperty([1], '0', {
    get() { called(); return Infinity; }, enumerable: true,
  }) },
  { name: 'non-enumerable indexed element', make: () => Object.defineProperty([1], '0', { value: 1, enumerable: false }) },
  { name: 'enumerable map override on an instance', make: called => Object.defineProperty([Infinity], 'map', {
    value() { called(); return []; }, enumerable: true,
  }) },
  { name: 'hidden map override on an instance', make: called => Object.defineProperty([Infinity], 'map', {
    value() { called(); return []; },
  }) },
  { name: 'map getter on an instance', make: called => Object.defineProperty([1], 'map', {
    get() { called(); return () => []; }, enumerable: true,
  }) },
  { name: 'iterator override on an instance', make: called => Object.defineProperty([1], Symbol.iterator, {
    value() { called(); return [][Symbol.iterator](); },
  }) },
  { name: 'toJSON override on an instance', make: called => Object.defineProperty([Infinity], 'toJSON', {
    value() { called(); return []; }, enumerable: true,
  }) },
  { name: 'extra named array property', make: () => Object.defineProperty([1], 'note', { value: 'extra', enumerable: true }) },
  { name: 'getter in a nested object element', make: called => [{ nested: Object.defineProperty({}, 'reading', {
    get() { called(); return 1; }, enumerable: true,
  }) }] },
];

for (const scenario of malformedArrays) test(`F1 rejects ${scenario.name} without invoking input behavior or writing`, async () => {
  let behaviorCalls = 0;
  const readings = scenario.make(() => { behaviorCalls++; });
  assert.throws(() => canonicalJson(readings));
  assert.equal(behaviorCalls, 0, 'canonicalization must not call input methods/getters');

  const vault = new InMemoryFileSystemAdapter('F1 Vault'), working = new InMemoryFileSystemAdapter('F1 Working');
  const state = await initializeProjectVault(working, vault, 'F1 disposable project');
  const before = inventorySignature(await readVerifiedInventory(vault));
  let fileWrites = 0, directoryCreates = 0;
  vault.setHooks({ onBeforeWrite: () => { fileWrites++; } });
  const getDirectory = vault.getDirectory.bind(vault);
  vault.getDirectory = async (path, options) => {
    if (options?.create) directoryCreates++;
    return getDirectory(path, options);
  };
  // Deliberately submit non-JSON runtime values through the public creation boundary.
  const input = {
    projectId: state.project.projectId, recordType: 'generic.observation', schemaVersion: 1,
    payload: { description: 'Original submission', attributes: { nested: [{ readings }] } },
    relationships: [], provenance: { kind: 'user-entered' },
  } as unknown as CreateKnowledgeRecordInput;
  await assert.rejects(createKnowledgeRecord(vault, input));
  assert.equal(behaviorCalls, 0, 'creation must not invoke nested input conversion behavior');
  assert.equal(fileWrites, 0);
  assert.equal(directoryCreates, 0);
  assert.equal(await vault.hasDirectory(['knowledge']), false, 'no record or publication namespace was created');
  assert.equal(inventorySignature(await readVerifiedInventory(vault)), before);
});

test('F1 preserves ordinary and frozen arrays, nested values, ordering and deterministic canonical bytes', async () => {
  const readings = Object.freeze([1, 2.5, -0, null, true, '  original\n\u00b5 ', { z: [3, 1], a: 'text' }]);
  const expected = '[1,2.5,-0,null,true,"  original\\n\u00b5 ",{"a":"text","z":[3,1]}]';
  assert.equal(canonicalJson(readings), expected);
  assert.equal(canonicalJson([]), '[]');
  assert.equal(canonicalJson(Object.freeze([])), '[]');
  const shared = { value: [2, 1] };
  assert.equal(canonicalJson([shared, shared]), '[{"value":[2,1]},{"value":[2,1]}]', 'noncyclic shared values remain valid');

  const vault = new InMemoryFileSystemAdapter('F1 Valid Vault'), working = new InMemoryFileSystemAdapter('F1 Valid Working');
  const state = await initializeProjectVault(working, vault, 'Valid array preservation');
  const payload = { description: '  Keep original text.\n', attributes: { readings } };
  const stored = await createKnowledgeRecord(vault, {
    projectId: state.project.projectId, recordType: 'generic.observation', schemaVersion: 1,
    payload: payload as unknown as CreateKnowledgeRecordInput['payload'], relationships: [], provenance: { kind: 'user-entered' },
  });
  assert.deepEqual(stored.record.payload, payload);
  assert.equal(canonicalJson(stored.record.payload.attributes), `{"readings":${expected}}`);
  assert.deepEqual((await openExistingVault(vault)).knowledge!.records, [stored]);
});

test('F1 preserves pre-fix example hashes (the old-ID docs examples are hash oracles only; they are no longer reopened)', async () => {
  const examples = JSON.parse(await readFile(new URL('../../docs/M1B-1-examples.json', import.meta.url), 'utf8')) as {
    cadDesignChange: PublishedKnowledgeRecord; genericObservation: PublishedKnowledgeRecord;
  };
  // These examples were generated before F1. Their recorded digests are the compatibility oracle.
  // validateEnvelope is left out: these docs examples use historical knowledge-<uuid> record IDs, which are no longer valid.
  for (const previous of [examples.cadDesignChange, examples.genericObservation]) {
    assert.equal(bodyChecksum(previous.record), previous.source.bodySha256);
    assert.equal(hashString(canonicalJson(previous.record)), previous.source.recordSha256);
  }
});
