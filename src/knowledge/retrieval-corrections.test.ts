import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeRetrievalFixture } from '../../tests/knowledge-retrieval-fixture';
import { captureRetrievalHistory } from '../../tests/knowledge-retrieval-benchmark';
import { getComponentKnowledgeTimeline, retrieveKnowledge } from './retrieval';
import { buildKnowledgeIndex } from './index';
import { createKnowledgeRecord, type JsonObject, type KnowledgeRelationshipInput } from './records';
import { canonicalJson } from './records/json';
import { initializeProjectVault, openExistingVault } from '../engine/vault-service';
import { InMemoryFileSystemAdapter } from '../engine/fs-adapter';
import { captureRevision } from '../engine/revision-service';
import { getBranchBaseline } from '../engine/branch-state';
import { scanBranchChanges } from '../engine/scanner';
import { createReferenceReview, updateProjectReference } from '../engine/references';
import { inventorySignature, readVerifiedInventory } from '../engine/copy-service';

test('F1 component ownership preserves applicable broader citations and explicit evidence with original scopes', async () => {
  const f = await knowledgeRetrievalFixture();
  const state = await updateProjectReference(f.vault, f.projectId, f.ref.referenceId, { projectVersionId: f.v1.versionId });
  const scan = await scanBranchChanges(f.main, 'branch-main', getBranchBaseline(state, 'branch-main'));
  const capture = await captureRevision(f.main, f.vault, { branchId: 'branch-main', workingFolders: f.folders, summary: 'Mixed reference scopes',
    notes: { problem: '', modification: '', observations: '' },
    fileNotes: [{ path: 'collar_plate.SLDPRT', problem: 'Component A problem', modification: '', observations: '' }],
    referenceReview: createReferenceReview(state, scan, [
      { referenceId: f.ref.referenceId, versionId: f.v2.versionId, locator: 'Section 2', explanation: 'Revision context' },
      { referenceId: f.ref.referenceId, versionId: f.v2.versionId, locator: 'Figure A', explanation: 'Component A context', component: { kind: 'existing', componentId: f.componentId } },
      { referenceId: f.ref.referenceId, versionId: f.v1.versionId, locator: 'Table B', explanation: 'Unrelated B context', component: { kind: 'existing', componentId: f.unrelatedComponentId } },
    ]),
  });
  const revisionId = capture.revision.manifest.revisionId;
  const context = buildKnowledgeIndex(capture.vaultState).revisions.find(r => r.revisionId === revisionId)!;
  const links: KnowledgeRelationshipInput[] = [
    { relation: 'related', target: { kind: 'component', projectId: f.projectId, revisionId, componentId: f.componentId } },
    ...context.referenceContext.attachments.filter(a => a.componentId !== f.unrelatedComponentId).map(a => ({ relation: 'evidence' as const,
      target: { kind: 'reference-version' as const, projectId: f.projectId, revisionId, referenceId: a.referenceId, versionId: a.versionId, associationPointer: a.source.jsonPointer } })),
  ];
  const published = await createKnowledgeRecord(f.vault, { projectId: f.projectId, recordType: 'generic.observation', schemaVersion: 1,
    payload: { description: 'Recorded component observation' }, relationships: links, provenance: { kind: 'user-entered' } });
  // A component link alone must not automatically add revision/project citations to an M1B record.
  const withoutCitation = await createKnowledgeRecord(f.vault, { projectId: f.projectId, recordType: 'generic.observation', schemaVersion: 1,
    payload: { description: 'No explicit citations' }, relationships: links.slice(0, 1), provenance: { kind: 'user-entered' } });
  const reopened = await openExistingVault(f.vault);
  const before = inventorySignature(await readVerifiedInventory(f.vault));
  for (const filters of [{}, { revisionId }, { branchId: 'branch-main' }, { revisionId, branchId: 'branch-main' }]) {
    const result = retrieveKnowledge(reopened, { projectId: f.projectId, componentId: f.componentId, ...filters });
    const record = result.records.find(r => r.id === published.record.recordId)!;
    assert.equal(record.references.length, 3, 'explicit project, revision and component citations survive');
    assert.deepEqual(new Set(record.references.map(r => r.attachment.scope)), new Set(['project', 'revision', 'component']));
    assert.ok(record.references.every(r => r.relation === 'evidence' && r.origin === 'persisted-relationship'));
    assert.ok(record.references.every(r => r.attachment.componentId === null || r.attachment.componentId === f.componentId));
    for (const ref of record.references) {
      const original = context.referenceContext.attachments.find(a => a.source.jsonPointer === ref.attachment.source.jsonPointer)!;
      assert.equal(ref.attachment.versionId, original.versionId);
      assert.equal(ref.attachment.locator, original.locator);
      assert.equal(ref.attachment.sha256, original.sha256);
      assert.equal(ref.attachment.origin, original.origin);
      assert.deepEqual(ref.attachment.source, original.source);
      assert.deepEqual(result.references.find(r => r.id === ref.id), ref);
      assert.equal(ref.verification.attachmentBytes, 'not_checked');
      assert.equal(ref.verification.claims, 'not_verified');
    }
    assert.deepEqual(result.records.find(r => r.id === withoutCitation.record.recordId)!.references, []);
    const note = result.records.find(r => r.sourceType === 'm1a-derived' && r.content.text === 'Component A problem')!;
    assert.equal(note.references.length, 3, 'M1A context applicability comes from its original attachment collection');
    assert.ok(note.references.every(r => r.relation === 'context' && r.origin === 'revision-context'));
    if (note.sourceType === 'm1a-derived') assert.deepEqual(note.references.map(r => r.attachment), note.content.attachments);
    assert.ok(!result.references.some(r => r.attachment.componentId === f.unrelatedComponentId));
    assert.ok(result.references.filter(r => r.attachment.scope !== 'component').every(r => r.attachment.componentId === null && r.attachment.componentPath === null));
  }
  assert.equal(retrieveKnowledge(reopened, { projectId: f.projectId, componentId: f.componentId, revisionId, branchId: f.branchId }).records.length, 0);
  assert.equal(inventorySignature(await readVerifiedInventory(f.vault)), before);
  const alternativeReference = buildKnowledgeIndex(reopened).revisions.find(r => r.revisionId === f.alternativeId)!.referenceContext.attachments[0];
  const crossContext = await createKnowledgeRecord(f.vault, { projectId: f.projectId, recordType: 'generic.observation', schemaVersion: 1,
    payload: { description: 'Main assertion cites an exact alternative-branch source' }, provenance: { kind: 'user-entered' }, relationships: [links[0],
      { relation: 'evidence', target: { kind: 'reference-version', projectId: f.projectId, revisionId: f.alternativeId,
        referenceId: alternativeReference.referenceId, versionId: alternativeReference.versionId, associationPointer: alternativeReference.source.jsonPointer } },
    ] });
  const crossResult = retrieveKnowledge(await openExistingVault(f.vault), { projectId: f.projectId, componentId: f.componentId, revisionId, branchId: 'branch-main', recordId: crossContext.record.recordId });
  assert.equal(crossResult.records.length, 1);
  assert.ok(crossResult.records[0].contexts.every(c => c.revisionId === revisionId && c.branchId === 'branch-main'));
  const citation = crossResult.records[0].references[0];
  assert.equal(citation.revisionId, f.alternativeId);
  assert.equal(citation.branchId, f.branchId);
  assert.equal(citation.attachment.locator, 'Page 7, figure 1');
  assert.deepEqual(crossResult.references.find(r => r.id === citation.id), citation);
});

