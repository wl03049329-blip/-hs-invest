(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;else root.HSFinalCoreScoreV1=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  const VERSION="FINAL_CORE_WEIGHT_V1";
  const STATUS="FROZEN_REFERENCE_NOT_YET_PRODUCTION_ENABLED";
  const MISSING_POLICY="FAIL_CLOSED";
  const WEIGHTS=Object.freeze({weeklyJ:30,dd52:55,crash:15});
  function validScore(value){return typeof value==="number"&&Number.isFinite(value)&&value>=0&&value<=100;}
  function calculateFinalCoreScoreV1(jScore,dd52Score,crashScore){
    if(!validScore(jScore)||!validScore(dd52Score)||!validScore(crashScore))return null;
    return (jScore*30+dd52Score*55+crashScore*15)/100;
  }
  function displayFinalCoreScoreV1(coreScore){return validScore(coreScore)?Math.floor(coreScore):null;}
  function meetsFinalCoreThresholdV1(coreScore,threshold){return validScore(coreScore)&&Number.isFinite(threshold)&&coreScore>=threshold;}
  return {VERSION,STATUS,MISSING_POLICY,WEIGHTS,calculateFinalCoreScoreV1,displayFinalCoreScoreV1,meetsFinalCoreThresholdV1};
});
