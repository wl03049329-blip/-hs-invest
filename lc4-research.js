/* Descriptive research subpage. Never reads or writes financial storage. */
(()=>{'use strict';
 const S={bundle:null,pointer:null,returnFocus:null,loading:false,scroll:''};
 const $=s=>document.querySelector(s), el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 const pct=(x,d=1)=>typeof x==='number'&&Number.isFinite(x)?(x*100).toFixed(d)+'%':'—';
 const num=x=>typeof x==='number'&&Number.isFinite(x)?x.toFixed(1):'—';
 const dialog=el('dialog',undefined,'lc4r');dialog.id='lc4-research';dialog.setAttribute('aria-labelledby','lc4r-title');
 const header=el('header');const title=el('h2','00631L 研究雷達');title.id='lc4r-title';
 const close=el('button','關閉 ×');close.type='button';close.setAttribute('aria-label','關閉研究雷達');
 header.append(title,close);const content=el('div',undefined,'lc4r-content');content.setAttribute('aria-live','polite');
 const toolbar=el('div',undefined,'lc4r-toolbar'),refresh=el('button','檢查研究資料');refresh.type='button';
 const notice=el('p','描述性研究 · 非買進訊號 · 不配置資金','lc4r-notice');toolbar.append(notice,refresh);dialog.append(header,toolbar,content);document.body.append(dialog);
 function section(title){const n=el('section');n.append(el('h3',title));content.append(n);return n;}
 function line(parent,label,value){const row=el('div',undefined,'lc4r-row');row.append(el('span',label),el('strong',value));parent.append(row);}
 function unlock(){document.body.style.overflow=S.scroll;const target=S.returnFocus;if(target?.isConnected)target.focus({preventScroll:true});}
 close.onclick=()=>dialog.close();dialog.addEventListener('close',unlock);dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
 async function json(url){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);try{const res=await fetch(url,{cache:'no-store',signal:controller.signal});if(!res.ok)throw Error('HTTP_'+res.status);const text=await res.text();if(text.length>8000000)throw Error('RESEARCH_BODY_TOO_LARGE');return{value:JSON.parse(text),text};}finally{clearTimeout(timer);}}
 function verify(b,p){if(b.schema!=='HS_LC4_RESEARCH_BUNDLE_V1'||b.research_only!==true||b.writer!==false||b.entry_authorized!==false||b.score!==null||b.asof!==p.asof||b.revision!==p.revision||!/^\d{4}-\d{2}-\d{2}$/.test(b.asof)||!b.description?.radar||!b.description?.risk)throw Error('RESEARCH_CONTRACT_INVALID');
  const r=b.description.radar;if(r.writer!==false||r.score!==null||r.entry.authorized!==false||r.asof!==b.asof||r.market.date!==b.asof||r.tiers!==null||r.predictive_probability!==null)throw Error('RESEARCH_SAFETY_CONTRACT_INVALID');
  for(const h of['5','10','20']){const x=b.description.risk[h];if(!x||!Number.isInteger(x.n)||x.n<0||x.further_break_count<0||x.further_break_count>x.n||x.not_a_forecast!==true)throw Error('HISTORICAL_SAMPLE_INVALID');}}
 function render(shadow,operation){content.replaceChildren();const b=S.bundle,r=b.description.radar;
  const status=section('資料與權限');status.dataset.lc4Health='true';
  const due=Date.parse(b.next_source_check_due),stale=!Number.isFinite(due)||Date.now()>=due;
  status.append(el('p',`${b.asof} 完成日線 · ${stale?'資料可能過期，等待來源核驗':'已驗證歷史研究資料，非即時行情'}`,stale?'lc4r-warn':''));
  line(status,'研究版本',b.model);line(status,'實際產生時間',new Date(b.produced_at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}));
  line(status,'最近來源檢查',operation?.checked_at?new Date(operation.checked_at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'無法確認');
  if(!operation||operation.status==='RESEARCH_UPDATE_BLOCKED')status.append(el('p','最近來源更新尚未核驗成功，僅保留標示日期的研究資料。','lc4r-warn'));
  const latched=r.data.canonical_incidents>0;
  line(status,'正式 V1 Shadow',latched?'FAIL_CLOSED · 完整性審核未完成':shadow?.status==='FAIL_CLOSED'?'FAIL_CLOSED':'未能確認正式可用狀態');
  line(status,'正式 Shadow 資料日期',shadow?.latest_data_date||'無法確認');
  line(status,'待審事故／舊狀態快取',`${r.data.canonical_incidents}／${r.data.cached_incidents}（不同時點）`);
  status.append(el('p','研究資料重建不會解除正式封鎖；沒有正式 L-C4 分數、加碼級距或進場資格。','lc4r-warn'));
  const cards=section('市場觀察');cards.classList.add('lc4r-grid');
  for(const[label,value,detail]of[
   ['五日急跌歷史百分位',num(r.opportunity.positive_decline_percentile)+' 百分位',`五日漲跌 ${pct(r.opportunity.return5)} · 僅比較歷史下跌日`],
   ['120 日／240 日回撤',pct(r.opportunity.drawdown.dd120.drawdown)+'／'+pct(r.opportunity.drawdown.dd240.drawdown),'相對各期收盤高點，不是買點分數'],
   ['0050 市場趨勢',({BULL:'多頭環境',BEAR:'空頭環境',RANGE:'震盪環境'})[r.market.regime]||'資料不足',`${r.market.date} · 股息調整指標`],
   ['止跌觀察',r.stabilization.breakout_observed===true?'突破前五日高（僅觀察）':r.stabilization.breakout_observed===false?'尚未突破前五日高':'資料不足','不等同已確認止跌或進場資格']]){
    const n=el('article');n.append(el('h4',label),el('strong',value),el('small',detail));cards.append(n);}
  const risk=section('急殺後的歷史風險');risk.append(el('p',`固定 ${b.description.fixed_event_count} 個既有事件；樣本已用於研究，不是全新樣本外驗證。歷史比例不是未來機率。`));
  const tabs=el('div',undefined,'lc4r-tabs');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','歷史觀察期間');const details=el('div');
  function horizon(h){const x=b.description.risk[h];details.replaceChildren();tabs.querySelectorAll('button').forEach(n=>n.setAttribute('aria-pressed',String(n.dataset.h===h)));
   line(details,'成熟樣本／未完整',`${x.n}／${x.pending}`);line(details,'再次跌破觸發日低點',`${x.further_break_count}／${x.n}（歷史 ${x.n?pct(x.further_break_count/x.n):'—'}）`);
   line(details,'最大不利波動中位數',pct(x.mae_median));line(details,'最差最大不利波動',pct(x.mae_min));
   details.append(el('p','波動口徑：觸發後下一交易日開盤至期間最低價；不含成本、非帳戶回撤，不能當成可成交的最低點。'));
   for(const[label,event]of[['典型事件（事後中位數附近）',x.typical],['最差事件（事後展示）',x.worst]])if(event){const n=el('article');n.append(el('h4',`${label} · ${event.date}`));line(n,'最大不利波動',pct(event.low_vs_entry_open));line(n,'期末相對觸發日收盤',pct(event.close_return));details.append(n);}
  }
  for(const h of['5','10','20']){const button=el('button',h+' 日');button.type='button';button.dataset.h=h;button.onclick=()=>horizon(h);tabs.append(button);}risk.append(tabs,details);horizon('5');
  const source=section('來源與研究限制');source.append(el('p',`TWSE 官方日線研究副本，截至 ${b.asof}。00631L 分割於 2026-03-31 按 22：1 僅調整一次；0050 趨勢含已審核股息。`),el('p',`222 個衝突日期、14 個缺漏日期已留存逐日核驗；來源原始內部原因及歷史當時發布版本仍不可驗證。訓練截止 ${r.training_end}。`),el('p','樣本少、事件相依、模型比較與資料修訂偏差仍存在；急跌高分位不代表一定反彈。'),el('small',`資料 SHA-256：${S.pointer.sha256}`));
 }
 async function load(){if(S.loading)return;S.loading=true;refresh.disabled=true;try{
   const {value:p}=await json('data/lc4-research/latest.json');
   if(p.schema!=='HS_LC4_RESEARCH_POINTER_V1'||!/^snapshots\/[0-9a-z.-]+\.json$/.test(p.path)||!/^[a-f0-9]{64}$/.test(p.sha256))throw Error('RESEARCH_POINTER_INVALID');
   const {value:b,text}=await json('data/lc4-research/'+p.path),bytes=new TextEncoder().encode(text),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
   if(hash!==p.sha256||bytes.length!==p.bytes)throw Error('RESEARCH_HASH_MISMATCH');verify(b,p);
   let shadow=null,operation=null;try{shadow=(await json('research/hs_leverage/forward/daily-status.json')).value;}catch{}
   try{operation=(await json('data/lc4-research/status.json')).value;if(operation.bundle_sha256!==p.sha256)operation=null;}catch{}
   S.bundle=b;S.pointer=p;render(shadow,operation);
  }catch(e){content.replaceChildren(el('p','研究資料目前無法核驗，未顯示未確認數值。','lc4r-warn'),el('small',String(e.message)));}
  finally{S.loading=false;refresh.disabled=false;}}
 refresh.onclick=load;
 function open(trigger){if(dialog.open)return;S.returnFocus=trigger;S.scroll=document.body.style.overflow;document.body.style.overflow='hidden';dialog.showModal();content.replaceChildren(el('p','正在核驗研究資料…'));close.focus();load();}
 document.addEventListener('click',e=>{const trigger=e.target.closest('[data-lc4-research-open]');if(trigger){e.preventDefault();open(trigger);}});
 window.addEventListener('online',()=>{if(dialog.open)load();});document.addEventListener('visibilitychange',()=>{if(!document.hidden&&dialog.open)load();});
})();
