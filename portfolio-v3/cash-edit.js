/* UI adapter for the existing explicit reconciliation contract. No new cash math. */
(function(root){'use strict';root.HSCashEdit=Object.freeze({
 async preview({api,transaction,amount,expected,acknowledged,reference,at,id,singleSave=false}){
  if(api.read().snapshot?.state_sha256!==expected)throw Error('資料已變更，請關閉並重新核對現金');
  const checked=p=>{if(p.expected?.state_sha256!==expected)throw Error('資料已變更，請關閉並重新核對現金');return p;};
  try{return checked(await api.previewCash(amount));}catch(e){
   if(e.message!=='CASH_DIFFERENCE_REQUIRES_EXPLICIT_RECONCILIATION')throw e;
   const state=api.read();if(state.snapshot?.state_sha256!==expected)throw Error('資料已變更，請關閉並重新核對現金');
   // The Save gesture confirms the entire manually maintained balance only
   // when there are NO Ledger events. Never invent a cause or external proof.
   if(singleSave===true&&state.status==='READY'&&state.cash?.status==='READY'&&Array.isArray(state.events)&&state.events.length===0){acknowledged=true;reference='使用者按儲存確認完整手動現金餘額；無帳本交易，非新增入金';}
   if(acknowledged!==true||!reference?.trim())throw Error('CASH_DIFFERENCE_REQUIRES_EXPLICIT_RECONCILIATION');
   return checked(await transaction.preview({operationId:id(),kind:'CASH_CHECKPOINT',intent:{baselineId:id(),amount,reconciliation:{acknowledged:true,confirmed_at:at,reference:reference.trim()}},expected:state.snapshot,asOf:at}));
  }
 }
});})(globalThis);
