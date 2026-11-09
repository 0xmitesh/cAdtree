import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryFileSystemAdapter } from '../../src/engine/fs-adapter';
import { inventorySignature, readVerifiedInventory } from '../../src/engine/copy-service';
import { KnowledgeVaultSession } from './vault-session';
import { disposableAuthoringFixture } from './authoring-fixture';
import { authoringTargets, newDraft, payloadFromDraft, selectedRelationships } from './authoring-model';

const observation = { recordType: 'generic.observation', schemaVersion: 1, payload: { description: '  Original text\n', attributes: { samples: 12 } }, relationships: [], provenance: { kind: 'user-entered' as const } };

test('session is read-only until explicit permission; save, close and reopen preserve stored data without CAD writes', async () => {
  const f = await disposableAuthoringFixture();
  const before = await readVerifiedInventory(f.container), working = inventorySignature(await readVerifiedInventory(f.working));
  const writes: string[] = [];
  f.container.setHooks({ onBeforeWrite: path => { writes.push(path); } });
  f.working.setHooks({ onBeforeWrite: () => { throw new Error('CAD working folder must never be written'); } });
  let permissionRequests = 0;
  const directory = await f.container.getDirectory(['vault']);
  const permission = directory.requestPermission.bind(directory);
  directory.requestPermission = mode => { permissionRequests++; return permission(mode); };
  const inspected = await KnowledgeVaultSession.inspect(directory);
  assert.equal(inspected.session.writeEnabled, false);
  assert.equal(permissionRequests, 0);
  await assert.rejects(inspected.session.create(observation), /read-only/);
  await assert.rejects(inspected.session.authorizeDisposable(false), /Confirm/);
  assert.equal(permissionRequests, 0);
  assert.equal(writes.length, 0);
  await inspected.session.authorizeDisposable(true);
  assert.equal(permissionRequests, 1);
  const saved = await inspected.session.create(observation);
  const record = saved.state.knowledge!.records[0];
  assert.deepEqual(record.record.payload, observation.payload);
  assert.ok(writes.length > 0 && writes.every(path => path.includes('/vault/knowledge/')));
  inspected.session.close();
  await assert.rejects(inspected.session.create(observation), /closed/);
  const reopened = await KnowledgeVaultSession.inspect(f.container);
  assert.equal(reopened.session.writeEnabled, false);
  assert.deepEqual(reopened.state.knowledge!.records, [record]);
  assert.equal(inventorySignature(await readVerifiedInventory(f.working)), working);
  const after = await readVerifiedInventory(f.container);
  assert.deepEqual(after.files.filter(file => !file.path.startsWith('vault/knowledge/')), before.files);
  assert.deepEqual(after.directories.filter(path => path !== 'vault/knowledge' && !path.startsWith('vault/knowledge/')), before.directories);
  await assert.rejects(KnowledgeVaultSession.inspect(f.working), /Select a cAdtree vault/);
});

test('denied or revoked permission keeps inspection usable and rejects saves without mutations', async () => {
  const f = await disposableAuthoringFixture(), selected = await KnowledgeVaultSession.inspect(f.container);
  f.container.setHooks({ writePermission: 'denied' });
  await assert.rejects(selected.session.authorizeDisposable(true), /not granted/);
  assert.equal(selected.session.writeEnabled, false);
  assert.equal((await selected.session.reload()).project.projectId, f.state.project.projectId);
  f.container.setHooks({ writePermission: 'granted' });
  await selected.session.authorizeDisposable(true);
  f.container.setHooks({ writePermission: 'denied' });
  await assert.rejects(selected.session.create(observation), /revoked/);
  assert.equal(selected.session.writeEnabled, false);
  assert.equal(await f.vault.hasDirectory(['knowledge']), false);
});

