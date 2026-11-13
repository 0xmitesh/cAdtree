import '../dom';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, fireEvent, within, act, type RenderResult } from '@testing-library/react';
import { KnowledgeExplorer } from './explorer';
import { RetrievalExplorer } from './retrieval';
import { emptyRetrievalFilters, retrievalQuery } from './retrieval-model';
import { syntheticKnowledgeState, collarId } from './fixture';
import { knowledgeRetrievalFixture } from '../knowledge-retrieval-fixture';
import { nativeDirectory } from '../native-fs';
import { buildKnowledgeIndex } from '../../src/knowledge';
import { retrieveKnowledge, getComponentKnowledgeTimeline } from '../../src/knowledge/retrieval';
import { createKnowledgeRecord } from '../../src/knowledge/records';
import { openExistingVault, initializeProjectVault } from '../../src/engine/vault-service';
import { InMemoryFileSystemAdapter, type FileSystemDirectoryAdapter } from '../../src/engine/fs-adapter';
import { inventorySignature, readVerifiedInventory } from '../../src/engine/copy-service';

afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'showDirectoryPicker'); });

async function open(ui: RenderResult, vault: FileSystemDirectoryAdapter) {
  Object.assign(window, { showDirectoryPicker: async (options: { mode: string }) => { assert.equal(options.mode, 'read'); return nativeDirectory(vault); } });
  fireEvent.click(ui.getByRole('button', { name: 'Open local project vault' }));
  await ui.findByText('Local vault metadata reconstructed with read access. Attachment bytes have not been verified.');
  return within(ui.getByRole('region', { name: 'Knowledge retrieval' }));
}

test('structured controls use verified IDs and render actual M1A/M1B API matches, literal text and direct record links', async () => {
  const f = await knowledgeRetrievalFixture(), ui = render(<KnowledgeExplorer />);
  const retrieval = await open(ui, f.vault);
  const change = (label: string, value: string) => fireEvent.change(retrieval.getByLabelText(label), { target: { value } });
  assert.ok(retrieval.getAllByText(/M1A-derived/).length);
  assert.ok(retrieval.getAllByText(/M1B-persisted/).length);
  const componentOptions = within(retrieval.getByLabelText('Component')).getAllByRole('option') as HTMLOptionElement[];
  assert.ok(componentOptions.find(o => o.value === f.componentId)?.textContent?.includes('collar_plate.SLDPRT'));
  assert.ok(componentOptions.find(o => o.value === f.unrelatedComponentId)?.textContent?.includes('collar.SLDPRT'));
  assert.ok(componentOptions.every(o => !o.value.endsWith('.SLDPRT')), 'paths never become identity values');
  change('Record source', 'm1b-persisted'); change('Record type', 'cad.design-change'); change('Literal text', '8 mm');
  const expected = retrieveKnowledge(f.state, retrievalQuery(f.projectId, { ...emptyRetrievalFilters, sourceType: 'm1b-persisted', kind: 'cad.design-change', text: '8 mm' }));
  assert.deepEqual(retrieval.getAllByRole('article', { name: /^Retrieved record / }).map(a => a.getAttribute('aria-label')), expected.records.map(r => `Retrieved record ${r.id}`));
  const card = within(retrieval.getByRole('article', { name: `Retrieved record ${f.design.record.recordId}` }));
  assert.ok(card.getByText('Use an 8 mm collar'));
  fireEvent.click(card.getByText('Complete original payload'));
  assert.deepEqual(JSON.parse(card.getByText('Complete original payload').closest('details')!.querySelector('pre')!.textContent!), f.design.record.payload);
  change('Component', f.componentId); change('Branch', 'branch-main'); change('Revision', f.renamedId);
  assert.ok(retrieval.getByRole('article', { name: `Snapshot ${f.renamedId}` }));
  change('Branch', f.branchId);
  assert.ok(retrieval.getByText(/No matching recorded knowledge/));
  assert.equal(retrieval.queryAllByRole('article', { name: /^Retrieved record / }).length, 0);
  change('Branch', 'branch-main'); change('Literal text', '8 MM');
  assert.ok(retrieval.getByText(/No matching recorded knowledge/), 'case-sensitive literal search');
  fireEvent.click(retrieval.getByRole('button', { name: 'Reset filters' }));
  change('Direct link to record', f.design.record.recordId);
  assert.ok(retrieval.getByRole('article', { name: `Retrieved record ${f.linked.record.recordId}` }));
  assert.equal(retrieval.getAllByRole('article', { name: /^Retrieved record / }).length, 1);
});

