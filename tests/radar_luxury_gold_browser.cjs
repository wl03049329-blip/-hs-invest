'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),perf=require('node:perf_hooks').performance,assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright-core');
const [root,mode]=process.argv.slice(2);
assert.ok(mode==='before'||mode==='after','Specify before/after');
const evidence=process.env.HS_LUXURY_ARTIFACTS||fs.mkdtempSync(path.join(require('node:os').tmpdir(),'hs-luxury-review-'));
fs.mkdirSync(evidence,{recursive:true});
const baselines=new Map();
if(mode==='after')for(const engine of ['chrome','webkit']){
 const file=path.join(evidence,'before-'+engine+'-data.json');
 assert.ok(fs.existsSync(file),'RC2_BASELINE_REQUIRED: '+file);
 const model=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.ok(model.rows?.length>0&&model.events?.latestDate,'RC2_BASELINE_INVALID: '+file);
 baselines.set(engine,model);
}
const out=path.join(path.dirname(evidence),path.basename(evidence)+'-'+mode+'-site'+(process.env.HS_CAPTURE_RUN||''));
if(!fs.existsSync(out))require(path.join(root,'scripts/build_stable_app.cjs')).build({root,out});
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://127.0.0.1'),f=path.resolve(out,'.'+decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname));if(!f.startsWith(out+path.sep)||!fs.existsSync(f)||!fs.statSync(f).isFile())return res.writeHead(404).end();const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml'};res.writeHead(200,{'Content-Type':mime[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res);});
const snap=(p,n)=>p.screenshot({path:path.join(evidence,n+'.png'),fullPage:true});
const instrument=JSON.parse(fs.readFileSync(path.join(root,'personal-v2/instrument-names.json'),'utf8')).items.find(x=>x.code==='2330');
assert.ok(instrument?.name,'Published 2330 identity required for the lookup replay');
async function watchRoundTrip(p){
 const persisted=()=>p.evaluate(()=>JSON.parse(localStorage.getItem('hsRadar.watchlist')||'[]'));
 const seed=await p.evaluate(()=>{const x={...catalogItem('0050'),strategyMode:'user_selected'};localStorage.setItem('hsRadar.watchlist',JSON.stringify([x]));localStorage.setItem('hsPersonalV3.v1.RC2_TEST_ONLY','keep');return x;});
 assert.equal(seed.id,'0050');
 await p.reload();await p.locator('[data-radar-mode=my]').click();await p.locator('#watchAdHocForm').waitFor();
 const lookup=async code=>{await p.locator('#watchAdHocTicker').fill(code);await p.locator('#watchAdHocForm button').click();};
 for(const code of ['2330','00878']){
  await lookup(code);
  await p.locator('#watchAdHocResult [data-add-ad-hoc="'+code+'"]').click();
  await p.waitForFunction(code=>JSON.parse(localStorage.getItem('hsRadar.watchlist')||'[]').some(x=>x.id===code),code);
  assert.deepEqual((await persisted())[0],seed);
 }
 await p.reload();await p.locator('[data-radar-mode=my]').click();await p.locator('#watchAdHocForm').waitFor();
 const afterReload=await persisted();assert.deepEqual(afterReload.map(x=>x.id),['0050','2330','00878']);
 for(const mode of ['score','drawdown','saved']){
  await p.locator('#radarGoldWatchOrder').selectOption(mode);assert.deepEqual(await persisted(),afterReload);
 }
 const ranked=await p.evaluate(()=>Object.fromEntries(['score','drawdown','saved'].map(mode=>[mode,radarGoldWatchRows([{id:'00878'},{id:'0050'},{id:'00830'}],mode).map(x=>x.id)])));
 assert.deepEqual(ranked,{score:['00830','0050','00878'],drawdown:['00830','0050','00878'],saved:['00878','0050','00830']});
 await p.locator('#manageWatchBtn').click();await p.getByRole('button',{name:'上移 00878'}).click();
 assert.deepEqual((await persisted()).map(x=>x.id),['0050','00878','2330']);
 p.once('dialog',d=>d.accept());await p.getByRole('button',{name:'刪除 2330'}).click();
 assert.deepEqual((await persisted()).map(x=>x.id),['0050','00878']);
 assert.deepEqual((await persisted())[0],seed);
 await lookup('0050');await p.getByRole('button',{name:'已在我的自選'}).waitFor();
 assert.equal(await p.evaluate(()=>localStorage.getItem('hsPersonalV3.v1.RC2_TEST_ONLY')),'keep');
}
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r)); const base='http://127.0.0.1:'+server.address().port+'/';
for(const [engine,type] of [['chrome',chromium],['webkit',webkit]]){const b=await type.launch(engine==='chrome'?{channel:'chrome'}:{});try{for(const [width,height] of [[390,844],[320,700],[375,812],[430,932],[844,390],[1200,900]].filter(([width])=>!process.env.HS_CAPTURE_WIDTH||width===Number(process.env.HS_CAPTURE_WIDTH))){
 const p=await b.newPage({viewport:{width,height},isMobile:width<900,hasTouch:width<900,serviceWorkers:'block'}),errs=[];let requests=0;p.on('pageerror',e=>errs.push(e.message));p.on('request',r=>{if(r.resourceType()==='fetch'||r.resourceType()==='xhr')requests++;});
 await p.clock.setFixedTime(new Date('2026-11-25T15:40:00Z'));
 await p.route('**/*',r=>{
  const url=new URL(r.request().url());
  if(r.request().url().startsWith(base))return r.continue();
  const headers={'access-control-allow-origin':'*','content-type':'application/json'};
  if(url.hostname==='api.finmindtrade.com'&&url.searchParams.get('dataset')==='TaiwanStockInfo')return r.fulfill({headers,json:{status:200,data:[{stock_id:instrument.code,stock_name:instrument.name,type:'TWSE',industry_category:'半導體業'}]}});
  return r.fulfill({status:503,headers,body:'{}'});
 });
 const t=perf.now();await p.goto(base+'?tab=signals',{waitUntil:'domcontentloaded'});
 await p.locator('#radarOverviewLong button[data-open-radar-detail]').first().waitFor({state:'visible',timeout:40000});
 const overview=Math.round(perf.now()-t),before=requests;
 if(width===390){
  const model=await p.evaluate(()=>{const items=activeRadarItems().filter(x=>strategyModeFor(x)==='long_term_core').sort(longRankComparator);
   return {rows:items.map(x=>{const {rows,officialRows,...research}=radarHistoryPhase6State(x),outcomes=['current','next','drawdown'].map(mode=>{const {kind,sample,sampleMode,condition,nonOverlap}=radarOutcomePhase7BState(x,mode);return {kind,sample,sampleMode,condition,nonOverlap};});return [x.id,officialArtifactCoreScoreHistory(finalizedCoreScoreHistoryArtifact,x.id,2),radarOfficialFactorPair(x.id),research,outcomes];}),events:radarEventState};
  });
  if(mode==='after'){
   assert.deepEqual(JSON.parse(JSON.stringify(model)),baselines.get(engine));
   const display=await p.evaluate(()=>Array.from(document.querySelectorAll('#radarOverviewLong [data-open-radar-detail]')).map(node=>{
    const symbol=node.dataset.openRadarDetail,raw=officialArtifactCoreScoreHistory(finalizedCoreScoreHistoryArtifact,symbol,1)[0],factor=radarOfficialFactorPair(symbol).current?.factors.find(f=>f.key==='dd52');
    const expected=raw?[formatC4Score(raw.finalCoreScore),HSFinalCoreProduction.labelFor(raw.finalCoreScore).label,raw.tradingDate,factor?.available?factor.raw.toFixed(2)+'%':'—']:['—','等待原生資料','正式日期待確認','—'];
    return {symbol,expected,actual:['[data-gold-score]','.radarGoldBadge','time','[data-gold-dd]'].map(s=>node.querySelector(s)?.textContent.trim())};
   }));
   assert.equal(display.length,6);
   for(const row of display)assert.deepEqual(row.actual,row.expected,row.symbol+' visible FINAL comparison');
   assert.ok(await p.locator('.radarGoldEvent').count()<=2);
   assert.equal(await p.locator('#radarGoldFinalDate').getAttribute('datetime'),model.events.latestDate);
  }
  fs.writeFileSync(path.join(evidence,mode+'-'+engine+'-data.json'),JSON.stringify(model,null,2));
  await p.screenshot({path:path.join(evidence,mode+'-'+engine+'-first.png')});await snap(p,mode+'-'+engine+'-overview');
  if(mode==='after'){
   await p.locator('#openRadarAlertSettings').click();await p.locator('#radarAlertSettingsModal.show').waitFor({state:'visible'});await p.locator('#closeRadarAlertSettings').click();
  }
 }
 const c=p.locator('#radarOverviewLong [data-open-radar-detail="0050"]');const t2=perf.now();await c.click();
 const selected=p.locator('.signalCard.is-selected[data-radar-v4]'),quick=selected.locator('[data-radar-v4-pane=quick]');
 await quick.waitFor({state:'visible'});assert.equal(await quick.locator(':scope>.radarV4Card').count(),2);
 const firstCardMs=Math.round(perf.now()-t2);
 if(mode==='after'){
  await quick.locator('.radarHistoryCanvas canvas').first().waitFor({timeout:20000});
  await p.waitForFunction(()=>document.querySelector('.is-selected .radarHistoryCanvas')?.dataset.selectedC4);
  const score=await p.evaluate(()=>{const r=officialArtifactCoreScoreHistory(finalizedCoreScoreHistoryArtifact,'0050',1)[0];return {date:r.tradingDate,score:formatC4Score(r.finalCoreScore)};});
  assert.match(await quick.locator('.radarV4Score').innerText(),new RegExp(score.score.replace('.','\\.')));
  assert.equal(await quick.locator('.radarHistoryReadout time').getAttribute('datetime'),score.date);
 }
 const quickMs=Math.round(perf.now()-t2);if(width===390){await p.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await snap(p,mode+'-'+engine+'-quick');}
 if(mode==='after'){for(const range of ['10D','20D','60D','120D','1Y','ALL'])await quick.locator('[data-history-range="'+range+'"]').click();await quick.locator('.radarHistoryCustom summary').click();await quick.locator('[data-custom-start]').fill('2026-11-17');await quick.locator('[data-custom-end]').fill('2026-11-24');await quick.locator('[data-history-action=custom]').click();}
 const historyHost=mode==='after'?await quick.locator('[data-radar-history]').elementHandle():null;
 await selected.locator('nav [data-radar-v4-tab=deep]').click();const deep=selected.locator('[data-radar-v4-pane=deep]');await deep.waitFor({state:'visible'});
 if(historyHost)assert.equal(await deep.locator('[data-radar-history]').evaluate((node,prior)=>node===prior,historyHost),true);
 if(mode==='after'&&width===390){
  const {research,factors}=await p.evaluate(()=>{const item=activeRadarItems().find(x=>x.id==='0050');return {research:radarHistoryPhase6State(item),factors:radarOfficialFactorPair(item.id).current.factors.map(f=>formatC4Score(f.contribution))};});
  assert.deepEqual(await deep.locator('.radarFactorValueV32').allTextContents(),factors.map(x=>'貢獻 '+x));
  if(research.kind==='READY'){
   const rarity=deep.locator('[data-radar-v4-fold=rarity]');
   await rarity.locator(':scope>summary').click();assert.match(await rarity.innerText(),new RegExp('P'+research.percentile+'\\b'));await rarity.locator(':scope>summary').click();
  }
 }
 if(width===390){await p.evaluate(()=>scrollTo(0,0));await snap(p,mode+'-'+engine+'-deep');const research=deep.locator('[data-radar-v4-fold=research] summary').first();await research.click();await snap(p,mode+'-'+engine+'-research');}
 const layout=await p.evaluate(()=>{const w=document.documentElement.clientWidth;return {w,scroll:document.documentElement.scrollWidth,over:[...document.querySelectorAll('#signals *')].filter(e=>e.getBoundingClientRect().right>w+2).slice(0,5).map(e=>[e.tagName,e.className?.baseVal||e.className,Math.round(e.getBoundingClientRect().right)])}});
 if(mode==='after')assert.ok(layout.scroll<=layout.w,JSON.stringify(layout));assert.deepEqual(errs,[]);
 if(mode==='after'&&width===390){
  await selected.locator('[data-radar-v4-action=picker]').click();
  await selected.locator('[data-radar-v4-pick="00662"]').click();
  assert.equal(await selected.getAttribute('data-etf-id'),'00662');await deep.waitFor({state:'visible'});
  await selected.locator('[data-radar-v4-action=back]').click();await p.locator('#radarOverviewLong').waitFor({state:'visible'});
  await p.locator('#radarGoldShowEvents').click();await p.locator('[data-radar-event-filter=CROSS_LEVEL]').click();assert.equal(await p.locator('#radarEventCenter').evaluate(e=>e.open),true);
  await p.locator('#radarEventEtfFilter').selectOption('0050');assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),'expanded event centre cannot widen the page');await snap(p,mode+'-'+engine+'-events');
  const l=p.locator('#radarOverviewSwing');await l.scrollIntoViewIfNeeded();await l.locator('select').selectOption('20');assert.match(await l.innerText(),/20 日最高收盤回落/);await snap(p,mode+'-'+engine+'-00631L');
  await p.locator('[data-radar-mode=my]').click();await p.locator('#watchAdHocForm').waitFor({state:'visible'});await p.locator('#radarGoldWatchOrder').selectOption('drawdown');
  await p.locator('#manageWatchBtn').click();assert.equal(await p.locator('#watchManagePanel').isVisible(),true);
  await p.locator('#watchAdHocTicker').fill('!');await p.locator('#watchAdHocForm button').click();await p.getByText('代號格式無效。',{exact:true}).waitFor();
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),'watchlist cannot widen the page');await snap(p,mode+'-'+engine+'-watch');
  for(const tab of ['today','portfolio','sentiment','more','signals']){await p.locator('.bottomNavButton[data-tab="'+tab+'"]').click();assert.ok(await p.locator('[data-tab-section="'+tab+'"]:visible').count(),tab);}
  await p.locator('[data-radar-mode=featured]').click();
  for(const [suffix,date] of [['no-events','2026-11-25'],['waiting','']]){
    await p.evaluate(date=>{const items=date?activeRadarItems().filter(x=>strategyModeFor(x)==='long_term_core'):[];document.getElementById('radarTodayFocusCards').innerHTML=radarGoldToday({latestDate:date},{events:[]},items);},date);
    await p.locator('#radarTodayFocus').screenshot({path:path.join(evidence,mode+'-'+engine+'-'+suffix+'.png')});
  }
  await watchRoundTrip(p);await snap(p,mode+'-'+engine+'-watch-saved');
 }
 console.log(JSON.stringify({mode,engine,width,overview,firstCardMs,quickMs,initialFetch:before,additionalFetch:requests-before,layout}));await p.close();
}}finally{await b.close();}}})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());