test('F1 timeline citations follow their citing records while independent context stays at its source event', async () => {
  const f = await knowledgeRetrievalFixture();
  const source = buildKnowledgeIndex(f.state).revisions.find(r => r.revisionId === f.alternativeId)!.referenceContext.attachments[0];
  const publish = (description: string, componentId: string) => createKnowledgeRecord(f.vault, {
    projectId: f.projectId, recordType: 'generic.observation', schemaVersion: 1, payload: { description }, provenance: { kind: 'user-entered' },
    relationships: [
      { relation: 'related', target: { kind: 'component', projectId: f.projectId, revisionId: f.unrelatedId, componentId } },
      { relation: 'evidence', target: { kind: 'reference-version', projectId: f.projectId, revisionId: f.alternativeId,
        referenceId: source.referenceId, versionId: source.versionId, associationPointer: source.source.jsonPointer } },
    ],
  });
  const first = await publish('Main component assertion citing Alternative', f.componentId);
  const second = await publish('Another Main assertion citing the same source', f.componentId);
  const unrelated = await publish('Unrelated component assertion citing Alternative', f.unrelatedComponentId);
  const state = await openExistingVault(f.vault);
  const before = JSON.stringify(state);
  const directories = [f.vault, ...Object.values(f.folders)];
  const inventories = await Promise.all(directories.map(async d => inventorySignature(await readVerifiedInventory(d))));
  let writes = 0;
  f.vault.setHooks({ onBeforeWrite: () => { writes++; } });
  f.main.setHooks({ onBeforeWrite: () => { writes++; } });
  function freeze(value: object) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); }
  freeze(state);
  for (const filters of [{}, { revisionId: f.unrelatedId }, { branchId: 'branch-main' }, { revisionId: f.unrelatedId, branchId: 'branch-main' }]) {
    const timeline = getComponentKnowledgeTimeline(state, { projectId: f.projectId, componentId: f.componentId, ...filters });
    const owner = timeline.events.find(e => e.context.revisionId === f.unrelatedId)!;
    assert.ok(owner.records.some(r => r.id === first.record.recordId));
    assert.ok(owner.records.some(r => r.id === second.record.recordId));
    assert.ok(!timeline.records.some(r => r.id === unrelated.record.recordId));
    const citations = owner.records.filter(r => r.id === first.record.recordId || r.id === second.record.recordId).flatMap(r => r.references);
    assert.equal(citations.length, 2, 'separate explicit relationships retain separate provenance identities');
    for (const citation of citations) {
      assert.equal(citation.revisionId, f.alternativeId);
      assert.equal(citation.branchId, f.branchId);
      assert.equal(citation.relation, 'evidence');
      assert.equal(citation.origin, 'persisted-relationship');
      assert.equal(citation.attachment.referenceId, source.referenceId);
      assert.equal(citation.attachment.versionId, source.versionId);
      assert.equal(citation.attachment.locator, 'Page 7, figure 1');
      assert.equal(citation.attachment.sha256, source.sha256);
      assert.deepEqual(citation.attachment.source, source.source);
      assert.equal(citation.verification.attachmentBytes, 'not_checked');
      assert.equal(citation.verification.claims, 'not_verified');
      assert.deepEqual(owner.references.find(r => r.id === citation.id), citation, 'owning Main event retains the exact citation');
      assert.deepEqual(timeline.references.find(r => r.id === citation.id), citation);
      assert.ok(!timeline.events.find(e => e.context.revisionId === f.alternativeId)?.references.some(r => r.id === citation.id), 'source location alone does not make a citation applicable to that event');
    }
    for (const event of timeline.events) {
      assert.equal(event.references.length, new Set(event.references.map(r => r.id)).size, 'event references deduplicate by retrieved identity');
      for (const ref of timeline.references.filter(r => r.origin === 'revision-context' && r.revisionId === event.context.revisionId)) assert.deepEqual(event.references.find(r => r.id === ref.id), ref, 'independent context remains in its own event');
      for (const record of event.records) for (const ref of record.references) assert.deepEqual(event.references.find(r => r.id === ref.id), ref);
      for (const ref of event.references) {
        assert.deepEqual(timeline.references.find(r => r.id === ref.id), ref);
        assert.ok(ref.origin === 'revision-context' && ref.revisionId === event.context.revisionId || event.records.some(r => r.references.some(a => a.id === ref.id)));
        assert.notEqual(ref.recordId, unrelated.record.recordId);
      }
    }
    const alternative = timeline.events.find(e => e.context.revisionId === f.alternativeId);
    if (!Object.keys(filters).length) assert.ok(alternative, 'the unfiltered timeline includes the source event');
    if (alternative) {
      assert.ok(!alternative.records.some(r => r.id === first.record.recordId || r.id === second.record.recordId));
      const independent = alternative.references.find(r => r.origin === 'revision-context')!;
      assert.equal(independent.relation, 'context');
      assert.deepEqual(independent.attachment, source);
      assert.ok(alternative.records.filter(r => r.sourceType === 'm1a-derived').length > 1);
      assert.equal(alternative.references.filter(r => r.id === independent.id).length, 1, 'shared M1A note citations and independent context produce one identity');
    }
    assert.deepEqual(getComponentKnowledgeTimeline(state, { projectId: f.projectId, componentId: f.componentId, ...filters }), timeline);
  }
  const query = { projectId: f.projectId, componentId: f.componentId, revisionId: f.unrelatedId, branchId: 'branch-main' };
  const reversed = structuredClone(state); reversed.revisions.reverse(); reversed.branches.reverse(); reversed.knowledge!.records.reverse();
  assert.deepEqual(getComponentKnowledgeTimeline(reversed, query), getComponentKnowledgeTimeline(state, query));
  assert.deepEqual(getComponentKnowledgeTimeline(state, { ...query, branchId: f.branchId }).events, []);
  assert.equal(JSON.stringify(state), before);
  assert.equal(writes, 0);
  assert.deepEqual(await Promise.all(directories.map(async d => inventorySignature(await readVerifiedInventory(d)))), inventories);
});

