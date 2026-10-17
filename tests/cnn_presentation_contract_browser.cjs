/* Local-only, controlled-clock cross-renderer contract. Never publishes data. */
"use strict";
const {webkit,chromium}=require("playwright-core"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const url=process.argv[2]||"http://127.0.0.1:8883/";
assert.equal(new URL(url).hostname,"127.0.0.1");
const fixture=require("./fixtures/cnn-gauge-20261016.json").payload;
const start=Date.parse(fixture.updated_at)+600000;
const output=process.env.CNN_CONTRACT_EVIDENCE_DIR||path.resolve("../cnn-contract-evidence-20261017");
fs.mkdirSync(output,{recursive:true});
const protectedFiles=["cnn-fear-greed.json","finalized-core-score-snapshots-v1.json","final-core-production.js","portfolio-core.js","portfolio-ledger-core.js"];
const hashes=()=>Object.fromEntries(protectedFiles.map(f=>[f,crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")]));
const before=hashes(),results=[];
// ICU implementations differ only in the separating space (U+2009 vs U+0020).
const normal=value=>value.replace(/\s+/gu," ");
const stamp=iso=>normal(new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(iso)));
async function run(engine,width,edge=false){
 const browser=await engine.launch(edge?{headless:true,executablePath:"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"}:{headless:true});
 const context=await browser.newContext({viewport:{width,height:900},isMobile:width<600,hasTouch:width<600,timezoneId:"Asia/Taipei",serviceWorkers:"block",reducedMotion:"reduce"});
 const page=await context.newPage(),errors=[];let clock=start,mode="valid",payload=structuredClone(fixture);
 page.on("pageerror",e=>errors.push(e.message));
 await page.addInitScript(time=>{
  const Native=Date;window.cnnContractClock=time;window.Date=class extends Native{constructor(...args){super(...(args.length?args:[window.cnnContractClock]));}static now(){return window.cnnContractClock;}};sessionStorage.setItem("hsRadar.activeTab","today");
  // Observe a real loading cycle; the button is also enabled before startup begins.
  let started=false;
  new MutationObserver(records=>{for(const record of records){if(record.target.id!=="reload")continue;if(record.target.disabled)started=true;else if(started)window.cnnContractLoadCompleted=true;}}).observe(document,{subtree:true,attributes:true,attributeFilter:["disabled"]});
 },start);
 await page.route("**/cnn-fear-greed.json?*",route=>{
  if(mode==="http")return route.fulfill({status:503,body:"TEST_ONLY_OUTAGE"});
  if(mode==="malformed")return route.fulfill({contentType:"application/json",body:"{not valid JSON"});
  return route.fulfill({json:payload});
 });
 async function read(){return page.evaluate(()=>{
  const home=document.querySelector("#homeCnnCard"),chip=document.querySelector('#chipOverviewContent [data-chip-jump="mood"]'),dash=document.querySelector(".cnnDashboard"),vm=cnnGaugePresentation();
  return{score:vm.cnn?.score??null,rawScore:cnnFearGreed?.score??null,state:vm.state,status:vm.status,home:{value:home.querySelector("b").textContent,state:home.dataset.cnnState,status:home.querySelector("small").textContent,date:home.title},chip:{value:chip.querySelector("b").textContent,state:chip.dataset.cnnState,status:chip.querySelector("small").textContent,date:chip.title},dashboard:{value:dash.querySelector("[data-cnn-value]").textContent,state:dash.dataset.state,status:dash.querySelector(".cnnGaugeStatus").textContent,source:dash.querySelector('[data-cnn-time="source"]').textContent,local:dash.querySelector('[data-cnn-time="local"]').textContent},summary:document.querySelector("#homeSentimentConclusion").textContent,overviewSummary:document.querySelector(".chipOverviewConclusion").textContent,moodSummary:document.querySelector("#sentimentSummaryContent").textContent,radarSummary:document.querySelector("#radarSentimentText").textContent,inline:[...document.querySelectorAll("[data-cnn-readout]")].map(n=>n.textContent),width:innerWidth,documentWidth:document.documentElement.scrollWidth};
 });}
 async function verify(name,value,state,source,local){
  const r=await read(),text=value===null?"—":String(value);
  assert.equal(r.score,value,name);assert.equal(r.state,state,name);
  for(const key of ["home","chip","dashboard"]){assert.equal(r[key].value,text,name+" "+key);assert.equal(r[key].state,state,name+" "+key);}
  assert.equal(r.dashboard.status,r.status);assert.ok(r.chip.status.includes(r.status));
  if(state==="expired")assert.equal(r.home.status,"資料已過期");
  if(state==="failed")assert.equal(r.home.status,"更新失敗");
  if(state==="current")assert.equal(r.home.status,"最新資料");
  for(const key of ["home","chip"]){assert.ok(normal(r[key].date).includes(stamp(source)),name+" "+key+" source time: "+r[key].date+" EXPECT "+stamp(source));assert.ok(normal(r[key].date).includes(stamp(local)),name+" retrieval time");}
  assert.equal(normal(r.dashboard.source),stamp(source));assert.equal(normal(r.dashboard.local),stamp(local));
  for(const summary of [r.summary,r.overviewSummary,r.moodSummary,r.radarSummary]){
   assert.ok(summary.includes("台股缺少"),name+" missing Taiwan inputs");
   if(value===null){assert.ok(summary.includes("美股 CNN 資料暫缺"));assert.ok(!summary.includes("18.9"));}
   else{assert.ok(summary.includes("美股 CNN "+text));assert.ok(summary.includes(r.status));}
  }
  for(const inline of r.inline){assert.ok(inline.includes(text));assert.ok(inline.includes(r.status));if(value===null)assert.ok(!inline.includes("18.9"));}
  assert.ok(r.documentWidth<=r.width+1,"horizontal overflow");
  results.push({engine:edge?"Chromium":"WebKit",width,name,result:r});
 }
 async function navigate(){
  for(const [tab,panel] of [["today",null],["sentiment","overview"],["sentiment","mood"],["today",null]]){
   await page.evaluate(({tab,panel})=>{switchTab(tab,{scroll:false});if(panel)switchChipTab(panel,{scroll:false});},{tab,panel});
   await verify("navigation "+tab+"/"+panel,null,"expired",fixture.source_updated_at,fixture.updated_at);
  }
 }
 try{
  await page.goto(url+"?scenario=complete",{waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>window.cnnContractLoadCompleted===true);
  await page.locator('#homeCnnCard[data-cnn-state="current"]').waitFor({timeout:45000});
  // Exercise the real auxiliary renderer with unavailable C4, not fabricated scores.
  await page.evaluate(()=>{renderDecisionCenter([],null,{available:false});renderCnnPresentationViews();});
  await verify("valid initial",18.9,"current",fixture.source_updated_at,fixture.updated_at);
  // Change time only: same page and same cached object, no reload or backfill.
  clock=start+12*86400000;
  await page.evaluate(time=>{window.cnnContractClock=time;switchTab("sentiment",{scroll:false});switchChipTab("overview",{scroll:false});},clock);
  await verify("deadline crossed without reload",null,"expired",fixture.source_updated_at,fixture.updated_at);
  assert.equal((await read()).rawScore,18.9,"cache preserved, not destroyed to hide the issue");
  mode="http";await page.evaluate(()=>refreshCnnFearGreed({force:true}));
  await verify("expired cache plus HTTP failure",null,"expired",fixture.source_updated_at,fixture.updated_at);
  await page.evaluate(()=>{renderSentiment();renderDecisionCenter([],null,{available:false});document.querySelector("#fomoContent").appendChild(document.createElement("i"));});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>resolve())));
  await verify("explicit renderers and legacy observer cannot resurrect cache",null,"expired",fixture.source_updated_at,fixture.updated_at);
  await navigate();
  await page.evaluate(()=>{switchTab("sentiment",{scroll:false});switchChipTab("overview",{scroll:false});});
  await page.locator("#chipOverviewContent").scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(output,(edge?"chromium":"webkit")+"-"+width+"-expired.png")});
  payload={...structuredClone(fixture),score:fixture.previous.week,updated_at:new Date(clock-60000).toISOString(),source_updated_at:new Date(clock-120000).toISOString()};mode="valid";
  await page.evaluate(()=>refreshCnnFearGreed({force:true}));
  await verify("fresh source recovers all renderers",46.5,"current",payload.source_updated_at,payload.updated_at);
  const restored=structuredClone(payload);
  for(const bad of ["malformed","missing","future","old"]){
   mode=bad==="malformed"?"malformed":"valid";payload=structuredClone(restored);
   if(bad==="missing")payload.score=null;
   if(bad==="future")payload.updated_at=payload.source_updated_at=new Date(clock+7*3600000).toISOString();
   if(bad==="old")payload.updated_at=payload.source_updated_at=fixture.updated_at;
   await page.evaluate(()=>refreshCnnFearGreed({force:true}));
   await verify("reject "+bad+" but preserve valid cache",46.5,"failed",restored.source_updated_at,restored.updated_at);
  }
  payload=restored;mode="valid";await page.evaluate(()=>refreshCnnFearGreed({force:true}));
  await verify("recover after invalid responses",46.5,"current",restored.source_updated_at,restored.updated_at);
  // Reject the same invalid inputs on a cold page, without any valid cache.
  for(const bad of ["malformed","missing","future","old"]){
   mode=bad==="malformed"?"malformed":"valid";payload=structuredClone(fixture);
   if(bad==="missing")payload.score=null;
   if(bad==="future")payload.updated_at=payload.source_updated_at=new Date(start+7*3600000).toISOString();
   if(bad==="old")payload.updated_at=payload.source_updated_at="2020-01-01T00:00:00Z";
   await page.reload({waitUntil:"domcontentloaded"});
   await page.waitForFunction(()=>window.cnnContractLoadCompleted===true);
   const state=bad==="old"?"expired":"unavailable";
   await page.locator('#homeCnnCard[data-cnn-state="'+state+'"]').waitFor({timeout:45000});
   const r=await read();for(const key of ["home","chip","dashboard"]){assert.equal(r[key].value,"—");assert.equal(r[key].state,state);}
   assert.equal(r.dashboard.status,r.status);assert.ok(r.chip.status.includes(r.status));assert.ok(r.summary.includes("美股 CNN 資料暫缺"));
   const hasTime=bad==="missing"||bad==="future"||bad==="old";
   const expectedSource=hasTime?stamp(payload.source_updated_at):"—",expectedLocal=hasTime?stamp(payload.updated_at):"—";
   assert.equal(normal(r.dashboard.source),expectedSource);assert.equal(normal(r.dashboard.local),expectedLocal);
   for(const key of ["home","chip"]){assert.ok(normal(r[key].date).includes(expectedSource));assert.ok(normal(r[key].date).includes(expectedLocal));}
   results.push({engine:edge?"Chromium":"WebKit",width,name:"cold reject "+bad,result:r});
  }
  assert.deepEqual(errors,[]);console.log("PASS cross-renderer clock/failure/navigation/recovery "+(edge?"Chromium":"WebKit")+" "+width);
 }finally{await context.close();await browser.close();}
}
(async()=>{
 try{for(const width of [375,390,393,430,1280])await run(webkit,width);await run(chromium,1280,true);assert.deepEqual(hashes(),before);}
 finally{fs.writeFileSync(path.join(output,"contract-results.json"),JSON.stringify({note:"Fixed public fixture plus test-only response/time mutations. No official writes; WebKit is not physical iPhone/PWA.",results},null,2));}
})().catch(e=>{console.error(e);process.exitCode=1});
