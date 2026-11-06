'use strict';
// Local fixture-only acceptance. No browser profile or financial writes.
const {chromium,webkit}=require('playwright-core');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=process.env.HS_MARGIN_UI_OUT,base=process.env.HS_MARGIN_UI_BASE;
if(!out||!/^[a-f0-9]{40}$/.test(base||''))throw Error('EVIDENCE_DIR_AND_BASE_REQUIRED');
fs.mkdirSync(out,{recursive:true});
const prior=new Map(['index.html','formal-black-gold.css'].map(file=>[file,cp.execFileSync('git',['show',base+':'+file],{cwd:root,maxBuffer:4e6})]));
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
          await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
          const p=await context.newPage(),errors=[];
          p.on('pageerror',e=>errors.push(e.message));
          await p.addInitScript(t=>{
            const D=Date;window.Date=class extends D{constructor(...a){super(...(a.length?a:[t]));}static now(){return t;}};
          },Math.max(fixed,Date.parse('2026-11-05T17:00:00Z')));
          await p.goto(origin+'/before/',{waitUntil:'domcontentloaded'});
          const cnn=p.locator('#homeCnnCard');
          await cnn.locator('svg').waitFor();
          await cnn.locator('g[data-cnn-needle][visibility="visible"]').waitFor();
          const old=await cnn.boundingBox();
          await p.locator('#homeSentiment').screenshot({path:path.join(out,`before-${name}-${width}.png`)});
          await p.goto(origin+'/after/',{waitUntil:'domcontentloaded'});
          await p.waitForFunction(()=>document.querySelector('#homeMarginBalanceCard b').textContent.includes('5,764.09'));
          await cnn.locator('g[data-cnn-needle][visibility="visible"]').waitFor();
          assert.equal(await p.locator('#homeSentimentCards > button').count(),5);
          assert.equal(await p.locator('#homeSentimentCards > button').first().getAttribute('id'),'homeCnnCard');
          assert.match(await p.locator('#homeMaintenanceCard').innerText(),/驗證中/);
          assert.doesNotMatch(await p.locator('#homeMaintenanceCard').innerText(),/\d{2,}|%/);
          const [now,plot,number,date]=await Promise.all([cnn.boundingBox(),cnn.locator('svg').boundingBox(),cnn.locator('b').boundingBox(),cnn.locator('small').boundingBox()]);
          await p.locator('#homeSentiment').screenshot({path:path.join(out,`after-${name}-${width}.png`)});
          assert.ok(plot.x+plot.width<=number.x+1&&plot.y+plot.height<=date.y+1,'plot/readout/date overlap '+JSON.stringify({now,plot,number,date}));
          assert.ok(now.height<old.height,'CNN not compacted');
          assert.ok(await p.evaluate(w=>document.documentElement.scrollWidth<=w+1,width));
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
          const geometry=await p.evaluate(()=>({doc:document.documentElement.scrollWidth, table:document.querySelector('#officialMarginObservation table').getBoundingClientRect().right}));
          assert.ok(geometry.doc<=width+1&&geometry.table<=width+1,'page/table overflow '+JSON.stringify(geometry));
          await panel.screenshot({path:path.join(out,`observation-${name}-${width}.png`)});
          assert.deepEqual(errors,[]);
          results.push({name,width,before:old.height,after:now.height,reduction:1-now.height/old.height});
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
