/* Same-owner personal research. No network or financial storage. */
(function(root,factory){const api=factory(typeof module==='object'?require('./lradar-core'):root.HSLRadar);if(typeof module==='object'&&module.exports)module.exports=api;else root.HSLRadarLocal=api;})(globalThis,R=>{'use strict';
 const PIN='8deb877cb18e953f9124d056c8150b9472dcc4651ea7a4bfeb78266e89535580',DB='hs.research.00631l.personal.v1',STORE='research',KEY='verified-history';
 const fail=(ok,why)=>{if(!ok)throw Error(why);};
 const digest=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(v)))),n=>n.toString(16).padStart(2,'0')).join('');
 const date=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei',dateStyle:'short'}).format(new Date());
 async function verify(input,today=date(),now=Date.now()){
  fail(input?.schema==='HS_00631L_PERSONAL_BACKUP_V1'&&Object.keys(input).sort().join(',')==='base,extension,schema','PRIVATE_SCHEMA');
  fail(await digest(input.base)===PIN,'PRIVATE_BASE_HASH_OR_RIGHTS');fail(input.base.asof<=today,'PRIVATE_FUTURE_DATE');
  const extension=R.verifyIndex({schema:'HS_00631L_OPEN_INDEX_V1',records:input.extension},today,now);let last=input.base.rows.at(-1);
  for(const r of extension){fail(r.trading_date>last[0]&&+r.comparison_twd===last[1]&&(r.observed_sessions.at(-2)===last[0]||r.cross_month_session?.previous===last[0]),'PRIVATE_EXTENSION_GAP_OR_PRICE');last=[r.trading_date,+r.close_twd];}
  return structuredClone(input);
 }
 function rows(input){return [...input.base.rows,...input.extension.map(r=>[r.trading_date,+r.close_twd])];}
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
  r.onsuccess=()=>{const db=r.result;db.onversionchange=()=>{db.close();opening=null;ready=false;};resolve(db);};
 });return opening;}
 async function read(refresh=false){
  if(refresh)ready=false;if(ready)return cache;const db=await open(),value=await new Promise((resolve,reject)=>{
   const tx=db.transaction(STORE,'readonly'),r=tx.objectStore(STORE).get(KEY);let value;
   r.onsuccess=()=>{value=r.result;};tx.oncomplete=()=>resolve(value||null);tx.onerror=tx.onabort=()=>reject(Error('PRIVATE_STORAGE_READ_FAILED'));
  });
  if(value){fail(Number.isSafeInteger(value.revision)&&value.revision>0&&typeof value.enabled==='boolean','PRIVATE_STORAGE_INVALID');await verify(value.data);}
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
 async function importText(text){
  fail(typeof text==='string'&&text.length<=2_000_000,'PRIVATE_FILE_SIZE');const incoming=await verify(JSON.parse(text));
  return change(old=>{if(old){const a=rows(old.data),b=rows(incoming);fail(b.length>=a.length&&a.every((r,i)=>JSON.stringify(r)===JSON.stringify(b[i])),'PRIVATE_IMPORT_ROLLBACK_OR_CONFLICT');}return {data:incoming,enabled:true};});
 }
 async function sync(records){
  R.verifyIndex({schema:'HS_00631L_OPEN_INDEX_V1',records},date(),Date.now());
  return change(old=>{if(!old?.enabled)return null;const next=merge(old.data,records);return next.extension.length===old.data.extension.length?null:{data:next,enabled:true};});
 }
 async function enable(enabled){return change(old=>{fail(old,'PRIVATE_NOT_IMPORTED');return old.enabled===enabled?null:{data:old.data,enabled};});}
 async function backup(){const current=await read();fail(current,'PRIVATE_NOT_IMPORTED');await verify(current.data);return JSON.stringify(current.data);}
 return Object.freeze({PIN,DB,verify,rows,merge,summary,read,importText,sync,enable,backup});
});
