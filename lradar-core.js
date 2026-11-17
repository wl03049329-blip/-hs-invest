/* Independent descriptive research. No trading or storage dependencies. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HSLRadar=api;})(globalThis,()=>{'use strict';
 const version='HS_L_RADAR_CRASH_REBOUND_V1';
 const states=Object.freeze({DATA_UNAVAILABLE:'資料不足，暫不判斷',NO_CRASH_SETUP:'尚無急跌機會',CRASH_UNSTABLE:'急跌中，先觀察',REBOUND_RESEARCH_CANDIDATE:'出現反彈研究機會'});
 const unavailable=()=>Object.freeze({strategy_version:version,symbol:'00631L',market_date:null,source_timestamp:null,evaluated_at:null,price_asof:null,source:null,quote_status:'NON_REALTIME',data_health:'UNAVAILABLE',research_state:'DATA_UNAVAILABLE',reason_codes:Object.freeze(['VERIFIED_INTRADAY_OHLCV_NOT_CONFIGURED']),research_only:true,entry_authorized:false,financial_writer:false});
 function describe(rows){
   if(!Array.isArray(rows)||rows.length<120||rows.some((r,i)=>!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(r?.date)||!Number.isFinite(Date.parse(r.date))||new Date(r.date).toISOString().slice(0,10)!==r.date||(i&&r.date<=rows[i-1].date)||
     !['open','high','low','close'].every(k=>Number.isFinite(r[k])&&r[k]>0)||r.low>Math.min(r.open,r.close)||r.high<Math.max(r.open,r.close)))throw Error('UNVERIFIED_DAILY_HISTORY');
   const last=rows.at(-1),returns=Object.fromEntries([1,3,5,10].map(n=>[n,last.close/rows.at(-1-n).close-1]));
   const drawdowns=Object.fromEntries([20,60,120].map(n=>[n,last.close/Math.max(...rows.slice(-n).map(r=>r.close))-1]));
   const prior=[];for(let i=5;i<rows.length-1;i++){const x=rows[i].close/rows[i-5].close-1;if(x<0)prior.push(-x);}
   return {asof:last.date,returns,drawdowns,declineSpeed5:Math.max(0,-returns[5])/5,
     declinePercentile:returns[5]<0&&prior.length?prior.filter(x=>x<=-returns[5]).length/prior.length:null};
 }
 return Object.freeze({version,states,unavailable,describe});
});
