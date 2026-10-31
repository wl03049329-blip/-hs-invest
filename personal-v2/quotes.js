// Read-only official MIS transport. No position quantities, cash or backup leave
// the browser. A blocked CORS request or missing z remains MARKET_PENDING.
async function safeWorker(){
 const registrations=await navigator.serviceWorker?.getRegistrations()||[];
 const relevant=registrations.filter(r=>location.href.startsWith(r.scope));
 if(!relevant.length&&!navigator.serviceWorker?.controller)return true;
 const expected=new URL('push-service-worker.js',base).href;
 if(navigator.serviceWorker?.controller&&navigator.serviceWorker.controller.scriptURL!==expected)return false;
 for(const r of relevant){const worker=r.active||r.waiting||r.installing;if(!worker||worker.scriptURL!==expected)return false;}
 try{const response=await host.fetch(expected,{cache:'no-store'});if(!response.ok)return false;const bytes=await response.arrayBuffer(),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');return hash==='__PUSH_SW_SHA__';}catch{return false;}
}
async function fetch(input,options){
 if(!String(input).startsWith('hpv2:quotes'))return host.fetch(input,options);
 const symbols=new URL(String(input).replace('hpv2:','https://local.invalid/')).searchParams.get('symbols')?.split(',').filter(s=>/^\d{4,6}[A-Z]?$/.test(s))||[];
 if(!symbols.length)return{ok:true,json:async()=>({records:[]})};
 const endpoint=new URL('https://mis.twse.com.tw/stock/api/getStockInfo.jsp');endpoint.searchParams.set('ex_ch',symbols.flatMap(s=>['tse_'+s+'.tw','otc_'+s+'.tw']).join('|'));endpoint.searchParams.set('json','1');endpoint.searchParams.set('delay','0');
 const response=await host.fetch(endpoint,{cache:'no-store',credentials:'omit',redirect:'error'});if(!response.ok)throw Error('OFFICIAL_QUOTE_UNAVAILABLE');
 const raw=await response.text(),acquired_at=new Date().toISOString(),payload=JSON.parse(raw),hash=await HSPortfolioMarketEvidenceCore.rawSHA(raw);
 const records=symbols.flatMap(symbol=>{const rows=(payload.msgArray||[]).filter(r=>r.c===symbol);if(rows.length!==1)return[];const market=rows[0].ex==='tse'?'TWSE':rows[0].ex==='otc'?'TPEX':null;if(!market)return[];return[{provider:'TWSE_MIS',transport:'FIXED_OFFICIAL_HTTPS',status:200,input:{provider:'TWSE_MIS',source_revision:'MIS_D_T_Z_V1',source_endpoint:endpoint.href,raw,expected_raw_sha256:hash,acquired_at,raw_reference:endpoint.href,source_receipt_reference:'HTTPS_OFFICIAL_RESPONSE:'+hash,instrument:{symbol,market,currency:'TWD',instrument_id:market+':'+symbol},maximum_quote_age_ms:600000}}];});
 return{ok:true,json:async()=>({records})};
}
