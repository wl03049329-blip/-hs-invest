(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.HSMarginRiskCore=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  const finite=value=>typeof value==="number"&&Number.isFinite(value);
  const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));

  function tradingDayAge(dataDate,today){
    const start=new Date(`${dataDate}T00:00:00+08:00`);
    const end=new Date(`${today}T00:00:00+08:00`);
    if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||start>end)return null;
    let cursor=new Date(start),days=0;
    while(cursor<end){
      cursor.setUTCDate(cursor.getUTCDate()+1);
      const label=new Intl.DateTimeFormat("en-US",{timeZone:"Asia/Taipei",weekday:"short"}).format(cursor);
      if(["Mon","Tue","Wed","Thu","Fri"].includes(label))days+=1;
    }
    return days;
  }

  function validatePayload(payload,today){
    if(!payload||typeof payload!=="object")return null;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(payload.data_date||""))return null;
    const balance=payload.margin_balance||{},maintenance=payload.maintenance_ratio||{};
    if(!finite(balance.value)||balance.value<=0)return null;
    const ratio=finite(maintenance.value)&&maintenance.value>0&&maintenance.value<1000?maintenance.value:null;
    const age=tradingDayAge(payload.data_date,today);
    return{
      ...payload,
      margin_balance:{...balance},
      maintenance_ratio:{...maintenance,value:ratio},
      trading_day_age:age,
      stale:Number.isFinite(age)&&age>3
    };
  }

  function classifyRisk(input={}){
    const balanceDirection=finite(input.balanceDailyChange)?Math.sign(input.balanceDailyChange):0;
    const ratioDirection=finite(input.maintenanceDailyChange)?Math.sign(input.maintenanceDailyChange):0;
    let key="incomplete",label="資料不完整",tone="neutral",summary="融資維持率資料暫時無法取得，暫以融資餘額與價格趨勢觀察。";
    if(balanceDirection>0&&ratioDirection<0){
      key="risk_high";label="風險升高";tone="warning";summary="槓桿增加、融資戶壓力升高。";
    }else if(balanceDirection<0&&ratioDirection<0){
      key="deleverage";label="去槓桿壓力";tone="orange";summary="可能出現停損、減碼或被動去槓桿，短期壓力仍高。";
    }else if(balanceDirection<0&&ratioDirection>0){
      key="improving";label="改善中";tone="calm";summary="槓桿壓力逐步舒緩。";
    }else if(balanceDirection>0&&ratioDirection>0){
      key="neutral_crowding";label="中性";tone="neutral";summary="市場上漲帶動融資增加，暫未出現明顯壓力，但需觀察是否過度擁擠。";
    }else if(balanceDirection<0){
      key="balance_falling";label="去槓桿觀察";tone="orange";summary="融資餘額下降，市場正在降低槓桿；維持率缺值，仍需搭配價格是否止跌。";
    }else if(balanceDirection>0){
      key="balance_rising";label="擁擠度觀察";tone="warning";summary="融資餘額增加，追價與擁擠風險需持續觀察；維持率資料目前缺值。";
    }
    if(input.stale)return{key:"stale",label:"資料可能過期",tone:"warning",summary:`${summary} 資料已超過 3 個交易日，解讀僅供參考。`};
    if(input.marketAcuteDrop&&["risk_high","deleverage"].includes(key))summary+= " 市場同步急跌，短線波動風險較高。";
    if(finite(input.balanceChange20d)&&input.balanceChange20d>5&&key==="risk_high")summary+=" 近 20 日融資也持續增加，籌碼較擁擠。";
    return{key,label,tone,summary};
  }

  function maintenanceFearScore(ratio,percentile){
    if(finite(percentile))return clamp(100-percentile,0,100);
    if(!finite(ratio))return null;
    return clamp((190-ratio)/60*100,0,100);
  }

  function combineFear(baseFear,maintenanceFear,maxWeight=.15){
    if(!finite(baseFear))return finite(maintenanceFear)?maintenanceFear:null;
    if(!finite(maintenanceFear))return baseFear;
    const weight=clamp(maxWeight,0,.15);
    return baseFear*(1-weight)+maintenanceFear*weight;
  }

  return{finite,clamp,tradingDayAge,validatePayload,classifyRisk,maintenanceFearScore,combineFear};
});
