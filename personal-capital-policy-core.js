(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.HSPersonalCapitalPolicyCore=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const VERSION="PERSONAL_CAPITAL_POLICY_V1";
  const INPUT_VERSION="PERSONAL_CAPITAL_INPUT_V1";
  const ELIGIBLE_SYMBOLS=Object.freeze(["0050","00662","00830","00935","009815"]);
  const finite=value=>{
    if(value===null||value===undefined||value==="")return null;
    const number=Number(value);
    return Number.isFinite(number)?number:null;
  };
  const symbolOf=value=>String(value??"").trim().toUpperCase();

  function allocationState(gapPct){
    const gap=finite(gapPct);
    if(gap===null)return null;
    if(gap<=-3)return "OVERWEIGHT";
    if(gap<=2)return "ON_TARGET";
    if(gap<=5)return "UNDERWEIGHT";
    return "DEEPLY_UNDERWEIGHT";
  }
  function scoreBucket(score){
    const value=finite(score);
    if(value===null||value<0||value>100)return null;
    if(value<=39)return "NORMAL";
    if(value<=49)return "WATCH";
    if(value<=64)return "SMALL_ADD";
    if(value<=69)return "FORMAL_ADD";
    if(value<=79)return "DEEP_ADD";
    if(value<=89)return "RARE";
    return "EXTREME";
  }
  function actionFor(state,score){
    if(state==="OVERWEIGHT")return "DO_NOT_ADD";
    if(state==="ON_TARGET")return score>=65?"ALLOW_ADD":"HOLD";
    if(state==="UNDERWEIGHT")return score<=39?"WAIT":score<=49?"WATCH":score<=64?"ALLOW_ADD":"PRIORITY_ADD";
    if(state==="DEEPLY_UNDERWEIGHT")return score<=39?"WAIT":score<=49?"WATCH":score<=64?"PRIORITY_ADD":"HIGH_PRIORITY_ADD";
    return null;
  }
  function unavailable(input,reasons){
    const symbol=symbolOf(input?.symbol);
    return{version:VERSION,symbol,status:"DATA_UNAVAILABLE",allocation:null,market:null,action:"DATA_UNAVAILABLE",rationaleCodes:[...new Set(reasons.filter(Boolean))],asOf:input?.asOf||null};
  }
  function evaluate(normalizedInput){
    const input=normalizedInput&&typeof normalizedInput==="object"?normalizedInput:{};
    const symbol=symbolOf(input.symbol);
    if(!ELIGIBLE_SYMBOLS.includes(symbol))return unavailable(input,["SYMBOL_OUT_OF_SCOPE"]);
    if(input.version!==INPUT_VERSION||input.eligibility!=="READY")return unavailable(input,["INPUT_NOT_READY",...(Array.isArray(input.reasons)?input.reasons:[])]);
    if(input.freshness?.portfolio!=="CURRENT"||input.freshness?.radar!=="CURRENT"||input.asOf?.aligned!==true)return unavailable(input,["INPUT_VALIDATION_INCOMPLETE"]);
    const actual=finite(input.portfolio?.actualWeightPct),target=finite(input.portfolio?.targetAllocationPct),score=finite(input.radar?.score);
    if(actual===null||actual<0||actual>100)return unavailable(input,["PORTFOLIO_ACTUAL_WEIGHT_INVALID"]);
    if(target===null||target<0||target>100)return unavailable(input,["TARGET_ALLOCATION_MISSING"]);
    if(score===null||score<0||score>100)return unavailable(input,["RADAR_SCORE_INVALID"]);
    const gap=target-actual,state=allocationState(gap),bucket=scoreBucket(score),action=actionFor(state,score);
    if(!state||!bucket||!action)return unavailable(input,["POLICY_INPUT_INVALID"]);
    return{
      version:VERSION,
      symbol,
      status:"READY",
      allocation:{actualWeightPct:actual,targetAllocationPct:target,gapPct:gap,state},
      market:{score,stage:input.radar?.stage||null,scoreBucket:bucket,decisionMode:input.asOf?.decisionMode||input.radar?.decisionMode||null},
      action,
      rationaleCodes:[`PORTFOLIO_${state}`,`MARKET_${bucket}`],
      asOf:input.asOf
    };
  }
  return Object.freeze({VERSION,INPUT_VERSION,ELIGIBLE_SYMBOLS,allocationState,scoreBucket,actionFor,evaluate});
});
