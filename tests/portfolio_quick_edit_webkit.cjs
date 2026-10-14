"use strict";
// Isolated personal-position fixtures only. Never uses an existing user profile.
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict"),{webkit}=require("playwright-core");
const ledgerCore=require("../portfolio-ledger-core");
const url=process.env.HS_PORTFOLIO_TEST_URL||"http://127.0.0.1:8878/?scenario=complete",out=process.env.HS_PORTFOLIO_EVIDENCE_DIR;
if(!out)throw Error("Private evidence directory required");
const results=[],H="hsRadar.portfolio.holdings",L="hsRadar.portfolio.ledger.v1";let lastPage;
async function open(page,mobile){await page.locator(mobile?'[data-mobile-holding="00830"]':'[data-edit-holding="00830"]').click();await page.locator("#portfolioModal").waitFor({state:"visible"});assert.equal(await page.locator("#portfolioLedgerModal").isVisible(),false)}
async function read(page,key){return page.evaluate(k=>JSON.parse(localStorage.getItem(k)||"null"),key)}
async function hidden(page){await page.locator("#portfolioModal").waitFor({state:"hidden"})}
async function closeAudit(page,name){
 const geometry=await page.locator("#portfolioModalClose").evaluate(b=>{const r=b.getBoundingClientRect(),v=visualViewport,x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height,viewport:{top:v?.offsetTop||0,height:v?.height||innerHeight,width:v?.width||innerWidth},hit:b===hit||b.contains(hit),parent:b.parentElement.id}});
 assert.equal(geometry.parent,"portfolioModal");assert.ok(geometry.hit);assert.ok(geometry.height>=48);assert.ok(geometry.top>=geometry.viewport.top);assert.ok(geometry.bottom<=geometry.viewport.top+geometry.viewport.height);
 await page.screenshot({path:path.join(out,name+".png")});
 const box=await page.locator("#portfolioModalClose").boundingBox();await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2);await hidden(page);
 assert.equal(await page.evaluate(()=>document.documentElement.classList.contains("portfolioEditorOpen")),false);
 assert.ok((await page.evaluate(()=>window.testCloseInputs.splice(0))).some(e=>e.trusted&&e.type==="touchstart"));
 results.push({name,...geometry});
}
(async()=>{
 fs.mkdirSync(out,{recursive:true});const browser=await webkit.launch({headless:true});
 try{for(const width of [375,390,430,1280])for(const enabled of [false,true]){
  const mobile=width<600,context=await browser.newContext({viewport:{width,height:mobile?812:900},isMobile:mobile,hasTouch:true});
  await context.route("**/*",route=>new URL(route.request().url()).origin===new URL(url).origin?route.continue():route.abort());
  const time=new Date(Date.now()-86400000).toISOString(),date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(time));
  const seedLedger=ledgerCore.migrateLegacyPortfolio({holdings:[{code:"00830",shares:1000,averageCost:80}],cash:1234,tradeDate:date,timestamp:time});
  await context.addInitScript(({enabled,H,L,seedLedger})=>{
   // Exercise cancellation with standard Fetch semantics: an already aborted
   // request rejects without attempting the local HTTP transport. WebKit's
   // intercepted localhost transport otherwise misreports it as a CORS error.
   const nativeFetch=window.fetch.bind(window);
   window.fetch=(input,options={})=>options.signal?.aborted?Promise.reject(options.signal.reason||new DOMException("Aborted","AbortError")):nativeFetch(input,options);
   if(!localStorage.getItem("test.quickEdit.seeded")){
    const date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(Date.now()-86400000));
    const time=new Date(Date.now()-86400000).toISOString();
    const h={code:"00830",shares:1000,averageCost:80,customName:"測試核心持股",name:"測試用持股",strategyType:"longTerm",targetAllocation:40};
    localStorage.setItem(H,JSON.stringify([h]));localStorage.setItem("hsRadar.portfolio.autoRefresh","false");
    if(enabled)localStorage.setItem(L,JSON.stringify(seedLedger));
    localStorage.setItem("test.quickEdit.seeded","1");
   }
   window.testCloseInputs=[];
   document.addEventListener("touchstart",e=>{if(e.target.closest?.("#portfolioModalClose"))window.testCloseInputs.push({type:e.type,trusted:e.isTrusted})},{capture:true,passive:true});
  },{enabled,H,L,seedLedger});
  const page=await context.newPage(),errors=[];lastPage=page;page.on("pageerror",e=>{errors.push(e.message);console.log("BROWSER_ERROR",width,enabled,e.name,e.message,e.stack)});
  await page.goto(url,{waitUntil:"domcontentloaded"});await page.waitForFunction(()=>Boolean(window.HSPortfolioV6));await page.waitForLoadState("networkidle");
  await page.locator(mobile?'.bottomNavButton[data-tab="portfolio"]':'.topTab[data-tab="portfolio"]').click();
  await open(page,mobile);const initial=await read(page,H),originalLedger=await read(page,L);
  assert.match(await page.locator("#portfolioPositionCurrent").textContent(),/00830.*1,000.*1.*80/);
  await page.locator('[data-add-shares="1000"]').click();assert.equal(await page.locator("#portfolioShares").inputValue(),"2000");
  await page.locator("#portfolioAverageCost").fill("83.25");assert.match(await page.locator("#portfolioPositionPreview").textContent(),/166,500/);
  await page.locator("#portfolioCancelBtn").click();await hidden(page);assert.deepEqual(await read(page,H),initial);assert.deepEqual(await read(page,L),originalLedger);
  await open(page,mobile);await page.locator('[data-add-shares="100"]').click();assert.equal(await page.locator("#portfolioShares").inputValue(),"1100");
  await page.keyboard.press("Escape");await hidden(page);assert.deepEqual(await read(page,H),initial);
  for(const [shares,cost]of [["0","80"],["1000","-1"],["","80"],["1000",""]]){
   await open(page,mobile);await page.locator("#portfolioShares").fill(shares);await page.locator("#portfolioAverageCost").fill(cost);await page.locator("#portfolioSaveBtn").click();
   assert.ok((await page.locator("#portfolioFormError").textContent()).length>0);assert.deepEqual(await read(page,H),initial);assert.deepEqual(await read(page,L),originalLedger);
   await page.locator("#portfolioModalClose").click();await hidden(page);
  }
  if(width===390){
   // A write interruption must not leave an appended event with stale holdings.
   await open(page,mobile);await page.locator('[data-add-shares="1000"]').click();
   await page.evaluate(H=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k===H){Storage.prototype.setItem=set;throw new DOMException("Test storage quota","QuotaExceededError")}return set.call(this,k,v)}},H);
   await page.locator("#portfolioSaveBtn").click();assert.match(await page.locator("#portfolioFormError").textContent(),/quota/);
   assert.deepEqual(await read(page,H),initial);assert.deepEqual(await read(page,L),originalLedger);
   await page.locator("#portfolioCancelBtn").click();await hidden(page);
   // Do not overwrite another tab's position or append a correction from stale UI.
   await open(page,mobile);await page.locator('[data-add-shares="100"]').click();
   await page.evaluate(H=>{const rows=JSON.parse(localStorage.getItem(H));rows[0].shares=1001;localStorage.setItem(H,JSON.stringify(rows))},H);
   await page.locator("#portfolioSaveBtn").click();assert.match(await page.locator("#portfolioFormError").textContent(),/其他視窗/);assert.equal((await read(page,H))[0].shares,1001);assert.deepEqual(await read(page,L),originalLedger);
   await page.evaluate(({H,initial})=>localStorage.setItem(H,JSON.stringify(initial)),{H,initial});
   await page.locator("#portfolioCancelBtn").click();await hidden(page);
  }
  await open(page,mobile);await page.locator('[data-add-shares="1000"]').click();await page.locator("#portfolioAverageCost").fill("83.25");await page.locator("#portfolioSaveBtn").click();await hidden(page);
  let saved=await read(page,H);assert.equal(saved[0].shares,2000);assert.equal(saved[0].averageCost,83.25);assert.equal(saved[0].customName,initial[0].customName);assert.equal(saved[0].targetAllocation,40);
  if(enabled){const next=await read(page,L);assert.deepEqual(next.events.slice(0,2),originalLedger.events);assert.equal(next.events.length,3);const e=next.events.at(-1);assert.equal(e.type,"POSITION_CORRECTION");assert.equal(e.quantity,2000);assert.equal(e.unitPrice,83.25);assert.equal(e.cashImpact,0);assert.equal(e.externalCashFlow,0)}
  assert.match(await page.locator("#portfolioPerformanceEmpty").textContent(),/持股已手動校正/);
  await page.waitForLoadState("networkidle");
  await page.reload({waitUntil:"domcontentloaded"});await page.waitForFunction(()=>Boolean(window.HSPortfolioV6));await page.waitForLoadState("networkidle");assert.equal((await read(page,H))[0].shares,2000);
  await page.locator(mobile?'.bottomNavButton[data-tab="portfolio"]':'.topTab[data-tab="portfolio"]').click();await open(page,mobile);assert.equal(await page.locator("#portfolioShares").inputValue(),"2000");
  if(mobile){for(const fraction of [0,.5,1]){await page.locator("#portfolioForm").evaluate((f,n)=>{f.scrollTop=(f.scrollHeight-f.clientHeight)*n},fraction);await closeAudit(page,"webkit-"+width+"-"+enabled+"-"+fraction);await open(page,mobile)}}
  await page.locator("#portfolioCancelBtn").click();await hidden(page);
  await page.locator('#portfolioMoreTools > summary').click();
  await page.locator('#portfolioWorkflowNav [data-portfolio-section="settings"]').click();
  await page.locator('#portfolioSettingsPanel > summary').click();
  page.on("dialog",d=>d.accept());await page.locator("[data-recovery-restore]").first().click();
  await page.waitForFunction(()=>window.HSPortfolioV6.getState().holdings[0].shares===1000);
  if(enabled)assert.deepEqual(await read(page,L),originalLedger);else assert.equal(await read(page,L),null);
  assert.equal((await read(page,H))[0].averageCost,80);
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  results.push({name:"flow-"+width+"-"+enabled,engine:browser.version(),physicalIPhone:false,errors,saveReloadRestore:true,cancel:true,invalid:true});await context.close();
 }}catch(error){await lastPage?.screenshot({path:path.join(out,"failure.png")});console.log(await lastPage?.evaluate(()=>({more:document.querySelector("#portfolioMoreTools").open,classes:document.querySelector("#portfolio").className,settingsHidden:document.querySelector('[data-portfolio-tool="settings"]').hidden,scrollY,active:document.querySelector("#portfolioWorkflowNav .active")?.textContent})));throw error;}finally{await browser.close();fs.writeFileSync(path.join(out,"results.json"),JSON.stringify(results,null,2))}
 console.log("WebKit quick edit PASS: "+results.length+" evidence records");
})().catch(e=>{console.error(e);process.exitCode=1});