test('relationship options delegate eligibility and retain exact IDs, historical scope and reference pointers', async () => {
  const f = await disposableAuthoringFixture(), revisionId = f.state.revisions[0].manifest.revisionId;
  const options = authoringTargets(f.state, revisionId);
  const links = selectedRelationships(f.state, options.revisions[0].key, options.components[0].key, options.references[0].key, '', 'evidence');
  assert.equal(links.length, 3);
  assert.equal(links[1].target.kind, 'component');
  assert.ok(options.components[0].label.includes('collar.SLDPRT'));
  if (links[2].target.kind === 'reference-version') {
    assert.equal(links[2].target.referenceId, f.reference.referenceId);
    assert.equal(links[2].target.versionId, f.reference.versions[0].versionId);
    assert.equal(links[2].target.associationPointer, '/links/0');
  }
  const unavailable = structuredClone(f.state);
  unavailable.components = { status: 'unavailable', reason: 'Synthetic missing identity evidence', revisions: f.state.components!.revisions };
  assert.ok(authoringTargets(unavailable, revisionId).components.every(o => o.unavailable));
  assert.throws(() => selectedRelationships(unavailable, options.revisions[0].key, options.components[0].key, '', '', 'context'), /no longer available/);
  unavailable.revisions[0].integrityStatus = 'corrupted';
  assert.ok(authoringTargets(unavailable, revisionId).revisions.every(o => o.unavailable));
});

test('schema forms retain original text and typed numbers and reject malformed content before persistence', () => {
  const draft = { ...newDraft(), problem: '  axial bending\n', change: 'Increase thickness', rationale: 'Stiffness', properties: [{ property: 'thickness', before: '6', after: '8', unit: 'mm' }], assumptions: '  Axial\nload ', observations: 'Pending prototype' };
  const payload = payloadFromDraft(draft);
  assert.deepEqual(payload.propertyChanges, [{ property: 'thickness', before: 6, after: 8, unit: 'mm' }]);
  assert.equal(payload.problem, draft.problem);
  assert.deepEqual(payload.assumptions, [draft.assumptions]);
  assert.throws(() => payloadFromDraft({ ...draft, properties: [{ ...draft.properties[0], before: 'invalid JSON' }] }), /valid JSON/);
  assert.throws(() => payloadFromDraft({ ...draft, problem: '' }), /Invalid payload/);
  assert.throws(() => payloadFromDraft({ ...newDraft(), schema: 'generic.observation', description: 'Observation', attributes: '[]' }), /Invalid payload/);
  assert.throws(() => payloadFromDraft({ ...newDraft(), schema: 'generic.observation', description: 'Observation', attributes: '{"value":1e400}' }), /finite/);
});

test('ambiguous publication clears authorization and reopening reveals the existing record before retry', async () => {
  const vault = new InMemoryFileSystemAdapter('Disposable interrupted vault');
  const { initializeProjectVault } = await import('../../src/engine/vault-service');
  await initializeProjectVault(new InMemoryFileSystemAdapter('Working'), vault, 'Interrupted test');
  const selected = await KnowledgeVaultSession.inspect(vault);
  await selected.session.authorizeDisposable(true);
  const directory = vault.getDirectory.bind(vault);
  let inject = true;
  vault.getDirectory = async (path, options) => {
    const result = await directory(path, options);
    if (inject && path[0] === 'knowledge' && path[1] === 'completed' && options?.exclusiveCreate) { inject = false; throw new Error('Lost publication acknowledgement'); }
    return result;
  };
  await assert.rejects(selected.session.create(observation), /Reload and inspect/);
  assert.equal(selected.session.writeEnabled, false);
  assert.equal((await selected.session.reload()).knowledge!.records.length, 1);
  await assert.rejects(selected.session.create(observation), /read-only/);
});

test('closed sessions cannot regain authorization after a delayed permission response', async () => {
  const f = await disposableAuthoringFixture();
  let respond!: (permission: 'granted') => void;
  const vault = await f.container.getDirectory(['vault']);
  vault.requestPermission = () => new Promise(resolve => { respond = resolve; });
  const selected = await KnowledgeVaultSession.inspect(vault);
  const permission = selected.session.authorizeDisposable(true);
  selected.session.close(); respond('granted');
  await assert.rejects(permission, /closed/);
  assert.equal(selected.session.writeEnabled, false);
  assert.equal(await f.vault.hasDirectory(['knowledge']), false);
});