test('component snapshots, historical renames and cross-branch event citations render unchanged source metadata', async () => {
  const f = await knowledgeRetrievalFixture();
  const attachment = buildKnowledgeIndex(f.state).revisions.find(r => r.revisionId === f.alternativeId)!.referenceContext.attachments[0];
  const cross = await createKnowledgeRecord(f.vault, { projectId: f.projectId, recordType: 'generic.observation', schemaVersion: 1,
    payload: { description: 'Main recorded assertion cites an Alternative source.' }, provenance: { kind: 'user-entered' }, relationships: [
      { relation: 'related', target: { kind: 'component', projectId: f.projectId, revisionId: f.renamedId, componentId: f.componentId } },
      { relation: 'evidence', target: { kind: 'reference-version', projectId: f.projectId, revisionId: f.alternativeId, referenceId: attachment.referenceId, versionId: attachment.versionId, associationPointer: attachment.source.jsonPointer } },
    ] });
  const state = await openExistingVault(f.vault), ui = render(<KnowledgeExplorer />);
  const retrieval = await open(ui, f.vault);
  fireEvent.change(retrieval.getByLabelText('Component'), { target: { value: f.componentId } });
  const expected = getComponentKnowledgeTimeline(state, { projectId: f.projectId, componentId: f.componentId });
  assert.deepEqual(retrieval.getAllByRole('article', { name: /^Snapshot / }).map(a => a.getAttribute('aria-label')), expected.events.map(e => `Snapshot ${e.context.revisionId}`));
  assert.ok(within(retrieval.getByRole('article', { name: `Snapshot ${f.firstId}` })).getByText('collar.SLDPRT', { exact: true }));
  assert.ok(within(retrieval.getByRole('article', { name: `Snapshot ${f.renamedId}` })).getByText('collar_plate.SLDPRT', { exact: true }));
  const referenceOnly = within(retrieval.getByRole('article', { name: `Snapshot ${f.referenceOnlyId}` }));
  assert.ok(referenceOnly.getByText('Recorded notes and linked knowledge (0)'));
  assert.ok(referenceOnly.getByText('Event reference context and citations (1)'));
  const citation = expected.records.find(r => r.id === cross.record.recordId)!.references[0];
  const alternative = retrieval.getByRole('article', { name: `Snapshot ${f.alternativeId}` });
  assert.ok(![...alternative.querySelectorAll(':scope > .kl-citation')].some(d => d.getAttribute('aria-label') === `Citation ${citation.id}`));
  fireEvent.change(retrieval.getByLabelText('Revision'), { target: { value: f.renamedId } });
  fireEvent.change(retrieval.getByLabelText('Branch'), { target: { value: 'branch-main' } });
  const event = retrieval.getByRole('article', { name: `Snapshot ${f.renamedId}` });
  const eventCitation = [...event.querySelectorAll(':scope > .kl-citation')].find(d => d.getAttribute('aria-label') === `Citation ${citation.id}`)!;
  assert.ok(eventCitation, 'cross-branch evidence appears in the owning Main event');
  const card = within(event).getByRole('article', { name: `Retrieved record ${cross.record.recordId}` });
  const recordCitation = card.querySelector('.kl-citation')!;
  fireEvent.click(recordCitation.querySelector('summary')!);
  assert.match(recordCitation.textContent!, /Thicker alternative/);
  fireEvent.click(within(recordCitation as HTMLElement).getByText('Exact citation source, IDs and hashes'));
  const inspected = JSON.parse(recordCitation.querySelector('pre')!.textContent!);
  assert.deepEqual(inspected, citation);
  assert.equal(inspected.revisionId, f.alternativeId); assert.equal(inspected.branchId, f.branchId);
  assert.equal(inspected.attachment.locator, 'Page 7, figure 1'); assert.equal(inspected.attachment.versionId, f.v2.versionId);
  assert.equal(inspected.attachment.source.jsonPointer, '/links/0'); assert.equal(inspected.relation, 'evidence');
  assert.equal(inspected.verification.claims, 'not_verified'); assert.equal(inspected.verification.attachmentBytes, 'not_checked');
  fireEvent.click(within(card).getByText('Original source and integrity'));
  const source = JSON.parse(within(card).getByText('Original source and integrity').closest('details')!.querySelector('pre')!.textContent!);
  assert.deepEqual(source.source, cross.source);
  assert.equal(recordCitation.querySelector('a'), null, 'metadata pointers are not filesystem navigation links');
});

