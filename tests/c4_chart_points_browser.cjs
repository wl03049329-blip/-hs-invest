"use strict";
const assert=require("node:assert/strict"), fs=require("node:fs"), path=require("node:path");
const {chromium,webkit}=require("playwright-core");
const archive=require("../finalized-core-score-snapshots-v1.json");
const observations=require("../data/c4-close-observations-v1.json");
const assets=["vendor/lightweight-charts/lightweight-charts.standalone.production.js","radar-history-core.js",
  "backtest/long-term/final-core-score-v1.js","strategy-mode-core.js","final-core-production.js","c4-display.js","radar-history-view.js"];
const dates=["2026-11-10",...observations.sessions.map(s=>s.date),"2026-11-17"];
async function run(){
  for(const engine of (process.env.HS_CHROME_ONLY==="1"?[chromium]:[chromium,webkit])){
    const browser=await engine.launch(engine===chromium?{channel:"chrome"}:{});
    try{
      const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
      await page.clock.setFixedTime(new Date("2026-11-17T11:00:00Z"));
      const errors=[];page.on("pageerror",e=>errors.push(e.message));
      await page.route("http://c4-chart.test/**",route=>{
        const name=new URL(route.request().url()).pathname.slice(1);
        if(!name)return route.fulfill({contentType:"text/html; charset=utf-8",body:
          '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/radar-history.css"><main id="host"></main>'+assets.map(a=>'<script src="/'+a+'"></script>').join("")});
        if(name==="data/c4-close-observations-v1.json")return route.fulfill({json:observations});
        if(assets.includes(name)||name==="radar-history.css")return route.fulfill({body:fs.readFileSync(path.join(__dirname,"..",name)),contentType:name.endsWith(".css")?"text/css":"text/javascript"});
        return route.abort();
      });
      await page.goto("http://c4-chart.test/");
      for(const symbol of ["0050","00757","00830","00935","00662"]){
        await page.evaluate(async ({dates,archive,symbol})=>{
          HSRadarHistoryView.unmount();
          window.HSRadarHistorySource={Source:class{cache=new Map();async sessions(){return {dates:dates.slice(0,-1)};}
            async year(s){return {rows:dates.slice(0,-1).filter(d=>s!=="00662"||d===dates[0]).map(time=>({time,open:48,high:50,low:47,close:49,volume:100})),events:[],invalid:[],dividendStatus:"VERIFIED"};}}};
          const h=document.querySelector("#host");h.innerHTML=HSRadarHistoryView.html(symbol);
          await HSRadarHistoryView.mount(h,{symbol,name:symbol,artifact:archive,contract:HSFinalCoreProduction,thresholds:[],completed:()=>true});
        },{dates,archive:{...archive,snapshots:archive.snapshots.filter(s=>dates.includes(s.date))},symbol});
        await page.locator(".radarObservationLegend").waitFor({state:"visible"});
        assert.equal(await page.locator(".radarObservationLegend button").count(),0);
        const canvas=page.locator(".radarHistoryCanvas");
        const settled=await page.waitForFunction(()=>document.querySelector(".radarHistoryCanvas")?.dataset.selectionDate==="2026-11-17");
        await settled.dispose();
        const expected=archive.snapshots.find(s=>s.date==="2026-11-17").rows.find(r=>r.symbol===symbol).final_core_score;
        assert.equal(Number(await canvas.getAttribute("data-selected-c4")),expected);
        const points=await page.evaluate(()=>HSRadarHistoryView.layoutDiagnostics().chart.observationPoints);
        assert.equal(points.length,symbol==="00662"?0:4);
        for(const day of points.map(p=>p.date)){
          await canvas.scrollIntoViewIfNeeded();
          const point=await page.evaluate(day=>HSRadarHistoryView.layoutDiagnostics().chart.observationPoints.find(p=>p.date===day),day);
          const b=await canvas.boundingBox();
          assert.ok(point.x>0&&point.x<b.width-40&&point.y>0&&point.y<230,JSON.stringify(point));
          await page.touchscreen.tap(b.x+point.x,b.y+point.y);
          await page.locator('.radarHistoryDetail time[datetime="'+point.date+'"]').waitFor();
          const text=await page.locator(".radarHistoryDetail").innerText();
          assert.ok(text.includes("獨立收盤觀察｜非正式 FINAL"));
          assert.ok(text.includes(observations.sessions.find(s=>s.date===point.date).symbols[symbol].score.toFixed(1)));
        }
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
        console.log(engine.name(),symbol,"390px direct points PASS");
      }
      assert.deepEqual(errors,[]);
    }finally{await browser.close();}
  }
}
run().catch(e=>{console.error(e);process.exitCode=1;});
