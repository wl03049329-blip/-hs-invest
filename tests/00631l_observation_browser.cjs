'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),{chromium,webkit}=require('playwright-core');
const ptr=require('../data/lc4-research/latest.json'),bundle=require('../data/lc4-research/'+ptr.path);
const series=bundle.history.histories['00631L'].map(r=>[r.date,r.close]);
const a=process.env.HS_00631L_ISOLATED_SNAPSHOT?JSON.parse(fs.readFileSync(process.env.HS_00631L_ISOLATED_SNAPSHOT,'utf8')):{
 schema:'HS_00631L_CLOSE_OBSERVATION_V1',asof:series.at(-1)[0],training_end:'2020-12-31',threshold_version:'P80_P95_CLOSE_FIXED_20201231_V1',
 history_sha256:ptr.sha256,verified_at:'2026-11-05T10:00:00Z',source:'TEST_ONLY',rows:series,thresholds:Object.fromEntries(['speed',20,60,120,240,'all'].map(k=>[k,[5,10,500]])),
 evidence:[1,2,3,4].map(()=>({url:'https://www.twse.com.tw/test-only',sha256:ptr.sha256}))
};
const fragment=fs.readFileSync('index.html','utf8').match(/<section id="lc4-radar-v2"[\s\S]*?<\/section>/)[0];
const webRoot='http://localhost:8234/';
(async()=>{for(const [engine,kind] of [[chromium,'chrome'],[webkit,'webkit']]){
 if(kind==='webkit'&&process.env.HS_CHROME_ONLY==='1')continue;
 const b=await engine.launch(kind==='chrome'?{channel:'chrome'}:{});
 try{for(const width of [320,375,390,430,1200]){
   const p=await b.newPage({viewport:{width,height:900},isMobile:width<500,hasTouch:width<500});
   try{
    const errors=[];p.on('pageerror',e=>errors.push(e.message));
    await p.clock.setFixedTime(new Date(Math.max(Date.parse(a.asof+'T19:00:00+08:00'),Date.parse(a.verified_at)+1000)));
    let late=false;
    await p.route(webRoot+'**',r=>{const name=new URL(r.request().url()).pathname;
      if(name==='/')return r.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="lc4-radar-v2.css">'+fragment+['lradar-core.js','lc4-research.js'].map(f=>'<script src="'+f+'"></script>').join('')});
      if(name==='/data/00631l-close-observation-v1.json')return r.fulfill({json:a});
      if(name==='/data/radar-history/status-v1.json')return r.fulfill({json:{schema_version:1,expected_completed_bar:late?'9999-11-19':a.asof,next_expected_trading_day:'2026-11-20'}});
      if(['/lc4-radar-v2.css','/lradar-core.js','/lc4-research.js'].includes(name))return r.fulfill({body:fs.readFileSync(name.slice(1)),contentType:name.endsWith('css')?'text/css':'text/javascript'});
      return r.abort();
    });
    await p.goto(webRoot);
    const radar=p.locator('.lradar-v3');await radar.locator('.lradar-v3-bar').first().waitFor();assert.equal(await radar.locator('.lradar-v3-bar').count(),2);
    const pick=radar.getByLabel('高點比較期間');for(const v of ['20','60','120','240','all']){await pick.selectOption(v);assert.match(await radar.locator('h4').nth(1).innerText(),new RegExp(v==='all'?'歷史最高':v+' 日'));}
    await radar.getByRole('button',{name:'全部',exact:true}).click();
    await radar.locator('svg').click();assert.match(await radar.locator('svg').locator('..').locator('p').innerText(),/收盤.*區間最高/);
    await radar.getByText('歷史相似急跌統計',{exact:true}).click();
    await radar.getByText(/首次跨越固定極端門檻/).waitFor();
    await radar.getByText(/後續最低收盤價跌幅/).first().waitFor();
    late=true;
    await p.reload();
    await radar.getByText('資料尚未更新',{exact:true}).waitFor();
    assert.ok((await radar.innerText()).includes(a.asof));
    assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(errors,[]);
    console.log(kind,width,'00631L PASS');
   }finally{await p.close();}
 }}finally{await b.close();}
}})().catch(e=>{console.error(e);process.exitCode=1;});
