import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeRetrievalFixture } from '../../tests/knowledge-retrieval-fixture';
import { retrieveKnowledge, getComponentKnowledgeTimeline } from './retrieval';
import { buildKnowledgeIndex } from './index';
import { createKnowledgeRecord, createKnowledgeSchemaRegistry, type JsonObject } from './records';
import { initializeProjectVault, openExistingVault } from '../engine/vault-service';
import { InMemoryFileSystemAdapter } from '../engine/fs-adapter';
import { getObjectPathSegments } from '../engine/object-store';
import { inventorySignature, readVerifiedInventory } from '../engine/copy-service';
import { componentChecksum } from '../engine/component-identity';

test('retrieves original M1A notes and M1B records using structured type/source/text/identity filters', async () => {
  const f = await knowledgeRetrievalFixture();
  for (const kind of ['problem', 'modification', 'observations'] as const) {
    const result = retrieveKnowledge(f.state, { projectId: f.projectId, sourceType: 'm1a-derived', recordType: `m1a.${kind}` });
    assert.equal(result.recordOutcome, 'matches');
    assert.ok(result.records.every(r => r.sourceType === 'm1a-derived' && r.content.kind === kind));
  }
  const design = retrieveKnowledge(f.state, { projectId: f.projectId, recordType: 'cad.design-change', text: '8 mm' });
  assert.equal(design.records.length, 1);
  assert.deepEqual(design.records[0].content, f.design.record);
  assert.deepEqual(design.records[0].source, f.design.source);
  assert.deepEqual(retrieveKnowledge(await openExistingVault(f.vault), { projectId: f.projectId, recordType: 'cad.design-change', text: '8 mm' }), design, 'reopening preserves source content, hashes and retrieval');
  assert.equal(retrieveKnowledge(f.state, { projectId: f.projectId, sourceType: 'm1b-persisted', recordType: 'generic.observation' }).records.length, 6);
  const literal = retrieveKnowledge(f.state, { projectId: f.projectId, recordType: 'm1a.observations', text: 'Prototype [A].*' });
  assert.equal(literal.records.length, 3);
  assert.equal(retrieveKnowledge(f.state, { projectId: f.projectId, recordType: 'm1a.observations', text: 'prototype [A].*' }).recordOutcome, 'empty');
  assert.equal(retrieveKnowledge(f.state, { projectId: f.projectId, text: f.projectId }).records.length, 0, 'technical IDs are not text search values');
});

test('component timeline spans branches, retains verified renames, and never assigns project/revision/reference-only assertions', async () => {
  const f = await knowledgeRetrievalFixture();
  const timeline = getComponentKnowledgeTimeline(f.state, { projectId: f.projectId, componentId: f.componentId });
  assert.equal(timeline.componentIdentity?.status, 'available');
  assert.equal(timeline.events.length, 5);
  assert.deepEqual(new Set(timeline.events.map(e => e.context.branchId)), new Set(['branch-main', f.branchId]));
  assert.equal(timeline.events.find(e => e.context.revisionId === f.firstId)!.context.component!.historicalPath, 'collar.SLDPRT');
  assert.equal(timeline.events.find(e => e.context.revisionId === f.renamedId)!.context.component!.historicalPath, 'collar_plate.SLDPRT');
  assert.ok(timeline.records.filter(r => r.sourceType === 'm1a-derived').every(r => r.content.scope === 'file' && r.content.componentId === f.componentId));
  const ids = timeline.records.map(r => r.id);
  assert.ok(ids.includes(f.design.record.recordId) && ids.includes(f.observation.record.recordId));
  for (const record of [f.projectOnly, f.revisionOnly, f.linked, f.referenceRecord]) assert.ok(!ids.includes(record.record.recordId));
  assert.ok(timeline.contexts.every(c => c.ancestry.availability.status === 'available'));
  assert.deepEqual(new Set(timeline.contexts.find(c => c.revisionId === f.alternativeId)!.ancestry.ancestry), new Set([f.alternativeId, f.firstId]));
  assert.ok(timeline.records.every(r => r.verification.claims === 'not_verified'));
});

