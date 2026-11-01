/* Read-only V3.3 group settings and simulation; never a financial Writer. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HSGroupStrategy=api;})(globalThis,function(){
 'use strict';
 const SCHEMA='HS_GROUP_STRATEGY_V1',KEY='hsRadar.portfolio.groupStrategy.v1';
 const fail=message=>{throw Error(message);};
 const minor=n=>{if(!Number.isSafeInteger(n)||n<0)fail('INVALID_MINOR');return n;};
 const bps=n=>{if(!Number.isInteger(n)||n<0||n>10000)fail('INVALID_BPS');return n;};
 const copy=x=>JSON.parse(JSON.stringify(x));
 function sum(values){return minor(values.reduce((a,b)=>a+minor(b),0));}
 function binding(groups,fp){return fp(groups.map(g=>({id:g.id,symbols:[...g.symbols].sort(),target_bps:g.target_bps})).sort((a,b)=>a.id.localeCompare(b.id)));}
 function assetWeights(equity,cash){
  if(!Number.isSafeInteger(equity)||equity<0||!Number.isSafeInteger(cash)||cash<0)return{stock:null,cash:null};
  const total=sum([equity,cash]);if(!total)return{stock:null,cash:null};const stock=equity/total*100;return{stock,cash:100-stock};
 }
 function displayWeights(equity,cash){const w=assetWeights(equity,cash);if(w.stock===null)return{stock:'—',cash:'—'};const stock=Number(w.stock.toFixed(1));return{stock:stock.toFixed(1)+'%',cash:(100-stock).toFixed(1)+'%'};}
 function tolerance(targetBps,{ratio_bps=1000,override_bps=null}={}){
  bps(targetBps);bps(ratio_bps);if(override_bps!==null)return bps(override_bps);
  return Math.max(50,targetBps*ratio_bps/10000);
 }
 function classify(currentPercent,targetBps,options){
  if(currentPercent===null||targetBps===null)return{status:'PENDING',gap_pp:null,tolerance_pp:null};
  if(!Number.isFinite(currentPercent)||currentPercent<0||currentPercent>100)fail('INVALID_WEIGHT');
  const gap=currentPercent*100-bps(targetBps),limit=tolerance(targetBps,options);
  return{status:Math.abs(gap)<=limit+1e-9?'NEAR_TARGET':gap<0?'UNDERWEIGHT':'OVERWEIGHT',gap_pp:gap/100,tolerance_pp:limit/100};
 }
 function validate(settings,groups,fp){
  if(settings?.schema!==SCHEMA||settings.version!==1||!Number.isSafeInteger(settings.revision)||settings.revision<1)fail('INVALID_SETTINGS');
  if(settings.group_binding_sha256!==binding(groups,fp))fail('GROUPS_CHANGED_RECONFIRM');
  const ids=groups.map(g=>g.id);if(new Set(ids).size!==ids.length||!Array.isArray(settings.order)||settings.order.length!==ids.length||new Set(settings.order).size!==ids.length||settings.order.some(id=>!ids.includes(id)))fail('INVALID_ORDER');
  const symbols=groups.flatMap(g=>g.symbols);if(new Set(symbols).size!==symbols.length)fail('DUPLICATE_SYMBOL');
  if(!settings.targets||Object.keys(settings.targets).length!==ids.length||ids.some(id=>!Object.hasOwn(settings.targets,id)))fail('TARGETS_INCOMPLETE');
  if(sum(ids.map(id=>bps(settings.targets[id])))!==10000)fail('GROUP_TARGET_SUM_NOT_100');
  if(!settings.etf_targets||Object.keys(settings.etf_targets).some(id=>!ids.includes(id)))fail('UNKNOWN_GROUP');
  for(const g of groups){const t=settings.etf_targets[g.id];if(t===undefined||t===null)continue;
   if(!g.symbols.length||Object.keys(t).length!==g.symbols.length||Object.keys(t).some(s=>!g.symbols.includes(s))||sum(Object.values(t).map(bps))!==10000)fail('ETF_TARGET_SUM_NOT_100');
  }
  bps(settings.tolerance_ratio_bps);
  for(const id of Object.keys(settings.tolerance_overrides||{})){if(!ids.includes(id))fail('UNKNOWN_TOLERANCE_GROUP');bps(settings.tolerance_overrides[id]);}
  if(!['SINGLE_ETF','GROUP'].includes(settings.mode))fail('INVALID_MODE');
  if(typeof settings.confirmed_at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(settings.confirmed_at)||!Number.isFinite(Date.parse(settings.confirmed_at))||new Date(settings.confirmed_at.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==settings.confirmed_at.slice(0,10)||+settings.confirmed_at.slice(11,13)>23||+settings.confirmed_at.slice(14,16)>59||+settings.confirmed_at.slice(17,19)>59||/[+-]14:(?!00$)/.test(settings.confirmed_at))fail('INVALID_TIME');
  if(settings.revision===1?settings.previous_sha256!==null:!/^[a-f0-9]{64}$/.test(settings.previous_sha256))fail('INVALID_PARENT');
  const{sha256,...body}=settings;if(fp(body)!==sha256)fail('SETTINGS_HASH_MISMATCH');return settings;
 }
 function create(previous,groups,input,at,fp){
  if(previous)validate(previous,previous.groups_snapshot||groups,fp);
  if(previous&&Date.parse(at)<Date.parse(previous.confirmed_at))fail('TIME_REVERSED');
  const body={schema:SCHEMA,version:1,revision:(previous?.revision||0)+1,previous_sha256:previous?.sha256??null,group_binding_sha256:binding(groups,fp),groups_snapshot:copy(groups),confirmed_at:at,order:copy(input.order),targets:copy(input.targets),etf_targets:copy(input.etf_targets),tolerance_ratio_bps:input.tolerance_ratio_bps??1000,tolerance_overrides:copy(input.tolerance_overrides||{}),mode:input.mode};
  return validate({...body,sha256:fp(body)},groups,fp);
 }
 // Does not migrate or write old data, nor invent equal ETF weights.
 function legacyDraft(groups){return{order:groups.map(g=>g.id),targets:Object.fromEntries(groups.map(g=>[g.id,g.target_bps])),etf_targets:Object.fromEntries(groups.map(g=>[g.id,null])),mode:'GROUP',tolerance_ratio_bps:1000,tolerance_overrides:{}};}
 function describe(view,groups,settings,fp){
  validate(settings,groups,fp);const values=new Map(),rows=view.rows;
  if(new Set(rows.map(r=>r.symbol)).size!==rows.length)fail('DUPLICATE_HOLDING');
  const complete=view.complete===true&&rows.every(r=>Number.isSafeInteger(r.market_value_minor)&&r.market_value_minor>=0);
  const equity=complete?sum(rows.map(r=>r.market_value_minor)):null;
  for(const g of groups){const members=rows.filter(r=>g.symbols.includes(r.symbol)),value=complete?sum(members.map(r=>r.market_value_minor)):null,t=settings.etf_targets[g.id],weight=equity>0?value/equity*100:null;
   const options={ratio_bps:settings.tolerance_ratio_bps,override_bps:settings.tolerance_overrides[g.id]??null};
   values.set(g.id,{id:g.id,name:g.name,market_minor:value,weight,target_bps:settings.targets[g.id],...classify(weight,settings.targets[g.id],options),members:members.map(r=>{const w=value>0?r.market_value_minor/value*100:null,target=t?.[r.symbol]??null;return{symbol:r.symbol,name:r.name,market_minor:complete?r.market_value_minor:null,weight_in_group:w,target_in_group_bps:target,effective_stock_target_bps:target===null?null:settings.targets[g.id]*target/10000,...classify(w,target,{ratio_bps:settings.tolerance_ratio_bps})};})});
  }
  const assigned=new Set(groups.flatMap(g=>g.symbols)),unassigned=rows.filter(r=>!assigned.has(r.symbol));
  return{equity_minor:equity,asset_weights:assetWeights(equity,view.cash_minor),groups:settings.order.map(id=>values.get(id)),targets_complete:groups.every(g=>g.symbols.length&&settings.etf_targets[g.id]&&g.symbols.every(s=>rows.some(r=>r.symbol===s)))&&!unassigned.length,unassigned:unassigned.map(r=>r.symbol),writes:false,production_writer:false};
 }
 // Single immutable basket is the source of every before/after display.
 // Quotes must already have passed the existing source/date/unit validators.
 function preview(view,basket,{positionValue=(n,p)=>Math.round(n*p*100)}={}){
  if(view.complete!==true||view.latest!==true)fail('MARKET_NOT_VERIFIED');
  const cash=minor(view.cash_minor),rows=view.rows.map(r=>({...r,market_value_minor:minor(r.market_value_minor)})),seen=new Set();let spent=0;
  if(new Set(rows.map(r=>r.symbol)).size!==rows.length)fail('DUPLICATE_HOLDING');
  for(const b of basket){if(seen.has(b.symbol))fail('DUPLICATE_BUY');seen.add(b.symbol);const r=rows.find(r=>r.symbol===b.symbol);if(!r)fail('UNKNOWN_SYMBOL');
   minor(b.units);minor(b.unit);minor(b.price_minor);minor(b.fee_minor);if(!b.unit||!b.price_minor||b.units%b.unit)fail('INVALID_LOT');
   if(r.quote?.latest!==true||(b.price_actual!==undefined?b.price_actual!==r.price:Math.abs(r.price*100-b.price_minor)>1e-6))fail('PRICE_CHANGED');
   const principal=minor(positionValue(b.units,r.price)),cost=b.units?sum([principal,b.fee_minor]):0;spent=sum([spent,cost]);r.market_value_minor=sum([r.market_value_minor,principal]);if(typeof r.shares==='number'){r.shares+=b.units;if(!Number.isFinite(r.shares)||r.shares>1e12)fail('INVALID_SHARES');}
  }
  if(spent>cash)fail('CASH_INSUFFICIENT');const equity=sum(rows.map(r=>r.market_value_minor));return{rows,equity_minor:equity,cash_minor:cash-spent,total_assets_minor:sum([equity,cash-spent]),asset_weights:assetWeights(equity,cash-spent),spent_minor:spent,writes:false,production_writer:false};
 }
 function validateStorage(entries,fp,now=Date.now()){
  const raw=entries[KEY],history=JSON.parse(entries[KEY+'.history']||'[]');
  if(!Array.isArray(history))fail('INVALID_HISTORY');if(!raw){if(history.length)fail('MISSING_CURRENT_SETTINGS');return null;}
  if(!Array.isArray(history))fail('INVALID_HISTORY');const current=JSON.parse(raw),all=[...history,current];let previous=null;
  for(const s of all){validate(s,s.groups_snapshot,fp);if(s.revision!==(previous?.revision||0)+1||s.previous_sha256!==(previous?.sha256??null)||Date.parse(s.confirmed_at)>(now)||previous&&Date.parse(s.confirmed_at)<Date.parse(previous.confirmed_at))fail('INVALID_SETTINGS_HISTORY');previous=s;}
  return current;
 }
 function effectiveTargets(groups,settings){const out={};for(const g of groups)for(const symbol of g.symbols){const t=settings.etf_targets[g.id]?.[symbol];if(t!==undefined&&t!==null)out[symbol]=settings.targets[g.id]*t/1000000;}return out;}
 // Qualification, intensity and global ceiling are supplied by the existing
 // private C4/period engine. This module does not define another C4 threshold.
 function plan({view,groups,settings,fp,ceiling,manualBudget=null,excluded=[],qualify,multiplier,positionValue}){
  const empty=reason=>({status:'PENDING',reason,budget_minor:null,spent_minor:0,unallocated_minor:null,remaining_cash_minor:view.cash_minor,basket:[],after:null,writes:false,production_writer:false});
  let detail;try{detail=describe(view,groups,settings,fp);}catch(e){return empty(e.message);}
  if(!detail.targets_complete)return empty('請補齊組合及ETF目標，並處理未分組持股');
  if(!view.complete||!view.latest||!Number.isSafeInteger(view.cash_minor)||view.cash_minor<0)return empty('行情或現金資料需要確認');
  if(!Number.isSafeInteger(ceiling)||ceiling<0)return empty('建倉額度尚未完成核對');
  if(view.settings?.feeReserveMinor===null||view.settings?.feeReserveMinor===undefined)return empty('請先確認每筆買進保留費用，不會推測券商費率');
  const fee=minor(view.settings.feeReserveMinor),unit=view.settings.unit;if(![1,1000].includes(unit))return empty('交易單位需要確認');
  if(manualBudget!==null)minor(manualBudget);
  const budget=Math.min(ceiling,view.cash_minor,manualBudget??ceiling),bySymbol=new Map(view.rows.map(r=>[r.symbol,r])),candidates=[];
  for(const g of detail.groups){if(g.status!=='UNDERWEIGHT')continue;for(const m of g.members){const r=bySymbol.get(m.symbol);if(m.status==='OVERWEIGHT'||!qualify(r)||excluded.includes(r.symbol)||!(m.effective_stock_target_bps>0))continue;candidates.push({...m,gid:g.id,gap:g.target_bps/100-g.weight,score:r.c4.score,multiplier:multiplier(r.c4.score),price:r.price,target_product:settings.targets[g.id]*settings.etf_targets[g.id][r.symbol]});}}
  candidates.sort((a,b)=>b.gap-a.gap||b.multiplier-a.multiplier||a.symbol.localeCompare(b.symbol));
  let principalLimit=Math.max(0,budget-fee*candidates.length),basket=[],after=null,stable=false;const groupLimits=new Map();
  // Monotone fixed point accounts for actual rounded units, retained cash and
  // changed stock denominator. Never pretend the unspent budget was invested.
  for(let iteration=0;iteration<160;iteration++){
   const postEquity=sum([detail.equity_minor,principalLimit]),allocations=new Map(),groupCaps=new Map(detail.groups.map(g=>[g.id,Math.min(groupLimits.get(g.id)??principalLimit,Math.max(0,Number(BigInt(postEquity)*BigInt(g.target_bps)/10000n)-g.market_minor))]));let left=principalLimit;
   const available=candidates.map(r=>({...r,cap:Math.max(0,Number(BigInt(postEquity)*BigInt(r.target_product)/100000000n)-r.market_minor)}));
   for(let round=0;round<available.length+2&&left>0;round++){
    const open=available.filter(r=>r.cap>(allocations.get(r.symbol)||0)&&groupCaps.get(r.gid)>0),total=open.reduce((n,r)=>n+(r.cap-(allocations.get(r.symbol)||0))*r.multiplier,0);if(!total)break;let used=0;
    for(const r of open){const own=allocations.get(r.symbol)||0,take=Math.min(left-used,groupCaps.get(r.gid),r.cap-own,Math.max(1,Math.floor(left*(r.cap-own)*r.multiplier/total)));if(take<=0)continue;allocations.set(r.symbol,own+take);groupCaps.set(r.gid,groupCaps.get(r.gid)-take);used+=take;}if(!used)break;left-=used;
   }
   // Also cap ETF weights INSIDE each post-buy group, not just flattened stock weights.
   for(const g of detail.groups){const subset=available.filter(r=>r.gid===g.id),wanted=sum(subset.map(r=>allocations.get(r.symbol)||0)),post=sum([g.market_minor,wanted]);let remaining=wanted;
    const caps=new Map(subset.map(r=>[r.symbol,Math.min(r.cap,Math.max(0,Number(BigInt(post)*BigInt(settings.etf_targets[g.id][r.symbol])/10000n)-r.market_minor))]));for(const r of subset)allocations.set(r.symbol,0);
    for(let round=0;round<subset.length+2&&remaining>0;round++){const open=subset.filter(r=>caps.get(r.symbol)>(allocations.get(r.symbol)||0)),total=open.reduce((n,r)=>n+(caps.get(r.symbol)-(allocations.get(r.symbol)||0))*r.multiplier,0);if(!total)break;let used=0;for(const r of open){const own=allocations.get(r.symbol)||0,take=Math.min(remaining-used,caps.get(r.symbol)-own,Math.max(1,Math.floor(remaining*(caps.get(r.symbol)-own)*r.multiplier/total)));if(take>0){allocations.set(r.symbol,own+take);used+=take;}}if(!used)break;remaining-=used;}
   }
   basket=[];for(const r of candidates){const cap=allocations.get(r.symbol)||0;let units=Math.floor(cap/(r.price*100)/unit)*unit;if(!Number.isSafeInteger(units))return empty('股數超出安全範圍');while(units>0&&positionValue(units,r.price)>cap)units-=unit;if(units>0)basket.push({symbol:r.symbol,group_id:r.gid,units,unit,price_minor:Math.round(r.price*100),price_actual:r.price,fee_minor:fee});}
   after=preview(view,basket,{positionValue});const actual=after.equity_minor-detail.equity_minor;
   const weights=describe({...view,rows:after.rows,cash_minor:after.cash_minor},groups,settings,fp);
   const safe=basket.every(b=>{const g=weights.groups.find(g=>g.id===b.group_id),m=g.members.find(m=>m.symbol===b.symbol),r=bySymbol.get(b.symbol);return BigInt(g.market_minor)*10000n<=BigInt(after.equity_minor)*BigInt(g.target_bps)&&BigInt(m.market_minor)*10000n<=BigInt(g.market_minor)*BigInt(settings.etf_targets[g.id][b.symbol])&&BigInt(m.market_minor)*100000000n<=BigInt(after.equity_minor)*BigInt(settings.targets[g.id]*settings.etf_targets[g.id][b.symbol])&&qualify(r);})&&BigInt(after.equity_minor)*10000n<=BigInt(after.total_assets_minor)*BigInt(view.settings.equityMaxBps)&&after.spent_minor<=budget;
   if(safe){stable=true;break;}for(const g of detail.groups)groupLimits.set(g.id,sum(basket.filter(b=>b.group_id===g.id).map(b=>positionValue(b.units,b.price_actual))));if(actual>=principalLimit&&principalLimit>0)principalLimit--;else principalLimit=actual;
  }
  if(!stable)return empty('零股取整後配置無法安全收斂，保留現金');
  return{status:'READY',reason:basket.length?'僅供參考，依有效報價試算，非成交保證':'目前無符合配置與C4條件的標的，保留現金',budget_minor:budget,spent_minor:after.spent_minor,unallocated_minor:budget-after.spent_minor,remaining_cash_minor:after.cash_minor,basket,after,details:detail,writes:false,production_writer:false};
 }
 return Object.freeze({KEY,SCHEMA,assetWeights,displayWeights,tolerance,classify,binding,validate,create,legacyDraft,describe,preview,validateStorage,effectiveTargets,plan});
});
