/* Descriptive research subpage. Never reads or writes financial storage. */
(()=>{'use strict';
 const S={bundle:null,pointer:null,returnFocus:null,loading:false,scroll:'',stats:null,renderedAt:0};
 const $=s=>document.querySelector(s), el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 const pct=(x,d=1)=>typeof x==='number'&&Number.isFinite(x)?(x*100).toFixed(d)+'%':'—';
 const num=x=>typeof x==='number'&&Number.isFinite(x)?x.toFixed(1):'—';
 const dialog=el('dialog',undefined,'lc4r');dialog.id='lc4-research';dialog.setAttribute('aria-labelledby','lc4r-title');
 const header=el('header');const title=el('h2','00631L 急跌反彈雷達');title.id='lc4r-title';
 const close=el('button','關閉 ×');close.type='button';close.setAttribute('aria-label','關閉研究雷達');
 header.append(title,close);const content=el('div',undefined,'lc4r-content');content.setAttribute('aria-live','polite');
 const toolbar=el('div',undefined,'lc4r-toolbar'),refresh=el('button','檢查研究資料');refresh.type='button';
 const notice=el('p','描述性研究 · 非買進訊號 · 不配置資金','lc4r-notice');toolbar.append(notice,refresh);dialog.append(header,toolbar,content);document.body.append(dialog);
 function section(title){const n=el('section');n.append(el('h3',title));content.append(n);return n;}
 function line(parent,label,value){const row=el('div',undefined,'lc4r-row');row.append(el('span',label),el('strong',value));parent.append(row);}
 const signed=x=>typeof x==='number'&&Number.isFinite(x)?(x>0?'+':'')+pct(x,2):'資料不足';
 const fraction=(k,n)=>n?`${pct(k/n,2)}（${k}／${n}）`:'資料不足';
 function legacy(host){const b=S.bundle,s=S.stats;
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const usable=false; // Frozen research is historical only, never current L-Radar evidence.
  const t=HSLC4RadarV2.threshold(s.return5,b.asof,today,usable),state=({REACHED:'已達極端急跌警戒線',BELOW:'尚未達極端急跌警戒線',INSUFFICIENT:'資料不足，等待核驗',EXPIRED:'年度門檻已到期或不適用'})[t.state];
  host.dataset.state=t.state;const head=el('div',undefined,'lc4v2-meta');head.append(el('span',`${b.asof} 收盤 · ${usable?'來源已核驗':'歷史資料，待核驗更新'}`),el('strong',`NT$ ${s.close.toFixed(2)}`));host.append(head);
  const crash=el('section',undefined,'lc4v2-crash');crash.append(el('span','最近 5 個交易日'),el('strong',signed(s.return5),'lc4v2-big'),el('b',state,'lc4v2-status'));
  const graph=el('figure',undefined,'lc4v2-threshold');graph.setAttribute('role','img');graph.setAttribute('aria-label',`五日漲跌 ${signed(s.return5)}；警戒線 ${t.linePct.toFixed(6)}%；${state}。不是分數或買進訊號。`);
  const depth=Math.max(0,-(s.return5??0)*100),scale=Math.max(15,-t.linePct*1.25,depth*1.15),rail=el('div',undefined,'lc4v2-rail');rail.append(el('i',undefined,'lc4v2-line'),el('i',undefined,'lc4v2-now'));rail.style.setProperty('--line',(-t.linePct/scale*100)+'%');rail.style.setProperty('--now',(depth/scale*100)+'%');graph.append(rail,el('figcaption',`極端急跌警戒線：5日跌幅 ${t.linePct.toFixed(2)}%`));crash.append(graph);
  crash.append(el('small',t.state==='REACHED'||t.state==='BELOW'?`${t.gapPP>=0?'超過警戒線':'距警戒線尚差'} ${Math.abs(t.gapPP).toFixed(2)} 個百分點 · 金點為目前跌幅，細線為門檻`:'僅顯示標示日期的歷史數值，不判定當前資格'));
  crash.append(el('p','急跌條件達標不代表已經止跌或適合買進。'));host.append(crash);
  const dd=el('div',undefined,'lc4v2-drawdown');for(const h of[120,240]){const n=el('div');n.append(el('span',`距 ${h} 日收盤高點`),el('strong',signed(s['dd'+h])));dd.append(n);}host.append(dd);
  const history=el('section');history.append(el('h3','歷史急跌後上漲比例'));const wins=el('div',undefined,'lc4v2-wins');for(const h of[5,10,20]){const x=s.horizons[h],n=el('div');n.append(el('span',`${h} 日後`),el('strong',x.n?pct(x.upFraction,2):'資料不足'),el('small',`${x.up}／${x.n} 例`));wins.append(n);}history.append(wins,el('small','固定年度急跌事件；各期只納入成熟樣本，歷史比例不是未來機率。'));host.append(history);
  const panel=el('section'),tabs=el('div',undefined,'lc4v2-tabs'),detail=el('div');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','反彈及下跌風險觀察期間');
  function horizon(h){const x=s.horizons[h];detail.replaceChildren();tabs.querySelectorAll('button').forEach(n=>n.setAttribute('aria-pressed',String(n.dataset.v2h===h)));
   detail.append(el('h3',`${h} 日歷史反彈`));line(detail,'第 N 日收盤報酬中位數',signed(x.endMedian));line(detail,'期間最高反彈中位數',signed(x.highMedian));
   const touch=el('div',undefined,'lc4v2-touch');for(const p of[5,10,15])touch.append(el('small',`曾達 +${p}%：${fraction(x.touch[p].count,x.n)}`));detail.append(touch,el('small','最高反彈為事後最高價統計，不代表可成交獲利。'));
   detail.append(el('h3',`${h} 日再次下跌風險`));line(detail,'再破觸發日低點',fraction(x.breakLow,x.n));line(detail,'最大不利波動中位數',signed(x.maeMedian));detail.append(el('small',`相對觸發日收盤；有效 ${x.n} 例、未成熟 ${x.pending} 例。`));
  }
  for(const h of['5','10','20']){const n=el('button',h+' 日');n.type='button';n.dataset.v2h=h;n.onclick=()=>horizon(h);tabs.append(n);}panel.append(tabs,detail);horizon('5');host.append(panel);
  const peak=el('section');peak.append(el('h3','20 日內高點出現時間'));const dist=el('div',undefined,'lc4v2-peaks');for(const[i,label]of['1–5 日','6–10 日','11–20 日'].entries()){const n=el('div');n.append(el('span',label),el('strong',s.peak20.n?pct(s.peak20.fractions[i],2):'資料不足'),el('small',`${s.peak20.counts[i]}／${s.peak20.n}`));dist.append(n);}peak.append(dist,el('small','同一組完整 20 日事件；重複高點取最早日，非最佳賣出時間。'));host.append(peak);
 }
 function detailedV2(){const s=S.stats,p=HSLC4RadarV2.policy,n=section('正二雷達 V2.0 · 統計口徑');line(n,'2026 原始急跌速度門檻',String(p.velocity));line(n,'精確五日警戒跌幅',String(-p.velocity*5)+'%');line(n,'訓練截止／門檻到期',p.trainingEnd+'／'+p.to);line(n,'門檻版本',p.version);
  n.append(el('p','目前警戒線保留 2026 固定門檻；歷史母體則沿用已審核的年度 C95／70 交易日冷卻規則，並非每個事件均達 2026 門檻。沒有重新篩選事件或調整參數。'),el('p','日數由觸發後下一交易日起算。期末報酬＝第 N 日收盤／觸發日收盤−1；最高反彈＝期間最高價／觸發日收盤−1；最大不利波動＝min(0,期間最低價／觸發日收盤−1)。再破低比較觸發日最低價；無費用、無實際交易。'));
  const years=el('details');years.append(el('summary','各年度樣本與事件明細'));for(const[year,y]of Object.entries(s.byYear)){line(years,year+' 年固定事件',String(y.events));for(const h of[5,10,20]){const x=y.horizons[h];line(years,`${h} 日上漲／期末中位數`,`${fraction(x.up,x.n)} · ${signed(x.endMedian)}`);}}for(const h of[5,10,20]){years.append(el('h4',`${h} 日事件：期末／最高／最大不利`));for(const e of s.horizons[h].paths)line(years,e.date,`${signed(e.endReturn)}／${signed(e.highReturn)}／${signed(e.mae)}`);}n.append(years);
  n.append(el('p','固定樣本數少，70 日冷卻僅減少重疊，不能證明事件獨立；已看過及用於模型比較的結果並非全新樣本外驗證。2027 門檻未獨立審核批准前停止當前門檻判定，正式進場資格始終未開放。'));
 }
 function unlock(){document.body.style.overflow=S.scroll;const target=S.returnFocus;if(target?.isConnected)target.focus({preventScroll:true});}
 close.onclick=()=>dialog.close();dialog.addEventListener('close',unlock);dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
 async function json(url){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);try{const res=await fetch(url,{cache:'no-store',signal:controller.signal});if(!res.ok)throw Error('HTTP_'+res.status);const text=await res.text();if(text.length>8000000)throw Error('RESEARCH_BODY_TOO_LARGE');return{value:JSON.parse(text),text};}finally{clearTimeout(timer);}}
 function verify(b,p){if(b.schema!=='HS_LC4_RESEARCH_BUNDLE_V1'||b.research_only!==true||b.writer!==false||b.entry_authorized!==false||b.score!==null||b.asof!==p.asof||b.revision!==p.revision||!/^\d{4}-\d{2}-\d{2}$/.test(b.asof)||!b.description?.radar||!b.description?.risk)throw Error('RESEARCH_CONTRACT_INVALID');
  const r=b.description.radar;if(r.writer!==false||r.score!==null||r.entry.authorized!==false||r.asof!==b.asof||r.market.date!==b.asof||r.tiers!==null||r.predictive_probability!==null)throw Error('RESEARCH_SAFETY_CONTRACT_INVALID');
  for(const h of['5','10','20']){const x=b.description.risk[h];if(!x||!Number.isInteger(x.n)||x.n<0||x.further_break_count<0||x.further_break_count>x.n||x.not_a_forecast!==true)throw Error('HISTORICAL_SAMPLE_INVALID');}}
 function render(shadow,operation){content.replaceChildren();const b=S.bundle,r=b.description.radar;
  const unavailable=HSLRadar.unavailable(),daily=HSLRadar.describe(b.history.histories['00631L']),market=HSLRadar.describe(b.history.histories['0050']);
  if(daily.asof!==b.asof||market.asof!==b.asof)throw Error('L_RADAR_HISTORY_DATE_CONFLICT');
  const simple=section('先看結論');simple.append(el('strong',HSLRadar.states[unavailable.research_state]));
  line(simple,'跌得夠深嗎？',`歷史 ${daily.asof}：近五日 ${signed(daily.returns[5])}；不判定今天`);
  line(simple,'跌勢有變慢嗎？','沒有已驗證盤中 K 線，無法確認');
  line(simple,'有回穩嗎？','沒有已驗證的新低、回升及相關市場證據');
  line(simple,'為什麼要等？','已保存的日線不能代替當日盤中走勢');
  const advanced=el('details');advanced.append(el('summary','進階研究、歷史統計與資料來源'));content.append(advanced);
  const depth=section('L-Radar · 歷史跌幅與回撤');
  for(const [days,value] of Object.entries(daily.returns))line(depth,days+' 日報酬',signed(value));
  for(const [days,value] of Object.entries(daily.drawdowns))line(depth,days+' 日回撤',signed(value));
  line(depth,'五日下跌速度',pct(daily.declineSpeed5,2)+'／日');
  line(depth,'同日 0050 五日報酬',signed(market.returns[5]));
  line(depth,'歷史下跌百分位',daily.declinePercentile===null?'不適用':pct(daily.declinePercentile,1));
  line(depth,'L-Radar 版本',HSLRadar.version);line(depth,'盤中行情／盤中計算','未取得／未執行');
  const findings=section('獨立回測 · NO-GO');
  findings.append(el('p','14 筆回穩候選；1、3、5 日扣成本平均報酬為負，10 日平均的不確定區間跨零。歷史重播不是全新的樣本外驗證。'));
  const report=el('a','下載完整回測數據（JSON）');report.href='research/hs_lradar/results-v1.json';findings.append(report);
  const frozen=section('既有固定樣本 · 描述性歷史');frozen.classList.add('lc4v2');legacy(frozen);
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
  detailedV2();
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
   const distribution=el('details');distribution.dataset.lc4Distribution='true';distribution.append(el('summary','查看完整歷史分布（由差至佳）'),el('p',x.mae_values.map(v=>pct(v)).join(' · ')));details.append(distribution);
   details.append(el('p','波動口徑：觸發後下一交易日開盤至期間最低價；不含成本、非帳戶回撤，不能當成可成交的最低點。'));
   for(const[label,event]of[['典型事件（事後中位數附近）',x.typical],['最差事件（事後展示）',x.worst]])if(event){const n=el('article');n.append(el('h4',`${label} · ${event.date}`));line(n,'最大不利波動',pct(event.low_vs_entry_open));line(n,'期末相對觸發日收盤',pct(event.close_return));details.append(n);}
  }
  for(const h of['5','10','20']){const button=el('button',h+' 日');button.type='button';button.dataset.h=h;button.onclick=()=>horizon(h);tabs.append(button);}risk.append(tabs,details);horizon('5');
  const source=section('來源與研究限制');source.append(el('p',`TWSE 官方日線研究副本，截至 ${b.asof}。00631L 分割於 2026-03-31 按 22：1 僅調整一次；0050 趨勢含已審核股息。`),el('p',`222 個衝突日期、14 個缺漏日期已留存逐日核驗；來源原始內部原因及歷史當時發布版本仍不可驗證。訓練截止 ${r.training_end}。`),el('p','樣本少、事件相依、模型比較與資料修訂偏差仍存在；急跌高分位不代表一定反彈。'),el('small',`資料 SHA-256：${S.pointer.sha256}`));
  advanced.append(...[...content.children].filter(n=>n!==simple&&n!==advanced));
 }
 async function load(){if(S.loading)return;S.loading=true;S.renderedAt=0;refresh.disabled=true;try{
   const {value:p}=await json('data/lc4-research/latest.json');
   if(!dialog.open)return;
   if(p.schema!=='HS_LC4_RESEARCH_POINTER_V1'||!/^snapshots\/[0-9a-z.-]+\.json$/.test(p.path)||!/^[a-f0-9]{64}$/.test(p.sha256))throw Error('RESEARCH_POINTER_INVALID');
   const {value:b,text}=await json('data/lc4-research/'+p.path);
   if(!dialog.open)return;
   const bytes=new TextEncoder().encode(text),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
   if(!dialog.open)return;
   if(hash!==p.sha256||bytes.length!==p.bytes)throw Error('RESEARCH_HASH_MISMATCH');verify(b,p);
   let shadow=null,operation=null;try{shadow=(await json('research/hs_leverage/forward/daily-status.json')).value;}catch{}
   if(!dialog.open)return;
   try{operation=(await json('data/lc4-research/status.json')).value;if(operation.bundle_sha256!==p.sha256)operation=null;}catch{}
   if(!dialog.open)return;
   const stats=HSLC4RadarV2.describe(b.history);if(stats.asof!==b.asof||Math.abs(stats.close-b.description.radar.stabilization.close)>1e-8||Math.abs(stats.return5-b.description.radar.opportunity.return5)>1e-12)throw Error('RESEARCH_HISTORY_SNAPSHOT_MISMATCH');
   if(!dialog.open)return;
   S.bundle=b;S.pointer=p;S.stats=stats;render(shadow,operation);S.renderedAt=Date.now();
   const time=$('#lradar-home-time');if(time)time.textContent=`非即時 · 歷史日線 ${b.asof}`;
  }catch(e){if(dialog.open)content.replaceChildren(el('p','研究資料目前無法核驗，未顯示未確認數值。','lc4r-warn'),el('small',String(e.message)));}
  finally{S.loading=false;refresh.disabled=false;}}
 refresh.onclick=load;
 function open(trigger){if(dialog.open)return;S.returnFocus=trigger;S.scroll=document.body.style.overflow;document.body.style.overflow='hidden';dialog.showModal();close.focus();
  const age=Date.now()-S.renderedAt;
  if(S.renderedAt&&age>=0&&age<300000)return; // In-memory, historical display only.
  content.replaceChildren(el('p','正在核驗研究資料…'));load();
 }
 document.addEventListener('click',e=>{const trigger=e.target.closest('[data-lc4-research-open]');if(trigger){e.preventDefault();open(trigger);}});
 // No background fetch, polling or heavy historical work during home startup.
})();
