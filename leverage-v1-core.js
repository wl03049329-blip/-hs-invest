(function(root,factory){
  const api=factory();
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  if(root)root.HSLeverageV1Core=api;
})(typeof window!=="undefined"?window:globalThis,function(){
  "use strict";
  const V1_CONFIG=Object.freeze({
    strategy:"HS_LEVERAGE_C_V1",
    threshold:2.033335,
    trainingEnd:"2025-12-31",
    forwardStart:"2026-08-24"
  });
  const finite=value=>Number.isFinite(Number(value))?Number(value):null;

  function evaluateCrashVelocity(rows,config=V1_CONFIG){
    const threshold=finite(config?.threshold),base={
      strategy:String(config?.strategy||V1_CONFIG.strategy),threshold,
      trainingEnd:String(config?.trainingEnd||V1_CONFIG.trainingEnd),
      forwardStart:String(config?.forwardStart||V1_CONFIG.forwardStart),
      source:"adjusted/restored daily OHLC"
    };
    if(threshold===null||threshold<=0)return Object.freeze({...base,status:"THRESHOLD_MISSING",available:false,trigger:false,value:null,return5d:null,dataAsOf:null});
    if(!Array.isArray(rows)||rows.length<6)return Object.freeze({...base,status:"DATA_UNAVAILABLE",available:false,trigger:false,value:null,return5d:null,dataAsOf:null});
    const current=rows.at(-1),prior=rows.at(-6),close=finite(current?.close),priorClose=finite(prior?.close);
    if(close===null||priorClose===null||close<=0||priorClose<=0)return Object.freeze({...base,status:"DATA_UNAVAILABLE",available:false,trigger:false,value:null,return5d:null,dataAsOf:null});
    const return5d=(close/priorClose-1)*100,value=Math.max(0,-return5d)/5,trigger=value>=threshold;
    return Object.freeze({...base,status:trigger?"TRIGGER":"STANDBY",available:true,trigger,value,return5d,dataAsOf:String(current?.date||"")||null});
  }

  return Object.freeze({V1_CONFIG,evaluateCrashVelocity});
});
