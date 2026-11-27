import '../../tests/dom';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import App from '../App';
import { InMemoryFileSystemAdapter } from '../engine/fs-adapter';
import { nativeDirectory } from '../../tests/native-fs';
import { completeHomeAddress } from '../../tests/app-controls';
import { createHome, openHome } from '../engine/home-service';
import { copyVerifiedTree } from '../engine/copy-service';
import { getWorkspacePath, saveWorkspacePath, rememberHome, clearAllConvenienceMetadata } from '../engine/idb-store';
import { pickDirectory } from '../utils/folder-access';

Object.assign(globalThis, { indexedDB });
afterEach(async () => { cleanup(); await clearAllConvenienceMetadata(); Reflect.deleteProperty(window, 'showDirectoryPicker'); Reflect.deleteProperty(window, 'isSecureContext'); });
const ready = (ui: ReturnType<typeof render>) => waitFor(() => assert.equal((ui.getByRole('button', { name: 'Create workspace' }) as HTMLButtonElement).disabled, false));

for (const address of ['/Users/you/Documents/Cadtree', '/home/you/工程/Cadtree']) test(`required creation accepts ${address}, persists locally and reopens the same handle`, async () => {
  const folder = new InMemoryFileSystemAdapter('Cadtree');
  Object.assign(window, { showDirectoryPicker: async () => nativeDirectory(folder) });
  let ui = render(<App />);
  fireEvent.click(ui.getByRole('button', { name: 'Start my Cadtree home' }));
  await waitFor(() => assert.ok(ui.getByRole('dialog')));
  assert.ok(ui.getByText(/cannot compare it with the selected folder/));
  assert.ok(ui.getByText(/How to copy and use a folder address/));
  assert.equal((await folder.listEntries()).length, 0, 'address remains required before publication');
  await completeHomeAddress(ui, address);
  await ready(ui);
  const home = await openHome(folder);
  assert.equal(await getWorkspacePath(home.identity.homeId, nativeDirectory(folder)), address);
  assert.equal((await folder.readFileText(['.cadtree-home.json'])).includes(address), false);
  cleanup();
  ui = render(<App />);
  await waitFor(() => assert.ok(ui.getByRole('button', { name: 'Return to Cadtree' })));
  fireEvent.click(ui.getByRole('button', { name: 'Return to Cadtree' }));
  await ready(ui);
  assert.equal(ui.queryByRole('dialog'), null, 'the same native entry retains its address');
});

test('a relocated copy of the same home requires a new address instead of reusing the original', async () => {
  const original = new InMemoryFileSystemAdapter('Cadtree');
  const home = await createHome(original);
  await saveWorkspacePath(home.identity.homeId, 'D:\\Original', nativeDirectory(original));
  const relocated = new InMemoryFileSystemAdapter('Cadtree');
  await copyVerifiedTree(original, relocated);
  Object.assign(window, { showDirectoryPicker: async () => nativeDirectory(relocated) });
  const ui = render(<App />);
  fireEvent.click(ui.getByRole('button', { name: 'Open my Cadtree home' }));
  await waitFor(() => assert.ok(ui.getByRole('dialog', { name: 'Complete home setup' })));
  assert.equal((ui.getByRole('textbox', { name: 'Cadtree home folder address' }) as HTMLInputElement).value, '');
  await completeHomeAddress(ui, '/home/you/Relocated');
  await ready(ui);
  assert.equal(await getWorkspacePath(home.identity.homeId, nativeDirectory(relocated)), '/home/you/Relocated');
  assert.equal(await getWorkspacePath(home.identity.homeId, nativeDirectory(original)), '');
});

test('unsupported browsers and insecure contexts stop setup with actionable guidance before any picker or disk access', async () => {
  Object.assign(window, { showDirectoryPicker: undefined });
  let ui = render(<App />);
  fireEvent.click(ui.getByRole('button', { name: 'Start my Cadtree home' }));
  await waitFor(() => assert.match(ui.getByRole('alert').textContent!, /desktop Chrome or Edge.*Windows, macOS or Linux.*Safari and Firefox/));
  assert.equal(ui.queryByRole('dialog'), null);
  cleanup();
  let picks = 0;
  Object.assign(window, { showDirectoryPicker: async () => { picks++; throw new Error('Must not pick'); } });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
  ui = render(<App />);
  fireEvent.click(ui.getByRole('button', { name: 'Open my Cadtree home' }));
  await waitFor(() => assert.match(ui.getByRole('alert').textContent!, /HTTPS or localhost/));
  assert.equal(picks, 0);
});

test('remembered access cannot bypass capability checks and revoked permission leaves the home untouched', async () => {
  const folder = new InMemoryFileSystemAdapter('Cadtree');
  const home = await createHome(folder);
  const handle = nativeDirectory(folder);
  await rememberHome({ homeId: home.identity.homeId, name: 'Cadtree', rootHandle: handle });
  await saveWorkspacePath(home.identity.homeId, '/Users/you/Cadtree', handle);
  Object.assign(window, { showDirectoryPicker: undefined });
  let ui = render(<App />);
  await waitFor(() => assert.ok(ui.getByRole('button', { name: 'Return to Cadtree' })));
  fireEvent.click(ui.getByRole('button', { name: 'Return to Cadtree' }));
  await waitFor(() => assert.match(ui.getByRole('alert').textContent!, /cannot connect local folders/));
  cleanup();
  Object.assign(handle, { requestPermission: async () => { throw new DOMException('Revoked', 'NotAllowedError'); } });
  Object.assign(window, { showDirectoryPicker: async () => handle });
  ui = render(<App />);
  await waitFor(() => assert.ok(ui.getByRole('button', { name: 'Return to Cadtree' })));
  fireEvent.click(ui.getByRole('button', { name: 'Return to Cadtree' }));
  await waitFor(() => assert.match(ui.getByRole('alert').textContent!, /denied or revoked.*site settings.*reconnect/));
  assert.equal((await openHome(folder)).identity.homeId, home.identity.homeId);
  assert.equal(ui.queryByRole('button', { name: 'Create workspace' }), null);
});

test('picker denial is actionable and cancellation retains its distinct abort outcome', async () => {
  Object.assign(window, { showDirectoryPicker: async () => { throw new DOMException('Denied', 'NotAllowedError'); } });
  await assert.rejects(pickDirectory('readwrite'), /denied or revoked.*site settings/);
  Object.assign(window, { showDirectoryPicker: async () => { throw new DOMException('Cancelled', 'AbortError'); } });
  await assert.rejects(pickDirectory('read'), { name: 'AbortError' });
});
