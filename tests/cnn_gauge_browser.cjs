/* Local-only UI regression. Routes never publish fixtures or call providers.
 * NODE_PATH must include playwright-core; run against radar_offline_server.py.
 * Real default data = unchanged repository JSON. Edge cases are test-only.
 */
const {webkit,chromium}=require("playwright-core"),fs=require("fs"),path=require("path"),os=require("os"),crypto=require("crypto"),assert=require("assert/strict");
const url=process.argv[2]||"http://127.0.0.1:8883/";
assert.equal(new URL(url).hostname,"127.0.0.1","Never run fixture routing on a production origin");
const output=process.env.CNN_GAUGE_EVIDENCE_DIR||path.join(os.tmpdir(),"hs-cnn-gauge-"+Date.now());
fs.mkdirSync(output,{recursive:true});
const actual=JSON.parse(fs.readFileSync("cnn-fear-greed.json","utf8")),hash=p=>crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const protectedFiles=["cnn-fear-greed.json","finalized-core-score-snapshots-v1.json","final-core-production.js","portfolio-core.js","portfolio-ledger-core.js"];
const before=Object.fromEntries(protectedFiles.map(p=>[p,hash(p)])),fixed=Date.parse(actual.updated_at)+600000,results=[];
const visible=async(page,selector)=>page.locator(selector).isVisible();
async function evidence(page){
 return page.evaluate(()=>{
  const panel=document.querySelector("#cnnFearGreedPanel"),gauge=panel.querySelector("[data-cnn-gauge]"),svg=gauge.querySelector("svg"),needle=gauge.querySelector("[data-cnn-needle]"),rect=panel.getBoundingClientRect(),sr=svg.getBoundingClientRect(),nr=needle.getScreenCTM(),base=svg.getScreenCTM(),score=Number(gauge.dataset.score),a=(score*1.8-90)*Math.PI/180;
  const tip=nr?new DOMPoint(180,54).matrixTransform(nr):null,expected=base?new DOMPoint(180+116*Math.sin(a),170-116*Math.cos(a)).matrixTransform(base):null;
  return{score:gauge.dataset.score,value:panel.querySelector("[data-cnn-value]").textContent,label:panel.querySelector("[data-cnn-label]").textContent,state:panel.querySelector(".cnnDashboard").dataset.state,status:panel.querySelector(".cnnGaugeStatus").textContent,angle:needle.dataset.angle||null,needleVisible:needle.getAttribute("visibility")==="visible",tip,expected,positionError:tip&&expected?Math.hypot(tip.x-expected.x,tip.y-expected.y):null,svg:{left:sr.left,right:sr.right,width:sr.width,height:sr.height},panel:{left:rect.left,right:rect.right,top:rect.top,height:rect.height},viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,bands:panel.querySelectorAll("[data-cnn-band]").length,zones:panel.querySelectorAll("[data-cnn-zone]").length,activeZones:panel.querySelectorAll('[data-cnn-zone][data-active="true"]').length,homeValue:document.querySelector("#homeCnnCard>b").textContent,homeState:document.querySelector("#homeCnnCard").dataset.cnnState,sourceTime:panel.querySelector('[data-cnn-time="source"]').textContent,comparisons:[...panel.querySelectorAll("[data-cnn-compare]")].map(r=>({period:r.dataset.cnnCompare,value:r.querySelector("b").textContent,delta:r.querySelector("em").textContent})),focus:document.activeElement.id,panelVisible:!document.querySelector('#sentiment').classList.contains("tabHidden"),moodVisible:!document.querySelector('[data-chip-panel="mood"]').hidden,otherPanels:[...document.querySelectorAll("[data-chip-panel]")].filter(p=>p.dataset.chipPanel!=="mood").every(p=>p.hidden),legend:[...panel.querySelectorAll("[data-cnn-zone]")].map(n=>{const r=n.getBoundingClientRect();return{left:r.left,right:r.right};})};
 });
}
async function geometry(page){
 const r=await evidence(page);assert.equal(r.bands,5);assert.equal(r.zones,5);assert.ok(r.documentWidth<=r.viewport+1,"horizontal overflow");assert.ok(r.panel.left>=-1&&r.panel.right<=r.viewport+1);
 if(r.needleVisible){assert.equal(r.activeZones,1);assert.ok(r.positionError<.6,"needle transform must match raw score: "+r.positionError);}
 for(const box of r.legend)assert.ok(box.left>=-1&&box.right<=r.viewport+1);
 return r;
}
async function click(page,locator,mobile){await locator.scrollIntoViewIfNeeded();if(mobile)await locator.tap();else await locator.click();}
async function settleScroll(page){
 await page.evaluate(()=>{delete window.cnnTestScrollSample;});
 await page.waitForFunction(()=>{
  const top=document.querySelector("#cnnFearGreedPanel").getBoundingClientRect().top,old=window.cnnTestScrollSample;
  window.cnnTestScrollSample={top,stable:old&&Math.abs(top-old.top)<.1?old.stable+1:0};
  return window.cnnTestScrollSample.stable>=3;
 },undefined,{polling:100,timeout:5000});
}
async function run(engine,width,{edge=false,full=false}={}){
 const browser=await engine.launch(edge?{headless:true,executablePath:"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"}:{headless:true});
 const mobile=width<600,context=await browser.newContext({viewport:{width,height:900},isMobile:mobile,hasTouch:mobile,timezoneId:"Asia/Taipei",serviceWorkers:"block",reducedMotion:full?"no-preference":"reduce"});
 const page=await context.newPage(),errors=[],badRequests=[];let mode="real",requests=0;
 page.on("pageerror",e=>errors.push(e.message));page.on("requestfailed",r=>badRequests.push({url:r.url(),error:r.failure()?.errorText}));
 await page.addInitScript(time=>{const Native=Date;window.Date=class extends Native{constructor(...args){super(...(args.length?args:[time]));}static now(){return time;}};sessionStorage.setItem("hsRadar.activeTab","today");},fixed);
 await page.route("**/cnn-fear-greed.json?*",async route=>{
  requests++;if(mode==="http")return route.fulfill({status:503,body:"TEST_ONLY_TRANSPORT_FAILURE"});
  const p=structuredClone(actual);
  if(mode==="updated")p.score=actual.previous.week;
  if(mode==="missing")p.score=null;
  if(mode==="zero")p.score=0;
  if(mode==="half")p.score=50;
  if(mode==="maximum")p.score=100;
  if(mode==="expired")p.updated_at=p.source_updated_at="2020-01-01T00:00:00Z";
  if(mode==="stale")p.updated_at=p.source_updated_at=new Date(fixed-6*86400000).toISOString();
  return route.fulfill({json:p});
 });
 const filename=(name)=>(edge?"edge":"webkit")+"-"+width+"-"+name+".png";
 try{
  await page.goto(url+"?scenario=complete",{waitUntil:"domcontentloaded"});
  await page.locator('#homeCnnCard[data-cnn-state="current"]').waitFor({timeout:45000});
  assert.equal(await page.locator("#homeSentimentCards>button").count(),6);
  assert.equal(await page.locator("#homeCnnCard>b").innerText(),String(actual.score));
  assert.match(await page.locator("#homeCnnCard>span").first().innerText(),/美股/);
  const summary=await page.locator("#homeSentimentConclusion").innerText();
  assert.match(summary,/美股 CNN 18\.9/);assert.match(summary,/資料不足/);
  assert.doesNotMatch(summary,/融資壓力中性|市場情緒偏恐懼|低檔分批/);
  assert.equal(await page.locator("#homeSentimentOverviewCard>b").innerText(),"資料不足");
  await page.locator("#homeSentiment").scrollIntoViewIfNeeded();await page.locator("#homeSentiment").screenshot({path:path.join(output,filename("home"))});
  await click(page,page.locator("#homeCnnCard"),mobile);await page.waitForTimeout(full?800:100);await settleScroll(page);
   const first=await geometry(page);assert.ok(first.panelVisible&&first.moodVisible&&first.otherPanels);assert.equal(first.focus,"cnnFearGreedPanel");
   // scrollIntoView is legitimately clamped at the document bottom on desktop.
   // Require the panel near the top OR its entire content visible; do not add
   // artificial page whitespace just to satisfy a fixed pixel threshold.
   assert.ok(first.panel.top>=0&&(first.panel.top<200||first.panel.top+first.panel.height<=900),"dashboard must be anchored or entirely visible");
   assert.equal(first.value,String(actual.score));assert.equal(Number(first.angle),actual.score*1.8-90);
   assert.equal(await page.locator('#cnnFearGreedPanel [data-cnn-band][data-active="true"]').count(),1);
   assert.equal(await page.locator('#cnnFearGreedPanel [data-cnn-band][data-active="true"]').evaluate(el=>getComputedStyle(el).stroke),"rgb(241, 217, 156)");
  assert.deepEqual(first.comparisons.map(r=>r.value),[actual.previous.day,actual.previous.week,actual.previous.month].map(String));
  await page.locator("#cnnFearGreedPanel").screenshot({path:path.join(output,filename("dashboard"))});
  results.push({engine:edge?"Chromium/Edge":"WebKit",width,mode:"real unchanged local artifact",requests,evidence:first});
  await click(page,page.locator('[data-chip-tab="margin"]'),mobile);assert.ok(!(await visible(page,"#cnnFearGreedPanel")));
  await click(page,page.locator('[data-chip-tab="mood"]'),mobile);assert.equal(await page.locator("#cnnFearGreedContent [data-cnn-gauge]").count(),1);
  await page.locator("[data-cnn-source]").scrollIntoViewIfNeeded();
  assert.ok(await page.locator("[data-cnn-source]").evaluate(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return r.top>=0&&r.bottom<=innerHeight&&!!hit&&(hit===el||el.contains(hit));}),"source link must remain visible and hit-testable above navigation");
  const bottom=await page.evaluate(()=>{
   const source=document.querySelector('[data-cnn-source]').getBoundingClientRect(),footer=document.querySelector('.appFooter').getBoundingClientRect(),nav=document.querySelector('.bottomNav'),n=nav.getBoundingClientRect();
   return{sourceBottom:source.bottom,footerBottom:footer.bottom,navTop:n.top,navVisible:getComputedStyle(nav).display!=="none"&&n.height>0};
  });
  if(mobile&&bottom.navVisible){assert.ok(bottom.sourceBottom<=bottom.navTop,"source must clear fixed navigation");assert.ok(bottom.footerBottom<=bottom.navTop,"footer must clear fixed navigation");}
  results.push({width,bottomNavigationSafety:bottom});
  await page.screenshot({path:path.join(output,filename("source-bottom"))});
  if(full){
   const initialRequests=requests;
   await page.evaluate(()=>{window.cnnTestNeedle=document.querySelector('#cnnFearGreedContent [data-cnn-needle]');});
   mode="updated";await click(page,page.locator("[data-cnn-refresh]"),mobile);
   await page.waitForFunction(value=>document.querySelector('#cnnFearGreedContent [data-cnn-gauge]').dataset.score===String(value),actual.previous.week);await page.waitForTimeout(800);
   const updated=await geometry(page);assert.equal(updated.value,String(actual.previous.week));assert.equal(updated.homeValue,updated.value);assert.equal(requests,initialRequests+1);assert.ok(await page.evaluate(()=>window.cnnTestNeedle===document.querySelector('#cnnFearGreedContent [data-cnn-needle]')),"needle DOM reused for real animation and focus stability");
   results.push({width,mode:"TEST_ONLY refresh from a real historical comparison value",evidence:updated});
   mode="http";await click(page,page.locator("[data-cnn-refresh]"),mobile);await page.locator('.cnnDashboard[data-state="failed"]').waitFor();
   const failed=await geometry(page);assert.equal(failed.value,updated.value);assert.equal(failed.homeState,"failed");await page.locator("#cnnFearGreedPanel").screenshot({path:path.join(output,filename("failed-retained"))});results.push({width,mode:"TEST_ONLY source outage",evidence:failed});
   for(const state of ["missing","expired","stale","zero","half","maximum"]){
    mode=state;await page.reload({waitUntil:"domcontentloaded"});
    const expectedState={missing:"unavailable",expired:"expired",stale:"stale",zero:"current",half:"current",maximum:"current"}[state];await page.locator('#homeCnnCard[data-cnn-state="'+expectedState+'"]').waitFor({timeout:45000});
    await click(page,page.locator("#homeCnnCard"),mobile);await page.waitForTimeout(800);
    const checked=await geometry(page);assert.equal(checked.state,expectedState);
    if(state==="missing"||state==="expired"){assert.equal(checked.value,"—");assert.equal(checked.needleVisible,false);assert.ok(checked.comparisons.every(r=>r.value==="—"));}
    if(state==="zero")assert.equal(checked.value,"0");
    if(state==="half")assert.equal(checked.angle,"0");
    if(state==="maximum")assert.equal(checked.angle,"90");
    if(["missing","expired","stale"].includes(state))await page.locator("#cnnFearGreedPanel").screenshot({path:path.join(output,filename(state))});
    results.push({width,mode:"TEST_ONLY "+state,evidence:checked});
   }
  }
  results.push({width,engine:edge?"Chromium/Edge":"WebKit",pageErrors:errors,requestFailures:badRequests});
  assert.deepEqual(errors,[],"unhandled browser errors");
  console.log("PASS "+(edge?"Chromium":"WebKit")+" "+width+(full?" + refresh/failure/missing/stale/0/50/100":""));
 }catch(error){
  results.push({width,engine:edge?"Chromium/Edge":"WebKit",failure:error.message,evidence:await evidence(page)});
  await page.screenshot({path:path.join(output,filename("failure")),fullPage:true});
  throw error;
 }finally{await context.close();await browser.close();}
}
(async()=>{
 try{for(const width of (process.argv[3]?.split(",").map(Number)||[375,390,393,430,1280,1920]))await run(webkit,width,{full:width===390});await run(chromium,1280,{edge:true});assert.deepEqual(Object.fromEntries(protectedFiles.map(p=>[p,hash(p)])),before);console.log("PASS source/C4/portfolio byte integrity; evidence "+output);}
 finally{fs.writeFileSync(path.join(output,"browser-results.json"),JSON.stringify({note:"Isolated browsers; WebKit viewport is not a physical iPhone. Boundary/error scenarios are test-only, never official market output.",fixedTime:new Date(fixed).toISOString(),sourceHash:before["cnn-fear-greed.json"],results},null,2));}
})().catch(e=>{console.error(e);process.exitCode=1});
