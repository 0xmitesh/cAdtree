// Reproduce Tutorial 4's real App captures using disposable native-handle facades.
// Run after npm run build: node tests/tutorial-4-capture.cjs
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { build } = require('esbuild');
const { chromium } = require('@playwright/test');
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts', 'tutorial-4');
const assets = path.join(root, 'public', 'tutorials', 'explore-design-alternatives');

(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const entry = `import {createRoot} from 'react-dom/client';
import App from './src/App';
import {createTestAuthController} from './tests/test-auth';
import {designAlternativesSample} from './tests/design-alternatives-sample';
import {nativeDirectory} from './tests/native-fs';
import {resolveManagedProject} from './src/engine/workspace-service';
import {inventorySignature,readVerifiedInventory} from './src/engine/copy-service';
async function main(){
 const sample=await designAlternativesSample();
 const mainBefore=inventorySignature(await readVerifiedInventory(sample.main));
 let picks=0;
 Object.assign(window, {showDirectoryPicker:async()=>{picks++;if(picks>1)throw Error('Managed case must not request a folder');return nativeDirectory(sample.home);},tutorialSample:{...sample,current:()=>resolveManagedProject(sample.workspace.root,sample.project.record.containerPath),mainBefore,signature:async()=>inventorySignature(await readVerifiedInventory(sample.main)),caseSignature:async id=>{const p=await resolveManagedProject(sample.workspace.root,sample.project.record.containerPath);return inventorySignature(await readVerifiedInventory(p.workingFolders[id]));},picks:()=>picks}});
 createRoot(document.getElementById('root')).render(<App auth={createTestAuthController().adapter}/>);
}main().catch(e=>{document.body.textContent=String(e.stack||e);console.error(e);});`;
  const bundle = await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: root }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const cssDir = path.join(root, 'dist', 'assets');
  const css = fs.readFileSync(path.join(cssDir, fs.readdirSync(cssDir).find(n => n.endsWith('.css'))), 'utf8');
  const html = path.join(artifacts, 'capture.html');
  fs.writeFileSync(html, '<!doctype html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body><div id="root"></div><script>' + bundle.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script></body></html>');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, deviceScaleFactor: 3 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const dismiss = async () => { const buttons = page.getByRole('button', { name: 'Dismiss message', exact: true }); while (await buttons.count()) await buttons.first().click(); };
  const idle = async () => { await page.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false'); await dismiss(); };
  const focus = async locator => { await page.keyboard.press('Tab'); await locator.focus(); };
  const capture = async (locator, name) => { await dismiss(); await locator.screenshot({ path: path.join(assets, name + '.png') }); };
  const settingsClip = async name => {
    await page.setViewportSize({ width: 1024, height: 1200 });
    const heading = page.getByRole('region', { name: 'Project context', exact: true });
    const location = page.locator('.settings-page > .panel').first().locator('.settings-row').first();
    await heading.scrollIntoViewIfNeeded();
    const top = await heading.boundingBox(), bottom = await location.boundingBox();
    await page.screenshot({ path: path.join(assets, name + '.png'), clip: { x: top.x, y: top.y, width: top.width, height: bottom.y + bottom.height - top.y } });
  };
  try {
    await page.goto(pathToFileURL(html).href);
    // Capture-only treatment: remove container shadows, retaining real controls,
    // layout and keyboard focus outlines. Product styles are not changed.
    await page.addStyleTag({ content: '.modal, .panel, .history-canvas, .revision-detail { box-shadow: none !important; }' });
    await page.getByRole('button', { name: 'Open my Cadtree home', exact: true }).click();
    await page.getByRole('textbox', { name: 'Cadtree home folder address' }).fill('D:\\Cadtree');
    await page.getByRole('button', { name: 'Complete setup', exact: true }).click(); await idle();
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click(); await idle();
    await page.getByRole('button', { name: 'Open project', exact: true }).click(); await idle();
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });
    // Refresh Tutorial 2's scan action, which also displayed the old per-page picker.
    await page.setViewportSize({ width: 1024, height: 1200 });
    await nav.getByRole('button', { name: 'Changes', exact: true }).click();
    const scan = page.getByRole('button', { name: 'Scan for changes', exact: true });
    await focus(scan);
    const contextBox = await page.getByRole('region', { name: 'Project context', exact: true }).boundingBox();
    const changesBox = await page.locator('.changes-page .page-heading').boundingBox();
    await page.screenshot({ path: path.join(root, 'public/tutorials/save-first-revision/step-4-scan.png'), clip: { x: changesBox.x - 8, y: contextBox.y, width: changesBox.width + 16, height: changesBox.y + changesBox.height - contextBox.y + 8 } });
    await nav.getByRole('button', { name: 'History', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1200 });
    const revision = page.getByRole('button', { name: /Rev 003: Reviewed design baseline/ });
    await revision.click(); await focus(revision);
    const canvas = page.locator('.history-canvas');
    await canvas.scrollIntoViewIfNeeded();
    const canvasBox = await canvas.boundingBox(), revisionBox = await revision.boundingBox();
    await page.screenshot({ path: path.join(assets, 'step-2-choose-revision.png'), clip: { x: canvasBox.x, y: canvasBox.y, width: canvasBox.width, height: revisionBox.y + revisionBox.height + 12 - canvasBox.y } });
    const create = page.getByRole('button', { name: 'Create design case from this revision', exact: true });
    await focus(create); await capture(page.locator('.recovery-bar'), 'step-2-create-action');
    await create.click();
    const dialog = page.getByRole('dialog', { name: 'Create design case', exact: true });
    await dialog.getByRole('textbox', { name: 'Case name', exact: true }).fill('Lightweight bracket');
    await dialog.getByRole('textbox', { name: 'Engineering reason', exact: true }).fill('Explore a lighter mounting solution without changing Main.');
    assert.equal(await dialog.getByRole('button', { name: 'Choose parent folder', exact: true }).count(), 0);
    const submit = dialog.getByRole('button', { name: 'Create design case', exact: true });
    await focus(submit);
    const formBox = await dialog.locator('form').boundingBox();
    // Keep the native focus ring inside a small white margin; exclude modal edges.
    await page.screenshot({ path: path.join(assets, 'step-3-create-dialog.png'), clip: { x: formBox.x - 8, y: formBox.y - 8, width: formBox.width + 16, height: formBox.height + 16 } });
    await submit.click(); await dialog.waitFor({ state: 'hidden' }); await idle();
    const afterCreate = await page.evaluate(async () => {
      const s = window.tutorialSample, p = await s.current();
      const branch = p.vaultState.branches.find(b => b.name === 'Lightweight bracket');
      return { branchId: branch.branchId, origin: branch.startingRevisionId, baseline: s.baseline.manifest.revisionId, mainUnchanged: await s.signature() === s.mainBefore, caseMatchesBaseline: await s.caseSignature(branch.branchId) === s.mainBefore, revisions: p.vaultState.revisions.length, path: p.workingPaths[branch.branchId], active: document.querySelector('.project-context-header')?.getAttribute('data-branch-id'), picks: s.picks() };
    });
    assert.equal(afterCreate.mainUnchanged, true); assert.equal(afterCreate.caseMatchesBaseline, true); assert.equal(afterCreate.revisions, 3); assert.equal(afterCreate.origin, afterCreate.baseline); assert.equal(afterCreate.active, afterCreate.branchId); assert.equal(afterCreate.picks, 1);
    await nav.getByRole('button', { name: 'Settings', exact: true }).click();
    await settingsClip('step-4-case-location');
    await nav.getByRole('button', { name: 'Changes', exact: true }).click();
    await page.getByRole('button', { name: /Show 3 unchanged files/ }).click();
    const copy = page.getByRole('button', { name: /Copy folder path.*Bracket\.SLDPRT/ });
    await focus(copy); await copy.hover(); await capture(page.locator('.changes-files:visible'), 'step-4-copy-folder-path');
    await nav.getByRole('button', { name: 'Settings', exact: true }).click();
    const selector = page.getByRole('combobox', { name: 'Working case', exact: true });
    await selector.selectOption('branch-main'); await idle(); await focus(selector); await settingsClip('step-5-main-active');
    await selector.selectOption(afterCreate.branchId); await idle(); await focus(selector); await settingsClip('step-5-case-active');
    await nav.getByRole('button', { name: 'History', exact: true }).click();
    const header = page.getByRole('region', { name: 'Project context', exact: true }), origin = page.locator('.branch-origin');
    await header.scrollIntoViewIfNeeded();
    const h = await header.boundingBox(), o = await origin.boundingBox();
    await page.screenshot({ path: path.join(assets, 'step-5-case-origin.png'), clip: { x: h.x, y: h.y, width: h.width, height: o.y + o.height - h.y } });
    await page.evaluate(async id => { const s = window.tutorialSample; await s.save(id, 'Reduced bracket thickness', 4); await s.save(id, 'Reinforced mounting rib', 5); await s.save('branch-main', 'Main mounting detail refined', 6); }, afterCreate.branchId);
    await nav.getByRole('button', { name: 'Settings', exact: true }).click();
    await selector.selectOption('branch-main'); await idle();
    await nav.getByRole('button', { name: 'History', exact: true }).click();
    await page.getByRole('button', { name: /Rev 006: Main mounting detail refined/ }).click();
    const clearHighlight = page.getByRole('button', { name: 'Clear ancestry highlight', exact: true });
    if (await clearHighlight.count()) await clearHighlight.click();
    await page.setViewportSize({ width: 1440, height: 1200 });
    // Focus the shared origin and the two later directions, rather than shrinking
    // the entire History page into the tutorial's image frame.
    const graph = page.locator('.history-canvas .graph-viewport');
    await graph.scrollIntoViewIfNeeded();
    const graphBox = await graph.boundingBox();
    const originBox = await page.getByRole('button', { name: /Rev 003: Reviewed design baseline/ }).boundingBox();
    const latestBox = await page.getByRole('button', { name: /Rev 006: Main mounting detail refined/ }).boundingBox();
    // Newest first: the origin may sit above or below the latest row, so clip by min/max.
    const top = Math.min(originBox.y, latestBox.y), bottom = Math.max(originBox.y + originBox.height, latestBox.y + latestBox.height);
    await page.screenshot({ path: path.join(assets, 'step-6-saved-histories.png'), clip: { x: graphBox.x + 12, y: top - 12, width: graphBox.width - 24, height: bottom - top + 24 } });
    const verification = await page.evaluate(async () => {
      const s = window.tutorialSample, p = await s.current();
      return { ...p.record, revisions: p.vaultState.revisions.map(r => ({ number: r.manifest.displayNumber, branch: p.vaultState.branches.find(b => b.branchId === r.manifest.branchId).name, parent: p.vaultState.revisions.find(v => v.manifest.revisionId === r.manifest.parentRevisionId)?.manifest.displayNumber ?? null, summary: r.manifest.summary })), picks: s.picks(), casePath: Object.values(p.workingPaths).find(p => !p.endsWith('/main')) };
    });
    assert.deepEqual(verification.revisions.map(r => [r.number, r.branch, r.parent]).sort((a, b) => a[0] - b[0]), [[1, 'Main', null], [2, 'Main', 1], [3, 'Main', 2], [4, 'Lightweight bracket', 3], [5, 'Lightweight bracket', 4], [6, 'Main', 3]]);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(artifacts, 'capture-verification.json'), JSON.stringify({ afterCreate, verification, errors }, null, 2));
    console.log(JSON.stringify({ screenshots: 9, afterCreate, verification, errors }));
  } catch (e) {
    await page.screenshot({ path: path.join(artifacts, 'capture-debug.png'), fullPage: true });
    console.error(await page.locator('body').innerText()); throw e;
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
