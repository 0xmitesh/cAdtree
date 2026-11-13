import '../dom';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { newDraft, payloadFromDraft } from './authoring-model';
import { KnowledgeAuthoring } from './authoring';
import { KnowledgeVaultSession } from './vault-session';
import { disposableAuthoringFixture } from './authoring-fixture';
import { createKnowledgeRecord } from '../../src/knowledge/records';
import { openExistingVault } from '../../src/engine/vault-service';
import { inventorySignature, readVerifiedInventory } from '../../src/engine/copy-service';

afterEach(cleanup);

const generic = (attributes: string) => payloadFromDraft({ ...newDraft(), schema: 'generic.observation', description: 'Observation', attributes });
const cad = (before: string, after = '8') => payloadFromDraft({ ...newDraft(), problem: 'Problem', change: 'Change', rationale: 'Rationale', properties: [{ property: 'value', before, after, unit: 'mm' }] });

test('R1 rejects original unsafe number tokens in attributes and both CAD values, including nested and alternative notation', () => {
  for (const literal of [
    '9007199254740993', '-9007199254740993', '9007199254740992', '-9007199254740992',
    '9007199254740993.0', '-9007199254740993.000',
    '9.007199254740993e15', '-9.007199254740993E+15',
    '90071992547409930e-1', '9007199254740993000e-3',
    '0.009007199254740993e18', '9007199254740993e+00000',
    '1e1000000000000000000000', '-1e400',
    '9007199254740991.1',
  ]) {
    const reason = /safe-integer range.*large integer identifiers as quoted strings/;
    assert.throws(() => generic(`{"measurementId":${literal}}`), reason, literal);
    assert.throws(() => generic(`{"nested":[0,{"ids":[${literal}]}]}`), reason, literal);
    assert.throws(() => cad(literal), reason, literal);
    assert.throws(() => cad('6', literal), reason, literal);
    assert.throws(() => cad(`{"nested":[${literal}]}`), reason, literal);
  }
});

test('R1 preserves safe boundaries, ordinary decimals, ordering and numeric-looking strings with escapes', () => {
  for (const [literal, expected] of [
    ['9007199254740991', Number.MAX_SAFE_INTEGER], ['-9007199254740991', Number.MIN_SAFE_INTEGER],
    ['9007199254740991.000', Number.MAX_SAFE_INTEGER], ['-90071992547409910e-1', Number.MIN_SAFE_INTEGER],
    ['9.0071992547409910e15', Number.MAX_SAFE_INTEGER], ['0e99999999999999999999', 0],
    ['1.25', 1.25], ['-6.25e-2', -0.0625], ['1.5e2', 150], ['0.000001', 0.000001],
  ] as const) {
    assert.deepEqual(generic(`{"value":${literal}}`).attributes, { value: expected });
    assert.deepEqual(cad(literal, literal).propertyChanges, [{ property: 'value', before: expected, after: expected, unit: 'mm' }]);
  }
  const strings = {
    measurementId: '9007199254740993', negative: '-9007199254740993',
    note: '"9.007199254740993e15" and \\"9007199254740993"',
    '9007199254740993': 'path\\9007199254740993',
    values: [3, 1.25, null, true, { identifier: '9007199254740993' }],
  };
  assert.deepEqual(generic(JSON.stringify(strings)).attributes, strings);
  assert.deepEqual(generic('{"id":"\\u0039007199254740993"}').attributes, { id: '9007199254740993' });
  assert.deepEqual(cad('"9007199254740993"', '"-9007199254740993"').propertyChanges,
    [{ property: 'value', before: '9007199254740993', after: '-9007199254740993', unit: 'mm' }]);
});

test('R1 keeps JSON syntax validation for malformed content', () => {
  for (const text of ['{"x":', '{"x":01}', '{"x":1.}', '{"x":+1}', '{"x":1e}', '{"x":NaN}', '{"x":Infinity}', '{"x":"unterminated}', '{"x":"bad\\q"}']) {
    assert.throws(() => generic(text), /valid JSON/);
    assert.throws(() => cad(text), /valid JSON/);
  }
});

