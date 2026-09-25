(function(root,factory){
  const api=factory(root);
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.HSC4ValidationMetadata=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(root){
  "use strict";
  const STATUS=Object.freeze({FORMAL:"FORMAL",VALIDATING:"VALIDATING",REFERENCE:"REFERENCE"});
  const PRESENTATION=Object.freeze({
    FORMAL:Object.freeze({label:"正式",copy:"已納入目前 HS 正式驗證範圍。"}),
    VALIDATING:Object.freeze({label:"驗證中",copy:"此標的正在累積 Benchmark / Forward 等驗證資料，目前 C4 分數仍屬研究驗證階段。"}),
    REFERENCE:Object.freeze({label:"參考",copy:"此標的可使用相同 HS C4 公式計算，但尚未完成此標的或資產類型的歷史驗證。分數反映目前 C4 因子狀態，僅供研究參考，不視為正式 HS 訊號。"})
  });
  // No symbol outside the formal C4 scope currently has documented, active C4-specific validation.
  // HS_LEVERAGE_C_V1 Forward Shadow validates a separate leverage strategy, not C4.
  const VALIDATING_METADATA=Object.freeze({});
  function createResolver({formalC4Source,validatingMetadata=VALIDATING_METADATA}={}){
    function resolve(symbol){
      const ticker=String(symbol||"").trim().toUpperCase();
      const formal=(formalC4Source||root.HSFormalCoreScoreAdapter)?.isFormalC4Symbol?.(ticker)===true;
      const candidate=validatingMetadata?.[ticker];
      const validating=!formal&&candidate?.status===STATUS.VALIDATING&&typeof candidate.method==="string"&&candidate.method.length>0;
      const status=formal?STATUS.FORMAL:validating?STATUS.VALIDATING:STATUS.REFERENCE;
      return Object.freeze({symbol:ticker,status,...PRESENTATION[status],metadata:validating?candidate:null});
    }
    return Object.freeze({resolve});
  }
  const {resolve}=createResolver();
  return Object.freeze({STATUS,PRESENTATION,VALIDATING_METADATA,createResolver,resolve});
});
