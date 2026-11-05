/* Descriptive statistics only. No score, trading authority or financial storage. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HSLC4RadarV2=api;})(typeof globalThis==='object'?globalThis:this,()=>{'use strict';
 const policy=Object.freeze({strategy:'HS_LEVERAGE_C_V1',velocity:2.033335,trainingEnd:'2025-12-31',from:'2026-01-01',to:'2026-12-31',version:'HS_LEVERAGE_C_V1_THRESHOLD_2026_TRAIN_END_2025-12-31'});
 // Existing Stage2 predeclared annual-C95 cohort; NEVER reselect by V2 outcomes.
 const dates=Object.freeze(['2018-02-06','2018-10-08','2020-01-30','2020-09-24','2021-01-29','2021-10-04','2022-03-08','2022-07-01','2022-10-13','2024-04-19','2024-08-05','2025-03-31','2026-03-04','2026-06-29','2026-10-15']);
 const require=(v,n)=>{if(!v)throw Error(n);},finite=x=>typeof x==='number'&&Number.isFinite(x);
 const median=a=>a.length?(a=[...a].sort((x,y)=>x-y),a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2):null;
 function validate(rows,asof){require(Array.isArray(rows)&&rows.length>0,'HISTORY_MISSING');let prev='';for(const r of rows){require(/^\d{4}-\d{2}-\d{2}$/.test(r.date)&&r.date>prev&&r.date<=asof,'HISTORY_DATE');require(['open','high','low','close'].every(k=>finite(r[k])&&r[k]>0)&&r.low<=Math.min(r.open,r.close)&&r.high>=Math.max(r.open,r.close),'HISTORY_OHLC');prev=r.date;}require(prev===asof,'HISTORY_ASOF');}
 function path(rows,index,h){require(Number.isInteger(index)&&index>=0&&Number.isInteger(h)&&h>0,'PATH_ARGUMENT');if(index+h>=rows.length)return null;
  const trigger=rows[index],window=rows.slice(index+1,index+h+1),high=Math.max(...window.map(r=>r.high)),low=Math.min(...window.map(r=>r.low));
  return {date:trigger.date,horizon:h,endDate:window.at(-1).date,endReturn:window.at(-1).close/trigger.close-1,highReturn:high/trigger.close-1,mae:Math.min(0,low/trigger.close-1),breakLow:low<trigger.low,peakDay:window.findIndex(r=>r.high===high)+1};
 }
 function summarize(paths,pending){const n=paths.length,k=paths.filter(x=>x.endReturn>0).length;return {n,pending,up:k,upFraction:n?k/n:null,endMedian:median(paths.map(x=>x.endReturn)),highMedian:median(paths.map(x=>x.highReturn)),touch:Object.fromEntries([5,10,15].map(p=>[p,{count:paths.filter(x=>x.highReturn>=p/100).length,n}])),breakLow:paths.filter(x=>x.breakLow).length,maeMedian:median(paths.map(x=>x.mae)),worst:paths.length?paths.reduce((a,b)=>a.mae<=b.mae?a:b):null,paths};}
 function threshold(return5,asof,today,usable=true){const velocity=finite(return5)?Math.max(0,-return5*100)/5:null;
  const expired=!today||today>policy.to||today<policy.from||asof<policy.from||asof>policy.to;
  return {velocity,linePct:-policy.velocity*5,gapPP:velocity===null?null:(velocity-policy.velocity)*5,state:expired?'EXPIRED':!usable||velocity===null?'INSUFFICIENT':velocity>=policy.velocity?'REACHED':'BELOW',entryAuthorized:false};}
 function describe(history){require(history?.model==='STAGE3_FIXED_DESCRIPTIVE_V1','FIXED_MODEL_REQUIRED');const rows=history.histories?.['00631L'];validate(rows,history.asof);
  require(Array.isArray(history.fixed_events)&&history.fixed_events.length===dates.length&&history.fixed_events.every((e,i)=>e.id==='EVENT:'+dates[i]&&e.date===dates[i]),'FIXED_COHORT_CHANGED');
  const indices=dates.map(d=>rows.findIndex(r=>r.date===d));require(indices.every((v,i)=>v>=0&&(!i||v-indices[i-1]>=70)),'EVENT_MISSING_OR_OVERLAPPING');
  const horizons={};for(const h of[5,10,20]){const paths=indices.map(i=>path(rows,i,h)).filter(Boolean);horizons[h]=summarize(paths,dates.length-paths.length);}
  const n=horizons[20].n,peak=[0,0,0];for(const p of horizons[20].paths)peak[p.peakDay<=5?0:p.peakDay<=10?1:2]++;
  const last=rows.at(-1),return5=rows.length>5?last.close/rows.at(-6).close-1:null;
  const drawdown=h=>rows.length>=h?last.close/Math.max(...rows.slice(-h).map(r=>r.close))-1:null;
  const byYear={};for(const d of dates){const year=d.slice(0,4);byYear[year]??={events:0,horizons:{}};byYear[year].events++;}
  for(const[year,y]of Object.entries(byYear))for(const h of[5,10,20]){const ps=horizons[h].paths.filter(p=>p.date.startsWith(year));y.horizons[h]=summarize(ps,y.events-ps.length);}
  return {schema:'HS_LC4_DESCRIPTIVE_STATS_V2',asof:history.asof,close:last.close,return5,dd120:drawdown(120),dd240:drawdown(240),cohortCount:dates.length,horizons,peak20:{n,counts:peak,fractions:peak.map(k=>n?k/n:null),tieRule:'EARLIEST_SESSION'},byYear,entryAuthorized:false,score:null};
 }
 return Object.freeze({policy,dates,validate,path,summarize,threshold,describe});
});
