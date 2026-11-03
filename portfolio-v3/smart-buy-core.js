/* Read-only V3.5 adapter. Targets, C4 and financial ceilings retain their owners. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./group-strategy'):root.HSGroupStrategy);if(typeof module==='object'&&module.exports)module.exports=api;else root.HSSmartBuy=api;})(globalThis,function(S){
 'use strict';
 function amount(text){if(typeof text!=='string'||!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text))throw Error('請輸入有效金額，最多兩位小數');const [a,b='']=text.split('.'),n=BigInt(a)*100n+BigInt(b.padEnd(2,'0'));if(n>BigInt(Number.MAX_SAFE_INTEGER))throw Error('金額超出安全範圍');return Number(n);}
 function cashPreview(equity,cash){if(!Number.isSafeInteger(cash)||cash<0)throw Error('INVALID_CASH');const total=Number.isSafeInteger(equity)&&equity>=0&&Number.isSafeInteger(equity+cash)?equity+cash:null;return{cash_minor:cash,total_assets_minor:total,weights:S.displayWeights(total===null?null:equity,cash),saved:false};}
 function calculate({view,strategy,requested,fp,ceiling,qualify,multiplier,positionValue,at}){
  const pending=reason=>({status:'PENDING',reason,basket:[],writes:false,production_writer:false});
  if(!Number.isSafeInteger(requested)||requested<=0)return pending('請輸入本次想投入的金額');
  if(view.cash_confirmed!==true||!view.snapshot||!view.complete||!view.latest||!view.rows?.length)return pending('持股、現金或行情尚未完整核對，暫不提供買進清單');
  let groups,settings;
  try{
   if(strategy?.value){groups=strategy.groupValue?.groups;settings=strategy.value;S.validate(settings,groups,fp);}
   else{
    if(strategy?.groupValue?.groups?.length)return pending('自訂部位尚未完成雙層目標確認');
    if(!view.targets_complete)return pending('請先設定完整的個股目標，合計100%');
    groups=view.rows.map((r,i)=>({id:'single-'+i,name:r.name||r.symbol,symbols:[r.symbol],target_bps:Math.round(view.settings.targets[r.symbol]*100)}));
    const input={order:groups.map(g=>g.id),targets:Object.fromEntries(groups.map(g=>[g.id,g.target_bps])),etf_targets:Object.fromEntries(groups.map(g=>[g.id,{[g.symbols[0]]:10000}])),mode:'GROUP'};
    settings=S.create(null,groups,input,at,fp);
   }
   // C4 qualification and intensity come directly from the original engine.
   const safeQualify=r=>!['00631L','009815'].includes(r.symbol)&&Number.isSafeInteger(r.market_value_minor)&&r.quote?.latest===true&&r.c4?.latest===true&&typeof view.c4_required_date==='string'&&r.c4.date===view.c4_required_date&&['AS_REPORTED','AS_CONFIRMED'].includes(r.unit_status)&&qualify(r);
   const result=S.plan({view,groups,settings,fp,ceiling,manualBudget:requested,qualify:safeQualify,multiplier,positionValue,policy:'DEFICIT_FIRST_V2'});
   return{...result,requested_minor:requested,unused_requested_minor:result.status==='READY'?requested-result.spent_minor:null,targets:S.effectiveTargets(groups,settings),snapshot_sha256:view.snapshot.state_sha256,policy:'DEFICIT_FIRST_V2'};
  }catch{return pending('目標或金融資料需要確認，暫不提供買進清單');}
 }
 function projection({view,strategy,requested,fp,positionValue,at}){
  const pending=reason=>({status:'PENDING',reason,basket:[],writes:false,production_writer:false,not_executable:true});
  if(!Number.isSafeInteger(requested)||requested<=0)return pending('請輸入本次想投入的金額');
  if(view.cash_confirmed!==true||!view.snapshot)return pending('請先核對可投資現金');
  if(!view.complete||!view.latest||!view.rows?.length)return pending('行情待更新，缺少完整有效價格，暫時無法計算股數與買後配置');
  if(!Number.isSafeInteger(view.cash_minor)||view.cash_minor<=0)return pending('目前沒有可投資現金');
  try{
   let groups,settings;if(strategy?.value){groups=strategy.groupValue?.groups;settings=S.validate(strategy.value,groups,fp);}else{if(strategy?.groupValue?.groups?.length)return pending('請先確認自訂部位的ETF目標');if(!view.targets_complete)return pending('請設定每支ETF目標，合計100%');groups=view.rows.map((r,i)=>({id:'single-'+i,name:r.name||r.symbol,symbols:[r.symbol],target_bps:Math.round(view.settings.targets[r.symbol]*100)}));settings=S.create(null,groups,{order:groups.map(g=>g.id),targets:Object.fromEntries(groups.map(g=>[g.id,g.target_bps])),etf_targets:Object.fromEntries(groups.map(g=>[g.id,{[g.symbols[0]]:10000}])),mode:'GROUP'},at,fp);}
   const known=Number.isSafeInteger(view.settings.feeReserveMinor)&&view.settings.feeReserveMinor>=0;if(view.settings.feeReserveMinor!==null&&view.settings.feeReserveMinor!==undefined&&!known)return pending('費用設定資料需要確認');
   const fee=known?view.settings.feeReserveMinor:0,max=view.settings.equityMaxBps;if(!Number.isInteger(max)||max<0||max>9500)return pending('原股票上限需要確認');
   const total=view.equity_minor+view.cash_minor,fees=fee*view.rows.length;if(!Number.isSafeInteger(total)||!Number.isSafeInteger(fees))return pending('金額超出安全範圍');
   const cap=Math.max(0,Number(BigInt(Math.max(0,total-fees))*BigInt(max)/10000n)-view.equity_minor);
   if(cap===0)return pending('已達原股票部位上限，本次保留現金');
   // A separately labelled WHAT-IF only: no period/quota/approval is issued.
   // Unknown fees are EXCLUDED, never claimed to be zero or broker-confirmed.
   const hypothetical={...view,settings:{...view.settings,feeReserveMinor:fee}};
   const valid=r=>!['00631L','009815'].includes(r.symbol)&&r.quote?.latest===true&&Number.isFinite(r.price)&&r.price>0&&['AS_REPORTED','AS_CONFIRMED'].includes(r.unit_status);
   const result=S.plan({view:hypothetical,groups,settings,fp,ceiling:Math.min(view.cash_minor,requested,cap),manualBudget:requested,qualify:valid,multiplier:()=>1,positionValue,policy:'DEFICIT_FIRST_V2'});
   return{...result,targets:S.effectiveTargets(groups,settings),requested_minor:requested,unused_requested_minor:result.status==='READY'?requested-result.spent_minor:null,scope:'TARGET_ALLOCATION_ONLY',fee_basis:known?'USER_CONFIRMED_RESERVE':'UNKNOWN_EXCLUDED',not_executable:true};
  }catch{return pending('配置或交易單位資料需要確認，暫時無法安全試算');}
 }
 function recommend(options){return{theory:projection(options),formal:calculate(options),writes:false,production_writer:false};}
 return Object.freeze({amount,cashPreview,calculate,projection,recommend});
});
