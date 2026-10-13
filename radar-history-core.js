/* Read-only chart contracts. No score computation, research or intraday fallback. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HSRadarHistory=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const RANGES=['10D','20D','60D','120D','1Y','ALL'];
  const DEFAULTS={range:'20D',ma5:false,ma10:false,ma20:false,ma60:false,volume:false,thresholds:false,extrema:true,score:true,price:true};
  const finite=v=>typeof v==='number'&&Number.isFinite(v);
  function dateOK(v){return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;}
  function preferences(value){const p={...DEFAULTS};if(RANGES.includes(value?.range))p.range=value.range;for(const key of Object.keys(p))if(key!=='range'&&typeof value?.[key]==='boolean')p[key]=value[key];return p;}
  function calendar(rows,cutoff){if(!dateOK(cutoff)||!Array.isArray(rows)||!rows.length||rows.some(r=>!dateOK(r.date)))throw Error('CALENDAR_INVALID');return [...new Set(rows.map(r=>r.date).filter(d=>d<=cutoff))].sort();}
  function scores(artifact,symbol,contract,completed){
    const rows=[],invalid=[],seen=new Map();
    if(artifact?.schema_version!==1||artifact.core_score_version!==contract.LONG_TERM_CORE_SCORE_VERSION||!Array.isArray(artifact.snapshots))return{rows,invalid:['SCORE_SCHEMA_INVALID']};
    for(const s of artifact.snapshots){
      if(!s||!dateOK(s.date)||!completed(s.date)||s.finalized!==true||s.snapshot_type!=='FINALIZED_CLOSE')continue;
      if(!Array.isArray(s.rows)){invalid.push(s.date);continue;}
      const matches=s.rows.filter(r=>r?.symbol===symbol);if(!matches.length)continue;
      const r=matches[0];if(r.status==='WAIT_NATIVE')continue;
      if(matches.length!==1||!finite(r.final_core_score)||r.final_core_score<0||r.final_core_score>100||r.core_score_version!==contract.LONG_TERM_CORE_SCORE_VERSION||!String(r.data_as_of||'').startsWith(s.date+'T')||s.source?.status!=='official_closing_data'||!s.source?.provider){invalid.push(s.date);continue;}
      const row={time:s.date,value:r.final_core_score,tier:contract.labelFor(r.final_core_score).label,version:r.core_score_version,asOf:r.data_as_of,updatedAt:s.finalized_at||null,source:s.source.provider};
      if(seen.has(s.date)&&JSON.stringify(seen.get(s.date))!==JSON.stringify(row)){invalid.push(s.date);continue;}seen.set(s.date,row);
    }
    for(const row of [...seen.values()].sort((a,b)=>a.time.localeCompare(b.time)))if(!invalid.includes(row.time))rows.push({...row,delta:rows.length?row.value-rows.at(-1).value:null});
    return{rows,invalid};
  }
  function prices(input,symbol,dates,cutoff,fetchedAt){
    const sessions=new Set(dates),seen=new Map(),invalid=[];
    if(!Array.isArray(input)||!dateOK(cutoff)||!Number.isFinite(Date.parse(fetchedAt)))throw Error('PRICE_SCHEMA_INVALID');
    for(const r of input){
      if(dateOK(r.date)&&r.date>cutoff)continue; // Never render an unfinished daily bar.
      const values=[r.open,r.max,r.min,r.close],volume=r.Trading_Volume;
      if(r.stock_id!==symbol||!dateOK(r.date)||!sessions.has(r.date)||values.some(v=>!finite(v)||v<=0)||r.min>Math.min(r.open,r.close)||r.max<Math.max(r.open,r.close)||r.min>r.max||!finite(volume)||volume<0||!Number.isInteger(volume)){invalid.push(r.date||'INVALID_DATE');continue;}
      const row={time:r.date,open:r.open,high:r.max,low:r.min,close:r.close,volume,source:'FinMind/TaiwanStockPrice',priceType:'RAW_UNADJUSTED',fetchedAt,status:'VERIFIED'};
      if(seen.has(r.date)&&JSON.stringify(seen.get(r.date))!==JSON.stringify(row)){invalid.push(r.date);continue;}seen.set(r.date,row);
    }
    return{rows:[...seen.values()].filter(r=>!invalid.includes(r.time)).sort((a,b)=>a.time.localeCompare(b.time)),invalid};
  }
  function dividends(input,symbol,dates){
    const sessions=new Set(dates);return(Array.isArray(input)?input:[]).filter(r=>r.stock_id===symbol&&dateOK(r.date)&&sessions.has(r.date)&&r.stock_or_cache_dividend==='息'&&finite(r.stock_and_cache_dividend)&&r.stock_and_cache_dividend>0).map(r=>({time:r.date,amount:r.stock_and_cache_dividend,source:'FinMind/TaiwanStockDividendResult'}));
  }
  function axis(dates,scoreRows,priceRows){const first=[scoreRows[0]?.time,priceRows[0]?.time].filter(Boolean).sort()[0],last=[scoreRows.at(-1)?.time,priceRows.at(-1)?.time].filter(Boolean).sort().at(-1);return first?dates.filter(d=>d>=first&&d<=last):[];}
  function segments(dates,rows,key='value'){
    const byDate=new Map(rows.map(r=>[r.time,r])),out=[];let segment=[];
    for(const time of dates){const r=byDate.get(time);if(r&&finite(r[key]))segment.push({time,value:r[key]});else if(segment.length){out.push(segment);segment=[];}}
    if(segment.length)out.push(segment);return out;
  }
  function movingAverage(dates,rows,period){
    const byDate=new Map(rows.map(r=>[r.time,r])),out=[],queue=[];let sum=0;
    for(const time of dates){const r=byDate.get(time);if(!r){queue.length=0;sum=0;continue;}queue.push(r.close);sum+=r.close;if(queue.length>period)sum-=queue.shift();if(queue.length===period)out.push({time,value:sum/period});}
    return out;
  }
  function range(dates,choice){if(!dates.length)return null;const to=dates.length-1;if(choice==='ALL')return{from:0,to};if(choice==='1Y'){const d=new Date(dates[to]+'T00:00:00Z');d.setUTCFullYear(d.getUTCFullYear()-1);const start=d.toISOString().slice(0,10);return{from:Math.max(0,dates.findIndex(v=>v>=start)),to};}const n=Number(choice.replace('D',''));return{from:Math.max(0,to-n+1),to};}
  function extrema(dates,scoreRows,priceRows,visible){
    if(!visible||!finite(visible.from)||!finite(visible.to))return null;
    // LWC logical coordinates can differ from an integer by a few floating-point
    // rounding units (e.g. 0 -> 2.27e-13 on a 1813-day axis). Snap only that noise;
    // genuinely fractional viewport boundaries still exclude offscreen centers.
    const tolerance=Number.EPSILON*Math.max(1,dates.length,Math.abs(visible.from),Math.abs(visible.to))*8;
    const snap=v=>Math.abs(v-Math.round(v))<=tolerance?Math.round(v):v;
    const from=Math.min(dates.length,Math.max(0,Math.ceil(snap(visible.from)))),to=Math.min(dates.length,Math.max(0,Math.floor(snap(visible.to))+1));
    const selected=dates.slice(from,Math.max(from,to)),set=new Set(selected),s=scoreRows.filter(r=>set.has(r.time)),p=priceRows.filter(r=>set.has(r.time));
    const pick=(rows,key,high)=>rows.reduce((a,b)=>!a||(high?b[key]>a[key]:b[key]<a[key])?b:a,null);
    return{sessions:selected.length,firstVisibleDate:selected[0]||null,lastVisibleDate:selected.at(-1)||null,scoreCount:s.length,priceCount:p.length,scoreHigh:pick(s,'value',true),scoreLow:pick(s,'value',false),priceHigh:pick(p,'high',true),priceLow:pick(p,'low',false)};
  }
  function detail(time,dates,scoreRows,priceRows,events){const score=scoreRows.find(r=>r.time===time)||null,price=priceRows.find(r=>r.time===time)||null,previousDate=dates[dates.indexOf(time)-1],previous=priceRows.find(r=>r.time===previousDate),change=price&&previous?price.close-previous.close:null;return{time,score,price,change,returnPct:change===null?null:change/previous.close*100,dividends:events.filter(r=>r.time===time)};}
  return{RANGES,DEFAULTS,finite,dateOK,preferences,calendar,scores,prices,dividends,axis,segments,movingAverage,range,extrema,detail};
});
