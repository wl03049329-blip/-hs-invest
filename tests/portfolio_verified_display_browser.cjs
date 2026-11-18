'use strict';
// Isolated localhost app and synthetic holdings; never use an existing profile.
const {chromium,webkit}=require('playwright-core'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {build}=require('../scripts/build_stable_app.cjs'),out=fs.mkdtempSync(path.join(os.tmpdir(),'hs-portfolio-readout-'));
const sites=[['candidate',build({out:path.join(out,'candidate')}).out]];
if(process.env.HS_BASELINE_ROOT)sites.unshift(['baseline',build({root:process.env.HS_BASELINE_ROOT,out:path.join(out,'baseline')}).out]);
const mime={'.html':'text/html','.json':'application/json','.js':'text/javascript','.css':'text/css','.webmanifest':'application/manifest+json','.png':'image/png'};
function server(site){return http.createServer((req,res)=>{const url=new URL(req.url,'http://local'),file=path.resolve(site,'../'+path.basename(site)+url.pathname.replace(/^\/-hs-invest/,'')+(url.pathname.endsWith('/')?'index.html':''));
 if(!file.startsWith(site+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return res.writeHead(404).end();
 res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});fs.createReadStream(file).pipe(res);
});}
async function add(p,symbol,shares,price){await p.locator('#hpv2-add').click();const d=p.locator('#hpv2-holdingDialog');await d.locator('#hpv2-symbol').fill(symbol);await d.locator('#hpv2-shares').fill(String(shares));await d.locator('#hpv2-breakEven').fill(String(price));await d.locator('button[type=submit]').click();await d.waitFor({state:'hidden'});}
const raw=p=>p.evaluate(()=>Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith('hsPersonalV3.v1.')).map(([k,v])=>[new TextDecoder().decode(Uint8Array.from(k.slice('hsPersonalV3.v1.'.length).match(/../g),x=>parseInt(x,16))),v]).filter(([k])=>/simpleHoldings|ledger|investableCash/.test(k))));
async function run(p,url,name,width){
 await p.addInitScript(({before,after})=>{const Date0=Date;window.testAt=Date0.parse(before);window.postSplit=()=>window.testAt=Date0.parse(after);window.Date=class extends Date0{constructor(...a){super(...(a.length?a:[window.testAt]));}static now(){return window.testAt;}};
  let reads=0;const get=Storage.prototype.getItem;Storage.prototype.getItem=function(...args){reads++;return get.apply(this,args);};window.readCount=()=>reads;
 },{before:'2026-11-12T11:30:00Z',after:'2026-11-18T11:30:00Z'});
 await p.goto(url,{waitUntil:'domcontentloaded'});
 await p.waitForFunction(()=>document.documentElement.dataset.hsV3Boot==='ready'&&document.getElementById('hpv2-start').onclick);
 await p.locator('#hpv2-consent').check();await p.locator('#hpv2-start').click();await add(p,'0050',100,70);await add(p,'00662',500,20);
 await p.evaluate(()=>postSplit());
 await p.evaluate(()=>document.getElementById('hpv2-updatePrices').click());
 await p.waitForFunction(()=>{const rows=HSPersonalV3.read().rows;return rows.some(r=>r.symbol==='0050'&&r.quote?.date==='2026-11-18')&&rows.some(r=>r.symbol==='00662'&&r.unit_status==='SPLIT_BASIS_REVIEW_REQUIRED');});
 const measure=()=>p.evaluate(async()=>{const list=document.querySelector('#hpv2-holdings');let rebuilds=0;const obs=new MutationObserver(a=>{for(const r of a)if(r.target.matches?.('.holding'))rebuilds+=[...r.addedNodes].filter(n=>n.matches?.('details.pv3row')).length;});obs.observe(list,{childList:true,subtree:true});
  const before=readCount(),start=performance.now();for(let i=0;i<12;i++)dispatchEvent(new Event('hs-personal-v2-market-updated'));const dispatch_ms=performance.now()-start;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));obs.disconnect();return{dispatch_ms,settled_ms:performance.now()-start,storage_reads:readCount()-before,holding_rebuilds:rebuilds};});
 const metrics=await measure();console.log(JSON.stringify({name,width,...metrics}));
 if(name==='candidate'){
  assert.ok(metrics.holding_rebuilds<=4,JSON.stringify(metrics));
  assert.match(await p.locator('.pv353assets').innerText(),/同日已核實市值小計/);
  const before=await raw(p),holding=p.locator('.holding[data-symbol="00662"]');
  await holding.locator('summary').click();
  await holding.getByRole('button',{name:'核對股數與分割單位'}).click();
  const d=p.locator('#pv3-unit-dialog');await d.waitFor();
  assert.equal(await d.locator('option[value="PRE_SPLIT"]').evaluate(option=>option.disabled),true);
  await d.locator('[name=basis]').selectOption('POST_SPLIT');
  assert.match(await d.locator('[data-preview]').innerText(),/500股.*20/);
  await d.locator('[name=ack]').check();await d.getByRole('button',{name:'確認保存'}).click();await d.waitFor({state:'hidden'});
  await p.waitForFunction(()=>HSPersonalV3.read().rows.some(r=>r.symbol==='00662'&&r.unit_status==='AS_CONFIRMED'));
  const row=await p.evaluate(()=>HSPersonalV3.read().rows.find(r=>r.symbol==='00662'));
  assert.equal(row.shares,500);assert.equal(row.break_even_price,20);assert.equal(row.market_value_minor,Math.round(row.price*50000));assert.deepEqual(await raw(p),before);
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  for(let i=0;i<4;i++)for(const name of ['today','portfolio'])await p.locator('.appNavButton[data-tab="'+name+'"]:visible').click();
  await p.evaluate(()=>{dispatchEvent(new PageTransitionEvent('pageshow'));dispatchEvent(new Event('online'));});
  assert.deepEqual(await raw(p),before);
 }
}
(async()=>{for(const [name,site] of sites){const s=server(site);await new Promise(r=>s.listen(0,'127.0.0.1',r));try{
 for(const [kind,engine] of [['chromium',chromium],['webkit',webkit]]){if(kind==='webkit'&&process.env.HS_CHROME_ONLY==='1')continue;const b=await engine.launch(kind==='chromium'?{channel:'chrome'}:{});
 try{for(const width of (process.env.HS_PORTFOLIO_PILOT==='1'?[390]:[375,390,430])){const p=await b.newPage({viewport:{width,height:900},isMobile:true,hasTouch:true});try{await run(p,'http://127.0.0.1:'+s.address().port+'/-hs-invest/?tab=portfolio',name,width);console.log(kind,width,name,'PASS');}finally{await p.close();}}}finally{await b.close();}
 }}finally{s.close();}}})().catch(e=>{console.error(e);process.exitCode=1;});
