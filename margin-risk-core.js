(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.HSMarginRiskCore=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  const finite=value=>typeof value==="number"&&Number.isFinite(value);
  const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));

  function tradingDayAge(dataDate,today){
    const start=new Date(`${dataDate}T00:00:00+08:00`),end=new Date(`${today}T00:00:00+08:00`);
    if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||start>end)return null;
    let cursor=new Date(start),days=0;
    while(cursor<end){
      cursor.setUTCDate(cursor.getUTCDate()+1);
      const weekday=new Intl.DateTimeFormat("en-US",{timeZone:"Asia/Taipei",weekday:"short"}).format(cursor);
      if(["Mon","Tue","Wed","Thu","Fri"].includes(weekday))days+=1;
    }
    return days;
  }

  function validatePayload(payload,today){
    if(!payload||typeof payload!=="object"||!/^\d{4}-\d{2}-\d{2}$/.test(payload.data_date||""))return null;
    const balance=payload.margin_balance||{},maintenance=payload.maintenance_ratio||{};
    const model=payload.model||{},coverageData=payload.coverage||{};
    const principal=balance.estimated_financing_principal;
    const estimated=model.name==="rolling_estimated_margin_cost"&&model.is_estimated===true&&maintenance.method==="rolling_estimated_margin_cost"&&maintenance.is_estimated===true;
    if(!estimated||!finite(principal)||principal<=0||!finite(balance.balance_shares)||balance.balance_shares<=0)return null;
    const ratio=finite(maintenance.value)&&maintenance.value>100&&maintenance.value<400?maintenance.value:null;
    const collateral=maintenance.collateral_market_value;
    const detailPrincipal=maintenance.estimated_financing_principal;
    if(ratio===null||!finite(collateral)||collateral<=0||!finite(detailPrincipal)||detailPrincipal!==principal)return null;
    const coverage=finite(coverageData.coverage_ratio)&&coverageData.coverage_ratio>=0&&coverageData.coverage_ratio<=100?coverageData.coverage_ratio:null;
    const age=tradingDayAge(payload.data_date,today);
    return{
      ...payload,
      margin_balance:{...balance},
      maintenance_ratio:{...maintenance,value:ratio},
      coverage:{...coverageData,coverage_ratio:coverage},
      trading_day_age:age,
      stale:Number.isFinite(age)&&age>3
    };
  }

  function displayValues(payload){
    const balance=payload?.margin_balance||{},maintenance=payload?.maintenance_ratio||{};
    return{
      financingPrincipal:finite(balance.estimated_financing_principal)&&balance.estimated_financing_principal>0?balance.estimated_financing_principal:null,
      collateralMarketValue:finite(maintenance.collateral_market_value)&&maintenance.collateral_market_value>0?maintenance.collateral_market_value:null,
      maintenanceRatio:finite(maintenance.value)&&maintenance.value>100&&maintenance.value<400?maintenance.value:null,
      dataDate:/^\d{4}-\d{2}-\d{2}$/.test(payload?.data_date||"")?payload.data_date:null
    };
  }

  function ratioBand(ratio){
    if(!finite(ratio))return{key:"unavailable",label:"資料暫時無法取得",tone:"neutral"};
    if(ratio>=160)return{key:"general",label:"安全墊一般",tone:"calm"};
    if(ratio>=150)return{key:"shrinking",label:"安全墊縮小",tone:"warning"};
    if(ratio>=140)return{key:"pressure",label:"壓力升高",tone:"warning"};
    if(ratio>=130)return{key:"reference",label:"接近法規參考區",tone:"orange"};
    return{key:"extreme",label:"極端壓力區",tone:"danger"};
  }

  function classifyRisk(input={}){
    const balanceDirection=finite(input.balanceDailyChange)?Math.sign(input.balanceDailyChange):0;
    const ratioDirection=finite(input.maintenanceDailyChange)?Math.sign(input.maintenanceDailyChange):0;
    const band=ratioBand(input.maintenanceValue);
    let key="incomplete",label="資料不完整",tone=band.tone,summary="融資餘額與推估維持率需一起觀察，目前資料不足以形成完整判斷。";
    if(balanceDirection>0&&ratioDirection<0){
      key="risk_high";label="槓桿壓力升高";tone="warning";summary="融資餘額增加、推估維持率下降，代表槓桿增加且融資戶壓力升高。";
    }else if(balanceDirection<0&&ratioDirection<0){
      key="deleverage";label="去槓桿壓力";tone="orange";summary="融資餘額與推估維持率同步下降，可能出現停損、減碼或被動去槓桿，短期壓力仍高。";
    }else if(balanceDirection<0&&ratioDirection>0){
      key="improving";label="壓力改善中";tone="calm";summary="融資餘額下降、推估維持率回升，槓桿壓力正逐步舒緩。";
    }else if(balanceDirection>0&&ratioDirection>0){
      key="neutral_crowding";label="中性、留意擁擠";tone="neutral";summary="市場上漲可能帶動融資增加，推估維持率同步回升，暫未見明顯壓力，但仍需觀察是否過度擁擠。";
    }else if(balanceDirection<0){
      key="balance_falling";label="融資退場";tone="orange";summary="融資餘額下降，但推估維持率趨勢樣本不足，先觀察去槓桿是否伴隨價格止穩。";
    }else if(balanceDirection>0){
      key="balance_rising";label="融資增加";tone="warning";summary="融資餘額增加，但推估維持率趨勢樣本不足，暫不判定壓力方向。";
    }
    if(finite(input.balanceChange20d)&&input.balanceChange20d>0&&balanceDirection>0)summary+=" 近20日融資亦偏增，須留意追價擁擠。";
    if(input.marketAcuteDrop&&["risk_high","deleverage"].includes(key))summary+=" 大盤同時急跌，短線壓力可能放大。";
    if(band.key==="reference")summary+=" 130%是個別信用帳戶的法規參考，不代表所有投資人必然追繳。";
    if(band.key==="extreme")summary+=" 數值低於130%僅表示估算壓力極高，不能推論個人帳戶狀態。";
    if(input.stale)return{key:"stale",label:"資料可能過期",tone:"warning",summary:`${summary} 資料已超過3個交易日，解讀需保守。`,band};
    return{key,label,tone,summary,band};
  }

  function maintenanceFearScore(ratio,percentileValue){
    if(finite(percentileValue))return clamp(100-percentileValue,0,100);
    if(!finite(ratio))return null;
    return clamp((190-ratio)/60*100,0,100);
  }

  function combineFear(baseFear,maintenanceFear,maxWeight=.15){
    if(!finite(baseFear))return finite(maintenanceFear)?maintenanceFear:null;
    if(!finite(maintenanceFear))return baseFear;
    const weight=clamp(maxWeight,0,.15);
    return baseFear*(1-weight)+maintenanceFear*weight;
  }

  return{finite,clamp,tradingDayAge,validatePayload,displayValues,ratioBand,classifyRisk,maintenanceFearScore,combineFear};
});
