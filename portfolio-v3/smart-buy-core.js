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
 return Object.freeze({amount,cashPreview,calculate});
});
