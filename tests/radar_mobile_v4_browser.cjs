"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),http=require("node:http");
const {chromium,webkit}=require("playwright-core"),{build}=require("../scripts/build_stable_app.cjs");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"hs-radar-v4-")),site=build({out:path.join(dir,"site"),commit:require("node:child_process").execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim()}).out;
const types={".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".webmanifest":"application/manifest+json"};
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,"http://localhost"),file=path.resolve(site,"."+url.pathname+(url.pathname==="/"?"index.html":""));
  if(url.pathname==="/__test/live-scores")return res.writeHead(503,{"Content-Type":"application/json"}).end('{"status":"unavailable"}');
  if(!file.startsWith(site+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return res.writeHead(404).end();
  res.writeHead(200,{"Content-Type":types[path.extname(file)]||"application/octet-stream"});
  fs.createReadStream(file).pipe(res);
});
const cases=[[375,812],[390,844],[430,932],[844,390],[1200,900]];
(async()=>{
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  const base="http://127.0.0.1:"+server.address().port;
  for(const engine of (process.env.HS_CHROME_ONLY==="1"?[chromium]:[chromium,webkit])){
    const browser=await engine.launch(engine===chromium?{channel:"chrome"}:{});
    try{for(const [width,height] of cases){
      const page=await browser.newPage({viewport:{width,height},isMobile:width<900,hasTouch:width<900,serviceWorkers:"block"});
      try{
        const errors=[];page.on("pageerror",e=>errors.push(e.message));
        await page.addInitScript(url=>{window.HS_LIVE_RAILWAY_URL=url;},base+"/__test/live-scores");
        await page.clock.setFixedTime(new Date("2026-11-18T01:00:00Z"));
        // Keep production disconnected. Model an unavailable cross-origin source
        // with an HTTP response so WebKit exercises the app fallback, not CORS.
        await page.route("**/*",r=>r.request().url().startsWith(base+"/")?r.continue():r.fulfill({
          status:503,headers:{"access-control-allow-origin":"*","content-type":"application/json"},
          body:'{"test":"isolated external source unavailable"}'
        }));
        await page.goto(base+"/",{waitUntil:"domcontentloaded"});
        await page.waitForFunction(()=>document.querySelector('#cards [data-etf-id="0050"][data-radar-v4]'));
        await page.evaluate(()=>openHomeC4RadarDetail("0050"));
        const selected=page.locator(".signalCard.is-selected[data-radar-v4]");
        const quick=selected.locator('[data-radar-v4-pane="quick"]');
        await quick.waitFor({state:"visible"});
        assert.equal(await quick.locator(":scope>.radarV4Card").count(),2);
        assert.match(await quick.innerText(),/近 52 週高點回落/);
        assert.match(await quick.innerText(),/64\.5/);
        assert.doesNotMatch(await quick.innerText(),/Weekly J|P100|FINAL_CORE_WEIGHT/);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        await quick.locator('[data-radar-v4-tab="deep"]').click();
        const deep=selected.locator('[data-radar-v4-pane="deep"]');
        await deep.waitFor({state:"visible"});
        assert.equal(await deep.locator('[data-radar-v4-fold]').count(),3);
        assert.equal(await deep.locator('.radarHistoryRanges button').count(),6);
        await deep.locator('[data-radar-v4-fold="factors"] summary').first().click();
        assert.equal(await deep.locator('[data-radar-v4-fold="factors"]').getAttribute("open"),"");
        await selected.locator('[data-radar-v4-action="picker"]').click();
        await selected.locator('[data-radar-v4-pick="00662"]').click();
        assert.equal(await selected.getAttribute("data-etf-id"),"00662");
        await deep.waitFor({state:"visible"});
        assert.equal(await deep.locator('[data-radar-v4-fold="factors"]').getAttribute("open"),"");
        await deep.locator('.radarHistoryCustom summary').click();
        await deep.locator('[data-custom-start]').fill("2026-11-17");
        await deep.locator('[data-custom-end]').fill("2026-11-10");
        await deep.locator('[data-history-action="custom"]').click();
        assert.match(await deep.locator('[data-custom-status]').innerText(),/日期順序錯誤/);
        await deep.locator('[data-custom-start]').fill("2026-11-10");
        await deep.locator('[data-custom-end]').fill("2026-11-17");
        await deep.locator('[data-history-action="custom"]').click();
        assert.match(await deep.locator('[data-custom-status]').innerText(),/保留缺口/);
        await deep.locator('[data-history-action="fullscreen"]').click();
        const full=page.locator(".radarHistoryFullscreen");
        await full.waitFor({state:"visible"});
        assert.ok((await full.boundingBox()).width<=width);
        await full.locator('[data-history-action="fullscreen"]').click();
        assert.equal(await page.locator(".radarHistoryFullscreen").count(),0);
        await selected.locator('nav [data-radar-v4-tab="quick"]').click();
        assert.match(await quick.innerText(),/46\.5/);
        assert.doesNotMatch(await quick.innerText(),/64\.5/);
        assert.deepEqual(errors,[]);
        console.log(engine.name(),width+"x"+height,"V4 PASS");
      }finally{await page.close();}
    }}finally{await browser.close();}
  }
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());
