import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReferenceBrowser, filterReferenceBrowser } from './reference-browser';
import { referenceBrowserFixture } from '../../tests/reference-browser-fixture';
import { openExistingVault } from '../engine/vault-service';

test('one search matches reference name, file name, note and the file it applies to, and preserves historical versions', async () => {
  const f = await referenceBrowserFixture();
  const before = JSON.stringify(f.state);
  f.vault.setHooks({ onBeforeRead() { throw Error('Browsing cannot read disk'); }, onBeforeWrite() { throw Error('Browsing cannot write disk'); } });
  const model = buildReferenceBrowser(f.state);
  assert.equal(model.entries.length, 5);
  assert.ok(model.entries.some(entry => entry.reference.referenceId === f.beta.referenceId), 'Removal from current defaults cannot hide historical sources');
  const titles = (query: string) => filterReferenceBrowser(model, query).map(entry => `${entry.reference.title}/${entry.version.originalFilename}`).sort();
  assert.equal(filterReferenceBrowser(model, '').length, 5, 'an empty search shows everything');
  assert.equal(filterReferenceBrowser(model, '   ').length, 5, 'blanks count as empty');
  // Reference name, case-insensitive, across all versions of that reference.
  assert.deepEqual(titles('alpha REQUIREMENT'), ['Alpha requirement/Alpha updated.txt', 'Alpha requirement/Alpha.txt']);
  // File name of one saved version.
  assert.deepEqual(titles('Alpha updated.txt'), ['Alpha requirement/Alpha updated.txt']);
  // Note (the description).
  assert.deepEqual(titles('Beta requirement description'), ['Beta requirement/Beta.txt']);
  // The file it applies to: only the associations that match are kept, and a renamed file keeps its history.
  const onA = filterReferenceBrowser(model, 'A-renamed.SLDPRT');
  assert.deepEqual(onA.map(entry => entry.version.originalFilename), ['Alpha.txt']);
  assert.deepEqual(onA[0].uses.map(use => use.partPath), ['A-renamed.SLDPRT']);
  const onB = filterReferenceBrowser(model, 'B.SLDPRT');
  assert.deepEqual(onB.map(entry => entry.version.originalFilename).sort(), ['Alpha updated.txt', 'Alpha.txt', 'Beta.txt']);
  assert.ok(onB.every(entry => entry.uses.length && entry.uses.every(use => use.partPath === 'B.SLDPRT')));
  // Revision details still narrow the matching associations.
  const updated = filterReferenceBrowser(model, 'Alternative updated source');
  assert.deepEqual(updated.map(entry => entry.reference.title).sort(), ['Alpha requirement', 'Project brief'], 'the whole-project brief is also part of that version');
  const alphaTwo = updated.find(entry => entry.version.versionId === f.version2.versionId)!;
  assert.equal(alphaTwo.uses.length, 1);
  assert.equal(alphaTwo.uses[0].displayNumber, 4);
  // A reference with no association is still found by its own name.
  assert.equal(filterReferenceBrowser(model, 'Unassigned')[0].uses.length, 0);
  assert.equal(filterReferenceBrowser(model, 'no such thing').length, 0);
  assert.equal(JSON.stringify(f.state), before);
});

test('a reused filename does not inherit another component references, and unavailable history never invents links', async () => {
  const f = await referenceBrowserFixture();
  await f.main.writeFileText(['A.SLDPRT'], 'An unrelated new component');
  await f.save('branch-main', 'Reuse old filename', [f.link(f.alpha, 'A-renamed.SLDPRT')]);
  const state = await openExistingVault(f.vault);
  const model = buildReferenceBrowser(state);
  const onA = filterReferenceBrowser(model, 'A.SLDPRT');
  assert.deepEqual(onA.map(entry => entry.version.originalFilename), ['Alpha.txt']);
  assert.ok(onA[0].uses.length && onA[0].uses.every(use => use.partPath === 'A.SLDPRT' && use.summary !== 'Reuse old filename'), 'the new A.SLDPRT is not linked to the old component\'s sources');
  const legacy = structuredClone(state);
  for (const key of Object.keys(legacy.references!.contexts)) legacy.references!.contexts[key] = { status: 'legacy' };
  const legacyModel = buildReferenceBrowser(legacy);
  assert.equal(filterReferenceBrowser(legacyModel, 'A-renamed.SLDPRT').length, 0);
  assert.ok(filterReferenceBrowser(legacyModel, '').every(entry => entry.uses.length === 0));
  const unavailable = structuredClone(state);
  unavailable.references!.status = 'unavailable';
  assert.equal(buildReferenceBrowser(unavailable).unavailable, true);
  assert.equal(buildReferenceBrowser(unavailable).entries.length, 0);
});
