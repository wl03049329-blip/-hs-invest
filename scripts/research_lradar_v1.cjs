"use strict";
// Offline, read-only research. The sole candidate and comparisons are fixed below.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const radar=require("../lradar-core");
const root=path.join(__dirname,"..","data","lc4-research");
const frozen={path:"snapshots/2026-11-05-r000003-3f03e5e90739.json",sha:"3f03e5e90739c395f2e85b82fb053d46cff7d8d5e3ccc80ec7ccea7bd07df899"};
const horizons=[1,3,5,10], costs=[0.002,0.005,0.01];
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const group=(items,key)=>items.reduce((m,v)=>{(m[v[key]]??=[]).push(v);return m;},Object.create(null));
function q(a,p){const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.ceil(s.length*p)-1)];}
const median=a=>a.length?(q(a,0.5)+[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)])/2:null;
function checkSplit(rows){
 const before=rows.find(r=>r.date==="2026-03-24"),after=rows.find(r=>r.date==="2026-03-31");
 if(!before||!after||Math.abs(before.close*22-443.15)>1e-8||rows.some(r=>r.date>before.date&&r.date<after.date)||Math.abs(after.close-19.26)>1e-8)throw Error("SPLIT_OR_HALT_EVIDENCE_MISMATCH");
}
function clusterCI(trades){
 const byYear=Object.values(group(trades,"year"));
 if(byYear.length<2)return null;
 let seed=631;
 const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return Math.floor(seed/4294967296*n);};
 const samples=Array.from({length:2000},()=>{const items=Array.from({length:byYear.length},()=>byYear[rand(byYear.length)]).flat();return [mean(items.map(r=>r.net)),mean(items.map(r=>+(r.net>0)))];});
 return {mean:[q(samples.map(r=>r[0]),.025),q(samples.map(r=>r[0]),.975)],positive:[q(samples.map(r=>r[1]),.025),q(samples.map(r=>r[1]),.975)]};
}
function summarize(trades){
 let equity=1,peak=1,mdd=0;
 for(const t of trades){for(const point of t.marks){const mark=equity*(1+point);peak=Math.max(peak,mark);mdd=Math.min(mdd,mark/peak-1);}equity*=1+t.net;}
 const net=trades.map(t=>t.net);
 return {n:net.length,mean:mean(net),median:median(net),positive:mean(net.map(v=>+(v>0))),ci:clusterCI(trades),
   medianMAE:median(trades.map(t=>t.mae)),medianMFE:median(trades.map(t=>t.mfe)),maxDrawdown:trades.length?mdd:null,worst:net.length?Math.min(...net):null,
   byYear:Object.fromEntries(Object.entries(group(trades,"year")).map(([k,v])=>[k,{n:v.length,mean:mean(v.map(x=>x.net))}])),
   byRegime:Object.fromEntries(Object.entries(group(trades,"regime")).map(([k,v])=>[k,{n:v.length,mean:mean(v.map(x=>x.net))}]))};
}
function run(bundle){
 const rows=bundle.history.histories["00631L"],market=bundle.history.histories["0050"];
 const a=radar.describe(rows),b=radar.describe(market);if(a.asof!==bundle.asof||b.asof!==bundle.asof)throw Error("ASOF_CONFLICT");checkSplit(rows);
 const return5=rows.map((r,i)=>i>=5?r.close/rows[i-5].close-1:null);
 const marketByDate=new Map(market.map((r,i)=>[r.date,i])), thresholds={},events=[];let previous=-12;
 for(let i=5;i<rows.length;i++){
  const r=rows[i],year=r.date.slice(0,4);
  if(year<"2018")continue;
  if(!(year in thresholds)){
   const train=return5.slice(5,i).filter(x=>x<0).map(x=>-x);
   thresholds[year]=train.length>=60?{cutoff:rows[i-1].date,n:train.length,threshold:q(train,.95)}:null;
  }
  if(!thresholds[year]||-return5[i]<thresholds[year].threshold||i-previous<12)continue;
  previous=i;const j=marketByDate.get(r.date),next=rows[i+1];
  const sma=j>=119?mean(market.slice(j-119,j+1).map(x=>x.close)):null,rel=sma?market[j].close/sma-1:null;
  events.push({i,date:r.date,year,regime:rel===null?"UNKNOWN":rel>.05?"BULL":rel<-.05?"BEAR":"RANGE",confirm:!!next&&next.low>=r.low&&next.close>r.close});
 }
 function trade(series,start,h,cost,event){
  const window=series.slice(start,start+h),entry=window[0].open;
  const liquidation=close=>(close/entry)*(1-cost/2)/(1+cost/2)-1;
  return {...event,net:liquidation(window.at(-1).close),marks:[liquidation(entry),...window.map(r=>liquidation(r.close))],
    mae:Math.min(0,...window.map(r=>r.low/entry-1)),mfe:Math.max(0,...window.map(r=>r.high/entry-1))};
 }
 const results={};
 for(const h of horizons){
  const mature=events.filter(e=>e.i+1+h<rows.length);
  results[h]={mature:mature.length,pending:events.length-mature.length,byCost:{}};
  for(const cost of costs){
   const crash=[],confirmed=[],matched=[],benchmark=[];
   for(const e of mature){
    const x=trade(rows,e.i+1,h,cost,e);crash.push(x);
    if(!e.confirm)continue;
    const y=trade(rows,e.i+2,h,cost,e);confirmed.push(y);matched.push(x);
    const start=marketByDate.get(rows[e.i+2].date),end=rows[e.i+1+h].date;
    if(start!==undefined&&market[start+h-1]?.date===end)benchmark.push(trade(market,start,h,cost,e));
   }
   results[h].byCost[cost]={crash:summarize(crash),confirmed:summarize(confirmed),matchedCrash:summarize(matched),matched0050:summarize(benchmark),cash:0};
  }
 }
 return {version:radar.version,asof:bundle.asof,source_sha256:frozen.sha,first:rows[0].date,last:rows.at(-1).date,
   rows:rows.length,thresholds,events,results,research_only:true,entry_authorized:false,financial_writer:false,decision:"NO-GO",
   scope:"Exploratory historical replay on already studied data; not fresh prospective OOS. No intraday claim."};
}
function read(){
 const sha=raw=>crypto.createHash("sha256").update(raw).digest("hex");
 let raw=fs.readFileSync(path.join(root,frozen.path));
 if(sha(raw)!==frozen.sha){
  // Windows checkout may convert LF. Use the original Git blob, still SHA-checked.
  const blob=require("node:child_process").execFileSync("git",["show","HEAD:data/lc4-research/"+frozen.path],{cwd:__dirname,maxBuffer:4000000});
  if(!raw.equals(Buffer.from(blob.toString("utf8").replace(/\r?\n/g,"\r\n"))))throw Error("RESEARCH_WORKTREE_CONFLICT");
  raw=blob;
 }
 if(sha(raw)!==frozen.sha)throw Error("RESEARCH_BUNDLE_HASH");
 return JSON.parse(raw);
}
if(require.main===module)console.log(JSON.stringify(run(read()),null,2));
module.exports={run,read,checkSplit};
