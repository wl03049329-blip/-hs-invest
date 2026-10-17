"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm");
const G=require("../cnn-gauge"),freshness=require("../data-freshness-core");
const html=fs.readFileSync("index.html","utf8"),css=fs.readFileSync("formal-black-gold.css","utf8"),fixture=require("./fixtures/cnn-gauge-20261016.json").payload;
let passed=0;
function check(name,fn){fn();passed++;console.log("PASS "+name);}
function extract(name){
 const marker="function "+name+"(",index=html.indexOf(marker);assert.ok(index>=0,name);
 const start=html.slice(index-6,index)==="async "?index-6:index;
 const candidates=["\nfunction ","\nasync function "].map(m=>html.indexOf(m,index+marker.length)).filter(i=>i>=0);
 return html.slice(start,Math.min(...candidates));
}
let now=Date.parse("2026-10-17T04:00:00Z"),calls=0,timers=[],renders=0;
class FixedDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
const sandbox={Date:FixedDate,Intl,URL,Number,console,HSDataFreshnessCore:freshness,document:{hidden:false},fetch:async()=>{calls++;return{ok:true,json:async()=>structuredClone(fixture)};},setTimeout:(fn,delay)=>{timers.push({fn,delay});return timers.length;},clearTimeout(){},renderCnnPresentationViews(){},renderCnnDashboard(){},renderHomeCnnGauge(){},renderSentiment(){renders++;}};
vm.createContext(sandbox);
vm.runInContext('let cnnFearGreed=null,cnnGaugeLoadState={phase:"loading",reason:"",kind:""},cnnPollTimer=null,cnnPollInFlight=null,cnnLastAttemptAt=0;const CNN_POLL_INTERVAL=20*60*1000;'+["validSentimentScore","isReasonableTimestamp","formatTaipeiDateTime","cnnSentimentLabel","cnnInterpretation","validateCnnFearGreed","loadCnnFearGreed","scheduleCnnPoll","refreshCnnFearGreed","cnnGaugePresentation"].map(extract).join("\n")+'\nfunction safeTrumpUrl(value){try{const u=new URL(value);return /^https?:$/.test(u.protocol)?u.href:"";}catch{return"";}}',sandbox);
check("gold SVG is native, has five continuous bands and 0–100 major ticks",()=>{
 assert.deepEqual(G.BANDS.map(b=>b.end),[24,44,55,74,100]);
 const svg=G.markup();assert.equal((svg.match(/data-cnn-band=/g)||[]).length,5);
 for(const tick of [0,25,50,75,100])assert.match(svg,new RegExp(">"+tick+"</text>"));
 assert.doesNotMatch(svg,/<img|<image|18\.9|previous.*year/);
 assert.equal((G.markup(true).match(/data-cnn-band=/g)||[]).length,5);
});
check("needle uses full raw value, correct endpoints and midpoint",()=>{
 for(const [value,angle] of [[0,-90],[25,-45],[50,0],[75,45],[100,90],[18.9,-55.98]])assert.ok(Math.abs(G.angle(value)-angle)<1e-9);
 assert.deepEqual(G.point(0,132),{x:48,y:170});assert.deepEqual(G.point(50,132),{x:180,y:38});assert.deepEqual(G.point(100,132),{x:312,y:170});
 for(const value of [null,undefined,"",false,[],NaN,Infinity,-1,101]){assert.equal(G.angle(value),null);assert.equal(G.format(value),"—");}
 assert.equal(G.format(0),"0");assert.equal(G.format(18.9),"18.9");assert.equal(G.comparison(18.9,31.5),"-12.6");assert.equal(G.comparison(null,0),"—");
});
check("missing/blank/boolean/object is not coerced to zero; genuine zero is valid",()=>{
 for(const value of [null,undefined,"","  ",false,true,[],{},NaN,Infinity,-1,101])assert.equal(sandbox.validSentimentScore(value),null);
 for(const value of [0,"0",18.9,"18.9",100])assert.equal(sandbox.validSentimentScore(value),Number(value));
 for(const key of ["score","day","week","month"]){
  const p=structuredClone(fixture);if(key==="score")p.score=null;else p.previous[key]=null;
  assert.equal(sandbox.validateCnnFearGreed(p),null,"existing all-required validation remains intact: "+key);
 }
});
check("all 5 bands match the existing CNN classifier at decimal boundaries",()=>{
 for(const score of [0,24,24.01,44,44.01,55,55.01,74,74.01,100])assert.equal(G.BANDS.find(b=>score<=b.end).label,sandbox.cnnSentimentLabel(score));
 const p=sandbox.validateCnnFearGreed(fixture);assert.equal(p.score,18.9);assert.equal(p.label,"極度恐懼");assert.equal(p.day,31.5);assert.equal(p.week,46.5);assert.equal(p.month,27.3);
 sandbox.p=p;vm.runInContext('cnnFearGreed=p;cnnGaugeLoadState={phase:"ready"}',sandbox);
 assert.equal(sandbox.cnnGaugePresentation().state,"current");
});
check("stale and expired cached data are never advertised as current",()=>{
 const p=structuredClone(fixture);p.source_updated_at="2026-10-11T18:05:59Z";p.updated_at="2026-10-16T18:11:58Z";
 const validated=sandbox.validateCnnFearGreed(p);assert.ok(validated);
 sandbox.p=validated;vm.runInContext("cnnFearGreed=p;cnnGaugeLoadState={phase:'ready'}",sandbox);assert.equal(sandbox.cnnGaugePresentation().state,"stale");
 const before=JSON.stringify(validated);now+=12*86400000;assert.equal(sandbox.cnnGaugePresentation().state,"expired");assert.equal(sandbox.cnnGaugePresentation().cnn,null);assert.equal(JSON.stringify(validated),before);
 now=Date.parse("2026-10-17T04:00:00Z");
});
check("homepage still has six cards and only CNN gets the dial; focused mood navigation",()=>{
 const cards=html.slice(html.indexOf('id="homeSentimentCards"'),html.indexOf('id="homeSentimentDetails"'));
 assert.equal((cards.match(/data-home-chip=/g)||[]).length,6);assert.equal((cards.match(/data-cnn-mini/g)||[]).length,1);
 assert.match(html,/id="cnnFearGreedPanel"[^>]*tabindex="-1"/);assert.match(html,/id="cnnGaugeTitle"/);
 assert.match(html,/data-cnn-refresh/);assert.doesNotMatch(html.slice(html.indexOf("function renderCnnDashboard"),html.indexOf("function openCnnGauge")),/一年|year|previous.*year/);
 assert.match(html,/refreshCnnFearGreed\(\{force:true\}\);\s*initLiveDebugPanel/,"CNN local artifact must not wait for upstream ETF API success");
 assert.match(fs.readFileSync("portfolio-v6.js","utf8"),/if\(typeof renderHomeCnnGauge==="function"\)renderHomeCnnGauge\(\)/,"legacy homepage renderer must not round over CNN's selected presentation");
 const events=[],panel={focus:v=>events.push(["focus",v]),scrollIntoView:v=>events.push(["scroll",v])},ctx={switchTab:(...a)=>events.push(["tab",...a]),switchChipTab:(...a)=>events.push(["chip",...a]),requestAnimationFrame:f=>f(),matchMedia:()=>({matches:true}),$:()=>panel};
 vm.createContext(ctx);vm.runInContext(extract("openCnnGauge"),ctx);ctx.openCnnGauge({stopPropagation:()=>events.push(["stop"])});
 assert.equal(events[1][1],"sentiment");assert.equal(events[2][1],"mood");assert.equal(events.at(-1)[1].behavior,"auto");assert.equal(events.at(-1)[1].block,"start");
 assert.match(css,/\.cnnGaugeNeedle\{[^}]*transform-origin:180px 170px/);assert.match(css,/@media\(prefers-reduced-motion:reduce\)\{\.cnnGaugeNeedle/);
});
check("market overview requires each Taiwan input; CNN never substitutes for missing chips",()=>{
 const complete={values:{financingPrincipal:2e11,maintenanceRatio:165},marginStatus:"LATEST",futures:{foreign_tx:{net:0},estimated_non_institutional_tmf:{long:100,short:120}},futuresStatus:"LATEST",cnnView:{cnn:{score:18.9,label:"極度恐懼"},status:"最新資料"}};
 assert.equal(G.marketCoverage(complete).value,"資料齊備");
 for(const [section,key,name] of [["values","financingPrincipal","台股融資"],["values","maintenanceRatio","維持率"],["foreign_tx","net","外資期貨"],["estimated_non_institutional_tmf","short","散戶部位"]]){
  const input=structuredClone(complete),target=input[section]||input.futures[section];target[key]=null;
  const view=G.marketCoverage(input);assert.equal(view.value,"資料不足");assert.deepEqual(view.missing,[name]);assert.match(view.text,/美股 CNN 18\.9/);assert.doesNotMatch(view.text,/融資壓力中性|市場情緒偏恐懼|等待回檔|低檔分批/);
 }
 for(const status of ["STALE","FAILED","FALLBACK","WAITING",undefined]){
  const input=structuredClone(complete);input.marginStatus=status;assert.equal(G.marketCoverage(input).value,"資料待更新");
 }
 for(const bad of [null,undefined,NaN,Infinity,-1]){const input=structuredClone(complete);input.values.maintenanceRatio=bad;assert.equal(G.marketCoverage(input).value,"資料不足");}
 for(const [key,value] of [["long",-1],["long",null],["short",0],["short",NaN]]){const input=structuredClone(complete);input.futures.estimated_non_institutional_tmf[key]=value;assert.deepEqual(G.marketCoverage(input).missing,["散戶部位"]);}
 const missing=G.marketCoverage();assert.equal(missing.missing.length,4);assert.match(missing.text,/CNN 資料暫缺/);
 const stale=structuredClone(complete);stale.cnnView.status="更新失敗｜保留最後資料";assert.match(G.marketCoverage(stale).text,/更新失敗/);
 assert.match(extract("combinedSentimentConclusion"),/marketSentimentPresentation\(\)\.text/);
 const legacy=fs.readFileSync("portfolio-v6.js","utf8");assert.match(legacy,/renderMarketSentimentSummary\(\)/);assert.doesNotMatch(legacy,/values\?\.maintenanceRatio<140/);
 assert.match(css,/cnnGaugeBand\[data-active="true"\]/);
});
check("expiry uses current time and the existing single timer, without erasing cache",()=>{
 const originalNow=now,p=sandbox.validateCnnFearGreed(fixture);sandbox.p=p;
 vm.runInContext("cnnFearGreed=p;cnnGaugeLoadState={phase:'ready'}",sandbox);
 now=Date.parse(fixture.updated_at)+7*86400000;
 sandbox.scheduleCnnPoll();assert.equal(timers.at(-1).delay,1,"one deadline wake-up uses existing timer");
 now+=1;assert.equal(sandbox.cnnGaugePresentation().cnn,null);assert.equal(sandbox.cnnGaugePresentation().state,"expired");
 assert.equal(vm.runInContext("cnnFearGreed.score",sandbox),18.9,"retained cache is not destroyed or converted to zero");
 now=originalNow;
 const future=structuredClone(fixture);future.updated_at=future.source_updated_at=new Date(now+7*3600000).toISOString();assert.equal(sandbox.validateCnnFearGreed(future),null);
 assert.match(extract("renderChipOverview"),/cnnView=cnnGaugePresentation\(\),cnn=cnnView\.cnn/);
 for(const name of ["switchTab","switchChipTab","refreshCnnFearGreed"])assert.match(extract(name),/renderCnnPresentationViews\(\)/,name+" must invalidate cached presentation on entry");
});
(async()=>{
 sandbox.p=sandbox.validateCnnFearGreed(fixture);vm.runInContext("cnnFearGreed=p;cnnGaugeLoadState={phase:'ready'}",sandbox);
 assert.equal(await sandbox.loadCnnFearGreed({preserveOnFailure:true}),true);
 sandbox.fetch=async()=>({ok:false,status:503});
 assert.equal(await sandbox.loadCnnFearGreed({preserveOnFailure:true}),false);
 let view=sandbox.cnnGaugePresentation();assert.equal(view.state,"failed");assert.equal(view.cnn.score,18.9);assert.match(view.reason,/503/);
 vm.runInContext("cnnFearGreed=null",sandbox);assert.equal(await sandbox.loadCnnFearGreed(),false);assert.equal(sandbox.cnnGaugePresentation().cnn,null);
 const expired=structuredClone(fixture);expired.updated_at=expired.source_updated_at="2026-09-01T00:00:00Z";
 sandbox.fetch=async()=>({ok:true,json:async()=>expired});
 assert.equal(await sandbox.loadCnnFearGreed(),false);view=sandbox.cnnGaugePresentation();assert.equal(view.state,"expired");assert.equal(view.cnn,null);assert.equal(view.sourceUpdatedAt,expired.source_updated_at);
 console.log("PASS fetch failure preserves only prior valid data; rejected stale timestamps remain visible without a fake score");passed++;
 calls=0;timers=[];sandbox.fetch=async(url,options)=>{calls++;assert.match(url,/cnn-fear-greed\.json\?ts=/);assert.equal(options.cache,"no-store");return{ok:true,json:async()=>fixture};};
 assert.equal(await sandbox.refreshCnnFearGreed({force:true}),true);assert.equal(calls,1);assert.equal(timers.at(-1).delay,20*60*1000);
 assert.equal(await sandbox.refreshCnnFearGreed(),false);assert.equal(calls,1);
 await sandbox.refreshCnnFearGreed({force:true});assert.equal(calls,2);assert.equal(sandbox.cnnGaugePresentation().state,"current");
 sandbox.document.hidden=true;assert.equal(await sandbox.refreshCnnFearGreed({force:true}),false);assert.equal(calls,2);
 sandbox.document.hidden=false;let resolve;const pending=new Promise(r=>resolve=r);sandbox.fetch=async()=>{calls++;await pending;return{ok:true,json:async()=>fixture};};
 const one=sandbox.refreshCnnFearGreed({force:true}),two=sandbox.refreshCnnFearGreed({force:true});resolve();await Promise.all([one,two]);assert.equal(calls,3);
 console.log("PASS original single-flight/20-minute/background/force-refresh lifecycle");passed++;
 sandbox.p=sandbox.validateCnnFearGreed(fixture);vm.runInContext("cnnFearGreed=p;cnnGaugeLoadState={phase:'ready'}",sandbox);
 now=Date.parse(fixture.updated_at)+7*86400000-100;
 vm.runInContext("cnnLastAttemptAt=Date.now()",sandbox);
 let invalidations=0;sandbox.renderCnnPresentationViews=()=>{invalidations++;};
 sandbox.scheduleCnnPoll();const deadlineWake=timers.at(-1);assert.equal(deadlineWake.delay,101);
 now+=102;const priorCalls=calls;await deadlineWake.fn();
 assert.equal(sandbox.cnnGaugePresentation().state,"expired");assert.ok(invalidations>0,"deadline callback updates presentation even if fetch is throttled");assert.equal(calls,priorCalls);
 console.log("PASS passive deadline invalidation uses one timer and does not bypass request throttling");passed++;
 console.log("CNN gauge: "+passed+"/"+passed+" groups PASS");
})().catch(error=>{console.error(error);process.exitCode=1});
