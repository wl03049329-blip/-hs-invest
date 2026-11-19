'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),{chromium,webkit}=require('playwright-core');
const {rec,makeIndex}=require('./test_00631l_observation.js');
const {archiveURL}=require('../lradar-core');
const asof=rec.at(-1).trading_date;
const fragment=fs.readFileSync('index.html','utf8').match(/<section id="lc4-radar-v2"[\s\S]*?<\/section>/)[0];
const webRoot='http://localhost:8234/';
(async()=>{for(const [engine,kind] of [[chromium,'chrome'],[webkit,'webkit']]){
 if(kind==='webkit'&&process.env.HS_CHROME_ONLY==='1')continue;
 const b=await engine.launch(kind==='chrome'?{channel:'chrome'}:{});
 try{for(const width of [320,375,390,430,1200]){
   const p=await b.newPage({viewport:{width,height:900},isMobile:width<500,hasTouch:width<500});
   try{
    const errors=[];p.on('pageerror',e=>errors.push(e.message));
    await p.clock.setFixedTime(new Date(asof+'T21:00:00+08:00'));
    let late=false, empty=true;
    await p.route(archiveURL,r=>empty?r.fulfill({status:404,headers:{'access-control-allow-origin':'*'}}):
      r.fulfill({json:makeIndex(rec),headers:{'access-control-allow-origin':'*'}}));
    await p.route(webRoot+'**',r=>{const name=new URL(r.request().url()).pathname;
      if(name==='/')return r.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="lc4-radar-v2.css">'+fragment+['lradar-core.js','lc4-research.js'].map(f=>'<script src="'+f+'"></script>').join('')});
      if(name==='/data/radar-history/status-v1.json')return r.fulfill({json:{schema_version:1,expected_completed_bar:late?'2026-11-17':asof,next_expected_trading_day:'2026-11-20'}});
      if(['/lc4-radar-v2.css','/lradar-core.js','/lc4-research.js'].includes(name))return r.fulfill({body:fs.readFileSync(name.slice(1)),contentType:name.endsWith('css')?'text/css':'text/javascript'});
      return r.abort();
    });
    await p.goto(webRoot);
    const radar=p.locator('.lradar-v3');await radar.locator('.lradar-v3-bar').first().waitFor();assert.equal(await radar.locator('.lradar-v3-bar').count(),2);
    assert.equal(await radar.locator('.lradar-v3-bar i').count(),0);
    assert.match(await radar.innerText(),/尚無已驗證的每日收盤封存/);
    const pick=radar.getByLabel('高點比較期間');for(const v of ['20','60','120','240','all']){await pick.selectOption(v);assert.match(await radar.locator('h4').nth(1).innerText(),new RegExp(v==='all'?'歷史最高':v+' 日'));}
    await radar.getByRole('button',{name:'全部',exact:true}).click();
    await radar.getByText('可比較的收盤資料累積中。',{exact:true}).waitFor();
    await radar.getByText('歷史相似急跌統計',{exact:true}).click();
    await radar.getByText('資料累積中（樣本不足）',{exact:true}).first().waitFor();
    assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    empty=false;
    await p.reload();
    await radar.locator('.lradar-v3-bar i').waitFor();
    await radar.getByRole('button',{name:'全部',exact:true}).click();
    await radar.locator('svg').click();assert.match(await radar.locator('svg').locator('..').locator('p').innerText(),/收盤.*區間最高/);
    assert.match(await radar.locator('svg').locator('..').locator('p').innerText(),/區間漲跌.*價格報酬/);
    await radar.getByText('其他期間漲跌（價格報酬）',{exact:true}).click();
    await radar.getByText('近 1 個月',{exact:true}).waitFor();
    await radar.getByText('近 1 年',{exact:true}).waitFor();
    await radar.getByText('歷史相似急跌統計',{exact:true}).click();
    await radar.getByText(/首次跨越固定極端門檻/).waitFor();
    await radar.getByText(/後續最低收盤價跌幅/).first().waitFor();
    late=true;
    await p.reload();
    await radar.getByText('資料尚未更新',{exact:true}).waitFor();
    assert.ok((await radar.innerText()).includes(asof));
    assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(errors,[]);
    console.log(kind,width,'00631L PASS');
   }finally{await p.close();}
 }}finally{await b.close();}
}})().catch(e=>{console.error(e);process.exitCode=1;});
