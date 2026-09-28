(function(root,factory){
  const api=factory();
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  if(root)root.HSLeverageStateView=api;
})(typeof window!=="undefined"?window:globalThis,function(){
  "use strict";
  const validNumber=value=>typeof value==="number"&&Number.isFinite(value)?value:null;
  const dateOf=row=>/^\d{4}-\d{2}-\d{2}$/.test(String(row?.date||""))?row.date:null;
  const closeOf=row=>validNumber(Number(row?.close));
  const lowOf=row=>validNumber(Number(row?.min??row?.low));
  function completedRows(rows){
    return (Array.isArray(rows)?rows:[]).filter(row=>dateOf(row)&&closeOf(row)>0&&lowOf(row)>0)
      .slice().sort((a,b)=>a.date.localeCompare(b.date));
  }
  function drawdownAt(rows,index,window){
    if(index<window-1)return null;
    let peak=0;
    for(let i=index-window+1;i<=index;i++)peak=Math.max(peak,closeOf(rows[i]));
    return peak>0?100*(1-closeOf(rows[index])/peak):null;
  }
  function deepDrop(rows){
    const clean=completedRows(rows),last=clean.length-1;
    function period(window){
      const current=drawdownAt(clean,last,window);
      if(current===null)return null;
      const past=[];
      for(let i=window-1;i<last;i++){
        const value=drawdownAt(clean,i,window);
        if(value!==null)past.push(value);
      }
      if(past.length<252)return{drawdown:-current,percentile:null};
      return{drawdown:-current,percentile:100*past.filter(value=>value<=current).length/past.length};
    }
    const p120=period(120),p240=period(240),primary=p120?.percentile!=null?p120:p240;
    // Phase 2's 60/70/80 research populations are descriptive ranks, not trading cutoffs.
    const rank=primary?.percentile;
    const label=rank==null?"資料不足":rank>=80?"罕見深跌":rank>=70?"深跌":rank>=60?"偏深":"一般相對區間";
    return{date:clean[last]?.date||null,p120,p240,primary:primary||null,label};
  }
  function riskContraction(rows){
    const clean=completedRows(rows),i=clean.length-1;
    const close=index=>closeOf(clean[index]);
    const mean=(start,end)=>{let sum=0;for(let j=start;j<=end;j++)sum+=close(j);return sum/(end-start+1)};
    const noLow3=i>=5?Array.from({length:3},(_,offset)=>{
      const day=i-offset,prior=Math.min(...clean.slice(day-3,day).map(lowOf));
      return lowOf(clean[day])>prior;
    }).every(Boolean):null;
    const return5=i>=5?close(i)>close(i-5):null;
    const aboveMa5=i>=4?close(i)>mean(i-4,i):null;
    function volAt(end){
      if(end<20)return null;
      const values=[];
      for(let j=end-19;j<=end;j++)values.push(close(j)/close(j-1)-1);
      const avg=values.reduce((a,b)=>a+b,0)/values.length;
      return Math.sqrt(values.reduce((sum,value)=>sum+(value-avg)**2,0)/values.length);
    }
    const previousVol=volAt(i-1),currentVol=volAt(i);
    const volFalling=previousVol===null||currentVol===null?null:currentVol<previousVol;
    const checks=[
      {key:"no_low_3",label:"連續 3 日未破 3 日舊低",value:noLow3},
      {key:"ret5_pos",label:"5 日報酬翻正",value:return5},
      {key:"above_ma5",label:"收盤站回 MA5",value:aboveMa5},
      {key:"vol20_falling",label:"20 日波動下降",value:volFalling}
    ];
    const complete=checks.every(check=>check.value!==null),on=checks.filter(check=>check.value===true).length;
    return{date:clean[i]?.date||null,checks,on:complete?on:null,label:!complete?"資料不足":on===4?"明顯收斂":on>=2?"部分收斂":"未收斂"};
  }
  function officialStatus(snapshot,now=Date.now()){
    if(snapshot?.schema_version!==1||snapshot.symbol!=="00631L"||snapshot.strategy_id!=="HS_LEVERAGE_C_V1")return null;
    const price=snapshot.price,shadow=snapshot.shadow,outcomes=snapshot.outcomes,capital=snapshot.capital;
    if(!price||!shadow||!outcomes||!capital||!dateOf({date:price.latest_completed_bar})||!["CURRENT","STALE","UNKNOWN"].includes(price.freshness))return null;
    const staleAfter=Date.parse(price.stale_after||"");
    if(price.freshness==="CURRENT"&&!Number.isFinite(staleAfter))return null;
    if(shadow.latest_evaluation_date!==null&&!dateOf({date:shadow.latest_evaluation_date}))return null;
    if(shadow.triggered!==null&&typeof shadow.triggered!=="boolean")return null;
    for(const value of [shadow.eligible_count,shadow.observation_count,...[20,40,60].flatMap(h=>[outcomes[`pending_${h}d`],outcomes[`completed_${h}d`]])]){
      if(value!==null&&(!Number.isInteger(value)||value<0))return null;
    }
    if(price.freshness==="CURRENT"&&now>=staleAfter)return{...snapshot,price:{...price,freshness:"STALE"}};
    return snapshot;
  }
  const esc=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[char]);
  const dateText=value=>dateOf({date:value})||"資料不足";
  const countText=value=>Number.isInteger(value)&&value>=0?String(value):"資料不足";
  const pct=value=>Number.isFinite(value)?`${value.toFixed(1)}%`:"資料不足";
  function renderHtml(item,snapshot,operationalRows){
    const official=officialStatus(snapshot);
    const rows=Array.isArray(operationalRows)?operationalRows:[];
    const deep=deepDrop(rows),risk=riskContraction(rows),price=official?.price,shadow=official?.shadow;
    const priceAligned=!!price&&deep.date===price.latest_completed_bar;
    const fresh=priceAligned&&price.freshness==="CURRENT";
    const currentShadow=fresh&&shadow?.latest_evaluation_date===price.latest_completed_bar&&typeof shadow.triggered==="boolean";
    const shadowLabel=!official?"正式狀態資料不足":price?.freshness==="STALE"?"資料待更新":!currentShadow?"Shadow 尚未更新":shadow.triggered?"已觸發":"未觸發";
    const deepLabel=!fresh?"資料待更新":deep.label;
    const riskLabel=!fresh?"資料待更新":risk.label;
    const checks=risk.checks.map(check=>`<li><span aria-hidden="true">${check.value===null?"—":check.value?"✓":"×"}</span>${esc(check.label)}：${check.value===null?"資料不足":check.value?"符合":"尚未符合"}</li>`).join("");
    const safeCount=(object,key)=>countText(object?.[key]);
    const outcome=official?.outcomes;
    const detail=official?`<dl><div><dt>正式 Shadow 狀態</dt><dd>${esc(shadow.status)}</dd></div><div><dt>最新完成日線</dt><dd>${esc(dateText(price.latest_completed_bar))}｜${price.freshness==="CURRENT"?"最新":price.freshness==="STALE"?"資料待更新":"新鮮度未知"}</dd></div><div><dt>最新 Shadow 評估日</dt><dd>${esc(dateText(shadow.latest_evaluation_date))}</dd></div><div><dt>Forward observations</dt><dd>${safeCount(shadow,"observation_count")}</dd></div><div><dt>Eligible 次數</dt><dd>${safeCount(shadow,"eligible_count")}</dd></div><div><dt>Pending 20D / 40D / 60D</dt><dd>${[20,40,60].map(h=>safeCount(outcome,`pending_${h}d`)).join(" / ")}</dd></div><div><dt>Completed 20D / 40D / 60D</dt><dd>${[20,40,60].map(h=>safeCount(outcome,`completed_${h}d`)).join(" / ")}</dd></div><div><dt>最近驗證時間</dt><dd>${esc(official.workflow?.validation_at||"資料不足")}</dd></div><div><dt>最近成功 workflow 時間</dt><dd>${esc(official.workflow?.last_successful_validation_at||"資料不足")}</dd></div><div><dt>Production signal</dt><dd>${official.capital.production_signal===false?"否":official.capital.production_signal===true?"是":"資料不足"}</dd></div><div><dt>Live capital</dt><dd>${official.capital.live_capital===false?"否":official.capital.live_capital===true?"是":"資料不足"}</dd></div><div><dt>Capital allocation</dt><dd>${Number.isFinite(official.capital.allocation_pct)?`${official.capital.allocation_pct}%`:"資料不足"}</dd></div></dl>`:"<p>正式狀態 snapshot 不可用，不以研究紀錄替代。</p>";
    const trigger=shadow?.triggered===true&&currentShadow?`觸發日 ${esc(dateText(shadow.trigger_date))}｜threshold ${pct(shadow.threshold)}｜signal value ${pct(shadow.signal_value)}`:currentShadow?"目前尚未符合 V1 急跌條件。":"尚無同日正式 Shadow 評估；不可視為已觸發或未觸發。";
    const summary=!fresh?`完成日線或 Shadow snapshot 資料待更新，目前不作最新狀態判讀。`:
      !currentShadow?`日線截至 ${esc(deep.date)}；正式 Shadow 尚無同日評估紀錄。`:
      `目前回撤${esc(deep.label)}，V1 Shadow ${esc(shadowLabel)}，短期風險${esc(risk.label)}。`;
    return`<section class="leverageStateReading" aria-label="00631L 槓桿狀態判讀"><header><h4>00631L 槓桿狀態判讀</h4><p>深跌程度 × V1 Shadow × 風險收斂</p><small>正式完成日線 ${esc(dateText(price?.latest_completed_bar))}｜Shadow 評估 ${esc(dateText(shadow?.latest_evaluation_date))}</small></header><div class="leverageStateGrid"><article><span>深跌程度</span><strong>${esc(deepLabel)}</strong><b>截至該日回撤 ${pct(deep.primary?.drawdown)}</b><p>120D 歷史百分位 ${pct(deep.p120?.percentile)}</p><p>${Number.isFinite(deep.p120?.percentile)?`代表該日跌幅比自己過去約 ${deep.p120.percentile.toFixed(0)}% 的有效交易日更深。`:"歷史資料不足，無法計算相對位置。"}</p><small>僅歷史相對位置，不是買點分數</small></article><article><span>V1 Shadow</span><strong>${esc(shadowLabel)}</strong><b>正式日線評估：${currentShadow?shadow.triggered?"已觸發":"未觸發":"資料不足"}</b><p>最近評估 ${esc(dateText(shadow?.latest_evaluation_date))}</p><p>${trigger}</p><small>Forward 狀態：${esc(shadow?.status||"資料不足")}</small></article><article><span>風險收斂</span><strong>${esc(riskLabel)}</strong><b>${fresh&&risk.on!==null?`${risk.on} / 4 項客觀條件`:"資料不足"}</b><ul>${checks}</ul><small>只描述已發生日線，不是回穩買點</small></article></div><p class="leverageStateSummary">${summary}</p><details class="leverageStateDisclosure"><summary>查看 00631L Shadow 驗證</summary>${detail}</details><details class="leverageStateDisclosure"><summary>研究說明</summary><p>Phase 1：單一深跌總分 — 未採用。Phase 2：回穩確認分數 — 未採用。</p><p>高分與未來報酬沒有穩定單調關係，獨立事件樣本不足；研究結果不參與正式訊號。</p><p>240D 歷史百分位：${pct(deep.p240?.percentile)}；60 / 70 / 80 百分位僅作研究分層描述。</p></details></section>`;
  }
  return Object.freeze({deepDrop,riskContraction,officialStatus,renderHtml});
});
