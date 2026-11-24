'use strict';
const assert=require('node:assert/strict'),cp=require('node:child_process'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto'),test=require('node:test');
const raw=fs.readFileSync('portfolio-v3/personal-v3.js','utf8'),end=raw.indexOf("const scope=document.getElementById('hpv2')");
const box={crypto:crypto.webcrypto,TextEncoder,TextDecoder,console};vm.createContext(box);vm.runInContext(raw.slice(0,end)+'host.contract=window;})(globalThis);',box);
const {HSPersonalV3Core:V,HSPersonalV3HistoryBasis:B,HSPersonalV3Accounting:A,HSPortfolioCapitalBuildPlanCore:P}=box.contract;
const {estimate}=require('../portfolio-v3/experience360');
const groups=require('../portfolio-v3/position-groups');
const pin='7ee0a446e016b5c91e02e05894c4c575b32e3276',from=name=>JSON.parse(cp.execFileSync('git',['show',pin+':'+name],{maxBuffer:16e6}));
const symbols=['0050','006201','00631L','00662','00685L','00830','00935','009815'],now='2026-11-24T23:15:00+08:00',status=from('data/radar-history/status-v1.json'),cache=from('market-quotes.json');
const history=s=>['006201','00631L','00685L'].includes(s)?null:from('data/radar-history/'+(s==='009815'?'tpex':'twse')+'/'+s+'.json');
const holdings=symbols.map(symbol=>({symbol,shares:1000,break_even_price:10,created_at:'2026-11-18',unit_status:'AS_REPORTED'}));
const av=(quotes,hs=holdings)=>V.view({holdings:hs,cashMinor:100000,prefs:null,quotes,now,positionValue:P.localPositionValue,allocate:()=>({rows:[]})});
test('11/24 actual 8 official close rows; no next date cannot block a proved same-day close or certify C4',()=>{
 const s=V.priceSession(status,now),quotes=V.closeQuotes(cache,status,now);
 assert.equal(s.reason,'VERIFIED_COMPLETED_NEXT_UNKNOWN');assert.equal(s.required_c4_date,null);
 assert.equal(symbols.filter(k=>quotes.get(k)?.date==='2026-11-24'&&quotes.get(k)?.latest).length,8);
 const v=av(quotes);assert.equal(v.complete,true);assert.equal(v.equity_minor,31236000);assert.equal(v.total_assets_minor,31336000);assert.equal(v.reference_basis_minor,8000000);assert.equal(v.actual_cost_minor,null);
 const [g,rest]=groups.aggregate(v,{groups:[{id:'TW',name:'自訂部位',symbols:['0050','006201'],target_bps:4000}]});
 assert.equal(g.market_minor,12567000);assert.equal(g.target_percent,40);assert.equal(g.market_minor+rest.market_minor,v.equity_minor);
 assert.equal(P.localPositionValue(1000,95.7),9570000); // 1 lot = 1,000 shares; market prices are per share
 const incomplete=av(quotes,holdings.map((h,i)=>i? h:{...h,break_even_price:null}));
 assert.equal(incomplete.total_assets_minor,v.total_assets_minor);assert.equal(incomplete.pnl_minor,null);
 for(const stamp of ['2026-11-24T12:00:00+08:00','2026-11-25T10:00:00+08:00'])assert.equal(V.priceSession(status,stamp),null);
 assert.equal(V.priceSession({...status,price_cutoff:'2026-11-25'},now),null);
 assert.equal(V.priceSession({...status,next_expected_trading_day:'INVALID'},now),null);
});
test('real archival previous-close evidence yields only five valid estimates, including TPEx',()=>{
 const quotes=V.closeQuotes(cache,status,now);
 for(const k of symbols)quotes.set(k,B.apply(quotes.get(k),history(k),status,A.actions,now));
 const result=estimate({holdings,quotes,session:V.priceSession(status,now),positionValue:P.localPositionValue});
 assert.equal(result.status,'PARTIAL');assert.equal(result.computed,5);
 assert.deepEqual(result.rows.filter(r=>r.status!=='ESTIMATED').map(r=>r.symbol),['006201','00631L','00685L']);
 const q=quotes.get('00830');assert.equal(B.preSplit00830(q),true);
 assert.equal(B.preSplit00830({...q,date:'2027-01-12'}),false);
 assert.equal(B.preSplit00830({...q,reference_kind:'EXCHANGE_COMPARISON_PRICE'}),false);
 const broken=history('009815');broken.incremental_verification.calendar_evidence[0].url='https://example.com/';
 assert.equal(B.apply(V.closeQuotes(cache,status,now).get('009815'),broken,status,A.actions,now).reference_kind,'EXCHANGE_COMPARISON_PRICE');
});
test('single incorrect date does not contaminate other estimates or become a full valuation',()=>{
 const quotes=V.closeQuotes(cache,status,now);quotes.delete('00830');
 assert.equal(av(quotes).total_assets_minor,null);assert.equal(V.knownSubtotal(av(quotes).rows).count,7);
 for(const k of symbols)if(quotes.has(k))quotes.set(k,B.apply(quotes.get(k),history(k),status,A.actions,now));
 quotes.set('0050',{...quotes.get('0050'),date:'2026-11-23'});
 const result=estimate({holdings,quotes,session:V.priceSession(status,now),positionValue:P.localPositionValue});
 assert.match(result.rows[0].reason,/收盤日期不符/);assert.equal(result.computed,3);
});
test('eight price estimates are possible with eight valid previous-session proofs; no Ledger substitution',()=>{
 const quotes=V.closeQuotes(cache,status,now);
 for(const k of symbols){
  const q=quotes.get(k);
  // Model-only input, not a published receipt for the three uncovered ETFs.
  quotes.set(k,{...q,reference_kind:'RAW_PREVIOUS_OFFICIAL',calendar_scope:'VERIFIED_INCREMENTAL_WINDOW',history_sha256:'a'.repeat(64),previous_session_date:'2026-11-23'});
 }
 const result=estimate({holdings,quotes,session:V.priceSession(status,now),positionValue:P.localPositionValue});
 assert.equal(result.status,'ESTIMATED');assert.equal(result.computed,8);assert.equal(result.pnl_minor,2895000);
});