test('R1 blocks authoring before save API calls or writes; quoted IDs persist and old records reconstruct unchanged', async () => {
  const f = await disposableAuthoringFixture();
  // Model a pre-existing finite record: the UI-only correction must not reinterpret old data.
  const previous = await createKnowledgeRecord(f.vault, {
    projectId: f.state.project.projectId, recordType: 'generic.observation', schemaVersion: 1,
    payload: { description: 'Legacy observation', attributes: { measurementId: 9007199254740992 } }, relationships: [], provenance: { kind: 'user-entered' },
  });
  const previousBytes = await f.vault.readFileText(previous.source.recordPath.split('/'));
  const selected = await KnowledgeVaultSession.inspect(f.vault);
  await selected.session.authorizeDisposable(true);
  const inventory = inventorySignature(await readVerifiedInventory(f.container));
  let fileWrites = 0, directoryCreates = 0, saveCalls = 0, completed = 0;
  f.container.setHooks({ onBeforeWrite: () => { fileWrites++; } });
  const getDirectory = f.vault.getDirectory.bind(f.vault);
  f.vault.getDirectory = async (path, options) => {
    if (options?.create) directoryCreates++;
    return getDirectory(path, options);
  };
  const ui = render(<KnowledgeAuthoring state={selected.state} enabled busy={false} onCreate={async input => {
    saveCalls++; await selected.session.create(input); completed++;
  }} />);
  const change = (label: string, value: string) => fireEvent.change(ui.getByLabelText(label), { target: { value } });
  const reject = async () => {
    fireEvent.submit(ui.getByRole('form', { name: 'New knowledge record' }));
    await waitFor(() => assert.match(ui.getByRole('alert').textContent!, /large integer identifiers as quoted strings/));
    assert.equal(saveCalls, 0); assert.equal(fileWrites, 0); assert.equal(directoryCreates, 0);
  };
  change('Knowledge schema', 'generic.observation');
  change('Observation description', 'Original observation');
  change('Attributes (JSON object, optional)', '{"measurementId":9007199254740993}');
  await reject();
  change('Attributes (JSON object, optional)', '{"nested":[{"id":-9.007199254740993e15}]}');
  await reject();
  change('Knowledge schema', 'cad.design-change');
  change('Problem statement', 'Problem'); change('Change description', 'Change'); change('Engineering rationale', 'Rationale');
  fireEvent.click(ui.getByRole('button', { name: 'Add property change' }));
  change('Property 1 property', 'identifier'); change('Property 1 before', '9007199254740993.0'); change('Property 1 after', '8');
  await reject();
  change('Property 1 before', '6'); change('Property 1 after', '-90071992547409930e-1');
  await reject();
  assert.equal(inventorySignature(await readVerifiedInventory(f.container)), inventory);
  assert.deepEqual((await selected.session.reload()).knowledge!.records, [previous]);

  change('Property 1 before', '9007199254740991'); change('Property 1 after', '"9007199254740993"');
  fireEvent.submit(ui.getByRole('form', { name: 'New knowledge record' }));
  await waitFor(() => assert.equal(completed, 1));
  change('Knowledge schema', 'generic.observation'); change('Observation description', 'Quoted identifier');
  change('Attributes (JSON object, optional)', '{"id":"9007199254740993","count":-9007199254740991,"ratio":1.25}');
  fireEvent.submit(ui.getByRole('form', { name: 'New knowledge record' }));
  await waitFor(() => assert.equal(completed, 2));
  const reopened = await openExistingVault(f.vault);
  assert.equal(reopened.knowledge!.records.length, 3);
  const savedCad = reopened.knowledge!.records.find(r => r.record.recordType === 'cad.design-change')!;
  assert.deepEqual(savedCad.record.payload.propertyChanges, [{ property: 'identifier', before: Number.MAX_SAFE_INTEGER, after: '9007199254740993' }]);
  const savedGeneric = reopened.knowledge!.records.find(r => r.record.payload.description === 'Quoted identifier')!;
  assert.deepEqual(savedGeneric.record.payload.attributes, { id: '9007199254740993', count: Number.MIN_SAFE_INTEGER, ratio: 1.25 });
  assert.deepEqual(reopened.knowledge!.records.find(r => r.record.recordId === previous.record.recordId), previous);
  assert.equal(await f.vault.readFileText(previous.source.recordPath.split('/')), previousBytes);
  assert.ok(fileWrites > 0 && directoryCreates > 0 && saveCalls === 2);
});
