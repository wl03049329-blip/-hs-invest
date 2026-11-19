'use strict';
// Private file is read locally by File API, never sent to CI or a web server.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium,webkit}=require('playwright-core'),R=require('../lradar-core');
const file=process.env.HS_PRIVATE_INPUT;if(!file)throw Error('LOCAL_PRIVATE_FILE_REQUIRED_NO_CI_UPLOAD');
const data=JSON.parse(fs.readFileSync(file)),asof=data.base.asof,archive=JSON.parse(fs.readFileSync(process.env.HS_OPEN_INDEX)),out=process.env.HS_PRIVATE_TEST_OUT;
const fragment=fs.readFileSync('index.html','utf8').match(/<section id="lc4-radar-v2"[\s\S]*?<\/section>/)[0];
(async()=>{const results=[];if(out)fs.mkdirSync(out,{recursive:true});for(const[engine,kind]of[[chromium,'chrome'],[webkit,'webkit']]){
 const b=await engine.launch(kind==='chrome'?{channel:'chrome'}:{});try{const c=await b.newContext({viewport:{width:390,height:900},isMobile:true,hasTouch:true,acceptDownloads:true}),p=await c.newPage(),errors=[],requests=[];
 p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>requests.push({method:r.method(),url:r.url()}));p.on('dialog',d=>d.accept());await p.clock.setFixedTime(new Date('2026-11-20T00:30:00+08:00'));
 await p.route('**/*',r=>{const u=new URL(r.request().url()),n=u.pathname;
  if(r.request().url()===R.archiveURL)return r.fulfill({json:archive,headers:{'access-control-allow-origin':'*'}});
  if(!['http://localhost:8235','http://localhost:8236'].includes(u.origin))return r.abort();
  if(n==='/')return r.fulfill({contentType:'text/html;charset=utf-8',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="lc4-radar-v2.css">'+fragment+['lradar-core.js','lradar-local.js','lc4-research.js'].map(s=>'<script src="'+s+'"></script>').join('')});
  if(n==='/data/radar-history/status-v1.json')return r.fulfill({json:{schema_version:1,expected_completed_bar:asof,next_expected_trading_day:'2026-11-20'}});
  if(['/lc4-radar-v2.css','/lradar-core.js','/lradar-local.js','/lc4-research.js'].includes(n))return r.fulfill({body:fs.readFileSync(n.slice(1)),contentType:n.endsWith('.css')?'text/css':'text/javascript'});
  return r.abort();
 });
 await p.goto('http://localhost:8235');const radar=p.locator('.lradar-v3'),panel=p.locator('[data-lradar-personal]');await panel.waitFor();await p.evaluate(()=>localStorage.setItem('hsPersonalV3.v1.TEST_ONLY','KEEP'));
 await panel.locator('summary').click();await p.getByLabel('匯入個人歷史或備份').setInputFiles(path.resolve(file));await radar.getByText('個人本機歷史 · 不含息價格報酬 · 不上傳',{exact:true}).waitFor();
 const actual=await p.evaluate(()=>HSLRadarLocal.read().then(s=>HSLRadarLocal.summary(s.data,240)));assert.equal(actual.rows.length,2935);assert.equal(actual.recent[5],100*(24.57/30.99-1));
 assert.match(await radar.textContent(),/FinMind TaiwanStockPrice 個人本機歷史/);
 await p.waitForFunction(()=>document.querySelector('.lradar-v3>strong')?.textContent==='歷史極端急跌');
 for(const n of ['20','60','120','240','all']){await radar.getByLabel('高點比較期間').selectOption(n);assert.equal(await radar.locator('.lradar-v3-bar i').count(),2);}
 for(const width of[320,375,390,430,1200]){await p.setViewportSize({width,height:900});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));if(out)await radar.screenshot({path:path.join(out,kind+'-'+width+'.png')});results.push({kind,width,pass:true});}
 await panel.locator('summary').click();const downloaded=p.waitForEvent('download');await panel.getByRole('button',{name:'備份本機歷史',exact:true}).click();assert.match((await downloaded).suggestedFilename(),/lradar-private\.json$/);
 const saved=await p.evaluate(()=>HSLRadarLocal.backup());assert.deepEqual(JSON.parse(saved),data);
 await p.reload();await radar.getByText('個人本機歷史 · 不含息價格報酬 · 不上傳',{exact:true}).waitFor();
 await p.evaluate(()=>HSLRadarLocal.enable(false));await p.reload();await panel.waitFor();await panel.locator('summary').click();await panel.getByRole('button',{name:'使用本機歷史',exact:true}).click();await radar.getByText('個人本機歷史 · 不含息價格報酬 · 不上傳',{exact:true}).waitFor();
 await p.evaluate(text=>HSLRadarLocal.importText(text),saved);const revision=await p.evaluate(()=>HSLRadarLocal.read().then(s=>s.revision));
 assert.ok(await p.evaluate(async text=>{const v=JSON.parse(text);v.base.rows[0][1]*=22;try{await HSLRadarLocal.importText(JSON.stringify(v));return false;}catch{return true;}},saved));assert.equal(await p.evaluate(()=>HSLRadarLocal.read().then(s=>s.revision)),revision);
 await c.setOffline(true);assert.equal(await p.evaluate(()=>HSLRadarLocal.read().then(s=>HSLRadarLocal.summary(s.data,240).close)),24.57);await c.setOffline(false);
 assert.equal(await p.evaluate(()=>localStorage.getItem('hsPersonalV3.v1.TEST_ONLY')),'KEEP');
 // TEST_ONLY future-day fixture: exercise atomic daily extension, not live data.
 await p.clock.setFixedTime(new Date('2026-11-20T21:00:00+08:00'));
 const append=await p.evaluate(async template=>{
  const r={...template,trading_date:'2026-11-20',close_twd:'25.00',comparison_twd:'24.57',captured_at:'2026-11-20T12:00:00Z',observed_sessions:['2026-11-19','2026-11-20']};
  const before=(await HSLRadarLocal.read()).revision;await Promise.all([HSLRadarLocal.sync([r]),HSLRadarLocal.sync([r])]);
  const s=await HSLRadarLocal.read();return {revision:s.revision-before,rows:HSLRadarLocal.rows(s.data).length};
 },archive.records.at(-1));assert.deepEqual(append,{revision:1,rows:2936});
 assert.ok(await p.evaluate(async text=>{try{await HSLRadarLocal.importText(text);return false;}catch(e){return e.message==='PRIVATE_IMPORT_ROLLBACK_OR_CONFLICT';}},saved));
 // A fresh origin simulates an empty research store without deleting any DB.
 await p.goto('http://localhost:8236');await panel.waitFor();await panel.locator('summary').click();
 await p.getByLabel('匯入個人歷史或備份').setInputFiles({name:'restored.lradar-private.json',mimeType:'application/json',buffer:Buffer.from(saved)});await radar.getByText('個人本機歷史 · 不含息價格報酬 · 不上傳',{exact:true}).waitFor();assert.equal(await p.evaluate(()=>HSLRadarLocal.read().then(s=>HSLRadarLocal.rows(s.data).length)),2935);
 assert.deepEqual(errors,[]);assert.ok(requests.every(r=>r.method==='GET'));assert.ok(requests.every(r=>/^http:\/\/localhost:823[56]\//.test(r.url)||r.url===R.archiveURL||r.url.startsWith('blob:')));
 results.push({kind,import_restore_offline:true,financial_sentinel_unchanged:true,uploads:0});await c.close();
 }finally{await b.close();}
}if(out)fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({results,physical_iphone:'PENDING'},null,2));console.log(JSON.stringify(results));})().catch(e=>{console.error(e);process.exitCode=1;});
