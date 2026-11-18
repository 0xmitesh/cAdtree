// Refresh Tutorial 2's first-revision History capture through the current App.
// Run after npm run build: node tests/tutorial-2-capture.cjs
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const {build} = require('esbuild');
const {chromium} = require('@playwright/test');
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts/tutorial-2');
(async () => {
  fs.mkdirSync(artifacts, {recursive:true});
  const bundle = await build({stdin:{resolveDir:root, loader:'tsx', contents:`
import {createRoot} from 'react-dom/client';
import App from './src/App';
import {InMemoryFileSystemAdapter} from './src/engine/fs-adapter';
import {createHome,createHomeWorkspace} from './src/engine/home-service';
import {createProject} from './src/engine/workspace-service';
import {captureRevision} from './src/engine/revision-service';
import {nativeDirectory} from './tests/native-fs';
import {createTestAuthController} from './tests/test-auth';
async function start(){
 const home=new InMemoryFileSystemAdapter('Cadtree');await createHome(home);
 const {workspace}=await createHomeWorkspace(home,'Tutorial Workspace');
 const p=await createProject(workspace.root,'Bracket Assembly');
 const main=p.workingFolders['branch-main'];
 for(const name of ['Bracket.SLDPRT','Mount.SLDPRT','BracketAssembly.SLDASM'])await main.writeFileText([name],'SYNTHETIC TUTORIAL SAMPLE - NOT A VALID CAD DOCUMENT');
 await captureRevision(main,p.vaultDir,{branchId:'branch-main',summary:'Finalize bracket mounting flange after stress review',notes:{problem:'Review flange strength.',modification:'Increase flange thickness from 4 mm to 5 mm.',observations:'Validate in CAD before release.'},workingFolders:p.workingFolders});
 window.showDirectoryPicker=async()=>nativeDirectory(home);
 createRoot(document.getElementById('root')).render(<App auth={createTestAuthController().adapter}/>);
}start();`}, bundle:true, write:false, format:'iife', jsx:'automatic', define:{'process.env.NODE_ENV':'"production"'}});
  const cssDir=path.join(root,'dist/assets');
  const css=fs.readFileSync(path.join(cssDir,fs.readdirSync(cssDir).find(n=>n.endsWith('.css'))),'utf8');
  const html=path.join(artifacts,'capture.html');
  fs.writeFileSync(html,'<!doctype html><html><head><meta charset="utf-8"><style>'+css+'</style></head><body><div id="root"></div><script>'+bundle.outputFiles[0].text.replaceAll('</script','<\\/script')+'</script></body></html>');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1200},deviceScaleFactor:3});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(pathToFileURL(html).href);
    await page.addStyleTag({content:'.panel,.history-canvas,.revision-detail {box-shadow:none !important;}'});
    await page.getByRole('button',{name:'Open my Cadtree home',exact:true}).click();
    await page.getByRole('textbox',{name:'Cadtree home folder address',exact:true}).fill('D:\\Cadtree');
    await page.getByRole('button',{name:'Complete setup',exact:true}).click();
    await page.getByRole('button',{name:'Open workspace',exact:true}).click();
    await page.getByRole('button',{name:'Open project',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('main')?.getAttribute('aria-busy')==='false');
    const dismiss=page.getByRole('button',{name:'Dismiss message',exact:true});
    while(await dismiss.count())await dismiss.first().click();
    const revision=page.getByRole('button',{name:/Rev 001: Finalize bracket mounting flange/});
    await revision.click();
    assert.equal(await page.locator('.project-context-header').getAttribute('data-branch-id'),'branch-main');
    const layout=await page.locator('.history-layout').boundingBox();
    const node=await revision.boundingBox();
    const detail=await page.locator('.revision-detail .detail-header').boundingBox();
    // Focus the saved-state evidence; omit the heading instead of shrinking it
    // together with the shared project header into the tutorial image frame.
    await page.screenshot({path:path.join(root,'public/tutorials/save-first-revision/step-6-history.png'),clip:{x:layout.x-8,y:layout.y-8,width:layout.width+16,height:Math.max(node.y+node.height+32,detail.y+detail.height)-layout.y+16}});
    assert.deepEqual(errors,[]);
    console.log('Captured Tutorial 2 first Main revision through the current App.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
