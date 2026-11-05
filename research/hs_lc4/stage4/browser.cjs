// Built original root, isolated synthetic profile, public recorded quotes only.
const fs=require('fs'),path=require('path'),http=require('http'),crypto=require('crypto'),assert=require('assert/strict');
const {chromium,webkit}=require('playwright');
const root=path.resolve(__dirname,'../../..'),out=path.resolve(process.argv[2]),site=path.resolve(process.argv[3]);
fs.mkdirSync(out,{recursive:true});const results=[];let count=0,mode='normal',activePage=null,activeContext=null,activeCase=null;const network=[];
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),ok=(v,n)=>{assert.ok(v,n);count++;};
const originalPointer=JSON.parse(fs.readFileSync(path.join(site,'data/lc4-research/latest.json')));
function fixture(name){
 if(!name.startsWith('data/lc4-research/'))return null;
 if(mode==='missing')return false;
 if(!['stale','contract'].includes(mode))return null;
 const b=JSON.parse(fs.readFileSync(path.join(site,'data/lc4-research',originalPointer.path)));
 if(mode==='stale')b.next_source_check_due='2020-01-01T18:00:00+08:00';else b.writer=true;
 const bytes=Buffer.from(JSON.stringify(b));
 if(name.endsWith('latest.json'))return Buffer.from(JSON.stringify({...originalPointer,sha256:hash(bytes),bytes:bytes.length}));
 if(name.endsWith(originalPointer.path))return bytes;
 return null;
}
const server=http.createServer((req,res)=>{let name=decodeURIComponent(new URL(req.url,'http://local').pathname.slice(1))||'index.html';if(name.includes('..')){res.writeHead(400).end();return;}
 const file=path.join(site,name);let bytes=fixture(name);if(bytes===false||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
 if(bytes===null)bytes=require(root+'/tests/stable_app_recorded_market.cjs').read(name)||fs.readFileSync(file);
 if(mode==='hash'&&name.endsWith(originalPointer.path))bytes=Buffer.from(bytes.toString()+' ');
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'}[path.extname(name)]||'application/octet-stream';
 res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store'}).end(bytes);});
const ready=p=>p.waitForFunction(()=>document.documentElement.dataset.hsV3Boot==='ready'&&document.querySelector('[data-lc4-research-open]'));
const storage=p=>p.evaluate(()=>Object.fromEntries(Object.entries(localStorage).filter(([k])=>/hsPersonal|ledger|cash|lc4-test/i.test(k))));
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port+'/';
 for(const [name,engine]of[['chrome',chromium],['webkit',webkit]]){
  const browser=await engine.launch({headless:true,...(name==='chrome'?{channel:'chrome'}:{})});
  try{for(const width of[320,375,390,1280]){
   if(process.env.LC4_CASE&&process.env.LC4_CASE!==name+width)continue;
   mode='normal';const context=await browser.newContext({viewport:{width,height:900},isMobile:width<700,hasTouch:width<700});
   const page=await context.newPage();activePage=page;activeContext=context;activeCase=name+width;const errors=[],blockedRequests=new Set();page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>network.push({case:activeCase,url:r.url(),failure:r.failure(),at:performance.now()}));await context.route(/^https?:\/\/(?!127\.0\.0\.1)/,r=>{const u=new URL(r.request().url());blockedRequests.add('/'+u.host+u.pathname+u.search);return r.abort();});
   await context.tracing.start({screenshots:true,snapshots:true});await page.goto(base,{waitUntil:'domcontentloaded'});await ready(page);
   await page.waitForFunction(()=>self.HSStableApp?.status().phase==='CURRENT'&&navigator.serviceWorker.controller?.state==='activated');
   await page.evaluate(()=>localStorage.setItem('lc4-test-ledger','SYNTHETIC_UNCHANGED'));
   const before=await storage(page);const entry=page.locator('[data-lc4-research-open]').first();await entry.click();
   await page.waitForFunction(()=>document.querySelector('[data-lc4-health]')||document.querySelector('.lc4r-content')?.textContent.includes('無法核驗'));
   ok(await page.locator('[data-lc4-health]').isVisible(),'research ready: '+await page.locator('.lc4r-content').innerText());ok(await page.locator('#lc4-research').evaluate(n=>n.open),'integrated dialog');
   ok((await page.locator('.lc4r-content').innerText()).includes('FAIL_CLOSED'),'formal latch visible');
   ok((await page.locator('.lc4r-content').innerText()).includes('2026-11-04'),'dated seed');
   ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'root no horizontal overflow');
   ok(await page.locator('#lc4-research').evaluate(n=>n.scrollWidth<=n.clientWidth+1),'research no horizontal overflow');
   const box=await page.locator('#lc4-research header button').boundingBox();ok(box.width>=44&&box.height>=44,'close touch target');ok(box.y>=0,'header safe viewport');
   ok(await page.evaluate(()=>document.body.style.overflow==='hidden'),'background locked');
   await page.screenshot({path:path.join(out,`${name}-${width}-top.png`),fullPage:false});
   for(const h of['5','10','20']){await page.locator(`.lc4r [data-h="${h}"]`).click();ok(await page.locator(`.lc4r [data-h="${h}"]`).getAttribute('aria-pressed')==='true','horizon'+h);await page.locator('[data-lc4-distribution] summary').click();ok(await page.locator('[data-lc4-distribution]').getAttribute('open')!==null,'full empirical distribution visible'+h);await page.locator('[data-lc4-distribution] summary').click();}
   await page.locator('.lc4r [data-h="20"]').click();ok((await page.locator('.lc4r-content').innerText()).includes('11／14'),'historical denominator11/14');
   await page.screenshot({path:path.join(out,`${name}-${width}-risk.png`),fullPage:false});
   await page.locator('#lc4-research header button').click();ok(!await page.locator('#lc4-research').evaluate(n=>n.open),'close works');
   ok(await page.evaluate(()=>document.activeElement?.hasAttribute('data-lc4-research-open')),'focus returned');
   ok(await page.evaluate(()=>document.body.style.overflow!=='hidden'),'background restored');
   await entry.click();await page.locator('[data-lc4-health]').waitFor();await page.keyboard.press('Escape');ok(!await page.locator('#lc4-research').evaluate(n=>n.open),'Esc close');
   ok(JSON.stringify(await storage(page))===JSON.stringify(before),'zero financial writes');
   for(const tab of['signals','portfolio','sentiment','more','today']){await page.locator('.appNavButton[data-tab="'+tab+'"]:visible').first().click();ok(await page.locator('.appNavButton.active[data-tab="'+tab+'"]:visible').count()>=1,'tab '+tab);}
   // Refresh through the product root; no second website or alternate app.
   await page.reload({waitUntil:'commit'});await ready(page);ok((await storage(page))['lc4-test-ledger']==='SYNTHETIC_UNCHANGED','reload preserves synthetic sentinel');
   if(width===375){for(const testmode of['hash','contract','missing','stale']){mode=testmode;await entry.click();if(testmode==='stale'){await page.locator('[data-lc4-health]').waitFor();ok((await page.locator('.lc4r-content').innerText()).includes('資料可能過期'),'stale never current');}else{await page.waitForFunction(()=>document.querySelector('.lc4r-content')?.textContent.includes('無法核驗'));ok(await page.locator('.lc4r article').count()===0,testmode+' hides unverified values');}await page.locator('#lc4-research header button').click();}
    mode='normal';await entry.click();await page.locator('[data-lc4-health]').waitFor();await context.setOffline(true);await page.getByRole('button',{name:'檢查研究資料',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.lc4r-content')?.textContent.includes('無法核驗'));ok(true,'offline fail closed');await context.setOffline(false);await page.getByRole('button',{name:'檢查研究資料',exact:true}).click();await page.locator('[data-lc4-health]').waitFor();ok(true,'reconnection refresh');await page.locator('#lc4-research header button').click();}
   // Existing root may log blocked remote telemetry; no new module exceptions.
   const suffix=' due to access control checks.';
   const blockedRemote=errors.filter(e=>e.endsWith(suffix)&&(
    blockedRequests.has(e.slice(0,-suffix.length))||network.some(r=>{
     if(r.case!==activeCase||!/Access-Control-Allow-Origin/.test(r.failure?.errorText||''))return false;
     const u=new URL(r.url);return e==='/'+u.host+u.pathname+u.search+suffix;
    })));
   ok(errors.length===blockedRemote.length,'unexpected page errors '+errors.join(';'));await context.tracing.stop({path:path.join(out,`${name}-${width}.zip`)});
   results.push({engine:name,width,status:'PASS',browser:browser.version(),errors,blockedRequestCount:blockedRequests.size,externalNetwork:blockedRemote.length?'SKIP_TRACE_CONFIRMED_CORS_OR_EXPLICIT_ABORT':'NOT_LIVE_TESTED'});fs.writeFileSync(path.join(out,'partial.json'),JSON.stringify({pass:count,results},null,2));await context.close();activePage=null;activeContext=null;
  }}finally{await browser.close();}
 }
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({pass:count,fail:0,skip:results.filter(r=>r.externalNetwork.startsWith('SKIP')).length,results,source:'LOCAL_BUILT_ORIGINAL_ROOT_WITH_PINNED_TEST_MARKET',physical_iPhone:'PENDING',public_deployment:'NOT_PERFORMED'},null,2));console.log(JSON.stringify({pass:count,fail:0,cases:results.length}));
})().catch(async e=>{let state=null;try{state=await activePage.evaluate(()=>({url:location.href,dialog:document.querySelector('#lc4-research')?.open,research:document.querySelector('.lc4r-content')?.textContent,update:self.HSStableApp?.status()}));await activePage.screenshot({path:path.join(out,'failure-screen.png')});await activeContext.tracing.stop({path:path.join(out,'failure-trace.zip')});}catch{}fs.writeFileSync(path.join(out,'failure-'+Date.now()+'.json'),JSON.stringify({error:e.stack,activeCase,checks_completed:count,results,state,network},null,2));console.error(e);process.exitCode=1;}).finally(()=>server.closeAllConnections()||server.close());
