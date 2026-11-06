'use strict';
// Local fixture-only acceptance. No browser profile or financial writes.
const {chromium,webkit}=require('playwright-core');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=process.env.HS_MARGIN_UI_OUT,base=process.env.HS_MARGIN_UI_BASE;
if(!out||!/^[a-f0-9]{40}$/.test(base||''))throw Error('EVIDENCE_DIR_AND_BASE_REQUIRED');
fs.mkdirSync(out,{recursive:true});
const prior=new Map(['index.html','formal-black-gold.css','official-margin-balance.js'].map(file=>[file,cp.execFileSync('git',['show',base+':'+file],{cwd:root,maxBuffer:4e6})]));
const fixture=file=>JSON.parse(cp.execFileSync('git',['show','9b9d1609f8581f64b8c7e5484dd4c45a096ffac5:'+file],{cwd:root}));
const originalFutures=fixture('futures-position.json'), originalMargin=fixture('official-margin-balance.json');
const mime={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
const server=http.createServer((req,res)=>{
  const [,stage,...pieces]=decodeURIComponent(new URL(req.url,'http://local').pathname).split('/');
  const file=pieces.join('/')||'index.html',p=path.resolve(root,file);
  if(!['before','after'].includes(stage)||!p.startsWith(root+path.sep)||!fs.existsSync(p)||!fs.statSync(p).isFile())return res.writeHead(404).end();
  const content=stage==='before'&&prior.get(file)||fs.readFileSync(p);
  res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'}).end(content);
});
const fixed=Date.parse(JSON.parse(fs.readFileSync(path.join(root,'cnn-fear-greed.json'),'utf8')).updated_at)+600000;
const results=[];
async function run(){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  for(const [name,engine] of [['chrome',chromium],['webkit',webkit]]){
    const browser=await engine.launch(name==='chrome'?{channel:'chrome'}:{});
    try{
      for(const width of [320,375,390,430,1280]){
        const context=await browser.newContext({viewport:{width,height:900},isMobile:width<600,hasTouch:width<600,serviceWorkers:'block'});
        try{
          let future=structuredClone(originalFutures), margin=structuredClone(originalMargin);
          await context.route('**/*',route=>{
            const url=new URL(route.request().url());
            if(url.origin===origin)return route.continue();
            // Model an HTTP outage explicitly. Aborting in the harness emits
            // an unrelated WebKit CORS PageError instead of the app's handled 503.
            if(['api.finmindtrade.com','hs-invest-production.up.railway.app','mis.twse.com.tw'].includes(url.hostname))
              return route.fulfill({status:503,headers:{'access-control-allow-origin':'*'},body:''});
            return route.abort();
          });
          await context.route('**/futures-position.json?*',r=>r.fulfill({json:future}));
          await context.route('**/official-margin-balance.json',r=>r.fulfill({json:margin}));
          const p=await context.newPage(),errors=[];
          p.on('pageerror',e=>errors.push(e.message));
          await p.addInitScript(t=>{
            const D=Date;window.Date=class extends D{constructor(...a){super(...(a.length?a:[t]));}static now(){return t;}};
          },Math.max(fixed,Date.parse('2026-11-05T17:00:00Z')));
          await p.goto(origin+'/before/',{waitUntil:'domcontentloaded'});
          const cnn=p.locator('#homeCnnCard');
          await cnn.locator('svg').waitFor();
          await cnn.locator('g[data-cnn-needle][visibility="visible"]').waitFor();
          await p.evaluate(()=>loadFuturesPosition());
          await p.evaluate(()=>renderHomeSentimentCards());
          await p.waitForFunction(()=>document.querySelector('#homeMarginBalanceCard b').textContent.includes('5,764.09'));
          const old=await cnn.boundingBox();
          await p.locator('#homeSentiment').screenshot({path:path.join(out,`before-${name}-${width}.png`)});
          await p.goto(origin+'/after/',{waitUntil:'domcontentloaded'});
          await p.waitForFunction(()=>document.querySelector('#homeMarginBalanceCard b').textContent.includes('5,764.09'));
          await cnn.locator('g[data-cnn-needle][visibility="visible"]').waitFor();
          await p.waitForFunction(()=>document.querySelector('[data-home-foreign-change]').textContent.includes('2,004'));
          assert.equal(await p.locator('#homeSentimentCards > .homeSentimentCard').count(),5);
          assert.equal(await p.locator('#homeSentimentCards > .homeSentimentCard').first().getAttribute('id'),'homeCnnCard');
          assert.match(await p.locator('#homeMaintenanceCard').innerText(),/驗證中/);
          assert.doesNotMatch(await p.locator('#homeMaintenanceCard').innerText(),/\d{2,}|%/);
          const [now,plot,number,date]=await Promise.all([cnn.boundingBox(),cnn.locator('svg').boundingBox(),cnn.locator('b').boundingBox(),cnn.locator('small').boundingBox()]);
          await p.locator('#homeSentiment').screenshot({path:path.join(out,`after-${name}-${width}.png`)});
          assert.ok(plot.x+plot.width<=number.x+1&&plot.y+plot.height<=date.y+1,'plot/readout/date overlap '+JSON.stringify({now,plot,number,date}));
          assert.ok(Math.abs(now.height-old.height)<=1,'CNN layout changed');
          assert.ok(await p.evaluate(w=>document.documentElement.scrollWidth<=w+1,width));
          const foreign=p.locator('#homeForeignFuturesCard'),tmf=p.locator('#homeTmfRatioCard'),homeMargin=p.locator('#homeMarginBalanceCard');
          const color=loc=>loc.evaluate(e=>getComputedStyle(e).color);
          const red='rgb(255, 133, 133)',green='rgb(121, 217, 173)';
          const delta=foreign.locator('[data-home-foreign-change]'),mDelta=homeMargin.locator('[data-home-margin-change]');
          assert.match(await delta.textContent(),/−2,004 口/);
          assert.equal(await color(delta),green);
          assert.equal(await color(mDelta),green);
          assert.equal(await homeMargin.locator('[data-home-margin-status]').textContent(),'官方資料已核對');
          assert.ok((await homeMargin.locator('[data-home-margin-status]').boundingBox()).y >= (await mDelta.boundingBox()).y+(await mDelta.boundingBox()).height+2);
          assert.equal(await color(tmf.locator('b')),red);assert.equal(await color(tmf.locator('em')),red);
          assert.match(await tmf.innerText(),/非三大法人部位推估/);
          for(const c of [foreign,tmf]){
            assert.equal(await c.locator('.homeFuturesDate').textContent(),'資料日 2026/11/05');
            assert.match(await c.locator('time').textContent(),/2026\/11\/05.*23:41/);
          }
          assert.ok(await p.evaluate(()=>[...document.querySelectorAll('#homeSentimentCards button > :is(b,em,small,time,strong)')].every(e=>e.scrollWidth<=e.clientWidth+1)));
          await p.locator('#homeMarginBalanceCard').click();
          const panel=p.locator('#officialMarginObservation');
          await panel.waitFor();
          assert.match(await panel.locator('#officialMarginChange').innerText(),/205\.37/);
          await panel.locator('[data-margin-limit="60"]').click();
          assert.equal(await panel.locator('tbody tr').count(),60);
          await panel.locator('[data-margin-market="tpex"]').click();
          assert.equal(await panel.locator('tbody tr').count(),30);
          await panel.locator('[data-margin-market="combined"]').click();
          assert.equal(await panel.locator('tbody tr').count(),30);
          assert.match(await panel.locator('#officialMarginValue').innerText(),/7,604\.46/);
          assert.ok((await panel.locator('tbody td:last-child').allTextContents()).every(x=>x==='—'));
          await panel.locator('summary').click();
          assert.ok((await panel.locator('svg path').getAttribute('d')).includes('L'));
          assert.ok(await panel.locator('svg').isVisible(),'trend chart must actually be visible');
          const geometry=await p.evaluate(()=>({doc:document.documentElement.scrollWidth, table:document.querySelector('#officialMarginObservation table').getBoundingClientRect().right}));
          assert.ok(geometry.doc<=width+1&&geometry.table<=width+1,'page/table overflow '+JSON.stringify(geometry));
          await panel.screenshot({path:path.join(out,`observation-${name}-${width}.png`)});
          if(width===375){
            const refresh=()=>p.evaluate(()=>loadFuturesPosition());
            future.foreign_tx.net_change=1234;
            future.updated_at='2026-11-05T16:10:00Z';
            future.estimated_non_institutional_tmf={long:8,short:10,net:-2,net_change:0};
            await refresh();
            assert.match(await delta.textContent(),/\+1,234 口/);
            assert.equal(await color(delta),red);
            assert.equal(await color(tmf.locator('b')),green);
            assert.equal(await color(tmf.locator('em')),green);
            assert.match(await foreign.locator('time').textContent(),/2026\/11\/06.*00:10/);
            future.foreign_tx.net_change=0;
            future.estimated_non_institutional_tmf={long:10,short:10,net:0,net_change:0};
            await refresh();assert.match(await delta.textContent(),/ 0 口/);
            assert.equal(await delta.getAttribute('data-home-tone'),'flat');
            assert.match(await tmf.locator('em').textContent(),/中性/);
            future.foreign_tx.net_change=null;
            await refresh();assert.equal(await delta.textContent(),'前日差異待更新');
            future.foreign_tx.net_change=-2004;future.source_status.net_change_available=false;
            await refresh();assert.equal(await delta.textContent(),'前日差異待更新');
            future.source_status.freshness='SOURCE_NOT_READY';future.source_status.lag_trading_days=1;
            await refresh();assert.equal(await tmf.getAttribute('data-home-tone'),'flat');
            assert.equal(await tmf.locator('em').textContent(),'官方待更新');
            future.data_date='2026-10-20';future.updated_at='2026-10-20T15:00:00Z';
            await refresh();assert.match(await tmf.locator('em').textContent(),/過期/);
            future.source_status.aligned=false;
            await refresh();assert.equal(await tmf.locator('b').textContent(),'—');
            future=structuredClone(originalFutures);future.updated_at=null;
            await refresh();assert.equal(await tmf.locator('b').textContent(),'—');
            const rows=margin.twse,previous=rows.at(-2).amount_ntd;
            for(const [amount,tone] of [[previous+100000000,'rise'],[previous,'flat']]){
              rows.at(-1).amount_ntd=amount;
              await p.evaluate(()=>window.dispatchEvent(new Event('online')));
              await p.waitForFunction(t=>document.querySelector('[data-home-margin-change]').dataset.homeTone===t,tone);
              if(tone==='rise')assert.equal(await color(mDelta),red);
            }
          }
          // WebKit can surface the deliberately isolated FinMind transport as
          // a PageError even when the route supplies 503. Keep it in evidence,
          // but require zero unrelated/app errors (same rule as the PWA suite).
          const transport=errors.filter(x=>/^\/api\.finmindtrade\.com\/api\/v4\/data\?dataset=TaiwanStock(?:Price|DividendResult)&[^\n]+ due to access control checks\.$/.test(x));
          assert.deepEqual(errors.filter(x=>!transport.includes(x)),[]);
          results.push({name,width,before:old.height,after:now.height,reduction:1-now.height/old.height,
            expectedIsolatedTransport:transport});
          console.log('PASS',JSON.stringify(results.at(-1)));
        }finally{await context.close();}
      }
    }finally{await browser.close();}
  }
}
run().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>{
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({pass:results.length,results,physicalIphone:'PENDING'},null,2));
  server.close();
});
