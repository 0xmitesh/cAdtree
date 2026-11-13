import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryFileSystemAdapter } from '../../src/engine/fs-adapter';
import { initializeProjectVault } from '../../src/engine/vault-service';
import { captureRevision } from '../../src/engine/revision-service';
import { inventorySignature, readVerifiedInventory } from '../../src/engine/copy-service';
import { loadLocalVault, pickLocalVault, readOnlyDirectory } from './load-vault';

test('existing vault reconstruction is read-only from a vault or managed container', async () => {
  const container = new InMemoryFileSystemAdapter('project');
  const vault = await container.getDirectory(['vault'], { create: true });
  const working = new InMemoryFileSystemAdapter('working');
  await initializeProjectVault(working, vault, 'Disposable load test');
  await working.writeFileText(['part.SLDPRT'], 'synthetic geometry');
  const captured = await captureRevision(working, vault, { branchId: 'branch-main', summary: 'Initial', notes: { problem: '', modification: '', observations: '' } });
  const before = inventorySignature(await readVerifiedInventory(container));
  let writes = 0;
  container.setHooks({ onBeforeWrite: () => { writes++; throw new Error('Writes forbidden'); } });
  for (const root of [vault, container]) {
    const state = await loadLocalVault(root);
    assert.equal(state.project.projectId, captured.vaultState.project.projectId);
    assert.equal(state.revisions.length, 1);
  }
  assert.equal(writes, 0);
  assert.equal(inventorySignature(await readVerifiedInventory(container)), before);
  const guarded = readOnlyDirectory(container);
  assert.throws(() => guarded.writeFileText(['x'], 'x'), /only permits read/);
  assert.throws(() => guarded.removeEntry(['vault']), /only permits read/);
  assert.throws(() => guarded.requestPermission('readwrite'), /only permits read/);
  await assert.rejects(guarded.getDirectory(['new'], { create: true }), /only permits read/);
  const child = await guarded.getDirectory(['vault']);
  assert.throws(() => child.writeFileBytes(['x'], new Uint8Array()), /only permits read/);
  await assert.rejects(loadLocalVault(working), /Select a cAdtree vault/);
});

test('picker requests read permission and preserves cancellation and unsupported errors', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    await assert.rejects(pickLocalVault(), /supported Chrome or Edge/);
    Object.assign(window, { showDirectoryPicker: async (options: object) => {
      assert.deepEqual(options, { mode: 'read', id: 'cadtree-knowledge-lab' });
      throw new DOMException('Cancelled', 'AbortError');
    } });
    await assert.rejects(pickLocalVault(), { name: 'AbortError' });
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
