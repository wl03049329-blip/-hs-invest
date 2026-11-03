/* UI adapter for the existing explicit reconciliation contract. No new cash math. */
(function(root){'use strict';root.HSCashEdit=Object.freeze({
 async preview({api,transaction,amount,expected,acknowledged,reference,at,id}){
  if(api.read().snapshot?.state_sha256!==expected)throw Error('資料已變更，請關閉並重新核對現金');
  try{return await api.previewCash(amount);}catch(e){
   if(e.message!=='CASH_DIFFERENCE_REQUIRES_EXPLICIT_RECONCILIATION')throw e;
   if(acknowledged!==true||!reference?.trim())throw Error('CASH_DIFFERENCE_REQUIRES_EXPLICIT_RECONCILIATION');
   return transaction.preview({operationId:id(),kind:'CASH_CHECKPOINT',intent:{baselineId:id(),amount,reconciliation:{acknowledged:true,confirmed_at:at,reference:reference.trim()}},expected:transaction.snapshot({asOf:at}),asOf:at});
  }
 }
});})(globalThis);
