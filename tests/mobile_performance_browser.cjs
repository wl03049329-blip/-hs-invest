'use strict';
// Isolated, unmodified browser storage. External requests fail deterministically.
const {chromium,webkit}=require('playwright-core');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const [dir,out]=process.argv.slice(2),root=path.resolve(dir);
const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost'),file=path.resolve(root,'.'+decodeURIComponent(url.pathname)+(url.pathname.endsWith('/')?'index.html':''));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return res.writeHead(404).end();
  res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Content-Length':fs.statSync(file).size,'Cache-Control':url.searchParams.has('v')?'public,max-age=86400':'no-store'});
  fs.createReadStream(file).pipe(res);
});
async function main(){
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const result=[];
  for(const [name,engine] of [['chrome',chromium],['webkit',webkit]]){
    if(process.env.HS_PERF_ENGINE&&name!==process.env.HS_PERF_ENGINE)continue;
    const browser=await engine.launch(name==='chrome'?{channel:'chrome'}:{});
    try{for(const width of [390,375,320]){
      const ctx=await browser.newContext({viewport:{width,height:844},isMobile:true,hasTouch:true,timezoneId:'Asia/Taipei',serviceWorkers:'block'});
      try{
        await ctx.route(url=>url.origin!==base,r=>r.abort());
        await ctx.addInitScript(()=>{
          const perf=window.hsPerf={c4:0,c4Dom:0,portfolioDom:0,firstC4:null,longTasks:null,json:[]};
          try{if(PerformanceObserver.supportedEntryTypes.includes('longtask')){
            perf.longTasks=[];new PerformanceObserver(l=>perf.longTasks.push(...l.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:true});
          }}catch{}
          addEventListener('hs:formal-core-score-updated',()=>perf.c4++);
          const parse=Response.prototype.json;
          Response.prototype.json=async function(){
            const start=performance.now();
            try{return await parse.call(this);}
            finally{const url=new URL(this.url||location.href);if(url.origin===location.origin)perf.json.push({name:url.pathname,bodyAndParseMs:performance.now()-start});}
          };
          new MutationObserver(records=>{
            for(const {target} of records){
              if(target.id==='hsDashboardC4Grid'){perf.c4Dom++;if(perf.firstC4===null&&target.querySelectorAll('[data-c4-symbol]').length===6)perf.firstC4=performance.now();}
              if(target.id==='hpv2'||target.classList?.contains('pv3'))perf.portfolioDom++;
            }
          }).observe(document,{childList:true,subtree:true});
        });
        const page=await ctx.newPage(),errors=[];
        page.on('pageerror',error=>errors.push(error.message));
        const cdp=name==='chrome'?await ctx.newCDPSession(page):null;
        if(cdp)await cdp.send('Performance.enable');
        for(const mode of ['cold','warm']){
          const before=cdp?Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value])):{};
          const cutoff=errors.length;
          if(mode==='cold')await page.goto(base+'/',{waitUntil:'domcontentloaded'});
          else await page.reload({waitUntil:'domcontentloaded'});
          await page.waitForFunction(()=>document.querySelectorAll('#hsDashboardC4Grid [data-c4-symbol]').length===6);
          const interactive=await page.locator('[data-home-c4-sort=change]').evaluate(async button=>{
            button.click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
            return button.classList.contains('is-active')?performance.now():null;
          });
          await page.waitForTimeout(1800);
          const startup=await page.evaluate(()=>{
            const nav=performance.getEntriesByType('navigation')[0],resources=performance.getEntriesByType('resource'),json=resources.filter(e=>new URL(e.name).pathname.endsWith('.json'));
            return {...window.hsPerf,dcl:nav.domContentLoadedEventEnd,firstPaint:performance.getEntriesByName('first-contentful-paint')[0]?.startTime??null,
              resources:resources.length,transferBytes:nav.transferSize+resources.reduce((n,r)=>n+r.transferSize,0),jsonBytes:json.reduce((n,r)=>n+r.encodedBodySize,0),
              large:json.filter(e=>e.encodedBodySize>1e6).map(e=>({name:new URL(e.name).pathname,bytes:e.encodedBodySize,downloadMs:e.responseEnd-e.responseStart})),
              blockingScripts:document.querySelectorAll('script[src]:not([async]):not([defer])').length};
          });
          const metrics=cdp?Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value])):{};
          const scroll=await page.evaluate(async()=>{
            const intervals=[];let previous=performance.now();
            for(let i=0;i<45;i++)await new Promise(r=>requestAnimationFrame(t=>{intervals.push(t-previous);previous=t;scrollTo({top:i*32,behavior:'instant'});r();}));
            return {frames:intervals.length,over25ms:intervals.filter(t=>t>25).length,maxMs:Math.max(...intervals)};
          });
          const tabs={};
          for(const tab of ['signals','portfolio','sentiment','more','today']){
            tabs[tab]=await page.locator('.bottomNavButton[data-tab='+tab+']').evaluate(async btn=>{
              const start=performance.now();btn.click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
              if(btn.getAttribute('aria-current')!=='page')throw Error('Tab did not activate');
              return performance.now()-start;
            });
          }
          const row={name,width,mode,interactive,scroll,tabs,startup,scriptMs:metrics.ScriptDuration!=null?1000*(metrics.ScriptDuration-(before.ScriptDuration||0)):null,layoutMs:metrics.LayoutDuration!=null?1000*(metrics.LayoutDuration-(before.LayoutDuration||0)):null,heapBytes:metrics.JSHeapUsedSize??null,errors:errors.slice(cutoff)};
          result.push(row);fs.writeFileSync(out,JSON.stringify(result,null,2));
          console.log(name,width,mode,Math.round(startup.dcl),Math.round(interactive),startup.c4,startup.c4Dom,row.errors);
        }
      }finally{await ctx.close();}
    }}finally{await browser.close();}
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());