test('same filename is not component identity; compound filters must match the same explicit historical context', async () => {
  const f = await knowledgeRetrievalFixture();
  const unrelated = getComponentKnowledgeTimeline(f.state, { projectId: f.projectId, componentId: f.unrelatedComponentId });
  assert.equal(unrelated.events.length, 1);
  assert.equal(unrelated.events[0].context.revisionId, f.unrelatedId);
  assert.ok(unrelated.records.filter(r => r.sourceType === 'm1a-derived').every(r => r.content.text.includes('Unrelated') || r.content.text === 'Independent design' || r.content.status === 'empty'));
  const branch = retrieveKnowledge(f.state, { projectId: f.projectId, componentId: f.componentId, branchId: f.branchId });
  assert.ok(branch.records.every(r => r.contexts.every(c => c.component?.componentId === f.componentId && c.branchId === f.branchId)));
  assert.ok(!branch.records.some(r => r.id === f.mixed.record.recordId), 'a component link on Main plus an unrelated revision link on Alternative cannot form an implicit component/branch link');
  const name = retrieveKnowledge(f.state, { projectId: f.projectId, componentId: 'collar.SLDPRT' });
  assert.equal(name.coverage, 'unavailable'); assert.equal(name.componentIdentity?.status, 'unavailable');
});

test('reference-context-only revisions survive without file notes and keep exact original versions/locators/provenance', async () => {
  const f = await knowledgeRetrievalFixture();
  const timeline = getComponentKnowledgeTimeline(f.state, { projectId: f.projectId, componentId: f.componentId });
  const event = timeline.events.find(e => e.context.revisionId === f.referenceOnlyId)!;
  assert.equal(event.records.length, 0);
  assert.equal(event.references.length, 1);
  assert.equal(event.references[0].attachment.versionId, f.v2.versionId);
  assert.equal(event.references[0].attachment.locator, 'Page 7, figure 1');
  const first = timeline.references.find(r => r.revisionId === f.firstId)!;
  assert.equal(first.attachment.referenceId, f.ref.referenceId);
  assert.equal(first.attachment.versionId, f.v1.versionId);
  assert.equal(first.attachment.locator, 'Page 4, figure 2');
  for (const reference of timeline.references) {
    assert.equal(reference.attachment.content.status, 'unavailable');
    const context = JSON.parse(await f.vault.readFileText(reference.attachment.source.recordPath.split('/')));
    const source = context.links[Number(reference.attachment.source.jsonPointer.split('/')[2])];
    assert.equal(source.versionId, reference.attachment.versionId);
    assert.equal(source.locator, reference.attachment.locator);
    if (reference.origin === 'persisted-relationship') {
      assert.equal(reference.relation, 'evidence');
      assert.ok(reference.relationshipSource?.recordSha256);
    }
  }
  assert.ok(timeline.references.some(r => r.origin === 'persisted-relationship' && r.recordId === f.design.record.recordId));
});

test('direct record-to-record retrieval preserves exact binding without transitive component attribution', async () => {
  const f = await knowledgeRetrievalFixture();
  const result = retrieveKnowledge(f.state, { projectId: f.projectId, relatedRecordId: f.design.record.recordId });
  assert.deepEqual(result.records.map(r => r.id), [f.linked.record.recordId]);
  assert.deepEqual(result.records[0].content, f.linked.record);
  const component = retrieveKnowledge(f.state, { projectId: f.projectId, componentId: f.componentId, relatedRecordId: f.design.record.recordId });
  assert.equal(component.recordOutcome, 'empty');
});

test('readable empty queries differ from unknown scopes and partial reconstruction', async () => {
  const vault = new InMemoryFileSystemAdapter('Empty Vault');
  const state = await initializeProjectVault(new InMemoryFileSystemAdapter('Working'), vault, 'Empty');
  const empty = retrieveKnowledge(state, { projectId: state.project.projectId });
  assert.equal(empty.recordOutcome, 'empty'); assert.equal(empty.coverage, 'readable');
  assert.ok(empty.limitations.some(l => l.includes('does not establish')));
  assert.equal(retrieveKnowledge(state, { projectId: 'wrong-project' }).coverage, 'unavailable');
  assert.equal(retrieveKnowledge(state, { projectId: state.project.projectId, revisionId: 'missing' }).coverage, 'unavailable');
  assert.equal(retrieveKnowledge(state, { projectId: state.project.projectId, branchId: 'missing' }).coverage, 'unavailable');
  assert.throws(() => getComponentKnowledgeTimeline(state, { projectId: state.project.projectId } as never), /component ID/);
  const partial = structuredClone(state); delete partial.knowledge;
  assert.equal(retrieveKnowledge(partial, { projectId: state.project.projectId, sourceType: 'm1b-persisted' }).coverage, 'unavailable');
  assert.throws(() => retrieveKnowledge(state, 'describe the project' as never), /structured/);
});

