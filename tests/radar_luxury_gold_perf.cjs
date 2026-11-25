'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),os=require('node:os');
const {chromium,webkit}=require('playwright-core');
const roots=process.argv.slice(2).map(p=>path.resolve(p));
assert.equal(roots.length,2,'Use baseline and candidate source worktrees');
const evidence=process.env.HS_LUXURY_ARTIFACTS||fs.mkdtempSync(path.join(os.tmpdir(),'hs-rc2-perf-'));
fs.mkdirSync(evidence,{recursive:true});
const mime={'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml'};
const fixtures=['finalized-core-score-snapshots-v1.json','market-quotes.json','etf-universe.json','data/c4-close-observations-v1.json','data/radar-history/status-v1.json'];
for(const f of fixtures)assert.deepEqual(fs.readFileSync(path.join(roots[0],f)),fs.readFileSync(path.join(roots[1],f)),f+' snapshot must match');
async function site(root){
 const out=require(path.join(root,'scripts/build_stable_app.cjs')).build({root,out:path.join(fs.mkdtempSync(path.join(os.tmpdir(),'hs-rc2-perf-site-')),'site')}).out;
 const srv=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost'),f=path.resolve(out,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!f.startsWith(out+path.sep)||!fs.existsSync(f)||!fs.statSync(f).isFile())return res.writeHead(404).end();res.setHeader('Content-Type',mime[path.extname(f)]||'application/octet-stream');fs.createReadStream(f).pipe(res);});
 await new Promise(r=>srv.listen(0,'127.0.0.1',r));return {srv,base:'http://127.0.0.1:'+srv.address().port+'/'};
}
async function one(b,base,after,{soak=false,engine}={}){
 const c=await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce',serviceWorkers:'block'}),p=await c.newPage();
 let requests=0,chartRequests=0,errors=[];p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>{if(!['xhr','fetch'].includes(r.resourceType()))return;requests++;if(/radar-history|c4-close-observations|TaiwanStockDividend/.test(r.url()))chartRequests++;});
 try{
  await p.clock.setFixedTime(new Date('2026-11-25T15:40:00Z'));
  await p.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.fulfill({status:503,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:'{}'}));
  await p.addInitScript(()=>{window.rcRebuilds=0;new MutationObserver(rs=>{window.rcRebuilds+=rs.filter(r=>['cards','radarOverviewLong'].includes(r.target.id)&&r.addedNodes.length).length;}).observe(document,{childList:true,subtree:true});});
  const t=performance.now();
  await p.goto(base+'?tab=signals',{waitUntil:'domcontentloaded'});
  await p.locator('#radarOverviewLong [data-open-radar-detail="0050"]').waitFor();
  const overview=performance.now()-t,bootRequests=requests,bootRebuilds=await p.evaluate(()=>rcRebuilds);
  const btn=(tab)=>p.locator('.signalCard.is-selected nav [data-radar-v4-tab="'+tab+'"]');
  const chart=()=>p.locator('.signalCard.is-selected .radarHistoryCanvas canvas:visible').first().waitFor({timeout:25000});
  const t1=performance.now();
  await p.locator('#radarOverviewLong [data-open-radar-detail="0050"]').click();
  await p.locator('.signalCard.is-selected [data-radar-v4-pane=quick]').waitFor();
  const detail=performance.now()-t1;
  if(!after)await btn('deep').click();
  await chart();
  const fullChart=performance.now()-t1;
  await btn('deep').click();await chart();
  const t2=performance.now();
  for(const symbol of ['00662','00757','00830','0050']){
   await p.locator('.signalCard.is-selected [data-radar-v4-action=picker]').click();
   await p.locator('.signalCard.is-selected [data-radar-v4-pick="'+symbol+'"]').click();
   await chart();
  }
  const etfs=performance.now()-t2,pre=chartRequests;
  const t3=performance.now();
  for(let i=0;i<4;i++){await btn('quick').click();await btn('deep').click();await chart();}
  const tabs=performance.now()-t3,tabChartRequests=chartRequests-pre;
  await p.locator('.signalCard.is-selected [data-radar-v4-action=back]').click();
  await p.locator('#radarOverview').waitFor();
  let eventToggle=null;
  if(after){const control=p.locator('#radarEventCenter>summary');await control.scrollIntoViewIfNeeded();const t4=performance.now();for(let i=0;i<4;i++)await control.click();eventToggle=performance.now()-t4;}
  else assert.ok(await p.locator('#radarEventCenter').isVisible(),'baseline always exposes events');
  assert.deepEqual(errors,[]);
  const result={overview,detail,fullChart,etfs,tabs,eventToggle,bootRequests,requests,chartRequests,tabChartRequests,bootRebuilds,rebuilds:await p.evaluate(()=>rcRebuilds)};
  if(soak){
   const cdp=engine==='chrome'?await c.newCDPSession(p):null,heap=async()=>{if(!cdp)return null;await cdp.send('HeapProfiler.collectGarbage');return (await cdp.send('Runtime.getHeapUsage')).usedSize;};
   await p.locator('#radarOverviewLong [data-open-radar-detail="0050"]').click();await btn('deep').click();await chart();
   const start=performance.now(),samples=[],latency=[];let cycles=0;
   while(cycles<30||performance.now()-start<30000){
    const t=performance.now();await btn('quick').click();await btn('deep').click();await chart();latency.push({cycle:performance.now()-t});
    if(cycles%10===0)samples.push({atCycle:cycles,heapBytes:await heap(),activeCanvases:await p.locator('.signalCard.is-selected .radarHistoryCanvas canvas:visible').count()});
    cycles++;
   }
   samples.push({atCycle:cycles,heapBytes:await heap(),activeCanvases:await p.locator('.signalCard.is-selected .radarHistoryCanvas canvas:visible').count()});
   assert.deepEqual(errors,[]);
   result.soak={elapsedMs:performance.now()-start,cycles,samples,cycleLatency:stats(latency).cycle};
  }
  return result;
 }finally{await c.close();}
}
function stats(rows){
 return Object.fromEntries(Object.keys(rows[0]).map(k=>{const a=rows.map(x=>x[k]).filter(Number.isFinite).sort((x,y)=>x-y),n=a.length;
  return [k,n?{n,median:(a[(n-1)>>1]+a[n>>1])/2,p95:a[Math.ceil(n*.95)-1]}:null];}));
}
(async()=>{
 const sites=await Promise.all(roots.map(site));const result={clock:'2026-11-25T15:40:00Z',viewport:390,samplesPerGroup:10,groups:{}};
 try{for(const [engine,t] of [['chrome',chromium],['webkit',webkit]]){
  const b=await t.launch(engine==='chrome'?{channel:'chrome'}:{}),samples=[[],[]];
  try{for(let i=0;i<10;i++)for(const side of i%2?[1,0]:[0,1]){samples[side].push(await one(b,sites[side].base,Boolean(side)));console.log(engine,i+1,side===0?'BASELINE':'RC2');}
  result.groups[engine]={baseline:stats(samples[0]),rc2:stats(samples[1]),samples};fs.writeFileSync(path.join(evidence,'rc2-perf.json'),JSON.stringify(result,null,2));
  if(process.env.HS_RC2_SOAK==='1'){
   result.groups[engine].soak=[];
   for(const side of [0,1]){const sample=await one(b,sites[side].base,Boolean(side),{soak:true,engine});result.groups[engine].soak.push(sample.soak);console.log(engine,side?'RC2':'BASELINE','SOAK',JSON.stringify(sample.soak));}
   fs.writeFileSync(path.join(evidence,'rc2-perf.json'),JSON.stringify(result,null,2));
  }}
  finally{await b.close();}
 }}finally{sites.forEach(s=>s.srv.close());}
 console.log(JSON.stringify(Object.fromEntries(Object.entries(result.groups).map(([k,v])=>[k,[v.baseline,v.rc2]]))));
})().catch(e=>{console.error(e);process.exitCode=1;});
