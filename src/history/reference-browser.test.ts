import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReferenceBrowser, filterReferenceBrowser } from './reference-browser';
import { referenceBrowserFixture } from '../../tests/reference-browser-fixture';
import { openExistingVault } from '../engine/vault-service';

test('branch, part and search intersect at the same saved association and preserve historical versions', async () => {
  const f = await referenceBrowserFixture();
  const before = JSON.stringify(f.state);
  f.vault.setHooks({ onBeforeRead() { throw Error('Browsing cannot read disk'); }, onBeforeWrite() { throw Error('Browsing cannot write disk'); } });
  const model = buildReferenceBrowser(f.state);
  assert.equal(model.entries.length, 5);
  assert.ok(model.entries.some(entry => entry.reference.referenceId === f.beta.referenceId), 'Removal from current defaults cannot hide historical sources');
  const partA = model.files.find(file => file.label.includes('A-renamed.SLDPRT'))!.value;
  const partB = model.files.find(file => file.label === 'B.SLDPRT')!.value;
  assert.ok(model.files.some(file => file.label === 'notes.txt'), 'Non-CAD files are selectable too');
  const mainB = filterReferenceBrowser(model, 'branch-main', partB);
  assert.deepEqual(mainB.map(entry => entry.reference.title).sort(), ['Beta requirement', 'Project brief']);
  assert.equal(filterReferenceBrowser(model, 'branch-main', partB, 'Alpha').length, 0, 'Alpha on Main/A and Alternative/B must not be combined into a false Main/B association');
  const alphaMain = filterReferenceBrowser(model, 'branch-main', partA, 'alpha');
  assert.equal(alphaMain.length, 1);
  assert.equal(alphaMain[0].version.originalFilename, 'Alpha.txt');
  assert.equal(alphaMain[0].uses.length, 2, 'Confirmed renames retain the component association');
  assert.equal(filterReferenceBrowser(model, f.branchId, partB, 'Alpha updated.txt')[0].version.versionId, f.version2.versionId);
  assert.equal(filterReferenceBrowser(model, 'branch-main', '', 'Alternative updated source').length, 0, 'Search cannot match another branch outside the selected scope');
  assert.equal(filterReferenceBrowser(model, f.branchId, partB, 'Alternative updated source')[0].uses[0].displayNumber, 4);
  assert.equal(filterReferenceBrowser(model, '', '', 'Unassigned')[0].uses.length, 0);
  assert.equal(filterReferenceBrowser(model, 'branch-main', '', 'Unassigned').length, 0);
  assert.equal(JSON.stringify(f.state), before);
});

test('reused filenames do not inherit another component references, and unavailable history never invents links', async () => {
  const f = await referenceBrowserFixture();
  await f.main.writeFileText(['A.SLDPRT'], 'An unrelated new component');
  await f.save('branch-main', 'Reuse old filename', [f.link(f.alpha, 'A-renamed.SLDPRT')]);
  const state = await openExistingVault(f.vault);
  const model = buildReferenceBrowser(state);
  const reused = model.files.find(file => file.label === 'A.SLDPRT')!;
  assert.ok(reused);
  assert.equal(filterReferenceBrowser(model, 'branch-main', reused.value, 'Alpha').length, 0);
  assert.equal(filterReferenceBrowser(model, 'branch-main', reused.value, 'Project brief').length, 1);
  const legacy = structuredClone(state);
  for (const key of Object.keys(legacy.references!.contexts)) legacy.references!.contexts[key] = { status: 'legacy' };
  assert.equal(filterReferenceBrowser(buildReferenceBrowser(legacy), 'branch-main').length, 0);
  const unavailable = structuredClone(state);
  unavailable.references!.status = 'unavailable';
  assert.equal(buildReferenceBrowser(unavailable).unavailable, true);
  assert.equal(buildReferenceBrowser(unavailable).entries.length, 0);
});
