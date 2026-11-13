import '../dom';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, fireEvent, within } from '@testing-library/react';
import { KnowledgeExplorer } from './explorer';
import { collarId } from './fixture';

afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'showDirectoryPicker'); });

test('explorer shows evidence and exact source pointers, including a component reference without notes', () => {
  const ui = render(<KnowledgeExplorer />);
  fireEvent.click(ui.getByRole('button', { name: 'Load synthetic project' }));
  const r03 = within(ui.getByRole('article', { name: 'Revision r03' }));
  assert.ok(r03.getByText('Parts/Collar_plate.SLDPRT', { exact: true }));
  assert.ok(r03.getByRole('heading', { name: 'Revision-level reference associations (1)' }));
  assert.ok(r03.getByRole('heading', { name: 'Engineering note records (4)' }));
  assert.ok(r03.getByText('references/contexts/r03.json#/links/0', { exact: true }));
  assert.ok(r03.getByText(/Attachment bytes are not verified by VaultState/, { selector: 'p' }));
  const r04 = within(ui.getByRole('article', { name: 'Revision r04' }));
  assert.ok(r04.getAllByText('Synthetic committed context is unavailable.').length);
  const r05 = within(ui.getByRole('article', { name: 'Revision r05' }));
  assert.ok(r05.getAllByText('unsupported').length);
  assert.ok(ui.getAllByText('not recorded').length);
  fireEvent.change(ui.getByLabelText('Component'), { target: { value: collarId } });
  fireEvent.change(ui.getByLabelText('Branch'), { target: { value: 'branch-thicker' } });
  assert.equal(ui.getAllByRole('article', { name: /^Revision r/ }).length, 1);
  assert.ok(ui.getByRole('heading', { name: 'Revision-level reference associations (1)' }));
  assert.ok(ui.getByRole('heading', { name: 'Engineering note records (0)' }));
  assert.ok(ui.getByRole('region', { name: 'Knowledge diagnostics' }));
  fireEvent.click(ui.getByRole('button', { name: 'Reset filters' }));
  fireEvent.change(ui.getByLabelText('Revision'), { target: { value: 'r02' } });
  fireEvent.change(ui.getByLabelText('Record type'), { target: { value: 'modification' } });
  assert.equal(ui.getAllByRole('article', { name: /^modification / }).length, 2);
  const note = within(ui.getByRole('article', { name: 'modification Parts/Collar.SLDPRT' }));
  fireEvent.click(note.getByText(/Inspect exact metadata source/));
  assert.ok(note.getByText('revisions/r02.manifest.json#/fileNotes/0/modification', { exact: true }));
});

test('picker cancellation retains current data and unsupported folder access is explained', async () => {
  const ui = render(<KnowledgeExplorer />);
  fireEvent.click(ui.getByRole('button', { name: 'Load synthetic project' }));
  Object.assign(window, { showDirectoryPicker: async () => { throw new DOMException('Cancelled', 'AbortError'); } });
  fireEvent.click(ui.getByRole('button', { name: 'Open local project vault' }));
  await ui.findByText('Folder selection cancelled. Current view retained.');
  assert.ok(ui.getByRole('article', { name: 'Revision r03' }));
  Reflect.deleteProperty(window, 'showDirectoryPicker');
  fireEvent.click(ui.getByRole('button', { name: 'Open local project vault' }));
  await ui.findByText(/Folder access requires a supported Chrome or Edge/);
});
