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
   const time=$('#lradar-home-time');if(time&&!$('.lradar-v3'))time.textContent=`非即時 · 歷史日線 ${b.asof}`;
  }catch(e){if(dialog.open)content.replaceChildren(el('p','研究資料目前無法核驗，未顯示未確認數值。','lc4r-warn'),el('small',String(e.message)));}
  finally{S.loading=false;refresh.disabled=false;}}
 // The daily observation is independent of the archived research dialog.
 const home=$('#lc4-radar-v2');
 if(home){
   const daily=el('div',undefined,'lradar-v3');
   daily.append(el('strong','資料尚未更新'),el('p','等待已驗證的收盤資料；不以盤中價替代。'));
   const oldButton=home.querySelector('[data-lc4-research-open]');
   if(oldButton)oldButton.textContent='查看封存研究 ›';
   home.querySelector('h3').textContent='00631L 急跌機會雷達';
   home.querySelector(':scope > strong').hidden=true;
   home.querySelector(':scope > p').hidden=true;
   home.querySelector('h3').after(daily);
   const labels=['一般波動','明顯急跌','歷史極端急跌'],periodName=p=>p==='all'?'歷史最高':p+' 日';
   const fmt=x=>Number.isFinite(x)?(x>0?'+':'')+x.toFixed(2)+'%':'—';
   const round=x=>Number.isFinite(x)?x.toFixed(2):'—';
   let selected=240,range=3,records=[],fresh=false,flight=null,lastCheck=0;
   const local=window.HSLRadarLocal;let personal=null,personalError='',personalBusy=false,autoBusy=false,autoStatus='',autoNext=null;
   const autoMessage=()=>({AUTO_STORAGE_UNAVAILABLE:'此瀏覽器本機儲存無法使用，完整歷史尚未啟用；保留公開版，不會清除你的資料。',AUTO_NETWORK_UNAVAILABLE:'FinMind 連線或瀏覽器跨站讀取暫不可用；冷卻後重試，保留已驗證公開收盤。',AUTO_PREVIOUS_INTERRUPTED:'上次歷史載入已中斷；冷卻後再試，目前未在下載。',AUTO_RESPONSE_INVALID:'歷史回應格式不符，已拒絕使用，等待來源核對。',AUTO_ROW_INVALID:'歷史價格或交易日期無法核驗，已拒絕使用。',AUTO_RESPONSE_SIZE:'來源回應超過安全大小，已停止讀取。',AUTO_SOURCE_UNAVAILABLE:'FinMind 服務暫時不可用，保留已驗證公開收盤。',AUTO_LOADING:'正在由你的裝置直接取得完整歷史；不需下載 JSON，也不需等待 240 天。',AUTO_ORIGIN_NOT_ENABLED:'此位置不是正式 HS，不會自動查詢個人歷史。',AUTO_OFFLINE:'目前離線，完整歷史尚未啟用；連線後會自動重試。',AUTO_HTTP_402:'FinMind 免費查詢額度暫時不足；保留已驗證公開收盤，冷卻後再試。',AUTO_HTTP_429:'FinMind 暫時限流；已停止請求並遵守冷卻時間。',AUTO_HTTP_401:'FinMind 要求授權，尚未取得歷史；沒有改用共享金鑰或繞過驗證。',AUTO_HTTP_403:'FinMind 拒絕此裝置查詢；完整歷史尚未啟用。',AUTO_HISTORY_REVISED:'來源歷史與凍結核驗版本不同，已拒絕使用，等待核對。',AUTO_COORDINATION_UNAVAILABLE:'瀏覽器不支援安全協調自動載入，尚未啟用完整歷史。',PUBLIC_SELECTED:'目前使用公開封存；你可切回已保存的個人本機歷史。'})[autoStatus]||'完整歷史尚未啟用：來源暫時無法核驗；不是要重新等待 240 天。';
   async function loadAutomatic(){if(!local||autoBusy||personalBusy)return;autoBusy=true;autoStatus='AUTO_LOADING';draw();try{const result=await local.bootstrap();autoStatus=result.status;autoNext=result.next||null;if(result.state){personal=result.state;if(personal.enabled&&records.length)personal=await local.sync(records);personalError='';}}catch(e){personalError=localError(e);autoStatus=e.message==='AUTO_COORDINATION_UNAVAILABLE'?e.message:'AUTO_STORAGE_UNAVAILABLE';}finally{autoBusy=false;draw();}}
   const localError=e=>({PRIVATE_BASE_HASH_OR_RIGHTS:'檔案來源、授權或內容無法核驗',PRIVATE_EXTENSION_GAP_OR_PRICE:'新收盤與本機歷史有缺日或前收不一致',PRIVATE_OVERLAP_CONFLICT:'公開封存與本機歷史重疊價格衝突',PRIVATE_IMPORT_ROLLBACK_OR_CONFLICT:'備份較舊或內容衝突，已保留目前資料',PRIVATE_BACKUP_EXTENSION_NEEDS_PUBLIC_CHECK:'備份新增收盤尚未與公開封存核對，請連線後再恢復',PRIVATE_CONCURRENT_CHANGE:'另一分頁已更新，請再試一次'})[e.message]||'本機資料暫時無法核驗或儲存，已保留原資料';
   async function personalAction(fn){if(personalBusy)return;personalBusy=true;try{personal=await fn();personalError='';}catch(e){personalError=localError(e);}finally{personalBusy=false;draw();}}
   function personalControls(d){
     if(!local)return;
     const panel=el('details');panel.dataset.lradarPersonal='true';panel.append(el('summary','個人本機歷史（自動載入／備份）'),el('p','歷史由此裝置直接向 FinMind 免費端點取得，不經 HS 轉發、不上傳。僅供本人非商業分析，勿轉發。清除資料或換手機後會重新核驗取得；私人備份仍可恢復。'));
     panel.append(el('p',personal?`${personal.enabled?'使用本機歷史':'使用公開封存'}｜本機 ${local.rows(personal.data).length} 筆，截至 ${local.rows(personal.data).at(-1)[0]}`:autoMessage()));
     if(autoNext)panel.append(el('small','最早重試：'+new Date(autoNext).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})));
     if(!personal){const retry=el('button','重新嘗試自動載入');retry.type='button';retry.disabled=autoBusy;retry.onclick=loadAutomatic;panel.append(retry);}
     if(personalError)panel.append(el('p',personalError,'lc4r-warn'));
     const label=el('label','一次性匯入或恢復備份 '),input=el('input');input.type='file';input.accept='.json,application/json';input.disabled=personalBusy;input.setAttribute('aria-label','匯入個人歷史或備份');
     input.onchange=()=>{const file=input.files?.[0];if(!file)return;if(file.size>2000000){personalError='檔案過大，未匯入';draw();return;}personalAction(async()=>{if(!confirm('此資料僅供你本人本機分析，不會上傳。確認匯入並啟用？'))return personal;personal=await local.importText(await file.text(),records);return records.length?await local.sync(records):personal;});};
     label.append(input);panel.append(label);
     const backup=el('button','備份本機歷史'),toggle=el('button',personal?.enabled?'改用公開封存':'使用本機歷史');
     for(const b of [backup,toggle]){b.type='button';b.disabled=!personal||personalBusy;}
     backup.onclick=async()=>{try{const text=await local.backup(),url=URL.createObjectURL(new Blob([text],{type:'application/json'})),a=el('a');a.href=url;a.download='00631L-personal-backup.lradar-private.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}catch(e){personalError=localError(e);draw();}};
     toggle.onclick=()=>personalAction(()=>local.enable(!personal.enabled));panel.append(backup,toggle);daily.append(panel);
   }
   function gauge(name,current,g,limits,needed,d){
     const n=el('section',undefined,'lradar-v3-gauge'),bar=el('div',undefined,'lradar-v3-bar'),fill=el('i'),mark=el('b');
     n.append(el('h4',name),el('strong',g?fmt(current):'—'));
     const [watch,extreme]=limits;
     mark.style.left=100*watch/extreme+'%';
     bar.setAttribute('aria-hidden','true');
     if(g){fill.style.width=Math.min(100,100*g.decline/g.extreme)+'%';bar.append(fill);}
     bar.append(mark);n.append(bar);
     n.append(el('small',`正常 0%｜觀察 ${round(watch)}%｜極端 ${round(extreme)}%`),
       el('p',!g?(local&&!personal?.enabled?'完整歷史尚未啟用；不是要重新累積 240 天。':needed==='all'?'缺少自上市起的完整核驗收盤':`需連續 ${needed} 筆同基準收盤，目前 ${d.rows.length} 筆`):g.fromExtreme>=0?`已達極端門檻，超過 ${round(g.fromExtreme)} 個百分點`:`距極端門檻還差 ${round(-g.fromExtreme)} 個百分點`),
       el('small',d.asof?'截至 '+d.asof:'尚無核驗截至日'));
     return n;
   }
   function draw(){
     const d=personal?.enabled?local.summary(personal.data,selected):HSLRadar.archiveSummary(records,selected),v=d.peaks[selected],peak240=d.peaks[240],level=d.level,speed=(d.speed?.level??-1)>=(d.depth?.level??-1);
     const current=fresh&&d.asof===records.at(-1)?.trading_date&&!(d.personal&&personalError);
     const trigger=level===null?'部分區間資料累積中，暫不分級':level===0?'兩項皆未達觀察門檻':(d.speed?.level===level&&d.depth?.level===level?'兩項皆達此等級':speed?'由五日跌幅觸發':'由最高收盤價回落觸發');
     const inactive=local&&!personal?.enabled;
     daily.replaceChildren(el('strong',inactive?(autoBusy?'正在啟用完整歷史':personal?'公開收盤模式':'完整歷史尚未啟用'):!d.asof?'資料累積中':!current?'資料尚未更新':level===null?'資料累積中':labels[level]),
       el('p',d.asof?`${current?trigger:'顯示最後核驗的歷史資料，不判定今天。'}｜${d.asof} 收盤 ${round(d.close)} 元`:'尚無已驗證的每日收盤封存。'));
     if(inactive)daily.append(el('p',autoMessage()));
     if(d.personal)daily.append(el('small','個人本機歷史 · 不含息價格報酬 · 不上傳'));
     const quick=el('div',undefined,'lradar-v3-grid');
     quick.append(gauge('五日急跌速度',d.recent[5],d.speed,HSLRadar.limits.speed,6,d),gauge(periodName(selected)+'最高收盤回落',v?.change,d.depth,HSLRadar.limits[selected],selected,d));
     const recentText=[3,5,10].map(n=>`近 ${n} 日 ${Number.isFinite(d.recent[n])?fmt(d.recent[n]):`—（需 ${n+1} 筆連續收盤）`}`).join('｜');
     daily.append(quick,el('p',recentText+(d.asof?'｜截至 '+d.asof:'')));
     const select=el('select');select.setAttribute('aria-label','高點比較期間');
     for(const p of HSLRadar.periods){const o=el('option',periodName(p));o.value=p;select.append(o);}select.value=selected;
     select.onchange=()=>{selected=select.value==='all'?'all':Number(select.value);draw();daily.querySelector('select').focus();};
     daily.append(select,el('p',v?`選取最高收盤價 ${round(v.price)} 元 · ${v.date} · 已過 ${v.age} 個交易日`:'選取期間：資料累積中'),
       el('p',peak240?`近 240 日回落 ${fmt(peak240.change)} · 距高點 ${peak240.age} 個交易日`:'近 240 日回落：資料累積中','lradar-v3-peak'));
     const points=el('details');points.append(el('summary','查看各期間最高收盤價'));
     for(const p of HSLRadar.periods){const x=d.peaks[p];line(points,periodName(p),x?`${fmt(x.change)}｜${round(x.price)} 元｜${x.date}`:'資料累積中');}
     daily.append(points);
     const returns=el('div',undefined,'lradar-v3-grid');['本月','近 3 個月','近 6 個月','今年'].forEach((name,i)=>{
       const missing=['缺上月底基準收盤','缺三個月前基準收盤','缺六個月前基準收盤','缺去年底基準收盤'];
       const r=d.returns[i],c=el('section',undefined,'lradar-v3-gauge');c.append(el('h4',name),el('strong',fmt(r?.change),r?.change>0?'lradar-rise':r?.change<0?'lradar-fall':''),el('small',r?'比較 '+r.date:missing[i]+'或其後有缺日'),el('small',d.asof?'截至 '+d.asof:'尚無核驗截至日'));returns.append(c);
     });
     daily.append(returns);
     const extra=el('details');extra.append(el('summary','其他期間漲跌（價格報酬）'));
     for(const [key,name,missing] of [['m1','近 1 個月','缺一個月前基準收盤或其後有缺日'],['y1','近 1 年','缺一年前基準收盤或其後有缺日']]){
       const r=d.performance[key];line(extra,name,r?`${fmt(r.change)}｜比較 ${r.date}，截至 ${r.asof}`:missing);
     }
     daily.append(extra);
     const graph=el('section',undefined,'lradar-v3-gauge'),ranges=el('div',undefined,'lc4r-tabs');
     for(const n of [1,3,6,12,0]){const b=el('button',n===0?'全部':n===12?'1 年':n+' 個月');b.type='button';b.setAttribute('aria-pressed',n===range);b.onclick=()=>{range=n;draw();daily.querySelector('.lc4r-tabs button[aria-pressed="true"]')?.focus();};ranges.append(b);}
     const rows=range&&d.asof?d.rows.filter(r=>r[0]>=HSLRadar.monthsBack(d.asof,range)):d.rows,svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
     graph.append(el('h4','價格走勢'),ranges);
     if(rows.length<2){graph.append(el('p','可比較的收盤資料累積中。'));}
     else{
     svg.setAttribute('viewBox','0 0 360 144');svg.setAttribute('aria-label','收盤價格走勢圖（歷史以現行分割單位表示）');
     const top=Math.max(...rows.map(r=>r[1])),bottom=Math.min(...rows.map(r=>r[1])),x=i=>4+352*i/Math.max(1,rows.length-1),y=p=>136-126*(p-bottom)/(top-bottom||1);
     const shape=(tag,attrs)=>{const e=document.createElementNS(svg.namespaceURI,tag);for(const [k,v]of Object.entries(attrs))e.setAttribute(k,v);svg.append(e);return e;};
     shape('polyline',{points:rows.map((r,i)=>x(i)+','+y(r[1])).join(' '),fill:'none',stroke:'#dfbf75','stroke-width':2});
     const pi=rows.findLastIndex(r=>r[1]===top);shape('circle',{cx:x(pi),cy:y(top),r:4,fill:'#dfbf75'});
     const interval=HSLRadar.rangeReturn(rows),rangeText=`區間漲跌 ${fmt(interval.change)}（${interval.start} 至 ${interval.end}，價格報酬）`;
     const readout=el('p',`區間最高收盤 ${round(top)} 元 · ${rows[pi][0]}｜${rangeText}`);
     const inspect=i=>{const r=rows[i];readout.textContent=`${r[0]} 收盤 ${round(r[1])} 元｜區間最高收盤 ${round(top)} 元（${rows[pi][0]}）｜${rangeText}`;};
     svg.onclick=e=>{const b=svg.getBoundingClientRect();inspect(Math.max(0,Math.min(rows.length-1,Math.round(((e.clientX-b.left)/b.width*360-4)/352*(rows.length-1)))));};
     const cursor=el('input');cursor.type='range';cursor.min=0;cursor.max=rows.length-1;cursor.value=rows.length-1;cursor.setAttribute('aria-label','逐日查看收盤價');cursor.oninput=()=>inspect(Number(cursor.value));
     graph.append(el('small',`僅顯示已核驗的連續封存：${rows[0][0]} 至 ${rows.at(-1)[0]}`),svg,cursor,readout);
     }
     daily.append(graph);
     const h=el('details');h.append(el('summary','歷史相似急跌統計'));h.ontoggle=()=>{
       if(!h.open||h.dataset.ready)return;h.dataset.ready='1';const driver=speed?'speed':'depth';
       h.append(el('p',`依${driver==='speed'?'五日跌幅':periodName(selected)+'最高收盤回落'}首次跨越固定極端門檻，事件間隔至少 21 個交易日。不是未來機率或交易績效。`));
     const stats=(selected!=='all'||d.personal)&&d.rows.length>=240?HSLRadar.historical({rows:d.rows,thresholds:HSLRadar.limits,training_end:HSLRadar.training},selected,driver):[];
       for(const n of [5,10,20]){
         const s=stats.find(x=>x.h===n);
         line(h,`${n} 日｜後續最低收盤價跌幅`,!s||s.n<10?'資料累積中（樣本不足）':`${s.n} 件（待成熟 ${s.pending}）｜平均 ${fmt(s.mean)}／中位 ${fmt(s.median)}；正報酬 ${round(s.positive)}%；後續最低收盤價跌幅 ${fmt(s.worst)}`);
       }
     };
     const source=el('details'),basis=d.personal?'FinMind TaiwanStockPrice 個人本機歷史（原資訊來源：臺灣證券交易所）；新收盤接續 TWSE 開放資料。2026/03/31 的 22:1 分割僅調整一次，分割前換算現行單位。':'臺灣證券交易所開放資料。';
     source.append(el('summary','資料與固定門檻'),el('p',`${basis}非即時。只比較相同價格基準的收盤，股價報酬不含股息。門檻版本 ${HSLRadar.thresholdVersion}，以截至 ${HSLRadar.training} 的 P80/P95 固定，不代表買進或保證反彈。`));
     if(d.personal){const terms=el('a','FinMind 個人非商業使用範圍（不含公開再散布）');terms.href='https://finmind.github.io/Pricing/';terms.target='_blank';terms.rel='noopener noreferrer';source.append(terms);}
     const attribution=el('p'),dataset=el('a','臺灣證券交易所｜個股日成交資訊'),license=el('a','政府資料開放授權條款第 1 版');
     dataset.href='https://data.gov.tw/dataset/11549';license.href='https://data.gov.tw/license';
     for(const a of [dataset,license]){a.target='_blank';a.rel='noopener noreferrer';}
     attribution.append(dataset,' · ',license);source.append(attribution);
     daily.append(h,source);$('#lradar-home-time').textContent=d.asof?'非即時 · 收盤資料 '+d.asof:'非即時 · 尚無已核驗收盤日期';
     personalControls(d);
   }
   function refreshDaily(){
     if(flight||Date.now()-lastCheck<60000)return;
     lastCheck=Date.now();
     flight=Promise.all([json(HSLRadar.archiveURL),json('data/radar-history/status-v1.json').catch(()=>null)]).then(async([x,s])=>{
       const cal=s?.value||{},now=new Date(),local=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei',dateStyle:'short',timeStyle:'short'}).format(now),today=local.slice(0,10);
       const nextRecords=HSLRadar.verifyIndex(x.value,today,+now);
       if(records.some((r,i)=>JSON.stringify(r)!==JSON.stringify(nextRecords[i])))throw Error('ARCHIVE_ROLLBACK_OR_OVERWRITE');
       const changed=nextRecords.length!==records.length, wasFresh=fresh;
       records=nextRecords;
       if(local&&personal?.enabled){try{personal=await local.sync(records);personalError='';}catch(e){personalError=localError(e);}}
       const asof=records.at(-1)?.trading_date;
       const completed=cal.expected_completed_bar,next=cal.next_expected_trading_day;
       const knownNext=/^\d{4}-\d{2}-\d{2}$/.test(next||'');
       const dayAfter=asof&&new Date(Date.parse(asof)+86400000).toISOString().slice(0,10);
       fresh=!!asof&&cal.schema_version===1&&completed===asof&&
         (today===asof||knownNext&&today<=next&&!(today===next&&local.slice(-5)>='18:00')||
           !knownNext&&today===dayAfter&&local.slice(-5)<'18:00');
       if(changed||wasFresh!==fresh||personalError)draw();
     }).catch(()=>{if(fresh){fresh=false;draw();}}).finally(()=>{flight=null;});
   }
   draw();refreshDaily();window.addEventListener('online',refreshDaily);window.addEventListener('pageshow',refreshDaily);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshDaily();});
   if(local)loadAutomatic();
   const restorePersonal=()=>{if(!local||document.hidden||personalBusy)return;local.read(true).then(p=>{if(p?.revision!==personal?.revision){personal=p;draw();}}).catch(e=>{personalError=localError(e);});};
   window.addEventListener('pageshow',restorePersonal);document.addEventListener('visibilitychange',restorePersonal);
   const retryAutomatic=()=>{if(!document.hidden&&!personal)loadAutomatic();};window.addEventListener('online',retryAutomatic);window.addEventListener('pageshow',retryAutomatic);
   window.setInterval(()=>{if(!document.hidden)refreshDaily();},300000);
 }
 refresh.onclick=load;
 function open(trigger){if(dialog.open)return;S.returnFocus=trigger;S.scroll=document.body.style.overflow;document.body.style.overflow='hidden';dialog.showModal();close.focus();
  const age=Date.now()-S.renderedAt;
  if(S.renderedAt&&age>=0&&age<300000)return; // In-memory, historical display only.
  content.replaceChildren(el('p','正在核驗研究資料…'));load();
 }
 document.addEventListener('click',e=>{const trigger=e.target.closest('[data-lc4-research-open]');if(trigger){e.preventDefault();open(trigger);}});
 // The archived research bundle is still only loaded on explicit request.
})();
