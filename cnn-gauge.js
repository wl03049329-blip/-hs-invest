/* CNN presentation only. Receives validated values; never fetches or scores. */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.HSCnnGauge=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  const BANDS=Object.freeze([
    {end:24,label:"極度恐懼",range:"0–24",color:"#665137"},
    {end:44,label:"恐懼",range:">24–44",color:"#8b7048"},
    {end:55,label:"中性",range:">44–55",color:"#747064"},
    {end:74,label:"貪婪",range:">55–74",color:"#9c8048"},
    {end:100,label:"極度貪婪",range:">74–100",color:"#b49761"}
  ].map(Object.freeze));
  const valid=value=>typeof value==="number"&&Number.isFinite(value)&&value>=0&&value<=100;
  const format=value=>valid(value)?new Intl.NumberFormat("zh-TW",{maximumFractionDigits:2}).format(value):"—";
  const angle=value=>valid(value)?value*1.8-90:null;
  function point(value,radius){const a=angle(value)*Math.PI/180;return{x:180+radius*Math.sin(a),y:170-radius*Math.cos(a)};}
  const n=value=>Number(value.toFixed(4));
  function arc(start,end){
    const a=point(start,132),b=point(end,132);
    return "M "+n(a.x)+" "+n(a.y)+" A 132 132 0 0 1 "+n(b.x)+" "+n(b.y);
  }
  function markup(compact=false){
    let start=0;
    const bands=BANDS.map((b,i)=>{const path='<path class="cnnGaugeBand" data-cnn-band="'+i+'" d="'+arc(start+(i?.45:0),b.end-(i<4?.45:0))+'" stroke="'+b.color+'"/>';start=b.end;return path;}).join("");
    const ticks=compact?"":[0,10,20,25,30,40,50,60,70,75,80,90,100].map(value=>{
      const major=value%25===0,a=point(value,145),b=point(value,major?153:149),t=point(value,165);
      return '<path class="cnnGaugeTick" d="M '+n(a.x)+' '+n(a.y)+' L '+n(b.x)+' '+n(b.y)+'"/>'+(major?'<text class="cnnGaugeTickLabel" x="'+n(t.x)+'" y="'+n(t.y+4)+'" text-anchor="middle">'+value+'</text>':"");
    }).join("");
    const tag=compact?"span":"figure";
    return '<'+tag+' class="cnnGauge'+(compact?' cnnGaugeCompact':'')+'" data-cnn-gauge data-empty="true"><svg viewBox="0 0 360 190" '+(compact?'aria-hidden="true"':'role="img" aria-label="CNN 情緒資料暫缺；沒有可驗證的指針位置"')+'><path class="cnnGaugeTrack" d="M 48 170 A 132 132 0 0 1 312 170"/>'+bands+ticks+'<g class="cnnGaugeNeedle" data-cnn-needle visibility="hidden"><path d="M 176 170 L 180 54 L 184 170 Z"/></g><circle class="cnnGaugeHubRim" cx="180" cy="170" r="12"/><circle class="cnnGaugeHub" cx="180" cy="170" r="5"/></svg>'+(compact?'':'<figcaption class="cnnGaugeReadout"><div><output data-cnn-value>—</output><small>/ 100</small></div><strong data-cnn-label>資料暫缺</strong></figcaption><ul class="cnnGaugeLegend" aria-label="五個情緒區間">'+BANDS.map((b,i)=>'<li data-cnn-zone="'+i+'" style="--cnn-zone:'+b.color+'"><i aria-hidden="true"></i><span>'+b.label+'</span><small>'+b.range+'</small></li>').join("")+'</ul>')+'</'+tag+'>';
  }
  function update(host,cnn,{compact=false}={}){
    if(!host)return;
    if(!host.querySelector("[data-cnn-gauge]"))host.innerHTML=markup(compact);
    const figure=host.querySelector("[data-cnn-gauge]"),needle=host.querySelector("[data-cnn-needle]"),score=cnn?.score,available=valid(score);
    figure.dataset.empty=String(!available);figure.dataset.score=available?String(score):"";
    needle.setAttribute("visibility",available?"visible":"hidden");
    if(available){needle.style.transform="rotate("+angle(score)+"deg)";needle.dataset.angle=String(angle(score));}
    else{needle.style.removeProperty("transform");delete needle.dataset.angle;}
    const value=host.querySelector("[data-cnn-value]"),label=host.querySelector("[data-cnn-label]");
    if(value)value.textContent=format(score);
    if(label)label.textContent=available?cnn.label:"資料暫缺";
    if(!compact)host.querySelector("svg").setAttribute("aria-label",available?"CNN 恐懼貪婪 "+format(score)+" 分，"+cnn.label:"CNN 情緒資料暫缺；沒有可驗證的指針位置");
    const zone=available?BANDS.findIndex(b=>score<=b.end):-1;
    host.querySelectorAll("[data-cnn-band]").forEach((el,i)=>{el.dataset.active=String(i===zone);});
    host.querySelectorAll("[data-cnn-zone]").forEach((el,i)=>{el.dataset.active=String(i===zone);if(i===zone)el.setAttribute("aria-current","true");else el.removeAttribute("aria-current");});
  }
  function comparison(score,previous){
    if(!valid(score)||!valid(previous))return"—";
    const difference=Number((score-previous).toFixed(2));
    return(difference>0?"+":"")+new Intl.NumberFormat("zh-TW",{maximumFractionDigits:2}).format(difference);
  }
  // Coverage is a presentation contract, not a market score or trading signal.
  function marketCoverage({values={},marginStatus,futures={},futuresStatus,cnnView={}}={}){
    const tmf=futures?.estimated_non_institutional_tmf,foreign=futures?.foreign_tx;
    const checks=[
      ["台股融資",Number.isFinite(values.financingPrincipal)&&values.financingPrincipal>0,marginStatus],
      ["維持率",Number.isFinite(values.maintenanceRatio)&&values.maintenanceRatio>0,marginStatus],
      ["外資期貨",Number.isFinite(foreign?.net),futuresStatus],
      ["散戶部位",Number.isFinite(tmf?.long)&&tmf.long>=0&&Number.isFinite(tmf?.short)&&tmf.short>0,futuresStatus]
    ];
    const missing=checks.filter(([,valid])=>!valid).map(([name])=>name);
    const outdated=checks.filter(([,valid,status])=>valid&&status!=="LATEST").map(([name])=>name);
    const cnn=cnnView.cnn;
    const overseas=cnn?"美股 CNN "+format(cnn.score)+"（"+cnn.label+"；"+cnnView.status+"）。":"美股 CNN 資料暫缺。";
    const value=missing.length?"資料不足":outdated.length?"資料待更新":"資料齊備";
    const detail=missing.length?"台股缺少："+missing.join("、")+"。":outdated.length?"台股待更新："+outdated.join("、")+"。":"台股四項資料齊備，仍須分別觀察。";
    return{value,hint:"不以美股代判台股",missing,outdated,text:overseas+detail+"不對缺漏指標推論多空，亦不以 CNN 單獨作完整市場結論。"};
  }
  return{BANDS,valid,format,angle,point,markup,update,comparison,marketCoverage};
});
