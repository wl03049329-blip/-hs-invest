(function(root,factory){
  const api=factory(
    typeof module==="object"&&module.exports?require("./backtest/long-term/final-core-score-v1.js"):root.HSFinalCoreScoreV1,
    typeof module==="object"&&module.exports?require("./strategy-mode-core.js"):root.HSStrategyModeCore
  );
  if(typeof module==="object"&&module.exports)module.exports=api;else root.HSFinalCoreProduction=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(canonical,strategy){
  "use strict";
  const LONG_TERM_CORE_SCORE_VERSION="FINAL_CORE_WEIGHT_V1";
  const LEGACY_VERSION="LEGACY_LONG_TERM_V62";
  const SUPPORTED_TICKERS=Object.freeze(["0050","00662","00830","00935"]);
  const LABELS=Object.freeze([
    {min:90,label:"歷史極端機會",triggerRate:.3},
    {min:80,label:"重大加碼機會",triggerRate:1.3},
    {min:70,label:"強力加碼訊號",triggerRate:2.8},
    {min:65,label:"積極加碼訊號",triggerRate:3.6},
    {min:50,label:"正式加碼訊號",triggerRate:9.0},
    {min:45,label:"試探加碼",triggerRate:11.6},
    {min:40,label:"加碼條件浮現",triggerRate:14.8},
    {min:30,label:"回檔訊號出現",triggerRate:22.1},
    {min:0,label:"一般持有",triggerRate:null}
  ]);
  function finite(value){return typeof value==="number"&&Number.isFinite(value)?value:null;}
  function clamp(value,min=0,max=100){return Math.max(min,Math.min(max,value));}
  function resolveVersion(requested){return requested===LEGACY_VERSION?LEGACY_VERSION:LONG_TERM_CORE_SCORE_VERSION;}
  function labelFor(score){
    const exact=finite(score);if(exact===null)return{label:"資料不足",triggerRate:null};
    return LABELS.find(item=>exact>=item.min)||LABELS[LABELS.length-1];
  }
  function ctaFor(score){
    const exact=finite(score);
    if(exact===null)return{headline:"資料不足",detail:"核心因子尚未齊備，暫不提供長期加碼分。"};
    if(exact>=90)return{headline:"歷史極端區間",detail:"僅適合依原定資金紀律分批，不代表最低點。"};
    if(exact>=80)return{headline:"重大加碼機會",detail:"可依資金規劃增加額外批次，仍保留後續資金。"};
    if(exact>=70)return{headline:"強力加碼訊號",detail:"低檔條件明顯，可分批提高額外投入。"};
    if(exact>=65)return{headline:"積極加碼訊號",detail:"回檔條件成熟，按紀律分批而非一次投入。"};
    if(exact>=50)return{headline:"正式加碼訊號",detail:"可在基本投入之外啟動額外加碼計畫。"};
    if(exact>=45)return{headline:"試探加碼",detail:"只適合小額試探，等待條件進一步改善。"};
    if(exact>=40)return{headline:"加碼條件浮現",detail:"先預留資金，尚未進入正式加碼區。"};
    if(exact>=30)return{headline:"回檔訊號出現",detail:"維持基本投入，開始追蹤低檔條件。"};
    return{headline:"一般持有",detail:"維持基本投入；尚未進入額外加碼區。"};
  }
  function crashRawFromRows(rows){
    const valid=(Array.isArray(rows)?rows:[]).map(row=>({date:String(row.date||""),close:Number(row.close)})).filter(row=>row.date&&Number.isFinite(row.close)&&row.close>0);
    if(!valid.length)return null;
    const sample=valid.slice(-20),latest=sample[sample.length-1].close,high=Math.max(...sample.map(row=>row.close));
    return high>0?(latest/high-1)*100:null;
  }
  function crashScore(raw){
    const value=finite(raw);if(value===null)return null;
    const magnitude=Math.abs(Math.min(0,value));
    return clamp((magnitude-5)/25*100);
  }
  function buildFinal(input={}){
    const ticker=String(input.ticker||"");
    const auxiliary={weeklyBias:finite(input.weeklyBias),marketFear:finite(input.marketFear),valuation:finite(input.valuation)};
    if(!SUPPORTED_TICKERS.includes(ticker))return{mode:"long_term_core",modeLabel:"長期核心",score:null,coreScore:null,coreScoreDisplay:null,coreScoreVersion:LONG_TERM_CORE_SCORE_VERSION,scoreStatus:"unavailable",coreFactors:null,label:"資料不足",historicalTriggerRate:null,coverage:0,availableWeight:0,auxiliary,stage:{key:"unavailable",label:"資料不足",recommendation:"缺少 canonical 歷史校準，暫不提供分數。"}};
    const jScore=strategy.weeklyKdjFactor(finite(input.j),finite(input.k),finite(input.d));
    const dd52Score=strategy.drawdownFactor(finite(input.dd52));
    const crashRaw=finite(input.crashRaw)??crashRawFromRows(input.rows);
    const crash=crashScore(crashRaw);
    const exact=canonical.calculateFinalCoreScoreV1(jScore,dd52Score,crash);
    const display=canonical.displayFinalCoreScoreV1(exact);
    const classification=labelFor(exact),cta=ctaFor(exact);
    const factors={
      weeklyJ:{raw:finite(input.j),score:jScore,weight:30,contribution:jScore===null?null:jScore*.30},
      dd52:{raw:finite(input.dd52),score:dd52Score,weight:55,contribution:dd52Score===null?null:dd52Score*.55},
      crash:{raw:crashRaw,score:crash,weight:15,contribution:crash===null?null:crash*.15}
    };
    return{mode:"long_term_core",modeLabel:"長期核心",score:display,coreScore:exact,coreScoreDisplay:display,coreScoreVersion:LONG_TERM_CORE_SCORE_VERSION,scoreStatus:exact===null?"unavailable":"complete",coreFactors:factors,label:classification.label,historicalTriggerRate:classification.triggerRate,coverage:exact===null?0:100,availableWeight:exact===null?Object.values(factors).filter(item=>item.score!==null).reduce((sum,item)=>sum+item.weight,0):100,weightedRawTotal:exact,normalizedScore:exact,finalScore:exact,auxiliary,stage:{key:exact===null?"unavailable":classification.label,label:classification.label,recommendation:cta.detail},cta};
  }
  function buildDecision(input={},legacyDecision=null,requestedVersion){
    const version=resolveVersion(requestedVersion);
    if(version===LEGACY_VERSION&&legacyDecision)return{...legacyDecision,coreScoreVersion:LEGACY_VERSION,legacyScore:legacyDecision.score};
    return{...buildFinal(input),legacyScore:Number.isFinite(legacyDecision?.score)?legacyDecision.score:null};
  }
  function compare(a,b){
    const av=finite(a?.coreScore),bv=finite(b?.coreScore);
    if(av===null&&bv===null)return String(a?.ticker||"").localeCompare(String(b?.ticker||""));
    if(av===null)return 1;if(bv===null)return-1;
    return bv-av||String(a?.ticker||"").localeCompare(String(b?.ticker||""));
  }
  return{LONG_TERM_CORE_SCORE_VERSION,LEGACY_VERSION,SUPPORTED_TICKERS,LABELS,resolveVersion,labelFor,ctaFor,crashRawFromRows,crashScore,buildFinal,buildDecision,compare};
});
