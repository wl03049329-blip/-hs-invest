'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium,webkit}=require('playwright-core'),R=require('../lradar-core'),L=require('../lradar-local');
const home='https://wl03049329-blip.github.io/-hs-invest/',fragment=fs.readFileSync('index.html','utf8').match(/<section id="lc4-radar-v2"[\s\S]*?<\/section>/)[0];
const replay=process.env.HS_DIRECT_RESPONSE?fs.readFileSync(process.env.HS_DIRECT_RESPONSE,'utf8'):null;
const output=process.env.HS_AUTO_TEST_OUT;
async function setup(browser,{status=403,body=null}={}){
 const c=await browser.newContext({viewport:{width:390,height:900},isMobile:true,hasTouch:true,acceptDownloads:true});
 let requests=0;const writes=[],headers=[],errors=[];
 await c.addCookies([{name:'TEST_ONLY_PROVIDER_COOKIE',value:'NOT_A_REAL_CREDENTIAL',domain:'api.finmindtrade.com',path:'/',secure:true}]);
 const dates=['2026-11-17','2026-11-18','2026-11-19'],prices=['26.86','26.84','24.57'];
 const records=dates.map((trading_date,i)=>({schema:'HS_00631L_OPEN_CLOSE_V1',symbol:'00631L',price_basis:'TWSE_RAW_CLOSE',trading_date,close_twd:prices[i],comparison_twd:i?prices[i-1]:'27.95',captured_at:trading_date+'T12:00:00Z',observed_sessions:dates.slice(0,i+1),source:'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',source_attribution:'臺灣證券交易所',dataset:'https://data.gov.tw/dataset/11549',license:'https://data.gov.tw/license',session_source:'https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK',session_dataset:'https://data.gov.tw/dataset/11672',response_sha256:'a'.repeat(64),session_sha256:'b'.repeat(64)}));
 await c.route('**/*',async route=>{const r=route.request(),u=new URL(r.url());if(r.method()!=='GET')writes.push(r.method());
  if(r.url()===L.DIRECT_URL){requests++;headers.push(await r.allHeaders());await new Promise(resolve=>setTimeout(resolve,150));return route.fulfill({status,body:body||JSON.stringify({status,msg:'TEST_ONLY source unavailable'}),contentType:'application/json',headers:{'access-control-allow-origin':'*','Retry-After':'3600','access-control-expose-headers':'Retry-After'}});}
  if(r.url()===R.archiveURL)return route.fulfill({json:{schema:'HS_00631L_OPEN_INDEX_V1',records},headers:{'access-control-allow-origin':'*'}});
  if(!r.url().startsWith(home))throw Error('Unexpected test request: '+u.origin+u.pathname);
  const name=u.pathname.slice('/-hs-invest/'.length);
  if(!name)return route.fulfill({contentType:'text/html;charset=utf-8',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="lc4-radar-v2.css">'+fragment+['lradar-core.js','lradar-local.js','lc4-research.js'].map(n=>'<script src="'+n+'"></script>').join('')});
  if(name==='data/radar-history/status-v1.json')return route.fulfill({json:{schema_version:1,expected_completed_bar:records.at(-1).trading_date,next_expected_trading_day:'2026-11-20'}});
  if(['lc4-radar-v2.css','lradar-core.js','lradar-local.js','lc4-research.js'].includes(name))return route.fulfill({body:fs.readFileSync(name),contentType:name.endsWith('.css')?'text/css':'text/javascript'});
  return route.abort();
 });
 async function page(){const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));await p.clock.setFixedTime(new Date('2026-11-20T01:30:00+08:00'));return p;}
 return {c,page,records,requests:()=>requests,check:()=>{assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);for(const h of headers){assert.equal(h.authorization,undefined);assert.equal(h.cookie,undefined);assert.equal(h.referer,undefined);}}};
}
(async()=>{const results=[];if(output)fs.mkdirSync(output,{recursive:true});
 for(const[engine,kind]of[[chromium,'chrome'],[webkit,'webkit']]){const browser=await engine.launch(kind==='chrome'?{channel:'chrome'}:{});
  try{
   for(const status of[401,402,403,429]){const t=await setup(browser,{status}),a=await t.page(),b=await t.page();
    await Promise.all([a.goto(home),b.goto(home)]);
    for(const p of[a,b])await p.waitForFunction(()=>document.querySelector('.lradar-v3>strong')?.textContent==='完整歷史尚未啟用');
    assert.equal(t.requests(),1);assert.equal(await a.locator('.lradar-v3-bar i').count(),0);
    await a.reload();await a.waitForFunction(()=>document.querySelector('.lradar-v3>strong')?.textContent==='完整歷史尚未啟用');assert.equal(t.requests(),1);
    assert.ok(await a.evaluate(async()=>{const r=await HSLRadarLocal.bootstrap();return r.next>Date.now()&&r.status.startsWith('AUTO_HTTP_');}));
    t.check();await t.c.close();results.push({kind,status,cross_tab_requests:1,cooldown:true,scope:'TEST_ONLY'});
   }
   if(replay){const t=await setup(browser,{status:200,body:replay}),p=await t.page();await p.goto(home);await p.getByText('個人本機歷史 · 不含息價格報酬 · 不上傳',{exact:true}).waitFor();
    await p.waitForFunction(()=>document.querySelector('.lradar-v3>strong')?.textContent==='歷史極端急跌');
    assert.equal(await p.evaluate(()=>HSLRadarLocal.read().then(s=>HSLRadarLocal.rows(s.data).length)),2935);assert.equal(t.requests(),1);
    await p.evaluate(()=>localStorage.setItem('hsPersonalV3.v1.TEST_ONLY','KEEP'));
    for(const width of[320,375,390,430,1200]){await p.setViewportSize({width,height:900});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));if(output)await p.locator('.lradar-v3').screenshot({path:output+'/'+kind+'-'+width+'.png'});}
    await p.reload();await p.getByText('個人本機歷史 · 不含息價格報酬 · 不上傳',{exact:true}).waitFor();assert.equal(t.requests(),1);
    const backup=await p.evaluate(()=>HSLRadarLocal.backup());assert.equal(JSON.parse(backup).base.schema,'HS_00631L_PERSONAL_DIRECT_V1');
    await p.evaluate(()=>HSLRadarLocal.enable(false));await p.reload();await p.getByText('公開收盤模式',{exact:true}).waitFor();assert.equal(t.requests(),1);
    await p.evaluate(()=>HSLRadarLocal.enable(true));await p.reload();await p.getByText('個人本機歷史 · 不含息價格報酬 · 不上傳',{exact:true}).waitFor();
    await p.clock.setFixedTime(new Date('2026-11-20T21:00:00+08:00'));
    t.records.push({...t.records.at(-1),trading_date:'2026-11-20',close_twd:'25.00',comparison_twd:'24.57',captured_at:'2026-11-20T12:00:00Z',observed_sessions:['2026-11-19','2026-11-20']});
    // Same open document must append after reconnect, not only after bootstrap.
    await p.evaluate(()=>window.dispatchEvent(new Event('online')));await p.waitForFunction(()=>document.querySelector('.lradar-v3')?.textContent.includes('2026-11-20 收盤 25.00')&&document.querySelector('.lradar-v3')?.textContent.includes('個人本機歷史 · 不含息價格報酬 · 不上傳'));
    assert.equal(await p.evaluate(()=>HSLRadarLocal.read().then(s=>HSLRadarLocal.rows(s.data).length)),2936);assert.equal(t.requests(),1);
    await t.c.setOffline(true);assert.equal(await p.evaluate(()=>HSLRadarLocal.read().then(s=>HSLRadarLocal.rows(s.data).length)),2936);await t.c.setOffline(false);
    assert.equal(await p.evaluate(()=>localStorage.getItem('hsPersonalV3.v1.TEST_ONLY')),'KEEP');t.check();await t.c.close();results.push({kind,automatic:true,requests:1,manual_file_operations:0,cache_reload:true,daily_extension:true,scope:'PRIVATE_LOCAL_REPLAY_NOT_LIVE'});
   }
  }finally{await browser.close();}
 }
 if(output)fs.writeFileSync(output+'/results.json',JSON.stringify(results,null,2));console.log(JSON.stringify({results,private_positive:replay?'PASS_LOCAL_REPLAY':'SKIP_NO_PRIVATE_DATA_IN_CI',physical_iphone:'PENDING'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
