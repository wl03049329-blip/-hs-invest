'use strict';
// Explicit browser suite: NODE_PATH must point to an installed playwright-core.
// Local fixture only by default; no upstream collection or production writes.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {webkit}=require('playwright-core');
const baseline=process.argv.includes('--baseline'),url=process.env.HS_STORY_TEST_URL||'http://127.0.0.1:8877/?scenario=complete';
const output=process.env.HS_STORY_EVIDENCE_DIR;
if(!output)throw Error('HS_STORY_EVIDENCE_DIR must be a private evidence directory outside Git');
const {measureStoryViewport,assertStoryViewport}=require('./test_hs_story_scroll');
const results=[];
async function isolateNetwork(context){const origin=new URL(url).origin;await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());}
async function recordTrustedInput(context){await context.addInitScript(()=>{
  window.storyCloseInputs=[];
  for(const type of ['pointerdown','touchstart','click'])document.addEventListener(type,e=>{if(e.target.closest?.('#closeHsStory'))window.storyCloseInputs.push({type,trusted:e.isTrusted,pointerType:e.pointerType||null});},{capture:true,passive:true});
});await isolateNetwork(context);}
async function audit(page,name,atBottom=false){
  if(!baseline)await page.waitForFunction(()=>{const m=document.querySelector('#hsStoryModal'),v=window.visualViewport,r=m.getBoundingClientRect();return Math.abs(r.width-(v?.width||innerWidth))<1&&Math.abs(r.height-(v?.height||innerHeight))<1&&Math.abs(r.top-(v?.offsetTop||0))<1;});
  const m=await page.evaluate(measureStoryViewport);
  await page.screenshot({path:path.join(output,name+'.png')});
  results.push({name,...m});if(!baseline)assertStoryViewport(m,{bottom:atBottom});return m;
}
async function open(page){await page.locator('#openHsStory').tap();await page.locator('#hsStoryModal').waitFor({state:'visible'});}
async function closeTouch(page){
  const box=await page.locator('#closeHsStory').boundingBox();
  await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2);
  await page.locator('#hsStoryModal').waitFor({state:'hidden'});
  const inputs=await page.evaluate(()=>window.storyCloseInputs.splice(0));
  assert.ok(inputs.some(e=>e.type==='touchstart'&&e.trusted));assert.ok(inputs.some(e=>e.type==='pointerdown'&&e.pointerType==='touch'&&e.trusted));assert.ok(inputs.some(e=>e.type==='click'&&e.trusted));
  results.push({name:'trusted-close-input',inputs});
  assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('hsStoryOpen')),false);
}
async function scroll(page,fraction){
  await page.locator('#hsStoryScroll').evaluate((s,f)=>{s.scrollTop=(s.scrollHeight-s.clientHeight)*f;},fraction);
  await page.waitForFunction(f=>{const s=document.querySelector('#hsStoryScroll');return Math.abs(s.scrollTop-(s.scrollHeight-s.clientHeight)*f)<2;},fraction);
}
(async()=>{
  fs.mkdirSync(output,{recursive:true});const browser=await webkit.launch({headless:true});
  try{
    const sizes=baseline?[{width:390,height:844}]:[{width:375,height:812},{width:390,height:844},{width:393,height:852},{width:430,height:932}];
    for(const size of sizes){
      const context=await browser.newContext({viewport:size,isMobile:true,hasTouch:true,deviceScaleFactor:2});
      await recordTrustedInput(context);
      const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(url);await page.getByRole('button',{name:'更多',exact:true}).tap();await open(page);
      const ancestors=await page.locator('#hsStoryModal').evaluate(m=>{const a=[];for(let e=m.parentElement;e;e=e.parentElement){const s=getComputedStyle(e);a.push({tag:e.tagName,id:e.id,class:e.className,transform:s.transform,filter:s.filter,overflow:s.overflow,zIndex:s.zIndex});}return a;});
      results.push({name:'ancestors-'+size.width,ancestors,engine:'WebKit '+browser.version(),physicalIPhone:false});
      if(baseline){
        await scroll(page,1);
        await audit(page,'baseline-bottom');await context.close();continue;
      }
      for(const [label,fraction]of [['top',0],['middle',.5],['bottom',1]]){
        await scroll(page,fraction);await audit(page,'webkit-'+size.width+'-'+label,fraction===1);await closeTouch(page);await open(page);
        assert.equal(await page.locator('#hsStoryScroll').evaluate(s=>s.scrollTop),0);
      }
      for(const id of ['intention','etfs','birth','research','leverage','future']){
        await page.locator('.hsStoryNav [data-story-target="hs-story-'+id+'"]').tap();
        await page.waitForFunction(id=>{const c=document.querySelector('#hs-story-'+id),nav=document.querySelector('.hsStoryNav'),r=c.getBoundingClientRect(),n=nav.getBoundingClientRect();return r.top>=n.bottom-2&&r.top<=n.bottom+16;},id);
        await audit(page,'webkit-'+size.width+'-chapter-'+id);
        assert.equal(await page.locator('.hsStoryNav [aria-current="true"]').getAttribute('data-story-target'),'hs-story-'+id);
      }
      await scroll(page,1);await page.locator('#hsStoryTop').tap();await page.waitForFunction(()=>document.querySelector('#hsStoryScroll').scrollTop<2);await closeTouch(page);await open(page);
      await page.setViewportSize({width:size.height,height:size.width});await audit(page,'webkit-'+size.width+'-landscape');await closeTouch(page);await open(page);
      await page.setViewportSize({width:size.width,height:600});await audit(page,'webkit-'+size.width+'-short');await closeTouch(page);
      assert.deepEqual(errors,[]);await context.close();
    }
    if(!baseline){
      // Controlled geometry regression: this is NOT a real iOS/PWA session.
      const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});await recordTrustedInput(context);
      await context.addInitScript(()=>{
        const v=new EventTarget();Object.assign(v,{offsetTop:90,offsetLeft:0,width:390,height:600,scale:1});Object.defineProperty(window,'visualViewport',{value:v});Object.defineProperty(navigator,'standalone',{value:true});
      });
      const page=await context.newPage();await page.goto(url);await page.addStyleTag({content:'#hsStoryModal{--hs-story-safe-top:47px;--hs-story-safe-right:0px}'});
      await page.getByRole('button',{name:'更多',exact:true}).tap();await open(page);await audit(page,'controlled-pwa-safe-area-offset');
      results.push({name:'controlled-pwa-safe-area-offset-limit',syntheticGeometry:true,physicalPWA:false});await closeTouch(page);await open(page);
      await page.evaluate(()=>{const v=window.visualViewport;Object.assign(v,{offsetTop:120,offsetLeft:60,width:250,height:450,scale:1.5});v.dispatchEvent(new Event('resize'));v.dispatchEvent(new Event('scroll'));});
      await audit(page,'controlled-zoom-offset');await closeTouch(page);await context.close();
      const desktop=await browser.newContext({viewport:{width:1280,height:900}});await isolateNetwork(desktop);const d=await desktop.newPage();await d.goto(url);await d.getByRole('button',{name:'更多',exact:true}).click();await d.locator('#openHsStory').click();
      await audit(d,'webkit-desktop-top');await scroll(d,1);await audit(d,'webkit-desktop-bottom',true);await d.locator('#closeHsStory').click();await d.locator('#hsStoryModal').waitFor({state:'hidden'});
      await d.locator('#openHsStory').click();await d.keyboard.press('Escape');await d.locator('#hsStoryModal').waitFor({state:'hidden'});
      await d.locator('#openHsStory').click();await d.mouse.click(30,450);await d.locator('#hsStoryModal').waitFor({state:'hidden'});await desktop.close();
    }
    fs.writeFileSync(path.join(output,'webkit-results.json'),JSON.stringify(results,null,2));
    console.log(JSON.stringify({engine:'WebKit '+browser.version(),baseline,audits:results.length,physicalIPhone:false,status:baseline?'BASELINE_CAPTURED':'PASS'}));
  }finally{await browser.close();}
})().catch(e=>{fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'webkit-results.json'),JSON.stringify({status:'FAIL',error:e.stack,results},null,2));console.error(e.stack);process.exitCode=1;});
