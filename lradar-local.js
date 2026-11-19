/* Same-owner personal research. One direct provider GET; no uploads/financial storage. */
(function(root,factory){const api=factory(typeof module==='object'?require('./lradar-core'):root.HSLRadar);if(typeof module==='object'&&module.exports)module.exports=api;else root.HSLRadarLocal=api;})(globalThis,R=>{'use strict';
 const PIN='8deb877cb18e953f9124d056c8150b9472dcc4651ea7a4bfeb78266e89535580',DB='hs.research.00631l.personal.v1',STORE='research',KEY='verified-history';
 const DIRECT_URL='https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=00631L&start_date=2014-10-01&end_date=2026-11-19';
 const ROW_PIN='9079de2db57bd184ec020978de47df21544f5659a1843658584e101d4291b94b',ATTEMPT='direct-bootstrap-attempt';
 const fail=(ok,why)=>{if(!ok)throw Error(why);};
 const textDigest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),n=>n.toString(16).padStart(2,'0')).join('');
 const digest=v=>textDigest(JSON.stringify(v));
 const date=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei',dateStyle:'short'}).format(new Date());
 async function verify(input,today=date(),now=Date.now()){
  fail(input?.schema==='HS_00631L_PERSONAL_BACKUP_V1'&&Object.keys(input).sort().join(',')==='base,extension,schema','PRIVATE_SCHEMA');
  if(input.base?.schema==='HS_00631L_PERSONAL_DIRECT_V1'){
   const b=input.base,s=b.source;
   fail(b.symbol==='00631L'&&b.scope==='PERSONAL_NONCOMMERCIAL_ONLY'&&b.price_basis==='SPLIT22_20260331_CLOSE_NO_DIVIDEND'&&b.listing_date==='2014-10-31'&&b.asof==='2026-11-19'&&
    JSON.stringify(b.split)===JSON.stringify({date:'2026-03-31',factor:22,applied_once:true})&&s?.provider==='FinMind'&&s.dataset==='TaiwanStockPrice'&&s.url===DIRECT_URL&&
    /^[a-f0-9]{64}$/.test(s.response_sha256)&&Number.isFinite(Date.parse(s.retrieved_at))&&Date.parse(s.retrieved_at)<=now&&await digest(b.rows)===ROW_PIN,'PRIVATE_BASE_HASH_OR_RIGHTS');
  }else fail(await digest(input.base)===PIN,'PRIVATE_BASE_HASH_OR_RIGHTS');
  fail(input.base.asof<=today,'PRIVATE_FUTURE_DATE');
  const extension=R.verifyIndex({schema:'HS_00631L_OPEN_INDEX_V1',records:input.extension},today,now);let last=input.base.rows.at(-1);
  for(const r of extension){fail(r.trading_date>last[0]&&+r.comparison_twd===last[1]&&(r.observed_sessions.at(-2)===last[0]||r.cross_month_session?.previous===last[0]),'PRIVATE_EXTENSION_GAP_OR_PRICE');last=[r.trading_date,+r.close_twd];}
  return structuredClone(input);
 }
 function rows(input){return [...input.base.rows,...input.extension.map(r=>[r.trading_date,+r.close_twd])];}
 function reconcile(incoming,observed,old){
  const trusted=new Map([...(old?.extension||[]),...observed].map(r=>[r.trading_date,JSON.stringify(r)]));
  for(const r of incoming.extension)fail(trusted.get(r.trading_date)===JSON.stringify(r),'PRIVATE_BACKUP_EXTENSION_NEEDS_PUBLIC_CHECK');
 }
 function merge(input,records){
  const all=rows(input),by=new Map(all),extension=[...input.extension];let last=all.at(-1);
  for(const r of records){
   if(r.trading_date<=last[0]){fail(by.get(r.trading_date)===+r.close_twd,'PRIVATE_OVERLAP_CONFLICT');continue;}
   fail(+r.comparison_twd===last[1]&&(r.observed_sessions.at(-2)===last[0]||r.cross_month_session?.previous===last[0]),'PRIVATE_EXTENSION_GAP_OR_PRICE');
   extension.push(r);last=[r.trading_date,+r.close_twd];by.set(...last);
  }return {...input,extension};
 }
 function summary(input,period){const series=rows(input);return {...R.summary({rows:series,thresholds:R.limits},period),rows:series,personal:true};}
 let opening,cache=null,ready=false,queue=Promise.resolve();
 function open(){if(!opening)opening=new Promise((resolve,reject)=>{
  const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>r.result.createObjectStore(STORE);
  r.onerror=()=>{opening=null;reject(Error('PRIVATE_STORAGE_UNAVAILABLE'));};r.onblocked=()=>{opening=null;reject(Error('PRIVATE_STORAGE_BLOCKED'));};
  r.onsuccess=()=>{const db=r.result;db.onversionchange=()=>{db.close();opening=null;ready=false;cache=null;};resolve(db);};
 });return opening;}
 async function read(refresh=false){
  if(refresh)ready=false;if(ready)return cache;const db=await open(),value=await new Promise((resolve,reject)=>{
   const tx=db.transaction(STORE,'readonly'),r=tx.objectStore(STORE).get(KEY);let value;
   r.onsuccess=()=>{value=r.result;};tx.oncomplete=()=>resolve(value||null);tx.onerror=tx.onabort=()=>reject(Error('PRIVATE_STORAGE_READ_FAILED'));
  });
  if(value){fail(Number.isSafeInteger(value.revision)&&value.revision>0&&typeof value.enabled==='boolean','PRIVATE_STORAGE_INVALID');await verify(value.data);}
  // A slower readonly/hash check must not replace a newer committed revision.
  if(cache&&(!value||value.revision<cache.revision))return cache;
  cache=value;ready=true;return cache;
 }
 function serial(fn){const job=queue.then(fn,fn);queue=job.catch(()=>{});return job;}
 async function write(expected,data,enabled){
  // Hash validation must finish before starting the atomic IDB transaction.
  await verify(data);const db=await open(),value={revision:(expected?.revision||0)+1,enabled,data};
  await new Promise((resolve,reject)=>{
   const tx=db.transaction(STORE,'readwrite'),s=tx.objectStore(STORE),get=s.get(KEY);let conflict=false;
   get.onsuccess=()=>{if((get.result?.revision||0)!==(expected?.revision||0)){conflict=true;tx.abort();return;}s.put(value,KEY);};
   tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(Error(conflict?'PRIVATE_CONCURRENT_CHANGE':'PRIVATE_STORAGE_WRITE_FAILED'));
  });cache=value;ready=true;return value;
 }
 async function change(fn){return serial(async()=>{
  for(let i=0;i<3;i++){const old=await read(),next=await fn(old);if(!next)return old;
   try{return await write(old,next.data,next.enabled);}catch(e){if(e.message!=='PRIVATE_CONCURRENT_CHANGE')throw e;ready=false;}
  }throw Error('PRIVATE_CONCURRENT_CHANGE');
 });}
 async function importText(text,observed=[]){
  fail(typeof text==='string'&&text.length<=2_000_000,'PRIVATE_FILE_SIZE');const incoming=await verify(JSON.parse(text));
  R.verifyIndex({schema:'HS_00631L_OPEN_INDEX_V1',records:observed},date(),Date.now());
  return change(old=>{reconcile(incoming,observed,old?.data);if(old){const a=rows(old.data),b=rows(incoming);fail(b.length>=a.length&&a.every((r,i)=>JSON.stringify(r)===JSON.stringify(b[i])),'PRIVATE_IMPORT_ROLLBACK_OR_CONFLICT');}return {data:incoming,enabled:true};});
 }
 async function sync(records){
  R.verifyIndex({schema:'HS_00631L_OPEN_INDEX_V1',records},date(),Date.now());
  return change(old=>{if(!old?.enabled)return null;const next=merge(old.data,records);return next.extension.length===old.data.extension.length?null:{data:next,enabled:true};});
 }
 async function enable(enabled){return change(old=>{fail(old,'PRIVATE_NOT_IMPORTED');return old.enabled===enabled?null:{data:old.data,enabled};});}
 async function backup(){const current=await read();fail(current,'PRIVATE_NOT_IMPORTED');await verify(current.data);return JSON.stringify(current.data);}
 async function fromProvider(text,now=Date.now()){
  fail(typeof text==='string'&&text.length<=4_000_000,'AUTO_RESPONSE_SIZE');
  let p;try{p=JSON.parse(text);}catch{throw Error('AUTO_RESPONSE_INVALID');}if([401,402,403,429].includes(p.status))throw Error('AUTO_HTTP_'+p.status);fail(p.status===200&&Array.isArray(p.data)&&p.data.length===2935,'AUTO_RESPONSE_INVALID');
  const series=p.data.map((r,i)=>{
   fail(r.stock_id==='00631L'&&/^\d{4}-\d{2}-\d{2}$/.test(r.date)&&Number.isFinite(Date.parse(r.date))&&new Date(r.date).toISOString().slice(0,10)===r.date&&(!i||p.data[i-1].date<r.date)&&
    Number.isFinite(r.close)&&r.close>0&&Number.isFinite(r.Trading_Volume)&&r.Trading_Volume>0&&!(r.date>'2026-03-24'&&r.date<'2026-03-31'),'AUTO_ROW_INVALID');
   return [r.date,r.date<'2026-03-31'?r.close/22:r.close];
  });
  fail(await digest(series)===ROW_PIN,'AUTO_HISTORY_REVISED');
  const result={schema:'HS_00631L_PERSONAL_BACKUP_V1',base:{schema:'HS_00631L_PERSONAL_DIRECT_V1',symbol:'00631L',scope:'PERSONAL_NONCOMMERCIAL_ONLY',price_basis:'SPLIT22_20260331_CLOSE_NO_DIVIDEND',listing_date:'2014-10-31',asof:'2026-11-19',split:{date:'2026-03-31',factor:22,applied_once:true},source:{provider:'FinMind',dataset:'TaiwanStockPrice',url:DIRECT_URL,response_sha256:await textDigest(text),retrieved_at:new Date(now).toISOString()},rows:series},extension:[]};
  return verify(result,date(),now);
 }
 async function attempt(value){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,value?'readwrite':'readonly'),s=tx.objectStore(STORE),r=value?s.put(value,ATTEMPT):s.get(ATTEMPT);let result;r.onsuccess=()=>{result=r.result;};tx.oncomplete=()=>resolve(value||result||null);tx.onabort=tx.onerror=()=>reject(Error('PRIVATE_STORAGE_WRITE_FAILED'));});}
 let automaticFlight;
 async function bootstrap(){
  if(automaticFlight)return automaticFlight;
  automaticFlight=(async()=>{
   const existing=await read();if(existing)return {state:existing,status:existing.enabled?'READY':'PUBLIC_SELECTED'};
   if(typeof location==='undefined'||location.origin!=='https://wl03049329-blip.github.io'||!location.pathname.startsWith('/-hs-invest/'))return {state:null,status:'AUTO_ORIGIN_NOT_ENABLED'};
   if(navigator.onLine===false)return {state:null,status:'AUTO_OFFLINE'};
   fail(navigator.locks?.request,'AUTO_COORDINATION_UNAVAILABLE');
   return navigator.locks.request('hs.research.00631l.direct-bootstrap.v1',async()=>{
    const prior=await read(true);if(prior)return {state:prior,status:prior.enabled?'READY':'PUBLIC_SELECTED'};
    const old=await attempt(),now=Date.now();if(old&&Number.isFinite(old.next)&&old.next>now)return {state:null,status:old.status==='AUTO_LOADING'?'AUTO_PREVIOUS_INTERRUPTED':old.status,next:old.next};
    await attempt({status:'AUTO_LOADING',next:now+1800000});
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);let delay=1800000;
    try{
     const response=await fetch(DIRECT_URL,{method:'GET',mode:'cors',credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal});
     if(!response.ok){
      const retry=response.headers.get('Retry-After'),seconds=Number(retry),until=Number.isFinite(seconds)&&retry!==null?Date.now()+Math.max(0,seconds)*1000:Date.parse(retry);
      delay=Math.max([401,403].includes(response.status)?86400000:[402,429].includes(response.status)?3600000:1800000,Number.isFinite(until)?until-Date.now():0);
      throw Error([401,402,403,429].includes(response.status)?'AUTO_HTTP_'+response.status:'AUTO_SOURCE_UNAVAILABLE');
     }
     fail(response.url===DIRECT_URL&&response.type==='cors'&&/application\/json/i.test(response.headers.get('content-type')||''),'AUTO_RESPONSE_INVALID');
     const reader=response.body.getReader(),parts=[];let bytes=0;
     while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>4_000_000){controller.abort();throw Error('AUTO_RESPONSE_SIZE');}parts.push(part.value);}
     const raw=new Uint8Array(bytes);let offset=0;for(const part of parts){raw.set(part,offset);offset+=part.byteLength;}
     const data=await fromProvider(new TextDecoder('utf-8',{fatal:true}).decode(raw));
     const state=await change(current=>current?null:{data,enabled:true});return {state,status:state.enabled?'READY':'PUBLIC_SELECTED'};
    }catch(e){
     const status=/^AUTO_(HTTP_(401|402|403|429)|HISTORY_REVISED|RESPONSE_INVALID|ROW_INVALID|RESPONSE_SIZE|SOURCE_UNAVAILABLE)$/.test(e.message)?e.message:'AUTO_NETWORK_UNAVAILABLE';
     if(['AUTO_HTTP_401','AUTO_HTTP_403'].includes(status))delay=Math.max(delay,86400000);else if(['AUTO_HTTP_402','AUTO_HTTP_429'].includes(status))delay=Math.max(delay,3600000);
     if(['AUTO_HISTORY_REVISED','AUTO_RESPONSE_INVALID','AUTO_ROW_INVALID'].includes(status))delay=86400000;
     const next=Date.now()+delay;await attempt({status,next});return {state:null,status,next};
    }finally{clearTimeout(timer);}
   });
  })().finally(()=>{automaticFlight=null;});return automaticFlight;
 }
 return Object.freeze({PIN,DB,DIRECT_URL,ROW_PIN,verify,rows,reconcile,merge,summary,read,importText,sync,enable,backup,fromProvider,bootstrap});
});