test('synthetic, readable-empty, incomplete and unavailable states retain the API uncertainty semantics', async () => {
  const ui = render(<KnowledgeExplorer />);
  fireEvent.click(ui.getByRole('button', { name: 'Load synthetic project' }));
  let retrieval = within(ui.getByRole('region', { name: 'Knowledge retrieval' }));
  assert.ok(retrieval.getByText(/SYNTHETIC.*simulated/));
  assert.ok(retrieval.getByRole('status').textContent?.includes('incomplete'));
  fireEvent.change(retrieval.getByLabelText('Literal text'), { target: { value: 'text absent from fixture' } });
  assert.ok(retrieval.getByText(/No matching recorded knowledge/));
  assert.match(retrieval.getByRole('status').textContent!, /empty.*incomplete/);
  fireEvent.click(retrieval.getByText(/Retrieval issues/));
  assert.ok(retrieval.getAllByText(/Synthetic committed context is unavailable/).length);
  const empty = new InMemoryFileSystemAdapter('Empty Vault');
  await initializeProjectVault(new InMemoryFileSystemAdapter('Empty Working'), empty, 'Readable empty project');
  retrieval = await open(ui, empty);
  assert.match(retrieval.getByRole('status').textContent!, /empty.*readable/);
  cleanup();
  const f = await knowledgeRetrievalFixture();
  const ready = JSON.parse(await f.vault.readFileText(['components', 'ready.json'])); ready.schemaVersion = 99;
  await f.vault.writeFileText(['components', 'ready.json'], JSON.stringify(ready));
  const state = await openExistingVault(f.vault);
  const isolated = render(<RetrievalExplorer state={state} index={buildKnowledgeIndex(state)} synthetic={false} ready filters={{ ...emptyRetrievalFilters, component: f.componentId }} onChange={() => {}} />);
  assert.match(isolated.getByRole('status').textContent!, /unavailable.*unavailable/);
  assert.ok(isolated.getByText(/Component identity:/).textContent?.includes('unsupported'));
  assert.equal(within(isolated.getByLabelText('Component')).getAllByRole('option').length, 1);
  assert.ok(isolated.getByText(/Verified component selection is unavailable/));
});

