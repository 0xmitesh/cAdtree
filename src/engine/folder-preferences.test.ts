import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { nativeDirectory } from '../../tests/native-fs';
import { InMemoryFileSystemAdapter } from './fs-adapter';
import { saveWorkspacePath, getWorkspacePath, saveWorkspaceWindowsPath, getWorkspaceWindowsPath, rememberWorkspace, bindWorkspaceWindowsPathToRoot, clearAllConvenienceMetadata } from './idb-store';

Object.assign(globalThis, { indexedDB });
afterEach(clearAllConvenienceMetadata);
test('saved Windows preferences remain readable and POSIX settings bind to the selected folder', async () => {
  const original = nativeDirectory(new InMemoryFileSystemAdapter('Cadtree'));
  const copy = nativeDirectory(new InMemoryFileSystemAdapter('Cadtree'));
  await saveWorkspaceWindowsPath('same-id', 'd:\\Old location\\', original);
  assert.equal(await getWorkspacePath('same-id', original), 'D:\\Old location');
  assert.equal(await getWorkspacePath('same-id', copy), '');
  await saveWorkspacePath('same-id', '/home/mitesh/Documents/Cadtree', copy);
  assert.equal(await getWorkspacePath('same-id', original), '');
  assert.equal(await getWorkspaceWindowsPath('same-id', copy), '/home/mitesh/Documents/Cadtree');
});

test('an unbound legacy address requires confirmation unless original remembered access proves the location', async () => {
  const original = nativeDirectory(new InMemoryFileSystemAdapter('Original'));
  const copy = nativeDirectory(new InMemoryFileSystemAdapter('Relocated'));
  await saveWorkspaceWindowsPath('old-id', 'D:\\Original');
  assert.equal(await getWorkspacePath('old-id'), 'D:\\Original', 'retain legacy preference text');
  assert.equal(await getWorkspacePath('old-id', original), '', 'do not guess an unbound location');
  await bindWorkspaceWindowsPathToRoot('old-id', copy);
  assert.equal(await getWorkspacePath('old-id', copy), '');
  await rememberWorkspace({ workspaceId: 'old-id', rootHandle: original, name: 'Original' });
  assert.equal(await getWorkspacePath('old-id', original), 'D:\\Original');
  assert.equal(await getWorkspacePath('old-id', copy), '');
  await bindWorkspaceWindowsPathToRoot('old-id', copy);
  assert.equal(await getWorkspacePath('old-id', copy), '');
});

test('failed handle comparison or noncloneable preference writes never authorize another address', async () => {
  const original = nativeDirectory(new InMemoryFileSystemAdapter('Original'));
  await saveWorkspacePath('w', '/Users/mitesh/Cadtree', original);
  const inaccessible = { isSameEntry: async () => { throw new DOMException('Revoked', 'NotAllowedError'); } } as unknown as FileSystemDirectoryHandle;
  assert.equal(await getWorkspacePath('w', inaccessible), '');
  await assert.rejects(saveWorkspacePath('w', '/home/wrong', { bad: () => {} } as unknown as FileSystemDirectoryHandle));
  assert.equal(await getWorkspacePath('w', original), '/Users/mitesh/Cadtree', 'preference write is atomic');
});
