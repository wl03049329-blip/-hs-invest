"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const {chromium,webkit}=require("playwright-core"),{build}=require("../scripts/build_stable_app.cjs");
const live=process.argv[2];
const url=live||"http://localhost:8234/-hs-invest/";
if(live)assert.equal(url,"https://wl03049329-blip.github.io/-hs-invest/");
const out=live?null:build({out:path.join(fs.mkdtempSync(path.join(os.tmpdir(),"hs-cnn-test-")),"site")}).out;
const fixed=new Date("2026-11-24T13:30:00Z");
const sessions=["09","10","11","12","13","16","17","18","19","20","23"].map((day,i)=>({date:"2026-11-"+day,score:[31.5,37.4,35.9,40.3,37.4,31.1,26,29.9,15.9,15.9,15.7][i]}));
const artifact={...require("../cnn-fear-greed.json"),score:20.7,
  updated_at:fixed.toISOString(),source_updated_at:fixed.toISOString(),
  history:{schema:"HS_CNN_CLOSED_SESSIONS_V1",sessions}};
(async()=>{for(const [engine,name] of [[chromium,"Chrome"],[webkit,"WebKit"]]){
  const browser=await engine.launch(name==="Chrome"?{channel:"chrome"}:{});
  try{for(const width of [375,390,430]){
    const page=await browser.newPage({viewport:{width,height:844},isMobile:true,hasTouch:true,timezoneId:"Asia/Taipei"});
    try{
      let requests=0,missing=false;
      page.on("request",request=>{if(new URL(request.url()).pathname.endsWith("/cnn-fear-greed.json"))requests++;});
      if(!live){
        await page.clock.setFixedTime(fixed);
        await page.route("**/*",route=>{
          const request=new URL(route.request().url());
          if(request.origin!==new URL(url).origin)return route.abort();
          const name=request.pathname.slice(new URL(url).pathname.length)||"index.html";
          if(name==="cnn-fear-greed.json")return route.fulfill({json:{...artifact,history:missing?undefined:artifact.history}});
          const file=path.resolve(out,name);
          if(!file.startsWith(out+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return route.fulfill({status:404,body:""});
          return route.fulfill({path:file});
        });
      }
      await page.goto(url,{waitUntil:"domcontentloaded"});
      const home=page.locator("#homeCnnCard");
      await home.tap({timeout:45000});
      const card=page.locator("#cnnFearGreedPanel"),toggle=card.locator(".cnnHistoryToggle"),panel=card.locator(".cnnHistoryPanel");
      const score=card.locator("[data-cnn-value]");
      await page.waitForFunction(()=>document.querySelector("#cnnFearGreedPanel [data-cnn-value]")?.textContent!=="—"&&!!document.querySelector("#cnnFearGreedPanel [data-cnn-gauge]:not([data-empty=true])"));
      assert.equal(await toggle.getAttribute("aria-expanded"),"false");
      const initialWidth=await page.evaluate(()=>document.documentElement.scrollWidth);
      const start=requests;
      await score.tap();
      assert.equal(await toggle.getAttribute("aria-expanded"),"true");
      assert.equal(await panel.locator("tbody tr").count(),10);
      const rows=await panel.locator("tbody tr").evaluateAll(nodes=>nodes.map(row=>({date:row.querySelector("time").dateTime,score:row.cells[1].textContent,change:row.cells[2].textContent,tone:row.cells[2].dataset.tone})));
      assert.ok(rows.every((row,i)=>i===0||row.date<rows[i-1].date));
      if(!live){
        assert.deepEqual(rows.map(r=>r.date),sessions.slice(1).reverse().map(r=>r.date));
        assert.equal(rows[0].score,"15.7");
        assert.equal(rows[1].tone,"flat");
        assert.equal(rows[9].change,"+5.9");
      }
      const geometry=await panel.evaluate(el=>({right:el.getBoundingClientRect().right,panelScroll:el.scrollWidth,panelWidth:el.clientWidth,viewport:document.documentElement.clientWidth,documentWidth:document.documentElement.scrollWidth}));
      assert.ok(geometry.right<=geometry.viewport+1&&geometry.panelScroll<=geometry.panelWidth+1&&geometry.documentWidth<=Math.max(geometry.viewport,initialWidth)+1,JSON.stringify({initialWidth,...geometry}));
      await toggle.tap();
      assert.ok(!await panel.isVisible());
      await card.locator("svg").tap();
      assert.ok(await panel.isVisible());
      if(!live)assert.equal(requests,start,"disclosure must not cause a new data request");
      if(!live&&width===390){
        missing=true;
        await card.locator("[data-cnn-refresh]").tap();
        await panel.getByText("暫無完整且已驗證的歷史紀錄。儀表板不受影響。").waitFor();
        assert.equal(await score.textContent(),"20.7");
      }
      console.log("PASS",name,width,live?JSON.stringify(rows):"disclosure, verified dates, no overflow or extra request");
    }finally{await page.close();}
  }}finally{await browser.close();}
}})().catch(error=>{console.error(error);process.exitCode=1;});
