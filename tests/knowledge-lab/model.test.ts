import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKnowledgeIndex } from '../../src/knowledge';
import { collarId, syntheticKnowledgeState } from './fixture';
import { componentAvailability, emptyFilters, filterKnowledge, revisionComponents } from './view-model';

test('deterministic fixture preserves note-independent references and explicit evidence states', () => {
  const state = syntheticKnowledgeState(), before = JSON.stringify(state);
  const index = buildKnowledgeIndex(state);
  assert.deepEqual(buildKnowledgeIndex(syntheticKnowledgeState()), index);
  assert.equal(JSON.stringify(state), before);
  const alternative = index.revisions.find(r => r.revisionId === 'r03')!;
  assert.equal(index.records.filter(n => n.revisionId === 'r03' && n.scope === 'file').length, 0);
  assert.equal(alternative.referenceContext.attachments[0].componentId, collarId);
  assert.equal(alternative.referenceContext.attachments[0].source.jsonPointer, '/links/0');
  assert.equal(alternative.referenceContext.attachments[0].content.status, 'unavailable');
  assert.deepEqual(new Set(index.revisions.flatMap(r => [r.notes.status, r.fileNotes.status, r.referenceContext.availability.status])), new Set(['available', 'unavailable', 'unsupported', 'not_recorded']));
  assert.deepEqual(new Set(alternative.history.ancestry), new Set(['r01', 'r02', 'r03']));
  assert.ok(index.diagnostics.some(d => d.source === 'references/contexts/r04.json'));
});

test('combined filters retain component associations without file notes and historical identities', () => {
  const state = syntheticKnowledgeState(), index = buildKnowledgeIndex(state);
  const component = filterKnowledge(state, index, { ...emptyFilters, component: collarId });
  assert.ok(component.revisions.some(r => r.revisionId === 'r03'));
  assert.ok(component.records.every(r => r.componentId === collarId));
  assert.ok(component.records.some(r => r.filePath === 'Parts/Collar.SLDPRT'));
  const filtered = filterKnowledge(state, index, { revision: 'r02', branch: 'branch-main', component: collarId, kind: 'modification' });
  assert.equal(filtered.records.length, 1);
  assert.equal(filtered.records[0].source.jsonPointer, '/fileNotes/0/modification');
  assert.equal(filterKnowledge(state, index, { ...emptyFilters, branch: 'branch-thicker', revision: 'r02' }).revisions.length, 0);
});

test('missing, unsupported and legacy component evidence preserves its reason without inferred mappings', () => {
  for (const status of ['unavailable', 'unsupported', 'legacy'] as const) {
    const state = syntheticKnowledgeState();
    state.components = { status, reason: 'Explicit component evidence problem.', revisions: state.components!.revisions };
    const index = buildKnowledgeIndex(state);
    assert.equal(componentAvailability(state, index, 'r02').status, status === 'legacy' ? 'not_recorded' : status);
    assert.deepEqual(revisionComponents(state, index, 'r02'), []);
  }
});
