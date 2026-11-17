"use strict";
const fs=require("node:fs"),assert=require("node:assert/strict"),{chromium,webkit}=require("playwright-core");
const archive=require("../data/c4-close-observations-v1.json");
const assets=["vendor/lightweight-charts/lightweight-charts.standalone.production.js","radar-history-core.js","backtest/long-term/final-core-score-v1.js","strategy-mode-core.js","final-core-production.js","c4-display.js","radar-history-view.js"];
const days=archive.sessions.map(x=>x.date);
async function run(){
 for(const [name,engine] of [["chromium",chromium],["webkit",webkit]]){
  const browser=await engine.launch(name==="chromium"?{executablePath:"C:/Program Files/Google/Chrome/Application/chrome.exe"}:{});
  try{
   const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
   await page.clock.setFixedTime(new Date("2026-11-17T11:00:00Z"));
   page.on("pageerror",e=>console.error(name,e.message));
   await page.route("http://fixture.test/**",route=>{
    const p=new URL(route.request().url()).pathname;
    if(p==="/")return route.fulfill({contentType:"text/html; charset=utf-8",body:'<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/radar-history.css"><main id="host"></main>'+assets.map(a=>'<script src="/'+a+'"></script>').join("")});
    if(p==="/data/c4-close-observations-v1.json")return route.fulfill({json:{...archive,sessions:archive.sessions.slice(0,visible)}});
    if(assets.includes(p.slice(1))||p==="/radar-history.css")return route.fulfill({path:require("node:path").join(__dirname,"..",p.slice(1)),
      contentType:p.endsWith(".css")?"text/css; charset=utf-8":"text/javascript; charset=utf-8"});
    return route.abort();
   });
   let visible=2;
   const open=async()=>{await page.goto("http://fixture.test/");await page.evaluate(async dates=>{
    const h=document.querySelector("#host");
    HSRadarHistorySource={Source:class{cache=new Map();async sessions(){return {dates};}async year(){return {rows:dates.map(time=>({time,open:48,high:50,low:47,close:49,volume:100})),events:[],invalid:[],dividendStatus:"VERIFIED"};}}};
    h.innerHTML=HSRadarHistoryView.html("00935");
    await HSRadarHistoryView.mount(h,{symbol:"00935",name:"00935",artifact:{snapshots:[]},contract:HSFinalCoreProduction,thresholds:[],completed:()=>true});
   },days);};
   await open();
   await page.locator('[data-observation-date="2026-11-12"]').waitFor({timeout:3000}).catch(async error=>{
    console.error(await page.evaluate(()=>({now:String(new Date()),legend:document.querySelector(".radarObservationLegend")?.outerHTML,
      status:document.querySelector(".radarHistoryStatus")?.textContent,chart:!!window.LightweightCharts,production:!!window.HSFinalCoreProduction})));throw error;
   });
   visible=4;
   await page.evaluate(()=>dispatchEvent(new Event("pageshow")));
   await page.locator('[data-observation-date="2026-11-16"]').waitFor();
   await page.locator('[data-observation-date="2026-11-16"]').click();
   await page.waitForFunction(()=>document.querySelector(".radarHistoryDetail")?.textContent.includes("84.6"));
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
   await open();
   await page.locator('[data-observation-date="2026-11-16"]').waitFor();
   console.log(name,"390px chart, date selection, foreground refresh, reopening PASS");
  }finally{await browser.close();}
 }
}
run().catch(e=>{console.error(e);process.exitCode=1;});