test('F2 valid storage-depth payloads retrieve without serializing wrappers or changing envelopes/checksums', async () => {
  const vault = new InMemoryFileSystemAdapter('Deep Vault');
  const state = await initializeProjectVault(new InMemoryFileSystemAdapter('Deep Working'), vault, 'Deep records');
  const projectId = state.project.projectId;
  let attributes: JsonObject = { value: 'Deep literal' };
  for (let n = 0; n < 61; n++) attributes = { nested: attributes };
  const deep = await createKnowledgeRecord(vault, { projectId, recordType: 'generic.observation', schemaVersion: 1,
    payload: { description: 'Deep payload', attributes }, relationships: [], provenance: { kind: 'user-entered' } });
  const shallow = await createKnowledgeRecord(vault, { projectId, recordType: 'generic.observation', schemaVersion: 1,
    payload: { description: 'Shallow payload' }, relationships: [], provenance: { kind: 'user-entered' } });
  assert.throws(() => canonicalJson(deep), /maximum nesting/, 'the published wrapper exceeds the storage-envelope limit, not the record');
  const before = await vault.readFileText(deep.source.recordPath.split('/'));
  const reopened = await openExistingVault(vault);
  assert.equal(reopened.knowledge?.records.length, 2);
  const result = retrieveKnowledge(reopened, { projectId });
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.find(r => r.id === deep.record.recordId)!.content, deep.record);
  assert.deepEqual(result.records.find(r => r.id === deep.record.recordId)!.source, deep.source);
  assert.equal(retrieveKnowledge(reopened, { projectId, text: 'Deep literal' }).records.length, 1);
  assert.deepEqual(retrieveKnowledge(reopened, { projectId, sourceType: 'm1a-derived' }).records, []);
  const shuffled = structuredClone(reopened); shuffled.knowledge!.records.reverse(); shuffled.revisions.reverse(); shuffled.branches.reverse();
  assert.deepEqual(retrieveKnowledge(shuffled, { projectId }), result);
  // Even a present M1B collection is not visited for an M1A-only query.
  const m1aOnly = { ...reopened, knowledge: new Proxy(reopened.knowledge!, { get(target, key) { if (key === 'records') throw new Error('Unnecessary M1B access'); return Reflect.get(target, key); } }) };
  assert.deepEqual(retrieveKnowledge(m1aOnly, { projectId, sourceType: 'm1a-derived' }).records, []);
  assert.equal(await vault.readFileText(deep.source.recordPath.split('/')), before);
  assert.equal(canonicalJson(deep.record), before);
  await vault.writeFileText(shallow.source.recordPath.split('/'), '{corrupt');
  const damaged = retrieveKnowledge(await openExistingVault(vault), { projectId });
  assert.deepEqual(damaged.records.map(r => r.id), [deep.record.recordId]);
  assert.equal(damaged.coverage, 'incomplete');
  assert.ok(damaged.issues.some(i => i.recordId === shallow.record.recordId && i.status === 'unavailable'));
});

