(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.HSDecisionLayerV1=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  // This module interprets already-canonical Core outputs. It never scores ETFs.
  const EXCLUDED_SYMBOLS=Object.freeze(new Set(["00631L"]));
  const FACTORS=Object.freeze([
    {input:"dd52",id:"DD52",label:"中期回檔幅度"},
    {input:"weeklyJ",id:"WEEKLY_J",label:"短期超賣程度"},
    {input:"crash",id:"CRASH",label:"急跌程度"}
  ]);
  const STAGES=Object.freeze([
    {min:90,stage:"EXTREME_REFERENCE",label:"極端機會",action:"HIGH_PRIORITY_ADD",posture:"RARE_EVENT"},
    {min:80,stage:"RARE_OPPORTUNITY",label:"罕見機會",action:"HIGH_PRIORITY_ADD",posture:"RARE_EVENT"},
    {min:70,stage:"DEEP_PULLBACK_ADD",label:"深跌加碼",action:"HIGH_PRIORITY_ADD",posture:"DEPLOY_IN_STAGES"},
    {min:65,stage:"FORMAL_SCALE_IN",label:"正式分批",action:"SCALE_IN",posture:"DEPLOY_IN_STAGES"},
    {min:50,stage:"SMALL_ADD",label:"小額加碼",action:"OPTIONAL_SMALL_ADD",posture:"DEPLOY_SMALL"},
    {min:40,stage:"PULLBACK_WATCH",label:"回檔觀察",action:"WATCH",posture:"PREPARE_CAPITAL"},
    {min:0,stage:"GENERAL",label:"一般持有",action:"NONE",posture:"PRESERVE_CASH"}
  ]);
  const NEXT_THRESHOLDS=Object.freeze([40,50,65,70,80,90]);
  const BASIS=Object.freeze(new Set(["FINALIZED_CLOSE","INTRADAY_SUCCESS","NONE"]));
  const finite=value=>value===null||value===undefined||value===""?null:(Number.isFinite(Number(value))?Number(value):null);

  // Core presentation uses floor(display score). Keep all Decision Layer boundaries
  // and distances on that same displayed canonical precision.
  function normalizeDecisionScore(value){
    const number=finite(value);
    return number===null||number<0||number>100?null:Math.floor(number);
  }
  function normalizeStatus(value){
    const status=String(value||"SUCCESS").toUpperCase();
    return ["SUCCESS","FAIL_CLOSED","WAIT_NATIVE","STALE"].includes(status)?status:"FAIL_CLOSED";
  }
  function stageFor(score){return STAGES.find(row=>score>=row.min)||null;}
  function distanceFor(score){
    const threshold=NEXT_THRESHOLDS.find(value=>value>score);
    return threshold===undefined?{distance:0,next:null}:{distance:threshold-score,next:stageFor(threshold)?.stage||null};
  }
  function factorContribution(factors,key){
    const contribution=finite(factors?.[key]?.contribution);
    return contribution===null?null:contribution;
  }
  function driverFor(currentFactors,baselineFactors){
    const candidates=[];
    for(const [priority,factor] of FACTORS.entries()){
      const current=factorContribution(currentFactors,factor.input),baseline=factorContribution(baselineFactors,factor.input);
      if(current===null||baseline===null)return null;
      candidates.push({...factor,priority,delta:current-baseline});
    }
    // FACTORS is intentionally DD52, Weekly J, Crash: exact ties preserve this order.
    candidates.sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta)||a.priority-b.priority);
    return candidates[0]||null;
  }
  function baseOutput(input,status,score){
    return {symbol:String(input?.symbol||""),score,decision_stage:null,decision_label_zh:null,action_required:"NONE",distance_to_next_stage:null,next_stage:null,primary_driver:null,primary_driver_delta:null,today_score_delta:null,comparison_basis:"NONE",capital_posture:"PRESERVE_CASH",explanation_code:"DATA_UNAVAILABLE",explanation_text_zh:"核心資料尚未齊備，依 FAIL_CLOSED 暫不提供決策。",source_status:status,as_of:String(input?.asOf||"")||null};
  }
  function explanation(stage,driver){
    if(driver&&driver.delta<0)return {code:"DRIVER_DOWN",text:`本次分數變化主要受${driver.label}走弱影響。`};
    if(stage.stage==="GENERAL")return {code:"GENERAL_NO_CHANGE",text:"目前屬一般持有，尚未進入額外加碼區。"};
    if(stage.stage==="PULLBACK_WATCH")return {code:"PULLBACK_WATCH",text:"目前屬回檔觀察，可開始留意，但尚未進入正式分批區。"};
    if(stage.stage==="SMALL_ADD"&&driver&&driver.delta>0)return {code:"SMALL_ADD_DRIVER_UP",text:`目前進入小額加碼區，主要因${driver.label}使正式分數提高。`};
    if(!driver)return {code:"DRIVER_UNAVAILABLE",text:`目前屬${stage.label}，主要變化來源尚無可比較資料。`};
    if(stage.stage==="FORMAL_SCALE_IN")return {code:"FORMAL_SCALE_IN",text:"目前已進入正式分批區，仍應保留後續加碼資金。"};
    if(stage.stage==="DEEP_PULLBACK_ADD")return {code:"DEEP_PULLBACK_ADD",text:"目前屬深跌加碼區，依既有資金紀律分批處理。"};
    if(stage.stage==="RARE_OPPORTUNITY")return {code:"RARE_OPPORTUNITY",text:"目前出現罕見低檔條件，仍不代表最低點。"};
    return {code:"EXTREME_REFERENCE",text:"目前位於極端參考區，僅依既有紀律分批，不作報酬保證。"};
  }
  function interpret(input={}){
    const symbol=String(input.symbol||"");
    if(EXCLUDED_SYMBOLS.has(symbol))throw new Error("HS_DECISION_LAYER_V1_EXCLUDED_SYMBOL");
    const status=normalizeStatus(input.sourceStatus),score=normalizeDecisionScore(input.score),output=baseOutput(input,status,score);
    if(status==="WAIT_NATIVE")return {...output,explanation_code:"WAIT_NATIVE",explanation_text_zh:"原生資料尚未成熟，目前暫不提供決策。"};
    if(status==="STALE")return {...output,explanation_code:"STALE_SOURCE",explanation_text_zh:"資料已過期，保留最後有效分數供參考，不提供今日決策。"};
    if(status!=="SUCCESS"||score===null)return output;
    const stage=stageFor(score),distance=distanceFor(score),baseline=input.baseline||{},basis=BASIS.has(String(baseline.type||""))?String(baseline.type):"NONE",baselineScore=basis==="NONE"?null:normalizeDecisionScore(baseline.score),driver=baselineScore===null?null:driverFor(input.currentFactors,baseline.factors);
    const copy=explanation(stage,driver);
    return {...output,decision_stage:stage.stage,decision_label_zh:stage.label,action_required:stage.action,distance_to_next_stage:distance.distance,next_stage:distance.next,primary_driver:driver?.id||null,primary_driver_delta:driver?.delta??null,today_score_delta:baselineScore===null?null:score-baselineScore,comparison_basis:baselineScore===null?"NONE":basis,capital_posture:stage.posture,explanation_code:copy.code,explanation_text_zh:copy.text};
  }
  return Object.freeze({STAGES,NEXT_THRESHOLDS,EXCLUDED_SYMBOLS,normalizeDecisionScore,interpret});
});
