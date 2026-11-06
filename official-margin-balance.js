(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.HSOfficialMargin=api;
})(typeof globalThis==="object"?globalThis:this,function(){
  "use strict";
  const names={twse:"上市",tpex:"上櫃",combined:"兩市合計"};
  const labels={ready:"官方資料已核對",waiting:"待更新",stale:"資料可能過期",failed:"官方資料驗證／載入失敗",loading:"載入中",missing:"資料暫缺"};
  const digest=/^[a-f0-9]{64}$/;
  const formatter=new Intl.NumberFormat("zh-TW",{minimumFractionDigits:2,maximumFractionDigits:2});
  const money=n=>Number.isSafeInteger(n)?formatter.format(n/1e8):"—";
  const change=n=>!Number.isSafeInteger(n)?"—":n>0?`↑ +${money(n)}`:n<0?`↓ −${money(-n)}`:"持平 0.00";
  const dayText=()=>new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  function dateOK(s){
    return typeof s==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))
      &&new Date(s).toISOString().slice(0,10)===s;
  }
  function parse(p,today){
    if(!dateOK(today)||p?.schema!=="HS_OFFICIAL_MARGIN_BALANCE_V1"||!Array.isArray(p.sessions)||!p.sessions.length||p.sessions.length>72||
       p.sessions.some((d,i)=>!dateOK(d)||d>today||(i>0&&d<=p.sessions[i-1])))throw Error("MARGIN_CALENDAR_INVALID");
    const maps={twse:new Map(),tpex:new Map()};
    for(const market of ["twse","tpex"]){
      if(!Array.isArray(p[market])||p[market].length>p.sessions.length)throw Error("MARGIN_ROWS_INVALID");
      let prior="";
      for(const row of p[market]){
        if(!row||!p.sessions.includes(row.date)||row.date<=prior||!Number.isSafeInteger(row.amount_ntd)||row.amount_ntd<=0||
           row.amount_ntd%1000!==0||typeof row.sha256!=="string"||!digest.test(row.sha256)||
           (market==="tpex"&&(typeof row.board_sha256!=="string"||!digest.test(row.board_sha256))))throw Error("MARGIN_ROW_INVALID");
        maps[market].set(row.date,row.amount_ntd);prior=row.date;
      }
    }
    const states={};
    if(p.source_status!==undefined){
      for(const market of ["twse","tpex"]){
        const status=p.source_status?.[market];
        if(!["ready","waiting","failed"].includes(status)||
           (status==="ready"&&!maps[market].has(p.sessions.at(-1))))throw Error("MARGIN_SOURCE_STATUS_INVALID");
        states[market]=status;
      }
    }
    return {sessions:p.sessions.slice(),maps,states};
  }
  function marketView(data,market,today,limit=60){
    if(!data||!Object.hasOwn(names,market))return {rows:[],latest:null,status:"missing"};
    let previous=null;
    const aligned=data.sessions.map(date=>{
      const a=data.maps.twse.get(date),b=data.maps.tpex.get(date);
      const total=Number.isSafeInteger(a)&&Number.isSafeInteger(b)&&Number.isSafeInteger(a+b)?a+b:null;
      const amount=(market==="combined"?total:market==="twse"?a:b)??null;
      const delta=amount!==null&&previous!==null?amount-previous:null;
      previous=amount;
      return {date,amount,delta};
    });
    const history=aligned.filter(r=>r.amount!==null),latest=history.at(-1)||null;
    const age=latest?(Date.parse(today)-Date.parse(latest.date))/86400000:Infinity;
    const upstreamFailed=(market==="combined"?["twse","tpex"]:[market]).some(m=>data.states?.[m]==="failed");
    const status=upstreamFailed?"failed":!latest?"missing":age>4?"stale":latest.date!==data.sessions.at(-1)?"waiting":"ready";
    const rows=history.slice(-limit);
    const plot=rows.length?aligned.filter(r=>r.date>=rows[0].date&&r.date<=rows.at(-1).date):[];
    return {rows,plot,latest,status};
  }
  function start(doc,fetcher){
    const panel=doc.querySelector("#officialMarginObservation");
    if(!panel)return;
    let market="twse",limit=20,data=null,pending=null,issue="loading";
    const set=(sel,text)=>{const el=doc.querySelector(sel);if(el)el.textContent=text;};
    function render(){
      const today=dayText(),home=marketView(data,"twse",today),view=marketView(data,market,today,limit);
      const latest=view.latest, row=home.latest, state=issue||home.status;
      set("#homeMarginBalanceCard b",row?`${money(row.amount)} 億`:"—");
      set("#homeMarginBalanceCard small",row?`資料日 ${row.date.replaceAll("-","/")}`:"資料日期 —");
      set("#homeMarginBalanceCard [data-home-margin-change]",row&&row.delta!==null?`${change(row.delta)} 億`:"—");
      set("#homeMarginBalanceCard [data-home-margin-status]",labels[state]);
      const delta=doc.querySelector("#homeMarginBalanceCard [data-home-margin-change]");
      if(delta)delta.dataset.homeTone=row?.delta>0?"rise":row?.delta<0?"fall":"flat";
      const card=doc.querySelector("#homeMarginBalanceCard");if(card)card.dataset.officialState=state;
      set("#officialMarginValue",latest?`${money(latest.amount)} 億元`:"—");
      set("#officialMarginChange",latest&&latest.delta!==null?`較前交易日 ${change(latest.delta)} 億元`:"無同市場前交易日可比資料");
      set("#officialMarginStatus",`${names[market]} · ${labels[issue||view.status]}`);
      const dateLine=["twse","tpex"].map(m=>`${names[m]} ${marketView(data,m,today).latest?.date.replaceAll("-","/")||"—"}`).join(" ｜ ");
      set("#officialMarginDates",`資料日：${dateLine}${market==="combined"?` ｜ 同日合計 ${latest?.date.replaceAll("-","/")||"—"}`:""}`);
      set("#officialMarginCoverage",`可核對 ${view.rows.length}／${limit} 個交易日；缺日不補造。維持率尚未啟用。`);
      const body=panel.querySelector("tbody");
      body.replaceChildren(...[...view.rows].reverse().map(r=>{
        const tr=doc.createElement("tr");
        for(const text of [r.date.replaceAll("-","/"),money(r.amount),change(r.delta),"—"]){
          const td=doc.createElement("td");td.textContent=text;tr.append(td);
        }
        return tr;
      }));
      for(const b of panel.querySelectorAll("[data-margin-market]"))b.setAttribute("aria-pressed",String(b.dataset.marginMarket===market));
      for(const b of panel.querySelectorAll("[data-margin-limit]"))b.setAttribute("aria-pressed",String(Number(b.dataset.marginLimit)===limit));
      const chart=panel.querySelector("svg"),points=view.plot||[],ys=points.filter(p=>p.amount!==null).map(p=>p.amount);
      const min=Math.min(...ys),max=Math.max(...ys),spread=max-min||1;
      let pen=false;
      chart.querySelector("path").setAttribute("d",points.map((p,i)=>{
        if(p.amount===null){pen=false;return "";}
        const command=pen?"L":"M";pen=true;
        return `${command}${(8+304*i/Math.max(points.length-1,1)).toFixed(2)} ${(ys.length>1&&max!==min?94-76*(p.amount-min)/spread:56).toFixed(2)}`;
      }).join(" "));
      chart.toggleAttribute("hidden",ys.length<2);
      set("#officialMarginChartNote",ys.length>=2?`${points[0].date} 至 ${points.at(-1).date} · ${money(min)}–${money(max)} 億元`:"至少需兩日有效資料");
    }
    async function refresh(){
      if(pending)return pending;
      pending=(async()=>{
        const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),8000);
        try{
          const response=await fetcher("official-margin-balance.json",{cache:"no-store",signal:controller.signal});
          if(!response.ok)throw Error("HTTP");
          data=parse(await response.json(),dayText());
          issue="";
        }catch{issue="failed";}
        finally{clearTimeout(timer);pending=null;render();}
      })();
      return pending;
    }
    panel.addEventListener("click",event=>{
      const b=event.target.closest("[data-margin-market],[data-margin-limit]");
      if(!b)return;
      if(Object.hasOwn(names,b.dataset.marginMarket))market=b.dataset.marginMarket;
      if(["20","60"].includes(b.dataset.marginLimit))limit=Number(b.dataset.marginLimit);
      render();
    });
    doc.querySelector("#reload")?.addEventListener("click",refresh);
    doc.defaultView?.addEventListener("online",refresh);
    render();refresh();
  }
  return {parse,marketView,money,change,start};
});