test('reload, close, project switching and failed reload invalidate results without writes or permission escalation', async () => {
  const f = await knowledgeRetrievalFixture(), ui = render(<KnowledgeExplorer />);
  const inventories = await Promise.all([f.vault, ...Object.values(f.folders)].map(async d => inventorySignature(await readVerifiedInventory(d))));
  let writes = 0, permissionRequests = 0;
  f.vault.setHooks({ onBeforeWrite: () => { writes++; } }); f.main.setHooks({ onBeforeWrite: () => { writes++; } });
  const handle = nativeDirectory(f.vault);
  Object.assign(handle, { requestPermission: async () => { permissionRequests++; throw new Error('Unexpected permission request'); } });
  Object.assign(window, { showDirectoryPicker: async (o: { mode: string }) => { assert.equal(o.mode, 'read'); return handle; } });
  fireEvent.click(ui.getByRole('button', { name: 'Open local project vault' }));
  await ui.findByText('Local vault metadata reconstructed with read access. Attachment bytes have not been verified.');
  let retrieval = within(ui.getByRole('region', { name: 'Knowledge retrieval' }));
  fireEvent.change(retrieval.getByLabelText('Literal text'), { target: { value: 'Collar' } });
  assert.ok(retrieval.getAllByRole('article', { name: /^Retrieved record / }).length);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.vault.setHooks({ onBeforeRead: () => gate });
  fireEvent.click(ui.getByRole('button', { name: 'Reload vault' }));
  assert.equal(retrieval.queryAllByRole('article', { name: /^Retrieved record / }).length, 0);
  assert.ok((retrieval.getByRole('group', { name: 'Retrieval controls' }) as HTMLFieldSetElement).disabled);
  await act(async () => { release(); });
  await ui.findByText('Vault reloaded from storage. Write authorization has been cleared.');
  assert.equal((retrieval.getByLabelText('Literal text') as HTMLInputElement).value, '');
  f.vault.setHooks({ onBeforeRead: () => { throw new Error('Read failed for reload'); } });
  fireEvent.click(ui.getByRole('button', { name: 'Reload vault' }));
  await ui.findByText('Read failed for reload');
  assert.equal(retrieval.queryAllByRole('article', { name: /^Retrieved record / }).length, 0);
  assert.ok(retrieval.getByText(/Retrieval results cleared/));
  f.vault.setHooks({ onBeforeRead: undefined });
  const second = new InMemoryFileSystemAdapter('Other vault');
  const other = await initializeProjectVault(new InMemoryFileSystemAdapter('Other CAD'), second, 'Different project');
  let choose!: (handle: FileSystemDirectoryHandle) => void;
  Object.assign(window, { showDirectoryPicker: () => new Promise(resolve => { choose = resolve; }) });
  fireEvent.click(ui.getByRole('button', { name: 'Open local project vault' }));
  assert.equal(retrieval.queryAllByRole('article', { name: /^Retrieved record / }).length, 0);
  await act(async () => { choose(nativeDirectory(second)); });
  await ui.findByRole('heading', { name: 'Different project' });
  retrieval = within(ui.getByRole('region', { name: 'Knowledge retrieval' }));
  assert.match(retrieval.getByRole('status').textContent!, /empty.*readable/);
  fireEvent.click(retrieval.getByText(/Retrieval issues/));
  fireEvent.click(retrieval.getByText('Exact structured query'));
  assert.equal(JSON.parse(retrieval.getByText('Exact structured query').closest('details')!.querySelector('pre')!.textContent!).projectId, other.project.projectId);
  assert.equal(retrieval.queryAllByRole('article', { name: /^Retrieved record / }).length, 0);
  fireEvent.click(ui.getByRole('button', { name: 'Close project' }));
  assert.equal(ui.queryByRole('region', { name: 'Knowledge retrieval' }), null);
  assert.equal(writes, 0); assert.equal(permissionRequests, 0);
  assert.deepEqual(await Promise.all([f.vault, ...Object.values(f.folders)].map(async d => inventorySignature(await readVerifiedInventory(d)))), inventories);
});

test('simulated retrieval remains deterministic and never creates a writable session', () => {
  assert.deepEqual(syntheticKnowledgeState(), syntheticKnowledgeState());
  const ui = render(<KnowledgeExplorer />);
  fireEvent.click(ui.getByRole('button', { name: 'Load synthetic project' }));
  const retrieval = within(ui.getByRole('region', { name: 'Knowledge retrieval' }));
  fireEvent.change(retrieval.getByLabelText('Component'), { target: { value: collarId } });
  fireEvent.change(retrieval.getByLabelText('Revision'), { target: { value: 'r02' } });
  fireEvent.change(retrieval.getByLabelText('Branch'), { target: { value: 'branch-main' } });
  assert.ok(retrieval.getByRole('article', { name: 'Snapshot r02' }));
  assert.ok(retrieval.getAllByText(/source:.*Thicker collar/).length);
  assert.equal(ui.queryByRole('region', { name: 'Knowledge authoring' }), null);
  assert.ok(ui.getByText(/simulated envelopes and checksums/));
});
