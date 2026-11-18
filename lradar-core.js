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
 const periods=Object.freeze([20,60,120,240,'all']);
 const validDay=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
 const day=d=>d.toISOString().slice(0,10);
 function monthsBack(date,months){
   const [y,m,d]=date.split('-').map(Number),month=new Date(Date.UTC(y,m-1-months,1));
   const last=new Date(Date.UTC(month.getUTCFullYear(),month.getUTCMonth()+1,0)).getUTCDate();
   month.setUTCDate(Math.min(d,last));return day(month);
 }
 function verify(a){
   if(a?.schema!=='HS_00631L_CLOSE_OBSERVATION_V1'||a.threshold_version!=='P80_P95_CLOSE_FIXED_20201231_V1'||a.training_end!=='2020-12-31'||
     !validDay(a.asof)||!Array.isArray(a.rows)||a.rows.length<240||a.rows.length>20000||a.rows.at(-1)[0]!==a.asof||
     !/^[a-f0-9]{64}$/.test(a.history_sha256)||!Number.isFinite(Date.parse(a.verified_at))||
     !Array.isArray(a.evidence)||a.evidence.length<4||a.evidence.some(e=>typeof e.url!=='string'||!(e.url.startsWith('https://www.twse.com.tw/')||(e.url==='https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'&&e.license==='https://data.gov.tw/license'&&e.dataset==='https://data.gov.tw/dataset/11549'&&validDay(e.date)))||!/^[a-f0-9]{64}$/.test(e.sha256))||
     ['speed',...periods].some(k=>{const t=a.thresholds?.[k];return !Array.isArray(t)||t.length!==3||!t.every(Number.isFinite)||t[0]<0||t[1]<=t[0]||t[1]>=100||!Number.isInteger(t[2])||t[2]<240;})||
     a.rows.some((r,i)=>!Array.isArray(r)||r.length!==2||!validDay(r[0])||i&&r[0]<=a.rows[i-1][0]||!Number.isFinite(r[1])||r[1]<=0))throw Error('OBSERVATION_SOURCE_INVALID');
   return a;
 }
 const pctChange=(a,b)=>100*(a/b-1);
 function peak(rows,i,period){
   if(period!=='all'&&i+1<period)return null;
   const from=period==='all'?0:i-period+1;let best=from;
   for(let j=from+1;j<=i;j++)if(rows[j][1]>=rows[best][1])best=j;
   return {date:rows[best][0],price:rows[best][1],age:i-best,change:pctChange(rows[i][1],rows[best][1])};
 }
 function gauge(change,[watch,extreme]){
   const decline=Math.max(0,-change);
   return {decline,watch,extreme,level:decline>=extreme?2:decline>=watch?1:0,fromExtreme:decline-extreme};
 }
 function summary(a,period=240){
   if(!periods.includes(period))throw Error('INVALID_PERIOD');
   const rows=a.rows,i=rows.length-1,last=rows[i],recent=Object.fromEntries([3,5,10].map(n=>[n,pctChange(last[1],rows[i-n][1])]));
   const peaks=Object.fromEntries(periods.map(n=>[n,peak(rows,i,n)]));
   const [year,month]=last[0].split('-').map(Number);
   const requested=[day(new Date(Date.UTC(year,month-1,0))),monthsBack(last[0],3),monthsBack(last[0],6),(year-1)+'-12-31'];
   const returns=requested.map(d=>{const row=rows.findLast(r=>r[0]<=d);return row?{date:row[0],change:pctChange(last[1],row[1])}:null;});
   const speed=gauge(recent[5],a.thresholds.speed),depth=gauge(peaks[period].change,a.thresholds[period]);
   return {asof:last[0],close:last[1],recent,peaks,returns,speed,depth,level:Math.max(speed.level,depth.level)};
 }
 function historical(a,period,driver){
   const rows=a.rows,limit=a.thresholds[driver==='speed'?'speed':period][1],events=[];let prior=false,last=-21,allHigh=0;
   // Frozen training ends before any eligible date. An episode enters once
   // upon crossing the extreme line; a 20-session exclusion prevents overlap.
   for(let i=0;i<rows.length;i++){
     const r=rows[i];allHigh=Math.max(allHigh,r[1]);
     if(i<5)continue;
     const p=driver==='speed'?pctChange(r[1],rows[i-5][1]):period==='all'?pctChange(r[1],allHigh):peak(rows,i,period)?.change;
     const now=Number.isFinite(p)&&-p>=limit;
     if(now&&!prior&&r[0]>a.training_end&&i-last>20){events.push(i);last=i;}
     prior=now;
   }
   return [5,10,20].map(h=>{
     const mature=events.filter(i=>i+h<rows.length),returns=mature.map(i=>pctChange(rows[i+h][1],rows[i][1])).sort((x,y)=>x-y),n=returns.length;
     const worst=mature.map(i=>Math.min(0,...rows.slice(i+1,i+1+h).map(r=>pctChange(r[1],rows[i][1]))));
     return {h,n,pending:events.length-n,mean:n?returns.reduce((x,y)=>x+y,0)/n:null,median:n?(returns[Math.floor((n-1)/2)]+returns[Math.floor(n/2)])/2:null,positive:n>=10?100*returns.filter(x=>x>0).length/n:null,worst:n?Math.min(...worst):null};
   });
 }
 const archiveURL='https://raw.githubusercontent.com/wl03049329-blip/-hs-invest/refs/heads/data/00631l-open-close/index.json';
 const training='2020-12-31', thresholdVersion='P80_P95_CLOSE_FIXED_20201231_V1';
 const limits=Object.freeze({speed:[2.2185014650481394,6.714628297362113,1508],
   20:[6.6833056017748245,13.198992443324942,1494],60:[11.023851076207103,23.181707613719293,1454],
   120:[15.859564164648921,26.069410815173534,1394],240:[18.886198547215493,27.72397094430994,1274],
   all:[19.854941069809605,28.934624697336574,1274]});
 const closeText=s=>typeof s==='string'&&/^\d{1,7}\.\d{2}$/.test(s)&&+s>0;
 function verifyIndex(index,today,now){
   if(index?.schema!=='HS_00631L_OPEN_INDEX_V1'||!Array.isArray(index.records)||index.records.length>15000||
     index.records.some((r,i)=>!r||r.schema!=='HS_00631L_OPEN_CLOSE_V1'||r.symbol!=='00631L'||r.price_basis!=='TWSE_RAW_CLOSE'||
       !validDay(r.trading_date)||r.trading_date>today||(i&&r.trading_date<=index.records[i-1].trading_date)||
       !closeText(r.close_twd)||(r.comparison_twd!==null&&!closeText(r.comparison_twd))||
       !Number.isFinite(Date.parse(r.captured_at))||Date.parse(r.captured_at)>now||Date.parse(r.captured_at)<Date.parse(r.trading_date+'T18:20:00+08:00')||
       r.source!=='https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'||r.dataset!=='https://data.gov.tw/dataset/11549'||r.source_attribution!=='臺灣證券交易所'||
       r.license!=='https://data.gov.tw/license'||r.session_source!=='https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK'||
       r.session_dataset!=='https://data.gov.tw/dataset/11672'||![r.response_sha256,r.session_sha256].every(s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s))||
       !Array.isArray(r.observed_sessions)||r.observed_sessions.length>62||r.observed_sessions.at(-1)!==r.trading_date||
       r.observed_sessions.some((d,j)=>!validDay(d)||j&&d<=r.observed_sessions[j-1])||
       r.cross_month_session!==undefined&&(!validDay(r.cross_month_session?.previous)||
         r.cross_month_session.previous.slice(0,7)>=r.trading_date.slice(0,7)||
         r.cross_month_session.source!=='HS_VERIFIED_TWSE_SESSION_INTERVAL'||
         !/^[a-f0-9]{64}$/.test(r.cross_month_session.sha256))))throw Error('UNVERIFIED_00631L_ARCHIVE');
   return index.records;
 }
 function archiveSummary(records,period){
   if(!periods.includes(period)) throw Error('INVALID_PERIOD');
   const last=records.at(-1);
   let start=records.length-1;
   for(let i=start;i>0;i--){
     const r=records[i],prior=records[i-1];
     if(r.comparison_twd!==prior.close_twd||
        (r.observed_sessions.at(-2)!==prior.trading_date&&r.cross_month_session?.previous!==prior.trading_date))break;
     start=i-1;
   }
   const rows=records.slice(Math.max(0,start)).map(r=>[r.trading_date,+r.close_twd]), i=rows.length-1, end=rows[i];
   // All-time data need an approved listing-to-present archive; the new forward archive is not one.
   const peaks=Object.fromEntries(periods.map(n=>[n,n==='all'||!end?null:peak(rows,i,n)]));
   const recent=Object.fromEntries([3,5,10].map(n=>[n,i>=n?pctChange(end[1],rows[i-n][1]):null]));
   const [year,month]=end?end[0].split('-').map(Number):[];
   const requested=end?[day(new Date(Date.UTC(year,month-1,0))),monthsBack(end[0],3),monthsBack(end[0],6),(year-1)+'-12-31']:[];
   const returns=[0,1,2,3].map(j=>{
     const r=rows.findLast(r=>r[0]<=requested[j]);
     return r?{date:r[0],change:pctChange(end[1],r[1])}:null;
   });
   const speed=Number.isFinite(recent[5])?gauge(recent[5],limits.speed):null;
   const depth=peaks[period]?gauge(peaks[period].change,limits[period]):null;
   const level=speed&&depth?Math.max(speed.level,depth.level):speed?.level===2||depth?.level===2?2:null;
   return {asof:last?.trading_date??null,close:end?.[1]??null,rows,recent,peaks,returns,speed,depth,level};
 }
 return Object.freeze({version,states,unavailable,describe,periods,verify,summary,historical,monthsBack,archiveURL,verifyIndex,archiveSummary,limits,training,thresholdVersion});
});