test('F2 duplicate accepted identities remain unavailable independently of input order', async () => {
  const f = await knowledgeRetrievalFixture();
  const state = structuredClone(f.state);
  state.knowledge!.records.push(structuredClone(f.design));
  const query = { projectId: f.projectId, recordId: f.design.record.recordId };
  const result = retrieveKnowledge(state, query);
  assert.deepEqual(result.records, []);
  assert.equal(result.coverage, 'incomplete');
  assert.ok(result.issues.some(i => i.recordId === f.design.record.recordId && i.code === 'persisted_identity'));
  state.knowledge!.records.reverse();
  assert.deepEqual(retrieveKnowledge(state, query), result);
});

test('F3 10/50/100 genuine revisions require only one projection per query, with no timing threshold', async () => {
  const snapshots = await captureRetrievalHistory();
  for (const [count, state] of snapshots) {
    const componentId = Object.values(state.components!.revisions)[0].files[0].componentId;
    let noteReads = 0;
    const measured = { ...state, revisions: state.revisions.map(r => ({ ...r, manifest: new Proxy(r.manifest, { get(target, key) {
      if (key === 'notes') noteReads++;
      return Reflect.get(target, key);
    } }) })) };
    for (const filter of [{ text: 'Problem' }, { componentId }]) {
      noteReads = 0;
      const result = retrieveKnowledge(measured, { projectId: state.project.projectId, ...filter });
      assert.equal(result.coverage, 'readable');
      assert.equal(result.records.length, 'componentId' in filter ? 3 * count : count);
      assert.ok(noteReads <= 4 * count, `${count} revisions: repeated full projections reread ${noteReads} note objects`);
      const reversed = { ...state, revisions: [...state.revisions].reverse(), branches: [...state.branches].reverse() };
      assert.deepEqual(retrieveKnowledge(reversed, { projectId: state.project.projectId, ...filter }), result);
    }
  }
});
