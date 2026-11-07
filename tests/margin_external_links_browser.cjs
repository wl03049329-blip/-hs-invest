'use strict';
// Both destinations are intercepted as navigation-only fixtures, never fetched.
const {chromium,webkit}=require('playwright-core');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {build}=require('../scripts/build_stable_app.cjs');
const taiex=require('../home-taiex-core.js');
const tmf=require('../home-tmf-core.js');
const out=process.env.HS_LINKS_TEST_OUT;
if(!out) throw Error('HS_LINKS_TEST_OUT_REQUIRED');
fs.mkdirSync(out,{recursive:true});
const production='https://wl03049329-blip.github.io/-hs-invest/';
const publicMode=process.argv.includes('--public');
const links=[
 ['玩股網維持率','https://www.wantgoo.com/stock/margin-trading/market-price/taiex'],
 ['證交所官方','https://www.twse.com.tw/dashboard/zh/credit/margin.html'],
];
const types={'.html':'text/html;charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
let server;
async function run(){
  let base=production;
  if(!publicMode){
    const site=build({out:path.join(out,'site')}).out;
    server=http.createServer((req,res)=>{
      const file=path.resolve(site,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
      const p=file===site?path.join(site,'index.html'):file;
      if(!p.startsWith(site+path.sep)||!fs.existsSync(p)||!fs.statSync(p).isFile())return res.writeHead(404).end();
      res.writeHead(200,{'Content-Type':types[path.extname(p)]||'application/octet-stream','Cache-Control':'no-store'}).end(fs.readFileSync(p));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    base='http://127.0.0.1:'+server.address().port+'/';
  }
  for(const [name,engine] of [['chrome',chromium],['webkit',webkit]]){
    const browser=await engine.launch(name==='chrome'?{channel:'chrome'}:{});
    try{
      for(const width of publicMode?[390]:[320,375,390,430,1280]){
        const mobile=width<600;
        const ctx=await browser.newContext({viewport:{width,height:900},isMobile:mobile,hasTouch:mobile,timezoneId:'Asia/Taipei',...(publicMode?{}:{serviceWorkers:'block'})});
        try{
          if(!publicMode)await ctx.route(u=>u.origin!==new URL(base).origin,r=>r.fulfill({status:503,headers:{'access-control-allow-origin':'*'},body:''}));
          const hits=[];
          for(const [,url] of links)await ctx.route(url,r=>{
            const req=r.request();
            hits.push({url:req.url(),type:req.resourceType(),navigation:req.isNavigationRequest(),referer:req.headers().referer});
            return r.fulfill({contentType:'text/html',body:'<!doctype html><title>Navigation fixture</title>'});
          });
          const p=await ctx.newPage();
          const receipt=await (await ctx.request.get(base+'app-release.json?links='+Date.now())).json();
          assert.equal(receipt.version,'3.9.1');
          assert.equal(receipt.financial_writer,false);
          if(publicMode){
            const expected=process.env.HS_LINKS_DEPLOYMENT;
            assert.ok(expected&&receipt.deployment_commit===expected,'unexpected deployment commit');
            const assets=receipt.assets.filter(a=>/^(index\.html|formal-black-gold\.css|push-service-worker\.js|home-taiex-(?:core|display)\.js|home-tmf-core\.js)\?/.test(a.url));
            assert.equal(assets.length,6);
            for(const a of assets){
              const resp=await ctx.request.get(base+a.url);assert.ok(resp.ok());
              const bytes=await resp.body();assert.equal(bytes.length,a.bytes);
              assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),a.sha256);
            }
          }
          await p.goto(base+'?links='+Date.now(),{waitUntil:'domcontentloaded'});
          if(publicMode)await p.waitForFunction(()=>self.HSStableApp?.status().phase==='CURRENT',null,{timeout:45000});
          assert.equal(await p.locator('meta[name="hs-app-commit"]').getAttribute('content'),receipt.commit);
          const home=p.locator('.homeMarginCardShell');
          const anchors=home.locator('.homeMarginExternalLinks > a');
          await anchors.first().waitFor();
          assert.equal(await anchors.count(),2);
          assert.equal(await p.locator('#homeSentimentCards > .homeSentimentCard').count(),5);
          assert.match(await p.locator('#homeTaiexCard').innerText(),/台灣加權指數/);
          assert.match(await p.locator('#homeTmfRatioCard').innerText(),/微台散戶淨留倉/);
          if(publicMode){
            const response=await ctx.request.get(base+'home-taiex.json?verify='+Date.now());
            assert.ok(response.ok());
            const snapshot=await response.json(),view=taiex.view(snapshot);
            assert.ok(view,'published official snapshot must be valid');
            await p.waitForFunction(d=>document.querySelector('#homeTaiexCard time')?.dateTime===d,view.date);
            const card=p.locator('#homeTaiexCard');
            assert.equal(await card.locator('b').textContent(),view.value);
            assert.equal(await card.locator('strong').textContent(),view.change);
            assert.equal(await card.locator('strong').getAttribute('data-home-tone'),view.tone);
            assert.match(await p.locator('#homeTmfRatioCard').innerText(),/非三大法人部位推估/);
            const tmfResponse=await ctx.request.get(base+'home-tmf-net.json?verify='+Date.now());
            assert.ok(tmfResponse.ok());
            const t=tmf.view(await tmfResponse.json());
            assert.ok(t,'published official TMF snapshot must be valid');
            await p.waitForFunction(d=>document.querySelector('#homeTmfRatioCard time')?.dateTime===d,t.date);
            const retail=p.locator('#homeTmfRatioCard');
            assert.equal(await retail.locator('b').textContent(),t.value);
            assert.equal(await retail.locator('strong').textContent(),t.change);
            assert.equal(await retail.locator('strong').getAttribute('data-home-tone'),t.tone);
            console.log('TMF',JSON.stringify(t));
            await p.locator('#homeSentiment').screenshot({path:path.join(out,name+'-'+width+'-sentiment.png')});
            console.log('TAIEX',JSON.stringify(view));
          }
          assert.ok(await anchors.evaluateAll(nodes=>nodes.every(n=>!n.closest('button,[data-home-chip]')&&!n.hasAttribute('ping'))));
          await p.evaluate(async()=>{await document.fonts.ready;});
          const [a,b]=await anchors.evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().toJSON()));
          if(!(a.height>=44&&b.height>=44&&Math.abs(a.y-b.y)<1&&a.right<=b.left&&b.right<=width)){
            await home.screenshot({path:path.join(out,name+'-'+width+'-geometry-fail.png')});
            assert.fail(JSON.stringify({name,width,a,b}));
          }
          assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
          assert.ok(await anchors.evaluateAll(nodes=>nodes.every(n=>n.scrollWidth<=n.clientWidth+1)));
          assert.deepEqual(hits,[],'no requests to the destinations before user navigation');
          await home.screenshot({path:path.join(out,name+'-'+width+'.png')});
          for(const [i,[label,url]] of links.entries()){
            const anchor=anchors.nth(i);
            assert.equal(await anchor.innerText(),label);
            assert.equal(await anchor.getAttribute('href'),url);
            assert.equal(await anchor.getAttribute('target'),'_blank');
            assert.equal(await anchor.getAttribute('rel'),'noopener noreferrer');
            const [popup]=await Promise.all([p.waitForEvent('popup'),mobile?anchor.tap():anchor.click()]);
            await popup.waitForLoadState('domcontentloaded');
            assert.equal(popup.url(),url);
            assert.equal(await popup.evaluate(()=>window.opener===null),true);
            await popup.close();
            assert.equal(await p.locator('.appNavButton[data-tab=today]:visible').getAttribute('aria-current'),'page');
          }
          assert.deepEqual(hits,links.map(([,url])=>({url,type:'document',navigation:true,referer:undefined})));
          await p.locator('#homeMarginBalanceCard').click();
          await p.locator('#officialMarginObservation').waitFor();
          for(const tab of ['signals','portfolio','more','sentiment','today']){
            const nav=p.locator('.appNavButton[data-tab='+tab+']:visible');
            await nav.click();
            assert.equal(await nav.getAttribute('aria-current'),'page');
            if(tab==='portfolio')await p.locator('.pv3').waitFor();
          }
          console.log('PASS',JSON.stringify({name,width,scope:publicMode?'PUBLIC_HS_INTERCEPTED_DESTINATIONS':'LOCAL',commit:receipt.commit,deployment:receipt.deployment_commit,run:receipt.run_id}));
        }finally{await ctx.close();}
      }
    }finally{await browser.close();}
  }
}
run().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server?.close());
