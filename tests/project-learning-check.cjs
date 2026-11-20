// Current-App browser regression using disposable file handles and injected test auth.
// Run: node tests/project-learning-check.cjs
// For an offline checkout only, CADTREE_OFFLINE_AUTH_CHECK=1 guards unavailable SDK imports.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const {build} = require('esbuild');
const {chromium} = require('@playwright/test');
const root = path.resolve(__dirname,'..');
const artifacts = path.join(root,'artifacts/r1-learning');
(async()=>{
  fs.mkdirSync(artifacts,{recursive:true});
  const offline = process.env.CADTREE_OFFLINE_AUTH_CHECK === '1';
  const names = ['getApp','getApps','initializeApp','GoogleAuthProvider','createUserWithEmailAndPassword','getAuth','onAuthStateChanged','sendPasswordResetEmail','signInWithEmailAndPassword','signInWithPopup','signOut'];
  const sdkGuard = {name:'offline-sdk-guard',setup(b){b.onResolve({filter:/^firebase\/(app|auth)$/},a=>({path:a.path,namespace:'sdk-guard'}));b.onLoad({filter:/.*/,namespace:'sdk-guard'},()=>({contents:names.map(n=>`export const ${n}=()=>{throw Error('Unexpected Firebase SDK call in injected-auth check')};`).join('\n')}));}};
  const bundle = await build({stdin:{contents:`import {createRoot} from 'react-dom/client';import App from './src/App';import {compareApplyRecoverSample} from './tests/compare-apply-recover-sample';import {nativeDirectory} from './tests/native-fs';import {resolveManagedProject} from './src/engine/workspace-service';import {createTestAuthController} from './tests/test-auth';import {inventorySignature,readVerifiedInventory} from './src/engine/copy-service';
async function start(){const s=await compareApplyRecoverSample();const caseBytes=await s.caseFolder.readFileBytes(['Bracket.SLDPRT']);await s.caseFolder.writeFileText(['Bracket.SLDPRT'],'Uncaptured study');let picks=0;window.showDirectoryPicker=async()=>{if(++picks>1)throw Error('Unexpected folder picker');return nativeDirectory(s.home)};window.sample={caseId:s.caseId,cleanCase:()=>s.caseFolder.writeFileBytes(['Bracket.SLDPRT'],caseBytes),working:async()=>[inventorySignature(await readVerifiedInventory(s.main)),inventorySignature(await readVerifiedInventory(s.caseFolder))],state:async()=>{const p=await resolveManagedProject(s.workspace.root,s.project.record.containerPath);return {revisions:p.vaultState.revisions.length,lifecycle:p.vaultState.caseLifecycles?.[s.caseId]?.status??'active'}},signature:async()=>inventorySignature(await readVerifiedInventory(s.home)),picks:()=>picks};createRoot(document.getElementById('root')).render(<App auth={createTestAuthController().adapter}/>);}start();`,loader:'tsx',resolveDir:root},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:offline?[sdkGuard]:[]});
  // Build the current stylesheet without needing a live server or any account/network access.
  const {build:buildStyles} = await import('vite');
  await buildStyles({root,logLevel:'error',build:{outDir:path.join(artifacts,'style-build'),rollupOptions:{external:['firebase/app','firebase/auth']}}});
  const cssDir=path.join(artifacts,'style-build/assets');
  const css=fs.readFileSync(path.join(cssDir,fs.readdirSync(cssDir).find(n=>n.endsWith('.css'))),'utf8');
  const assetRoot=pathToFileURL(path.join(root,'public/tutorials')+path.sep).href;
  const js=bundle.outputFiles[0].text.replaceAll('"/tutorials/','"'+assetRoot).replaceAll('</script','<\\/script');
  const html=path.join(artifacts,'check.html');
  fs.writeFileSync(html,'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style></head><body><div id="root"></div><script>'+js+'</script></body></html>');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  const results=[];
  try {
    for(const viewport of [{width:1366,height:900},{width:1100,height:1244},{width:390,height:844}]){
      const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(pathToFileURL(html).href);
      await page.getByRole('button',{name:'Open my Cadtree home',exact:true}).click();
      await page.getByRole('textbox',{name:'Cadtree home folder address'}).fill('D:\\Cadtree');
      await page.getByRole('button',{name:'Complete setup',exact:true}).click();
      await page.getByRole('button',{name:'Open workspace',exact:true}).click();
      await page.getByRole('button',{name:'Open project',exact:true}).click();
      const nav=page.getByRole('navigation',{name:'Primary navigation'});
      await nav.getByRole('button',{name:'Settings',exact:true}).click();
      // The Explorer (sidebar tree, or Browse folders on narrow screens) is the only case switcher.
      const pickCase=async id=>{const row=page.locator(`[role="treeitem"][data-branch-id="${id}"]:visible`);if(!(await row.count()))await nav.getByRole('button',{name:'Browse folders',exact:true}).click();await row.click();};
      await pickCase(await page.evaluate(()=>window.sample.caseId));
      await page.waitForFunction(()=>document.querySelector('main')?.getAttribute('aria-busy')==='false');
      await nav.getByRole('button',{name:'Changes',exact:true}).click();
      // The case switch already scanned; Changes shows its result without any button.
      await page.waitForSelector('[data-scanned-at]');
      await page.getByRole('textbox',{name:'Revision summary'}).fill('Keep pending notes');
      await page.getByRole('button',{name:/Add a description/}).click();
      await page.getByRole('textbox',{name:'Overall: Description',exact:true}).fill('Keep intent');
      await nav.getByRole('button',{name:'History',exact:true}).click();
      await page.getByRole('button',{name:/V4: Reduced bracket thickness/}).click();
      const before=await page.evaluate(()=>window.sample.signature());
      const selected=await page.locator('.revision-detail').innerText();
      // R5: one stable working destination across project views, distinct from inspection.
      const working=page.locator('.project-context-case');
      for(const view of ['Changes','References','Settings','History']) {
        await nav.getByRole('button',{name:view,exact:true}).click();
        assert.equal(await page.getByRole('combobox',{name:'Working case',exact:true}).count(),0);
        assert.equal(await page.locator('.project-context-header').getAttribute('data-branch-id'),await page.evaluate(()=>window.sample.caseId));
        assert.equal(await working.count(),view==='References'?0:1);
        assert.equal(await page.getByRole('region',{name:'Project context',exact:true}).isVisible(),true);
        if(view==='References') {
          assert.equal(await page.getByRole('textbox',{name:'Search references',exact:true}).count(),0);
          assert.equal(await page.getByRole('checkbox',{name:'Show removed references',exact:true}).count(),0);
        }
        if(view==='Settings') {
          await page.getByText('Troubleshooting',{exact:true}).click();
          await page.getByText('Reset folder connections',{exact:true}).click();
          await page.getByRole('button',{name:'Reset all remembered folder connections in this browser',exact:true}).click();
          const reset=page.getByRole('dialog',{name:'Reset all remembered folder connections?',exact:true});
          assert.match(await reset.innerText(),/across all workspaces/);
          assert.equal(await reset.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
          await page.screenshot({path:path.join(artifacts,`browser-reset-${viewport.width}.png`)});
          await reset.getByRole('button',{name:'Cancel',exact:true}).click();
        }
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        await page.screenshot({path:path.join(artifacts,`working-case-${view.toLowerCase()}-${viewport.width}.png`)});
      }
      assert.equal(await page.locator('.revision-detail').innerText(),selected);
      assert.equal(await page.getByRole('checkbox',{name:'Show hidden cases',exact:true}).count(),0);
      assert.equal(await page.locator('.detail-tabs').getByRole('button',{name:'Changed files',exact:true}).count(),1);
      assert.equal(await page.locator('.detail-tabs').getByRole('button',{name:'Saved references',exact:true}).count(),1);
      await page.getByRole('button',{name:'Create design case from this revision',exact:true}).click();
      const createCase=page.getByRole('dialog',{name:'Create design case',exact:true});
      assert.equal(await createCase.getByRole('textbox',{name:'Case name',exact:true}).count(),1);
      await createCase.getByRole('button',{name:'Cancel',exact:true}).click();
      const learn=nav.getByRole('button',{name:'Learn cAdtree',exact:true});await learn.focus();await learn.press('Enter');
      const chooser=page.getByRole('dialog',{name:'Learn cAdtree',exact:true});assert.equal(await chooser.getByRole('article').count(),5);
      await page.screenshot({path:path.join(artifacts,`chooser-${viewport.width}.png`)});
      assert.equal(await chooser.evaluate(e=>e.scrollWidth>e.clientWidth),false);
      const start=chooser.getByRole('article',{name:'Explore design alternatives',exact:true}).getByRole('button',{name:'Start tutorial',exact:true});
      await start.click();
      const viewer=page.getByRole('dialog',{name:'Explore design alternatives',exact:true});await viewer.getByRole('button',{name:'Next',exact:true}).click();
      await viewer.getByRole('button',{name:'Next visual',exact:true}).click();
      await page.screenshot({path:path.join(artifacts,`viewer-${viewport.width}.png`)});
      await page.keyboard.press('Escape');await viewer.waitFor({state:'hidden'});
      assert.equal(await chooser.isVisible(),true,'Escape only closes the top tutorial');assert.equal(await start.evaluate(e=>document.activeElement===e),true);
      await start.click();
      for(let step=1;step<=6;step++){
        const nextVisual=viewer.getByRole('button',{name:'Next visual',exact:true});
        while(await nextVisual.count()&&await nextVisual.isEnabled())await nextVisual.click();
        await viewer.getByRole('button',{name:step===6?'Finish':'Next',exact:true}).click();
      }
      await viewer.waitFor({state:'hidden'});assert.equal(await start.evaluate(e=>document.activeElement===e),true);
      await page.keyboard.press('Escape');await chooser.waitFor({state:'hidden'});assert.equal(await learn.evaluate(e=>document.activeElement===e),true);
      assert.equal(await page.locator('.revision-detail').innerText(),selected);
      assert.equal(await page.locator('.project-context-header').getAttribute('data-branch-id'),await page.evaluate(()=>window.sample.caseId));
      await nav.getByRole('button',{name:'Changes',exact:true}).click();
      assert.equal(await page.getByRole('textbox',{name:'Revision summary'}).inputValue(),'Keep pending notes');
      assert.equal(await page.getByRole('textbox',{name:'Overall: Description',exact:true}).inputValue(),'Keep intent');
      // Main-view history is separate from dialogs and retains the loaded project.
      const logo=page.getByRole('button',{name:'cAdtree introduction',exact:true});
      assert.equal(await logo.getAttribute('href'),null);
      const changes=page.getByRole('heading',{name:'Changes.',exact:true});
      await logo.focus();await page.keyboard.press('Enter');
      await page.getByRole('heading',{name:'Welcome to cAdtree',exact:true}).waitFor();
      await page.goBack();await changes.waitFor();
      assert.equal(await page.getByRole('textbox',{name:'Revision summary'}).inputValue(),'Keep pending notes');
      assert.equal(await page.getByRole('textbox',{name:'Overall: Description',exact:true}).inputValue(),'Keep intent');
      await page.goForward();await page.getByRole('heading',{name:'Welcome to cAdtree',exact:true}).waitFor();
      await nav.getByRole('button',{name:'My workspaces',exact:true}).click();
      await page.getByRole('button',{name:'Open workspace',exact:true}).click();
      await page.getByRole('heading',{name:'Tutorial Workspace.',exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'Back to My workspaces',exact:true}).isVisible(),viewport.width<=960);
      if(viewport.width<=960)await nav.getByRole('button',{name:'Browse folders',exact:true}).click();
      const tree=viewport.width<=960?page.getByRole('dialog',{name:'Browse folders'}):page.locator('.desktop-workspace-tree');
      const rootNode=tree.getByRole('treeitem',{name:'Cadtree home',exact:true});
      const expanded=await rootNode.getAttribute('aria-expanded');await rootNode.click();
      assert.notEqual(await rootNode.getAttribute('aria-expanded'),expanded);
      await rootNode.press('Enter');assert.equal(await rootNode.getAttribute('aria-expanded'),expanded);
      if(viewport.width<=960)await tree.getByRole('button',{name:'Close dialog',exact:true}).click();
      assert.equal(await page.getByRole('heading',{name:'Tutorial Workspace.',exact:true}).isVisible(),true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.screenshot({path:path.join(artifacts,`workspace-navigation-${viewport.width}.png`)});
      if(viewport.width<=960)await page.getByRole('button',{name:'Back to My workspaces',exact:true}).click();
      else await nav.getByRole('button',{name:'My workspaces',exact:true}).click();
      await page.getByRole('heading',{name:'My workspaces.',exact:true}).waitFor();
      await page.goBack();await page.getByRole('heading',{name:'Tutorial Workspace.',exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>window.sample.signature()),before);assert.equal(await page.evaluate(()=>window.sample.picks()),1);assert.deepEqual(errors,[]);
      // R4: case information, comparison and lifecycle actions now live in History.
      await page.getByRole('button',{name:'Open project',exact:true}).click();
      await page.evaluate(()=>window.sample.cleanCase());
      await nav.getByRole('button',{name:'Settings',exact:true}).click();
      await pickCase('branch-main');
      await page.waitForFunction(()=>document.querySelector('main')?.getAttribute('aria-busy')==='false');
      await nav.getByRole('button',{name:'History',exact:true}).click();
      await page.getByRole('heading',{name:'History.',exact:true}).waitFor();
      const reviewBefore=await page.evaluate(()=>window.sample.signature());
      await page.locator('.history-design-cases > summary').click();
      const cases=page.getByRole('region',{name:'Design cases',exact:true});
      assert.equal(await page.locator('.settings-page .design-cases').count(),0);
      assert.equal(await cases.getByRole('button',{name:'Hide case Main',exact:true}).count(),0);
      assert.equal(await cases.getByLabel('Saved activity and divergence for Lightweight bracket',{exact:true}).count(),0);
      await cases.getByRole('button',{name:'Compare Lightweight bracket with Main',exact:true}).click();
      const comparison=page.getByRole('dialog',{name:'Compare saved revisions',exact:true});
      assert.match(await comparison.innerText(),/All project files/);
      await comparison.getByRole('button',{name:'Close comparison',exact:true}).click();
      assert.equal(await page.evaluate(()=>window.sample.signature()),reviewBefore);
      const workingBefore=await page.evaluate(()=>window.sample.working());
      await cases.getByRole('button',{name:'Hide case Lightweight bracket',exact:true}).click();
      let confirmation=page.getByRole('dialog',{name:'Hide design case',exact:true});
      await confirmation.getByRole('button',{name:'Cancel',exact:true}).click();
      assert.equal((await page.evaluate(()=>window.sample.state())).lifecycle,'active');
      await cases.getByRole('button',{name:'Hide case Lightweight bracket',exact:true}).click();
      await confirmation.getByRole('button',{name:'Hide case',exact:true}).click();await confirmation.waitFor({state:'hidden'});
      assert.equal((await page.evaluate(()=>window.sample.state())).lifecycle,'archived');
      await page.locator('.history-hidden-toggle input').check();
      await cases.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(artifacts,`history-design-cases-${viewport.width}.png`)});
      await cases.getByRole('button',{name:'Unhide case Lightweight bracket',exact:true}).click();
      confirmation=page.getByRole('dialog',{name:'Unhide design case',exact:true});
      await confirmation.getByRole('button',{name:'Unhide',exact:true}).click();await confirmation.waitFor({state:'hidden'});
      assert.deepEqual(await page.evaluate(()=>window.sample.state()),{revisions:6,lifecycle:'active'});
      assert.deepEqual(await page.evaluate(()=>window.sample.working()),workingBefore);
      assert.equal(await page.getByRole("region", { name: "Project context",exact:true}).getAttribute('data-branch-id'),'branch-main');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
      // Reload cannot restore the old page's in-memory handles through Back.
      await page.reload();await page.getByRole('heading',{name:'Welcome to cAdtree',exact:true}).waitFor();
      await page.goBack();await page.getByRole('heading',{name:'Welcome to cAdtree',exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>window.sample.picks()),0);
      results.push({...viewport,offlineAuthGuard:offline,projectPreserved:true,errors});await page.close();
    }
    fs.writeFileSync(path.join(artifacts,'verification.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
