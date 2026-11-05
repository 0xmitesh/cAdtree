// Render the current App and all Tutorial 4 visuals without native folder access.
// Run after npm run build: node tests/tutorial-4-check.cjs
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { build } = require('esbuild');
const { chromium } = require('@playwright/test');
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts', 'tutorial-4');

(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const assetRoot = pathToFileURL(path.join(root, 'public', 'tutorials') + path.sep).href;
  const bundle = await build({
    stdin: { contents: `import {createRoot} from 'react-dom/client';import App from './src/App';import {EXPLORE_DESIGN_ALTERNATIVES_TUTORIAL} from './src/tutorials/explore-design-alternatives';window.definition=EXPLORE_DESIGN_ALTERNATIVES_TUTORIAL;window.pickerCalls=0;window.showDirectoryPicker=async()=>{window.pickerCalls++;throw Error('Tutorial must not choose a folder');};createRoot(document.getElementById('root')).render(<App/>);`, loader: 'tsx', resolveDir: root },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'local-assets', setup(b) { b.onLoad({ filter: /(?:start-tutorial|save-first-revision|bring-existing-work|explore-design-alternatives)\.ts$/ }, a => ({ loader: 'ts', contents: fs.readFileSync(a.path, 'utf8').replaceAll('"/tutorials/', '"' + assetRoot) })); } }],
  });
  const cssDir = path.join(root, 'dist', 'assets');
  const css = fs.readFileSync(path.join(cssDir, fs.readdirSync(cssDir).find(n => n.endsWith('.css'))), 'utf8');
  const html = path.join(artifacts, 'viewer.html');
  fs.writeFileSync(html, '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style></head><body><div id="root"></div><script>' + bundle.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script></body></html>');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const results = [];
  try {
    for (const viewport of [{ width: 1366, height: 900 }, { width: 1100, height: 1244 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(pathToFileURL(html).href);
      for (const title of ['Start with cAdtree', 'Save your first revision', 'Bring existing work into cAdtree']) {
        await page.getByRole('article', { name: title, exact: true }).getByRole('button', { name: 'Start tutorial', exact: true }).click();
        const old = page.getByRole('dialog', { name: title, exact: true });
        assert.equal(await old.getByText('Step 1 of 6', { exact: true }).count(), 1);
        await old.getByRole('button', { name: 'Close', exact: true }).click();
      }
      const start = page.getByRole('article', { name: 'Explore design alternatives', exact: true }).getByRole('button', { name: 'Start tutorial', exact: true });
      await start.focus(); await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Explore design alternatives', exact: true });
      const definition = await page.evaluate(() => window.definition);
      let images = 0;
      for (const [index, step] of definition.steps.entries()) {
        const stepLabel = 'Step ' + (index + 1) + ' of 6';
        const forward = dialog.getByRole('button', { name: index === 5 ? 'Finish' : 'Next', exact: true });
        assert.equal(await dialog.getByText(stepLabel, { exact: true }).count(), 1);
        if (step.visuals.length > 1) assert.equal(await forward.isDisabled(), true);
        for (const [v, visual] of step.visuals.entries()) {
          await page.waitForFunction(() => { const img = document.querySelector('dialog img'); return img?.complete && img.naturalWidth > 0; });
          assert.equal(await dialog.getByRole('img').count(), 1);
          assert.equal(await dialog.getByRole('img').getAttribute('src'), visual.src);
          assert.equal(await dialog.getByRole('img').getAttribute('alt'), visual.alt);
          assert.equal(await page.evaluate(() => { const d = document.querySelector('dialog'); return document.documentElement.scrollWidth > innerWidth || d.scrollWidth > d.clientWidth; }), false, 'no horizontal overflow');
          images++;
          if ((index === 0) || (index === 1 && v === 1) || (index === 2) || (index === 3 && v === 1) || (index === 4 && v === 2) || (index === 5 && v === 0)) {
            await dialog.locator('img').scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(artifacts, `step-${index + 1}-${viewport.width}.png`) });
          }
          if (v < step.visuals.length - 1) {
            await dialog.getByRole('button', { name: 'Next visual', exact: true }).focus();
            await page.keyboard.press('Enter');
            assert.equal(await dialog.getByText(stepLabel, { exact: true }).count(), 1);
          }
        }
        assert.equal(await forward.isDisabled(), false);
        await forward.click();
      }
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(await start.evaluate(el => document.activeElement === el), true);
      await start.click();
      assert.equal(await dialog.getByText('Step 1 of 6', { exact: true }).count(), 1);
      await dialog.getByRole('button', { name: 'Next', exact: true }).click();
      assert.equal(await dialog.getByRole('button', { name: 'Next', exact: true }).isDisabled(), true);
      await dialog.getByRole('button', { name: 'Next visual', exact: true }).click();
      await dialog.getByRole('button', { name: 'Previous visual', exact: true }).click();
      assert.equal(await dialog.getByLabel('Visual 1 of 2', { exact: true }).count(), 1);
      await dialog.getByRole('button', { name: 'Back', exact: true }).click();
      await dialog.getByRole('button', { name: 'Next', exact: true }).click();
      assert.equal(await dialog.getByLabel('Visual 1 of 2', { exact: true }).count(), 1);
      assert.equal(await dialog.getByRole('button', { name: 'Next', exact: true }).isDisabled(), false);
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      assert.equal(await start.evaluate(el => document.activeElement === el), true);
      const future = page.getByRole('article', { name: 'Compare & recover', exact: true });
      assert.equal(await future.getByText('Coming soon', { exact: true }).count(), 1);
      assert.equal(await future.locator('button,a,[tabindex]').count(), 0);
      assert.equal(await page.evaluate(() => window.pickerCalls), 0);
      assert.deepEqual(errors, []);
      results.push({ ...viewport, images, errors });
      await page.close();
    }
    const contact = await browser.newPage({ viewport: { width: 1500, height: 1500 } });
    const names = fs.readdirSync(path.join(root, 'public', 'tutorials', 'explore-design-alternatives'));
    await contact.setContent('<html><body style="margin:16px;background:#eef1eb;font:14px Arial;display:grid;grid-template-columns:repeat(3,1fr);gap:16px">' + names.map(n => '<figure style="margin:0;background:white;padding:8px"><figcaption>' + n + '</figcaption><img style="display:block;max-width:100%;height:340px;object-fit:contain" src="' + assetRoot + 'explore-design-alternatives/' + n + '"></figure>').join('') + '</body></html>');
    // file:// resources require a local document origin, so use a file page for the contact sheet.
    const contactHTML = path.join(artifacts, 'contact.html');
    fs.writeFileSync(contactHTML, await contact.content());
    await contact.goto(pathToFileURL(contactHTML).href);
    await contact.waitForFunction(() => [...document.images].every(i => i.complete && i.naturalWidth > 0));
    await contact.screenshot({ path: path.join(artifacts, 'contact.png'), fullPage: true });
    fs.writeFileSync(path.join(artifacts, 'viewer-verification.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
