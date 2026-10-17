"use strict";
// Isolated browser contract. Only saved, real tracked observations are served.
// Clock/failure/version mutations are TEST ONLY; this script never publishes data.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),cp=require('node:child_process');
const {chromium,webkit}=require('playwright-core');
const root=process.cwd(),base='https://wl03049329-blip.github.io/-hs-invest/',symbols=['0050','00662','00757','00830','00935'];
const read=f=>JSON.parse(fs.readFileSync(path.join(root,f),'utf8'));
const final=read('finalized-core-score-snapshots-v1.json'),archive=read('intraday-core-snapshots-v1.json'),live=archive.snapshots.at(-1),day=live.trading_date;
const output=process.env.C4_INIT_EVIDENCE_DIR||path.resolve(root,'../c4-init-evidence/browser');fs.mkdirSync(output,{recursive:true});
const reports=[];
const html=process.env.C4_TEST_BASELINE?cp.execFileSync('git',['show','HEAD:index.html'],{encoding:'utf8',maxBuffer:2e6}):fs.readFileSync('index.html','utf8');
const allowed=new Set([...html.matchAll(/(?:src|href)="([^"?#]+)(?:[?#][^"]*)?"/g)].map(m=>m[1]).filter(p=>!p.includes(':')));
for(const file of fs.readdirSync(root).filter(f=>f.endsWith('.json')))allowed.add(file);
for(const s of symbols.concat('009815'))allowed.add(`research/c4_historical/${s}.json`);
function railway(live){return{schema_version:1,status:'AVAILABLE',market_state:'OPEN',trading_date:day,as_of:live.freshness.market_as_of,calculated_at:live.calculated_at,completeness:'5/5',c4_version:live.score_version,
 tickers:Object.fromEntries([...symbols.map(s=>{const r=live.items[s];return[s,{status:'AVAILABLE',score:r.score,display_score:r.display_score,quote_as_of:r.market_as_of,freshness:r.freshness,delta_vs_official:r.delta_vs_previous_close,quote_source:'TEST_REPLAY_OF_TRACKED_ARCHIVE'}]}),['009815',{status:'WAIT_NATIVE',freshness:'WAIT_NATIVE',score:null,display_score:null}]])}}
const scenarios=[
 {name:'cors-valid-holiday',clock:'2026-10-17T11:00:00+08:00',state:'HOLIDAY',source:'FINAL'},
 {name:'cors-valid-premarket',clock:day+'T08:30:00+08:00',state:'PREMARKET',source:'FINAL',railway:'premarket'},
 {name:'cors-valid-postmarket',clock:day+'T19:00:00+08:00',state:'CLOSED',source:'FINAL'},
 {name:'cors-open-railway-valid',clock:day+'T13:26:00+08:00',state:'OPEN',source:'LIVE',railway:'valid'},
 {name:'cors-open-railway-down',clock:day+'T13:26:00+08:00',source:'UNAVAILABLE'},
 {name:'cors-open-railway-expired',clock:day+'T13:26:00+08:00',source:'UNAVAILABLE',railway:'expired'},
 {name:'cors-open-railway-version',clock:day+'T13:26:00+08:00',source:'UNAVAILABLE',railway:'version'},
 {name:'cors-open-railway-incomplete',clock:day+'T13:26:00+08:00',source:'UNAVAILABLE',railway:'incomplete'},
 {name:'both-unavailable',clock:'2026-10-17T11:00:00+08:00',source:'UNAVAILABLE',official:'down'},
 {name:'official-wrong-version',clock:'2026-10-17T11:00:00+08:00',source:'UNAVAILABLE',official:'version'},
 {name:'official-incomplete',clock:'2026-10-17T11:00:00+08:00',source:'UNAVAILABLE',official:'incomplete'},
 {name:'finmind-success',clock:'2026-10-17T11:00:00+08:00',source:'FINAL',finmind:true}
];
async function run(engine,scenario,width){
 const browser=await engine.launch(engine===chromium?{headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'}:{headless:true});
 const context=await browser.newContext({viewport:{width,height:900},timezoneId:'Asia/Taipei',isMobile:width<600,hasTouch:width<600}),page=await context.newPage(),errors=[],requests=[];
 await page.clock.install({time:new Date(scenario.clock)});
 await page.addInitScript(()=>{let started=false;new MutationObserver(rs=>{for(const r of rs)if(r.target.id==='reload'){if(r.target.disabled)started=true;else if(started)window.c4TestDone=true}}).observe(document,{subtree:true,attributes:true,attributeFilter:['disabled']})});
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const u=new URL(route.request().url()),json=p=>route.fulfill({json:p});
  if(u.hostname==='api.finmindtrade.com'){
   requests.push(u.searchParams.get('dataset'));
   if(!scenario.finmind)return route.abort('failed');
   const symbol=u.searchParams.get('data_id'),dataset=u.searchParams.get('dataset'),file=`research/c4_historical/source/${symbol}.json`;
   const saved=fs.existsSync(file)?read(file):null;
   return json({status:200,data:dataset==='TaiwanStockPrice'?saved?.price||[]:dataset==='TaiwanStockDividendResult'?saved?.dividend||[]:[]});
  }
  if(u.hostname==='hs-invest-production.up.railway.app'){
   if(!scenario.railway)return route.fulfill({status:503,body:'TEST_SOURCE_DOWN'});
   if(scenario.railway==='premarket')return json({status:'UNAVAILABLE',market_state:'CLOSED',trading_date:day,diagnostic_reason:'PREMARKET'});
   const saved=scenario.railway==='expired'?archive.snapshots.findLast(s=>s.trading_date===day&&s.freshness.market_as_of.slice(11,16)<='13:10'):live;
   assert.ok(saved,'must use a real saved earlier bucket, not fabricated time/score');
   const p=railway(saved);if(scenario.railway==='version')p.c4_version='INVALID_TEST_VERSION';if(scenario.railway==='incomplete')p.tickers['0050'].score=null;return json(p);
  }
  if(u.origin!==new URL(base).origin)return route.abort();
  const file=decodeURIComponent(u.pathname.slice(new URL(base).pathname.length))||'index.html';
  if(file==='index.html')return route.fulfill({body:html,contentType:'text/html'});
  if(file==='finalized-core-score-snapshots-v1.json'){
   if(scenario.official==='down')return route.fulfill({status:503,body:'TEST_SOURCE_DOWN'});
   const p=structuredClone(final);
   // Never let a later same-day FINALIZED close leak into an open-session replay.
   if(scenario.clock.slice(11,13)<'18'&&scenario.clock.startsWith(day))p.snapshots=p.snapshots.filter(s=>s.date<day);
   if(scenario.official==='version')p.core_score_version='INVALID_TEST_VERSION';
   if(scenario.official==='incomplete')for(const s of p.snapshots)s.rows=s.rows.filter(r=>r.symbol!=='0050');
   return json(p);
  }
  if(!allowed.has(file)||file.includes('..')||!fs.existsSync(file))return route.fulfill({status:404,body:'TEST_NOT_EXPOSED'});
  return route.fulfill({path:path.join(root,file),contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':undefined});
 });
 try{
  await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.c4TestDone,undefined,{timeout:90000});
  const result=await page.evaluate(()=>({loaded:all.length,dual:currentDualTrackCoreView(),cards:[...document.querySelectorAll('.hsDashboardC4Card')].map(el=>({symbol:el.dataset.c4Symbol,source:el.dataset.c4Source,score:el.querySelector('.hsC4CardScore>b')?.textContent,text:el.textContent})),message:document.querySelector('#message').textContent,cnn:document.querySelector('#homeCnnCard>b').textContent,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,leverage:document.querySelector('#homeLeverageCard').textContent}));
  assert.equal(result.cards.length,6);assert.ok(result.scrollWidth<=width+1);if(scenario.state)assert.equal(result.dual.market_state,scenario.state);
  for(const s of symbols){const card=result.cards.find(c=>c.symbol===s);assert.equal(card.source,scenario.source,`${s}: ${JSON.stringify(result.dual.items[s])}`);
   if(scenario.source==='UNAVAILABLE'){assert.equal(card.score,'—');assert.ok(!/還差\s+\d/.test(card.text));}
   else {const row=result.dual.items[s][scenario.source==='LIVE'?'live':'official'];assert.equal(card.score,Number(row.score).toFixed(1));assert.ok(card.text.includes('vs 前次正式'));}
  }
  assert.equal(result.cards.find(c=>c.symbol==='009815').source,'WAIT_NATIVE');assert.ok(result.leverage.includes('00631L'));
  const summary=await page.locator('#homeEtfBriefSummary').innerText(),updated=await page.locator('#updatedTop').innerText();
  if(scenario.official){assert.match(summary,/正式 C4 資料不足/);assert.match(updated,/正式分數暫不可用/)}
  else {const ranked=Object.entries(result.dual.items).filter(([,r])=>r.official).sort((a,b)=>b[1].official.score-a[1].official.score||a[0].localeCompare(b[0]));assert.ok(summary.includes(`正式最高：${ranked[0][0]}`));assert.ok(summary.includes(`次順位：${ranked[1][0]}`));assert.ok(updated.includes(ranked[0][1].official.trading_date));}
  assert.ok(requests.includes('TaiwanStockPrice'));assert.equal(scenario.finmind?result.loaded>0:result.loaded===0,true);assert.deepEqual(errors,[]);
  // A later source refresh must still render with all=[], without reviving rejected LIVE.
  await page.evaluate(()=>{renderTop();renderCnnPresentationViews()});
  assert.equal(await page.locator('.hsDashboardC4Card').count(),6);
  await page.locator('#homeEtfBrief').screenshot({path:path.join(output,`${engine.name()}-${width}-${scenario.name}.png`)});
  reports.push({engine:engine.name(),width,scenario:scenario.name,result,errors,status:'PASS'});console.log('PASS',engine.name(),width,scenario.name);
 }catch(e){await page.screenshot({path:path.join(output,`${engine.name()}-${width}-${scenario.name}-FAIL.png`),fullPage:true});reports.push({engine:engine.name(),width,scenario:scenario.name,error:e.message,errors,status:'FAIL'});throw e}
 finally{await browser.close();fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(reports,null,2))}
}
(async()=>{for(const engine of [chromium,webkit]){for(const scenario of scenarios)await run(engine,scenario,1280);for(const width of [375,390,393,430])await run(engine,scenarios[0],width)}})().catch(e=>{console.error(e);process.exitCode=1});
