"use strict";
const assert=require("node:assert/strict"), fs=require("node:fs"), path=require("node:path");
const {chromium,webkit}=require("playwright-core");
const archive=require("../finalized-core-score-snapshots-v1.json");
const observations=require("../data/c4-close-observations-v1.json");
const adjusted=require("../backtest/long-term/historical-adjusted.json");
const raw0050=require("../research/c4_historical/source/0050.json");
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
        const readout=page.locator(".radarHistoryReadout");
        assert.equal(await readout.locator("time").getAttribute("datetime"),"2026-11-17");
        assert.match(await readout.innerText(),/原始收盤 —/);
        assert.ok((await readout.boundingBox()).y+(await readout.boundingBox()).height<=(await canvas.boundingBox()).y);
        const bounds=await page.evaluate(()=>HSRadarHistoryView.layoutDiagnostics().chart.paneBounds);
        for(const [pane,{height,top,bottom}] of Object.entries(bounds)){
          assert.ok(Number.isFinite(top)&&top>=24&&bottom<=height-24&&bottom>top,pane+JSON.stringify(bounds));
        }
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
          assert.equal(await readout.locator("time").getAttribute("datetime"),point.date);
          assert.match(await readout.innerText(),/獨立收盤觀察｜非正式 FINAL/);
          assert.match(await readout.innerText(),/原始收盤 49/);
        }
        if(points.length){
          const first=points[0],b=await canvas.boundingBox();
          await page.touchscreen.tap(b.x+first.x,b.y+bounds.score.height+100);
          await readout.locator('time[datetime="'+first.date+'"]').waitFor();
          assert.match(await readout.innerText(),/原始收盤 49/);
          assert.match(await readout.innerText(),/漲跌 [→+−-]?0/);
        }
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
        console.log(engine.name(),symbol,"390px direct points PASS");
      }
      // Replay the two archived price bases through the actual UI. No live data
      // claim: official raw history and the repository's adjusted OHLC research
      // snapshot are separate fixtures. The split must never be a false return.
      const interval=['2025-06-10','2025-06-18'],sourceRows=raw0050.price.filter(r=>interval.includes(r.date)),adjustedRows=adjusted.items['0050'].rows.filter(r=>interval.includes(r.date));
      assert.equal(adjusted.metadata.price_basis,'Adjusted OHLC');assert.equal(sourceRows.length,2);assert.equal(adjustedRows.length,2);
      assert.ok(Math.abs((adjustedRows[1].close/adjustedRows[0].close)-(sourceRows[1].close/sourceRows[0].close))>.5);
      for(const complete of [true,false]){
        await page.reload();
        await page.evaluate(async ({interval,sourceRows,adjustedRows,complete})=>{
          window.HSRadarHistorySource={Source:class{cache=new Map();async sessions(){return {dates:interval};}
            async year(){return {rows:sourceRows.map(r=>({time:r.date,open:r.open,high:r.max,low:r.min,close:r.close,volume:r.Trading_Volume})),events:[],invalid:[],dividendStatus:"VERIFIED"};}}};
          const h=document.querySelector('#host');h.setAttribute('data-luxury-gold','');h.innerHTML=HSRadarHistoryView.html('0050');
          await HSRadarHistoryView.mount(h.firstElementChild,{symbol:'0050',name:'0050',artifact:null,contract:HSFinalCoreProduction,thresholds:[],completed:()=>true,adjustedRows:complete?adjustedRows:adjustedRows.slice(0,1)});
        },{interval,sourceRows,adjustedRows,complete});
        const panel=page.locator('[data-radar-history=\'0050\']');
        await panel.locator('.radarHistoryCustom summary').click();
        await panel.locator('[data-custom-start]').fill(interval[0]);
        await panel.locator('[data-custom-end]').fill(interval[1]);
        await panel.locator('[data-history-action=custom]').click();
        if(complete){
          const result=100*(adjustedRows[1].close/adjustedRows[0].close-1);
          const actual=await panel.locator('[data-gold-interval]').innerText();
          assert.ok(actual.includes('還原價格 '+(result>0?'+':'')+result.toFixed(2)+'%'),JSON.stringify({actual,result,status:await panel.locator('.radarHistoryStatus').innerText(),custom:await panel.locator('[data-custom-status]').innerText()}));
        }else assert.match(await panel.locator('[data-gold-interval]').innerText(),/還原價格 資料不足/);
        assert.match(await panel.locator('.radarHistoryReadout').innerText(),new RegExp('原始收盤 '+String(sourceRows.at(-1).close).replace('.','\\.')));
      }
      assert.deepEqual(errors,[]);
    }finally{await browser.close();}
  }
}
run().catch(e=>{console.error(e);process.exitCode=1;});
