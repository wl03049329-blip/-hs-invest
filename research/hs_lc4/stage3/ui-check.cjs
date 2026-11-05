// Isolated offline DESIGN acceptance, never a production/iPhone-PWA assertion.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{pathToFileURL}=require('url');
const {chromium,webkit}=require('playwright');
const out=path.resolve(process.argv[2]);if(!fs.existsSync(path.join(out,'radar-design.html')))throw Error('DESIGN_REQUIRED');
const results=[],screens=[];let checks=0;const ok=(v,msg)=>{checks++;if(!v)throw Error(msg)};
(async()=>{
 const html=fs.readFileSync(path.join(out,'radar-design.html'),'utf8');
 for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
  const browser=await engine.launch({headless:true,...(name==='chromium'?{channel:'chrome'}:{})});
  try{for(const w of [320,375,430,1280]){
   const context=await browser.newContext({viewport:{width:w,height:900},deviceScaleFactor:1,isMobile:w<650,hasTouch:w<650});
   await context.addInitScript(()=>{window.researchAudit={storage:0,network:0};for(const k of ['getItem','setItem','removeItem','clear'])Storage.prototype[k]=function(){window.researchAudit.storage++;throw Error('STORAGE_FORBIDDEN')};window.fetch=function(){window.researchAudit.network++;throw Error('NETWORK_FORBIDDEN')};});
   const page=await context.newPage(),errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url())});
   await page.goto(pathToFileURL(path.join(out,'radar-design.html')).href,{waitUntil:'load'});
   ok(await page.locator('#asof').innerText()==='2026-11-04',`${name}${w}: dated snapshot`);
   ok((await page.locator('.permit').innerText()).includes('尚未核准'),`${name}${w}: no authorization`);
   ok(await page.evaluate(()=>D.snapshot.score===null&&D.snapshot.writer===false),`${name}${w}: no score/writer`);
   ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${name}${w}: overflow`);
   for(const h of [5,10,20,40,60]){await page.locator(`[data-h="${h}"]`).click();ok(await page.locator(`[data-h="${h}"]`).getAttribute('aria-pressed')==='true',`${name}${w}: horizon${h}`)}
   await page.locator('[data-h="20"]').click();ok((await page.locator('#breaks').innerText()).includes('14件'),`${name}${w}: sample denominator`);
   for(const e of await page.locator('[data-h]').all()){const b=await e.boundingBox();ok(b.height>=44&&b.width>=44,`${name}${w}: touch target`)}
   const summary=page.locator('#integrity summary');await summary.click();ok(await page.locator('#integrity details').getAttribute('open')!==null,`${name}${w}: details open`);await summary.click();ok(await page.locator('#integrity details').getAttribute('open')===null,`${name}${w}: details close`);
   ok(errors.length===0,`${name}${w}: JS ${errors}`);ok(requests.length===0,`${name}${w}: external requests`);ok(await page.evaluate(()=>researchAudit.storage===0&&researchAudit.network===0),`${name}${w}: data isolation`);
   const shot=path.join(out,`${name}-${w}-design.png`);await page.screenshot({path:shot,fullPage:true});screens.push(shot);results.push({engine:name,channel:name==='chromium'?'installed Chrome':'bundled WebKit',browserVersion:browser.version(),width:w,status:'PASS',errors,external_requests:requests.length,real_iPhone:'NOT_TESTED'});
   if(w===375){const missing=await context.newPage(),errs=[];missing.on('pageerror',e=>errs.push(e.message));const modified=html.replace(/(<script type="application\/json" id="dataset">)([\s\S]*?)(<\/script>)/,(all,a,b,c)=>{const d=JSON.parse(b);const s=d.snapshot;s.opportunity.return5=null;s.opportunity.crash_velocity_pct_per_session=null;s.opportunity.positive_decline_percentile=null;s.opportunity.drawdown.dd120.drawdown=null;s.opportunity.drawdown.dd120.historical_depth_percentile=null;s.market.regime='UNKNOWN';s.stabilization.close=null;s.stabilization.prior5_high=null;s.stabilization.description='資料不足';s.data.research_copy='UNKNOWN';return a+JSON.stringify(d)+c});await missing.setContent(modified,{waitUntil:'load'});ok(await missing.locator('#return5').innerText()==='資料不足',`${name}: missing price`);ok((await missing.locator('#market').innerText()).includes('資料不足'),`${name}: missing market`);ok((await missing.locator('#integrity').innerText()).includes('停止判讀'),`${name}: missing integrity`);ok(errs.length===0,`${name}: missing JS errors`);ok((await missing.locator('.permit').innerText()).includes('尚未核准'),`${name}: missing auth`);await missing.screenshot({path:path.join(out,`${name}-missing-design.png`),fullPage:true});}
   await context.close();
  }}finally{await browser.close()}
 }
 fs.writeFileSync(path.join(out,'ui-results.json'),JSON.stringify({scope:'OFFLINE_DESIGN_ONLY',input_html_sha256:crypto.createHash('sha256').update(html).digest('hex'),pass:checks,fail:0,skip:0,cases:results,screenshots:screens,iPhoneSafari:'PENDING',installedPWA:'PENDING',production:'NOT_TESTED_NOT_DEPLOYED'},null,2));console.log(JSON.stringify({pass:checks,cases:results.length,fail:0,scope:'OFFLINE_DESIGN_ONLY'}));
})().catch(e=>{const f=path.join(out,'ui-failure.json');fs.writeFileSync(fs.existsSync(f)?path.join(out,`ui-failure-${Date.now()}.json`):f,JSON.stringify({error:String(e),checks_completed:checks,results},null,2));console.error(e);process.exitCode=1});