test('unsupported and damaged persisted data cannot disappear behind literal/type/component filters', async () => {
  const f = await knowledgeRetrievalFixture(), schemas = createKnowledgeSchemaRegistry();
  schemas.register('generic.observation', 2, (v): v is JsonObject => typeof v === 'object' && v !== null);
  const future = await createKnowledgeRecord(f.vault, { projectId: f.projectId, recordType: 'generic.observation', schemaVersion: 2, payload: { future: 'Unknown schema' }, relationships: [], provenance: { kind: 'user-entered' } }, schemas);
  await f.vault.writeFileText(f.design.source.recordPath.split('/'), '{broken');
  const state = await openExistingVault(f.vault);
  const result = retrieveKnowledge(state, { projectId: f.projectId, recordType: 'cad.design-change', componentId: f.componentId, text: 'No such recorded text' });
  assert.equal(result.recordOutcome, 'empty'); assert.equal(result.coverage, 'incomplete');
  assert.ok(result.issues.some(i => i.recordId === future.record.recordId && i.status === 'unsupported'));
  assert.ok(result.issues.some(i => i.recordId === future.record.recordId && i.recordType === 'generic.observation' && i.schemaVersion === 2));
  assert.ok(result.issues.some(i => i.recordId === f.design.record.recordId && i.status === 'unavailable'));
  assert.ok(!result.records.some(r => r.id === future.record.recordId));
  assert.ok(await f.vault.hasFile(future.source.recordPath.split('/')));
});

test('ambiguous component mappings remain unavailable rather than joining unrelated same-name files', async () => {
  const f = await knowledgeRetrievalFixture();
  const path = ['components', 'revisions', `${f.unrelatedId}.json`];
  const mapping = JSON.parse(await f.vault.readFileText(path));
  mapping.files[1].componentId = mapping.files[0].componentId;
  mapping.payloadSha256 = componentChecksum(mapping);
  await f.vault.writeFileText(path, JSON.stringify(mapping));
  const state = await openExistingVault(f.vault);
  assert.equal(state.components?.status, 'unavailable');
  const result = getComponentKnowledgeTimeline(state, { projectId: f.projectId, componentId: f.componentId });
  assert.equal(result.coverage, 'unavailable'); assert.deepEqual(result.events, []);
  assert.ok(result.issues.some(i => i.code === 'component_identity'));
});

test('unpublished records produce incomplete coverage, whereas a readable nonmatching branch intersection is empty', async () => {
  const f = await knowledgeRetrievalFixture();
  const empty = retrieveKnowledge(f.state, { projectId: f.projectId, componentId: f.componentId, revisionId: f.firstId, branchId: f.branchId });
  assert.equal(empty.recordOutcome, 'empty'); assert.equal(empty.coverage, 'readable');
  const directory = f.vault.getDirectory.bind(f.vault);
  f.vault.getDirectory = async (path, options) => {
    if (path[0] === 'knowledge' && path[1] === 'completed' && options?.exclusiveCreate) throw new Error('Interrupted publication');
    return directory(path, options);
  };
  await assert.rejects(createKnowledgeRecord(f.vault, { projectId: f.projectId, recordType: 'generic.observation', schemaVersion: 1, payload: { description: 'Unpublished' }, relationships: [], provenance: { kind: 'user-entered' } }), /Interrupted/);
  const state = await openExistingVault(f.vault);
  const result = retrieveKnowledge(state, { projectId: f.projectId, sourceType: 'm1b-persisted', text: 'Unpublished' });
  assert.equal(result.recordOutcome, 'empty'); assert.equal(result.coverage, 'incomplete');
  assert.ok(result.issues.some(i => i.status === 'incomplete' && i.recordId));
});

test('missing reference content returns valid recorded notes with incomplete evidence, never verified document bytes', async () => {
  const f = await knowledgeRetrievalFixture();
  await f.vault.removeEntry(getObjectPathSegments(f.v1.sha256));
  const state = await openExistingVault(f.vault);
  const result = getComponentKnowledgeTimeline(state, { projectId: f.projectId, componentId: f.componentId });
  assert.equal(result.componentIdentity?.status, 'available'); assert.equal(result.coverage, 'incomplete');
  assert.ok(result.records.some(r => r.sourceType === 'm1a-derived'));
  assert.equal(result.references.length, 0);
  assert.ok(result.issues.some(i => i.code === 'reference_context'));
});

