// Refresh Tutorial 3 project/location captures (and Tutorial 2 step 2 working-folder panel) through the current App.
// Run after npm run build: node tests/tutorial-3-capture.cjs
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const {build} = require('esbuild');
const {chromium} = require('@playwright/test');
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts/tutorial-3');
(async () => {
  fs.mkdirSync(artifacts, {recursive:true});
  const bundle = await build({stdin:{resolveDir:root, loader:'tsx', contents:`
import {createRoot} from 'react-dom/client';
import App from './src/App';
import {InMemoryFileSystemAdapter} from './src/engine/fs-adapter';
import {createHome,createHomeWorkspace} from './src/engine/home-service';
import {importProject} from './src/engine/workspace-service';
import {inventorySignature,readVerifiedInventory} from './src/engine/copy-service';
import {nativeDirectory} from './tests/native-fs';
import {createTestAuthController} from './tests/test-auth';
async function start(){
 const home=new InMemoryFileSystemAdapter('Cadtree');await createHome(home);
 const {workspace}=await createHomeWorkspace(home,'Client A');
 const source=new InMemoryFileSystemAdapter('Bracket Assembly');
 for(const [name,size] of [['Bracket.SLDPRT',512000],['Mount.SLDPRT',256000],['BracketAssembly.SLDASM',128000]]){
  const bytes=new Uint8Array(size);bytes.set(new TextEncoder().encode('SYNTHETIC TUTORIAL SAMPLE - NOT A VALID CAD DOCUMENT'));await source.writeFileBytes([name],bytes);
 }
 const original=inventorySignature(await readVerifiedInventory(source));
 await importProject(workspace.root,source,'Bracket Assembly');
 if(inventorySignature(await readVerifiedInventory(source))!==original)throw Error('Import changed the source');
 window.showDirectoryPicker=async()=>nativeDirectory(home);
 createRoot(document.getElementById('root')).render(<App auth={createTestAuthController().adapter}/>);
}start();`}, bundle:true, write:false, format:'iife', jsx:'automatic', define:{'process.env.NODE_ENV':'"production"'}});
  const cssDir=path.join(root,'dist/assets');
  const css=fs.readFileSync(path.join(cssDir,fs.readdirSync(cssDir).find(n=>n.endsWith('.css'))),'utf8');
  const html=path.join(artifacts,'capture.html');
  fs.writeFileSync(html,'<!doctype html><html><head><meta charset="utf-8"><style>'+css+'</style></head><body><div id="root"></div><script>'+bundle.outputFiles[0].text.replaceAll('</script','<\\/script')+'</script></body></html>');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1024,height:1200},deviceScaleFactor:3});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(pathToFileURL(html).href);
    await page.addStyleTag({content:'.panel,.history-canvas,.revision-detail {box-shadow:none !important;}'});
    await page.getByRole('button',{name:'Open my Cadtree home',exact:true}).click();
    await page.getByRole('textbox',{name:'Cadtree home folder address',exact:true}).fill('D:\\Cadtree');
    await page.getByRole('button',{name:'Complete setup',exact:true}).click();
    await page.getByRole('button',{name:'Open workspace',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('main')?.getAttribute('aria-busy')==='false');
    const dismiss=page.getByRole('button',{name:'Dismiss message',exact:true});
    while(await dismiss.count())await dismiss.first().click();
    const open=page.getByRole('button',{name:'Open project',exact:true});
    await open.focus();
    assert.equal(await page.getByText('Managed project',{exact:true}).count(),0);
    assert.equal(await page.getByText(/One shared vault, independent working folders/).count(),0);
    await page.locator('.projects-page').screenshot({path:path.join(root,'public/tutorials/bring-existing-work/step-6-projects.png')});
    await open.click();
    await page.getByRole('navigation',{name:'Primary navigation'}).getByRole('button',{name:'Settings',exact:true}).click();
    while(await dismiss.count())await dismiss.first().click();
    await page.locator('.settings-troubleshooting > summary').click();
    await page.locator('.settings-troubleshooting').screenshot({path:path.join(root,'public/tutorials/bring-existing-work/step-6-managed-main.png')});
    // Tutorial 2 step 2 reuses the same real Settings panel (Main only, no saved revision) at the wider 1280px layout it was first captured at.
    await page.setViewportSize({width:1280,height:1200});
    const folders=page.locator('.settings-troubleshooting');
    assert.equal(await folders.getByText('projects/Bracket Assembly/working/main').first().isVisible(),true);
    await folders.screenshot({path:path.join(root,'public/tutorials/save-first-revision/step-2-working-folder.png')});
    assert.deepEqual(errors,[]);
    console.log('Captured Tutorial 3 project list and managed location, plus Tutorial 2 working folder; original source unchanged.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