test('unsupported component evidence is unavailable identity, never a fallback to historical filenames', async () => {
  const f = await knowledgeRetrievalFixture();
  const ready = JSON.parse(await f.vault.readFileText(['components', 'ready.json'])); ready.schemaVersion = 99;
  await f.vault.writeFileText(['components', 'ready.json'], JSON.stringify(ready));
  const state = await openExistingVault(f.vault);
  const result = getComponentKnowledgeTimeline(state, { projectId: f.projectId, componentId: f.componentId });
  assert.equal(result.componentIdentity?.status, 'unsupported'); assert.equal(result.coverage, 'unavailable');
  assert.deepEqual(result.events, []); assert.deepEqual(result.records, []);
  const project = retrieveKnowledge(state, { projectId: f.projectId, sourceType: 'm1a-derived' });
  assert.ok(project.records.length > 0);
  const referenceOnly = retrieveKnowledge(state, { projectId: f.projectId, revisionId: f.referenceOnlyId, sourceType: 'm1a-derived' });
  assert.equal(referenceOnly.references.length, 0, 'reconstruction withholds associations that cannot verify component evidence');
  assert.equal(referenceOnly.coverage, 'incomplete');
  assert.ok(referenceOnly.issues.some(i => i.code === 'reference_context'));
  assert.ok(referenceOnly.issues.some(i => i.code === 'component_evidence' && i.status === 'unsupported'), 'reference-only contexts must not hide unavailable component verification');
  await f.vault.removeEntry(['components'], { recursive: true });
  const legacy = getComponentKnowledgeTimeline(await openExistingVault(f.vault), { projectId: f.projectId, componentId: f.componentId });
  assert.equal(legacy.componentIdentity?.status, 'not_recorded'); assert.equal(legacy.coverage, 'unavailable');
});

test('missing committed revision/ancestry damage remains explicit beside readable descendant metadata', async () => {
  const f = await knowledgeRetrievalFixture();
  await f.vault.removeEntry(['revisions', `${f.firstId}.manifest.json`]);
  const state = await openExistingVault(f.vault);
  const result = retrieveKnowledge(state, { projectId: f.projectId, revisionId: f.alternativeId, sourceType: 'm1a-derived' });
  assert.ok(result.records.length > 0); assert.equal(result.coverage, 'incomplete');
  assert.equal(result.contexts[0].ancestry.availability.status, 'unavailable');
  assert.ok(result.issues.some(i => i.code === 'ancestry'));
});

test('repeated queries, reordered collections and tied timestamps preserve deterministic chronology without I/O or mutation', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-08T08:00:00Z') });
  const f = await knowledgeRetrievalFixture();
  t.mock.timers.reset();
  const before = JSON.stringify(f.state), vault = inventorySignature(await readVerifiedInventory(f.vault));
  const folders = await Promise.all(Object.values(f.folders).map(async folder => inventorySignature(await readVerifiedInventory(folder))));
  let writes = 0;
  f.vault.setHooks({ onBeforeWrite: () => { writes++; } });
  f.main.setHooks({ onBeforeWrite: () => { writes++; } });
  function freeze(value: object) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); }
  freeze(f.state);
  const query = { projectId: f.projectId, componentId: f.componentId };
  const result = getComponentKnowledgeTimeline(f.state, query);
  const shuffled = structuredClone(f.state); shuffled.revisions.reverse(); shuffled.branches.reverse(); shuffled.knowledge!.records.reverse();
  assert.deepEqual(getComponentKnowledgeTimeline(shuffled, query), result);
  assert.deepEqual(getComponentKnowledgeTimeline(f.state, query), result);
  const order = result.events.map(e => `${e.context.branchId}\0${e.context.revisionId}`);
  assert.deepEqual(order, [...order].sort());
  result.events[0].context.component!.historicalPath = 'Consumer edit';
  assert.equal(JSON.stringify(f.state), before);
  assert.equal(writes, 0);
  assert.equal(inventorySignature(await readVerifiedInventory(f.vault)), vault);
  assert.deepEqual(await Promise.all(Object.values(f.folders).map(async folder => inventorySignature(await readVerifiedInventory(folder)))), folders);
  assert.equal(buildKnowledgeIndex(f.state).records.length > 0, true);
});
