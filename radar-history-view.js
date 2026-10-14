/* Two panes of ONE chart: shared date scale/crosshair, independent value scales. */
(function(root){
  'use strict';
  const C=root.HSRadarHistory,KEY='hsRadar.history.preferences.v1',INPUT_EVENTS=['mousemove','mousedown','touchstart','touchmove'];let active=null,source=null,sessionPreferences=null;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num=v=>C.finite(v)?String(Number(v.toFixed(4))):'—',signed=v=>C.finite(v)?(v>0?'+':'')+num(v):'—';
  const sourceMessage=reason=>({'SOURCE_HTTP_402':'行情來源額度已達上限，暫停重試','SOURCE_HTTP_429':'行情來源限制請求，暫停重試','SOURCE_COOLDOWN':'來源冷卻中，稍後再試；未繞過供應商限制','Failed to fetch':'來源無法連線或不允許瀏覽器讀取，原因尚無法由瀏覽器確認'}[reason]||reason);
  function layoutDiagnostics(){
    const selectors=['#radarOverview','#radarDetailStickyNav','#cards','.signalCard.is-selected','.signalCard.is-selected .signalCardDetails','.signalCard.is-selected .detailTabs','.signalCard.is-selected [data-detail-panel="score"]','.signalCard.is-selected [data-detail-panel="drawdown"]','.signalCard.is-selected .radarHistoryCanvas'];
    const s=active,scale=s?.chart?.timeScale(),data=s?.priceSeries?.data?.()||[],bars=data.filter(r=>C.finite(r.close)),logical=scale?.getVisibleLogicalRange();
    const chart=s?{symbol:s.symbol,normalizedPriceCount:s.prices.length,axisCount:s.axis.length,setDataCount:data.length,candleCount:bars.length,firstCandle:bars[0]?.time,lastCandle:bars.at(-1)?.time,logicalRange:logical,dateRange:scale?.getVisibleRange(),visibleCounts:logical?C.extrema(s.axis,s.score.rows,s.prices,logical):null,firstCoordinate:scale?.timeToCoordinate(s.axis[0]),lastCoordinate:scale?.timeToCoordinate(s.axis.at(-1)),paneCount:s.chart?.panes?.().length,lastCrosshair:s.lastCrosshair||null}:null;
    return{viewport:{width:root.innerWidth,height:root.innerHeight,scrollY:root.scrollY,documentWidth:document.documentElement.scrollWidth},chart,nodes:selectors.map(selector=>{const el=document.querySelector(selector);if(!el)return{selector,present:false};const r=el.getBoundingClientRect(),s=root.getComputedStyle(el);return{selector,top:r.top,bottom:r.bottom,height:r.height,width:r.width,hidden:el.hidden,open:el.open,display:s.display,position:s.position,margin:s.margin,padding:s.padding,minHeight:s.minHeight,scrollMarginTop:s.scrollMarginTop,stickyTop:s.top};})};
  }
  function readPreferences(){if(sessionPreferences)return C.preferences(sessionPreferences);try{return C.preferences(JSON.parse(localStorage.getItem(KEY)));}catch{return C.preferences();}}
  function savePreferences(p){sessionPreferences=C.preferences(p);try{localStorage.setItem(KEY,JSON.stringify(p));}catch{/* Private browsing / full storage: keep session preferences. */}}
  function html(symbol){return`<section class="radarV2Section radarHistoryV2" data-radar-history="${esc(symbol)}">
    <header><h3>近期趨勢與訊號 2.0</h3><small class="radarHistoryIdentity">${esc(symbol)}｜正式 C4 × 原始日 K</small></header>
    <nav class="radarHistoryRanges" aria-label="圖表時間區間">${C.RANGES.map(r=>`<button type="button" data-history-range="${r}">${r==='ALL'?'全部':r}</button>`).join('')}</nav>
    <div class="radarHistorySelection"><div class="radarHistoryDetail" aria-live="polite"></div><button type="button" data-history-action="details">查看 C4 詳細資訊</button></div>
    <div class="radarHistoryCanvas" aria-label="上圖 C4 正式分數；下圖原始日 K，共用交易日期" tabindex="0"></div>
    <div class="radarHistoryTools"><button type="button" data-history-action="latest">最新</button><button type="button" data-history-action="older">載入更早歷史</button><button type="button" data-history-action="zoom-in" aria-label="放大圖表">＋</button><button type="button" data-history-action="zoom-out" aria-label="縮小圖表">−</button><button type="button" data-history-action="retry">重新取得</button></div>
    <details class="radarHistorySettings"><summary>圖表設定</summary><div>${Object.entries({score:'C4 折線',price:'原始 K 線',extrema:'高低點標記',ma5:'MA5',ma10:'MA10',ma20:'MA20',ma60:'MA60',volume:'成交量',thresholds:'正式門檻線'}).map(([key,label])=>`<label><input type="checkbox" data-history-pref="${key}"> ${label}</label>`).join('')}</div></details>
    <div class="radarHistoryExtrema"></div><p class="radarHistoryStatus" role="status">載入已驗證歷史資料…</p>
    <p class="radarHistoryHint">上：C4 分數（金線）｜下：原始日 K（紅漲綠跌）<br>點選／長按查日期 · 拖曳看歷史 · 雙指縮放 · 上下滑動捲頁</p>
    <small class="radarHistorySource">原始價格報酬不含配息；不與下方既有還原價格表現混用。<br>Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noopener">TradingView</a> · Lightweight Charts™ 5.0.9</small></section>`;}
function cutoff(now,closeHour=18,closeMinute=0){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now),v=Object.fromEntries(parts.map(p=>[p.type,p.value])),day=`${v.year}-${v.month}-${v.day}`;return Number(v.hour)*60+Number(v.minute)>=closeHour*60+closeMinute?day:new Date(Date.parse(day+'T00:00:00Z')-86400000).toISOString().slice(0,10);}
function unmount(){if(active){closeSheet(active,false);active.sheet?.remove();active.abort.abort();document.removeEventListener("visibilitychange",active.resume);root.removeEventListener("pageshow",active.resume);active.resize?.disconnect();active.chart?.remove();active.host.removeEventListener('click',active.click);active.host.removeEventListener('change',active.change);for(const type of INPUT_EVENTS)active.host.removeEventListener(type,active.input,true);active=null;}}
  async function mount(host,{symbol,name,artifact,contract,thresholds,completed,headers}){
    if(active?.host===host&&active.symbol===symbol)return;
    unmount();if(!host||!root.LightweightCharts)return;
    if(!source)source=new root.HSRadarHistorySource.Source({headers});
    const s={host,symbol,name,artifact,contract,thresholds,completed,prefs:readPreferences(),abort:new AbortController(),prices:[],events:[],invalid:[],dates:[],series:[],markers:[],years:new Set(),warnings:new Set(),firstYear:null,busy:false,dividendStatus:'VERIFIED',selected:null};active=s;
    // Opt-in, DOM-only evidence. No API calls, scores, credentials or user holdings.
    if(typeof location!=='undefined'&&new URLSearchParams(location.search).get('radarLayoutDebug')==='1'&&!host.querySelector('.radarHistoryDiagnostics')){const d=document.createElement('details');d.className='radarHistoryDiagnostics';d.innerHTML='<summary>版面診斷（唯讀）</summary><button type="button" data-history-action="measure">量測版面</button><pre></pre>';host.append(d);}
    host.querySelector('.radarHistoryIdentity').textContent=s.symbol+' '+s.name+'｜正式 C4 × 原始日 K';
    s.status=text=>{if(active===s)host.querySelector('.radarHistoryStatus').textContent=text;};
    s.click=async e=>{const button=e.target.closest('button');if(!button)return;try{if(button.dataset.historyRange){s.prefs.range=button.dataset.historyRange;savePreferences(s.prefs);if(s.prefs.range==='ALL')await loadAll(s);else if(['1Y','120D'].includes(s.prefs.range)&&s.years.size===1)await older(s);setRange(s);}
      const action=button.dataset.historyAction;if(action==='details'){openSheet(s,button);return;}if(action==='measure'){host.querySelector('.radarHistoryDiagnostics pre').textContent=JSON.stringify(layoutDiagnostics(),null,2);return;}if(action==='latest'){s.selected=null;setRange(s);}if(action==='older')await older(s);if(action==='retry'){source.cache.clear();unmount();await mount(host,{symbol,name,artifact,contract,thresholds,completed,headers});}if(action?.startsWith('zoom-')){const r=s.chart?.timeScale().getVisibleLogicalRange();if(r){const center=(r.from+r.to)/2,half=(r.to-r.from)/2*(action==='zoom-in'?.75:1.35);s.chart.timeScale().setVisibleLogicalRange({from:center-half,to:center+half});}}}catch(error){if(active===s)s.status('資料不足｜'+error.message+'；既有已驗證資料保留，未補值。');}};
    s.change=e=>{const key=e.target.dataset.historyPref;if(!key)return;s.prefs[key]=e.target.checked;savePreferences(s.prefs);draw(s,true);};host.addEventListener('click',s.click);host.addEventListener('change',s.change);
    s.inputEpoch=0;s.consumedInputEpoch=0;
    s.input=e=>{
      if(active!==s||!e.target.closest?.('.radarHistoryCanvas'))return;
      if(e.type==='mousemove'){
        const moved=typeof e.movementX==='number'&&typeof e.movementY==='number'?e.movementX!==0||e.movementY!==0:s.mousePosition&&(e.clientX!==s.mousePosition.x||e.clientY!==s.mousePosition.y);
        s.mousePosition={x:e.clientX,y:e.clientY};if(!moved)return;
      }
      s.inputEpoch++;
    };
    for(const type of INPUT_EVENTS)host.addEventListener(type,s.input,{capture:true,passive:true});
    s.startedAt=Date.now();s.resume=()=>{if(active===s&&document.visibilityState==="visible"&&Date.now()-s.startedAt>300000){source.cache.clear();unmount();mount(host,{symbol,name,artifact,contract,thresholds,completed,headers});}};document.addEventListener("visibilitychange",s.resume);root.addEventListener("pageshow",s.resume);
    try{
s.score=C.scores(artifact,symbol,contract,date=>completed(date)&&date<=cutoff(new Date(),13,30));s.cutoff=cutoff(new Date());if(source.priceCutoff!==s.cutoff){source.cache.clear();source.priceCutoff=s.cutoff;}let cal;try{cal=await source.sessions(new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Taipei'}),s.abort.signal);}catch(error){if(s.abort.signal.aborted)throw error;cal=await source.savedSessions(symbol,s.score.rows.map(r=>r.time),s.abort.signal);s.warnings.add(error.message);}if(active!==s)return;s.observedOnly=cal.observedOnly===true;s.dates=cal.dates;s.calendarFetchedAt=cal.fetchedAt;if(!s.dates.length)throw Error('CALENDAR_EMPTY');s.firstYear=Number(s.dates[0].slice(0,4));s.nextYear=Number(s.cutoff.slice(0,4));await older(s);
      if(active!==s)return;if(s.prefs.range==='ALL')await loadAll(s);else if(['1Y','120D'].includes(s.prefs.range))await older(s);setRange(s);
}catch(error){if(active===s){if(s.dates.length&&s.score.rows.length){draw(s,false);}else{host.querySelector('.radarHistoryCanvas').hidden=true;host.querySelector('.radarHistoryDetail').textContent='無可驗證日線時不產生假 K 線。';}s.status('資料不足｜'+sourceMessage(error.message)+'；不使用盤中或還原價格替代。');}}
  }
  async function older(s){if(active!==s||s.busy||s.nextYear<s.firstYear)return;s.busy=true;const year=s.nextYear;s.status(`正在載入 ${year} 原始日線…`);try{const result=await source.year(s.symbol,year,s.dates,s.cutoff,s.abort.signal);if(active!==s)return;s.years.add(year);s.nextYear--;s.prices=[...result.rows,...s.prices].sort((a,b)=>a.time.localeCompare(b.time));s.events=[...result.events,...s.events];s.invalid.push(...result.invalid);if(result.sourceWarning)s.warnings.add(result.sourceWarning);if(result.dividendStatus!=='VERIFIED')s.dividendStatus=result.dividendStatus;s.fetchedAt=result.fetchedAt;draw(s,true);}finally{s.busy=false;}}
  async function loadAll(s){if(s.busy)return;while(active===s&&s.prefs.range==='ALL'&&s.nextYear>=s.firstYear){await older(s);if(s.abort.signal.aborted)return;}}
  function setRange(s){if(active!==s||!s.chart)return;const r=C.range(s.axis,s.prefs.range);if(r)s.chart.timeScale().setVisibleLogicalRange(r.from===r.to?{from:r.from-.5,to:r.to+.5}:r);s.syncingCursor=true;try{s.chart.clearCrosshairPosition();}finally{s.syncingCursor=false;}syncControls(s);showDetail(s,s.axis.at(-1));syncCursor(s);}
  function syncControls(s){s.host.querySelectorAll('[data-history-range]').forEach(b=>{b.classList.toggle('active',b.dataset.historyRange===s.prefs.range);b.setAttribute('aria-pressed',String(b.dataset.historyRange===s.prefs.range));});s.host.querySelectorAll('[data-history-pref]').forEach(b=>b.checked=s.prefs[b.dataset.historyPref]);}
  const displayDate=time=>String(time||'—').replace(/-/g,'/');
  function dataState(s,d){
    const states=[];
    if(s.score.invalid.includes(d.time)||s.invalid.includes(d.time))states.push('資料驗證失敗');
    if(!d.score)states.push('無正式 C4 紀錄');
    else if(d.score.factors.some(f=>f.raw===null||f.weight===null||f.contribution===null))states.push('正式分項未保存');
    else states.push('正式紀錄完整');
    if(!d.price)states.push(d.time>(s.prices.at(-1)?.time||'')?'股價尚未更新':'原始行情缺失');
    return states;
  }
  function cells(entries){return entries.map(([a,b])=>`<div><dt>${esc(a)}</dt><dd>${esc(b)}</dd></div>`).join('');}
  function showDetail(s,time){
    if(!time||!s.axis.includes(time))return;s.selected=time;s.host.dataset.selectedDate=time;
    const d=C.detail(time,s.dates,s.score.rows,s.prices,s.events),p=d.price,c=d.score;
    s.host.querySelector('.radarHistoryDetail').innerHTML=`
      <header><time datetime="${esc(time)}">${displayDate(time)}</time><b>${esc(s.symbol)} ${esc(s.name)}</b></header>
      <div class="radarHistorySummary"><strong>${c?num(c.value)+' 分':'尚無正式分數'}</strong><span>${esc(c?.tier||'無正式 C4 紀錄')}</span><span>${c&&c.delta!==null?(c.delta>0?'↑ ':c.delta<0?'↓ ':'→ ')+signed(c.delta):'暫無前筆正式比較'}</span></div>
      <small>C4 前筆 ${c?.previousDate?displayDate(c.previousDate)+'｜'+num(c.previousValue)+' 分':'資料不足'}</small>
      <div class="radarHistoryContributions">${C.FACTORS.map(({key,label})=>{const f=c?.factors.find(f=>f.key===key);return`<span>${label}${f?.weight!=null?' '+num(f.weight)+'%':''} <b>${num(f?.contribution)}</b></span>`;}).join('')}</div>
      <div class="radarHistoryPrice"><b>原始收盤 ${num(p?.close)}</b><span>${signed(d.change)}（${d.returnPct===null?'—':signed(d.returnPct)+'%'}）</span></div>
      <div class="radarHistoryOHLC">${[['O',p?.open],['H',p?.high],['L',p?.low],['C',p?.close]].map(([k,v])=>`<span>${k} <b>${num(v)}</b></span>`).join('')}</div>
      <small>股價前筆 ${displayDate(d.previousPriceDate)}｜${esc(dataState(s,d).join(' · '))}</small>
      <span class="radarHistorySourceState">股價：${p?'已驗證 RAW_UNADJUSTED':'資料不足'}</span>`;
    updateSheet(s,d);
  }
  function syncCursor(s){
    if(!s.chart||!s.selected||s.syncingCursor||s.rendering)return;
    const p=s.prices.find(p=>p.time===s.selected),c=s.score.rows.find(c=>c.time===s.selected);
    const line=s.scoreLines?.find(line=>line.data().some(r=>r.time===s.selected));
    s.syncingCursor=true;
    try{if(p)s.chart.setCrosshairPosition(p.close,s.selected,s.priceSeries);else if(c&&line)s.chart.setCrosshairPosition(c.value,s.selected,line);else s.chart.clearCrosshairPosition();}
    finally{s.syncingCursor=false;}
  }
  function selectDate(s,time,reveal=false){
    if(active!==s||!C.selectionDates(s.score.rows,s.prices).includes(time))return;
    showDetail(s,time);
    if(reveal){const scale=s.chart.timeScale(),r=scale.getVisibleLogicalRange(),next=C.revealRange(r,s.axis.indexOf(time),s.axis.length);if(next!==r)scale.setVisibleLogicalRange(next);}
    syncCursor(s);
  }
  function closeSheet(s,restore=true){
    if(!s.sheet?.open)return;
    s.sheet.close();
    if(s.previousOverflow!==undefined){document.documentElement.style.overflow=s.previousOverflow;delete s.previousOverflow;}
    if(restore)s.sheetTrigger?.focus({preventScroll:true});
  }
  function openSheet(s,trigger){
    if(!s.selected)return;s.sheetTrigger=trigger;
    if(!s.sheet){
      const sheet=document.createElement('dialog');s.sheet=sheet;sheet.className='radarHistorySheet';
      sheet.setAttribute('aria-label','C4 歷史詳細資訊');
      sheet.innerHTML='<div class="radarHistorySheetHandle" aria-hidden="true"><span></span></div><header class="radarHistorySheetHeader"><button type="button" data-sheet-action="previous" aria-label="上一個交易日">←</button><h2>C4 歷史詳細資訊<time></time></h2><button type="button" data-sheet-action="next" aria-label="下一個交易日">→</button><button type="button" data-sheet-action="close" aria-label="關閉 C4 詳細資訊">✕</button></header><div class="radarHistorySheetBody"></div>';
      sheet.addEventListener('click',async e=>{
        const action=e.target.closest('button')?.dataset.sheetAction;
        if(action==='close'){closeSheet(s);return;}
        if(!['previous','next'].includes(action)||s.navigating)return;
        s.navigating=true;
        try{
          let time=C.adjacent(C.selectionDates(s.score.rows,s.prices),s.selected,action==='previous'?-1:1);
          // Load earlier verified chunks only when crossing the loaded boundary.
          while(!time&&action==='previous'&&!s.busy&&s.nextYear>=s.firstYear&&active===s){await older(s);time=C.adjacent(C.selectionDates(s.score.rows,s.prices),s.selected,-1);}
          if(time)selectDate(s,time,true);
        }catch(error){if(active===s)s.status('更早資料取得失敗｜'+sourceMessage(error.message));}
        finally{s.navigating=false;if(active===s)updateSheet(s,C.detail(s.selected,s.dates,s.score.rows,s.prices,s.events));}
      });
      sheet.addEventListener('cancel',e=>{e.preventDefault();closeSheet(s);});
      sheet.addEventListener('close',()=>{if(s.previousOverflow!==undefined){document.documentElement.style.overflow=s.previousOverflow;delete s.previousOverflow;}});
      const handle=sheet.querySelector('.radarHistorySheetHandle');
      handle.addEventListener('pointerdown',e=>{s.dragStart={x:e.clientX,y:e.clientY,id:e.pointerId};handle.setPointerCapture(e.pointerId);});
      handle.addEventListener('pointerup',e=>{const start=s.dragStart;s.dragStart=null;if(start&&e.pointerId===start.id&&e.clientY-start.y>70&&Math.abs(e.clientX-start.x)<80)closeSheet(s);});
      handle.addEventListener('pointercancel',()=>s.dragStart=null);
      document.body.append(sheet);
    }
    updateSheet(s,C.detail(s.selected,s.dates,s.score.rows,s.prices,s.events));
    if(!s.sheet.open){s.previousOverflow=document.documentElement.style.overflow;s.sheet.showModal();document.documentElement.style.overflow='hidden';}
  }
  function updateSheet(s,d){
    if(!s.sheet)return;
    const c=d.score,p=d.price,dates=C.selectionDates(s.score.rows,s.prices);
    s.sheet.querySelector('h2 time').textContent=displayDate(d.time)+'｜'+s.symbol+' '+s.name;
    s.sheet.querySelector('[data-sheet-action="previous"]').disabled=!C.adjacent(dates,d.time,-1)&&(s.nextYear<s.firstYear||s.busy);
    s.sheet.querySelector('[data-sheet-action="next"]').disabled=!C.adjacent(dates,d.time,1);
    s.sheet.querySelector('.radarHistorySheetBody').innerHTML=`
      <h3>正式 C4</h3><dl>${cells([['正式總分',c?num(c.value)+' 分':'無正式 C4 紀錄'],['正式級距',c?.tier||'—'],['前筆正式分數',num(c?.previousValue)],['分數增減',signed(c?.delta)],['比較日期',displayDate(c?.previousDate)]])}</dl>
      <h3>三項正式因子</h3>${!c||c.factors.some(f=>f.raw===null||f.weight===null||f.contribution===null)?'<p>該日未保存正式分項資料</p>':''}
      <table><thead><tr><th>指標／權重</th><th>原始值</th><th>加權貢獻</th></tr></thead><tbody>${C.FACTORS.map(({key,label})=>{const f=c?.factors.find(f=>f.key===key);return`<tr><th>${label}<small>${f?.weight!=null?num(f.weight)+'%':'權重未保存'}</small></th><td>${num(f?.raw)}</td><td>${num(f?.contribution)}</td></tr>`;}).join('')}</tbody></table>
      <p>直接讀取當時保存的正式計分輸出；未補算歷史分項。</p>
      <h3>ETF 原始行情</h3><dl>${cells([['Open',num(p?.open)],['High',num(p?.high)],['Low',num(p?.low)],['Close',num(p?.close)],['漲跌金額',signed(d.change)],['漲跌幅',d.returnPct===null?'—':signed(d.returnPct)+'%'],['前一有效價格日期',displayDate(d.previousPriceDate)]])}</dl>
      <p>原始價格漲跌不含配息。${d.dividends.length?' 當日除息 '+d.dividends.map(e=>num(e.amount)+' 元（'+esc(e.source)+'）').join('、'):''}</p>
      <h3>資料狀態</h3><p>${esc(dataState(s,d).join('｜'))}</p>
      <dl>${cells([['C4 版本',c?.version||'—'],['C4 來源',c?.source||'—'],['資料日期',c?.asOf||'—'],['正式更新',c?.updatedAt||'未保存'],['股價來源',p?.source||'—'],['行情取得',p?.fetchedAt||'—']])}</dl>
      ${c?`<p>來源原始分數 ${esc(c.value)}</p>`:''}`;
  }
  function visible(s,r){if(active!==s||!r)return;s.host.dataset.visibleFrom=String(r.from);s.host.dataset.visibleTo=String(r.to);const x=C.extrema(s.axis,s.score.rows,s.prices,r);if(!x)return;const entry=(label,row,key)=>`<div><small>${label}</small><b>${num(row?.[key])}</b><time>${esc(row?.time||'資料不足')}</time></div>`;s.host.querySelector('.radarHistoryExtrema').innerHTML=entry('C4 最高',x.scoreHigh,'value')+entry('C4 最低',x.scoreLow,'value')+entry('股價最高',x.priceHigh,'high')+entry('股價最低',x.priceLow,'low');
    const latest=s.prices.at(-1)?.time,expected=s.dates.filter(d=>d<=s.cutoff).at(-1);s.host.dataset.calendarRange=s.dates[0]+"~"+s.dates.at(-1);s.host.dataset.loadedYears=[...s.years].sort().join(",");s.host.dataset.rejectedDates=s.invalid.join(",");s.status(`原始歷史起點 ${s.prices[0]?.time||"資料不足"}｜可視交易日 ${x.sessions}｜C4 ${x.scoreCount}/${x.sessions}｜股價 ${x.priceCount}/${x.sessions}。C4 截至 ${s.score.rows.at(-1)?.time||'資料不足'}；原始日線 ${latest||'資料不足'}（${latest===expected?'已驗證':'待更新'}）。${s.invalid.length||s.score.invalid.length?'驗證異常：已隔離不合格資料。':''}${s.nextYear>=s.firstYear?'已載入 '+[...s.years].sort().join('、')+'；可向左載入更早資料。':'已查詢來源全部交易日範圍。'}${s.dividendStatus==='UNAVAILABLE'?'除息資料不足。':''}`);
    if(s.warnings.size)s.status(s.host.querySelector('.radarHistoryStatus').textContent+' 最新增量未完成｜'+[...s.warnings].map(sourceMessage).join('、')+'；保留已驗證快取，不代表完整最新歷史。');
    if(s.observedOnly){s.status(s.host.querySelector('.radarHistoryStatus').textContent.replace('（已驗證）','（日期完整性待確認）').replace('已查詢來源全部交易日範圍。','已載入保存資料範圍。')+' 交易日曆不可用：僅按已保存行情／正式 C4 日期排列，不能確認缺日；MA 暫停顯示。');}
    const suspension=root.HSRadarHistorySource.SUSPENSIONS?.[s.symbol],noTrade=new Set(suspension?.dates||[]);
    const priceDates=new Set(s.prices.map(p=>p.time));s.host.dataset.missingPriceDates=s.axis.filter(d=>d>=s.prices[0]?.time&&d<=s.prices.at(-1)?.time&&!priceDates.has(d)&&!noTrade.has(d)).join(',');
    s.host.dataset.knownNoTradeDates=[...noTrade].filter(d=>d>=s.prices[0]?.time&&d<=s.prices.at(-1)?.time).join(',');
    if(s.host.dataset.knownNoTradeDates)s.status(s.host.querySelector('.radarHistoryStatus').textContent+' 0050：2025/06/11–06/17 為已確認分割停牌五個交易日（TWSE 2025/06/17 公告），不補 K 線。');
    const points=[];if(s.prefs.extrema){if(x.priceHigh)points.push({time:x.priceHigh.time,position:'aboveBar',color:'#dfc587',shape:'circle',text:'高 '+num(x.priceHigh.high)});if(x.priceLow)points.push({time:x.priceLow.time,position:'belowBar',color:'#dfc587',shape:'circle',text:'低 '+num(x.priceLow.low)});}
    for(const e of s.events)if(s.prices.some(p=>p.time===e.time))points.push({time:e.time,position:'belowBar',color:'#b7a6de',shape:'arrowUp',text:'息 '+num(e.amount)});s.priceMarkers?.setMarkers(points.sort((a,b)=>a.time.localeCompare(b.time)));
    for(const m of s.scoreMarkers||[]){const points=[];if(s.prefs.extrema&&s.prefs.score){if(x.scoreHigh&&m.times.has(x.scoreHigh.time))points.push({time:x.scoreHigh.time,position:'aboveBar',color:'#e8c367',shape:'circle',text:'高 '+num(x.scoreHigh.value)});if(x.scoreLow&&m.times.has(x.scoreLow.time)&&x.scoreLow.time!==x.scoreHigh?.time)points.push({time:x.scoreLow.time,position:'belowBar',color:'#e8c367',shape:'circle',text:'低 '+num(x.scoreLow.value)});}m.api.setMarkers(points.sort((a,b)=>a.time.localeCompare(b.time)));}
    if(r.from<2&&s.prices.length&&!s.busy&&s.nextYear>=s.firstYear&&s.prefs.range!=='ALL')older(s).catch(error=>s.status('更早資料取得失敗｜'+error.message));
  }
  function draw(s,preserve){
    if(active!==s)return;const L=root.LightweightCharts,oldRange=s.chart?.timeScale().getVisibleRange(),oldAxis=s.axis;s.axis=C.axis(s.dates,s.score.rows,s.prices);s.host.querySelector('.radarHistoryCanvas').hidden=!s.axis.length;if(!s.axis.length){s.status('歷史資料不足；可載入更早歷史或重新取得。');return;}s.rendering=true;
    if(!s.chart){s.chart=L.createChart(s.host.querySelector('.radarHistoryCanvas'),{height:560,layout:{background:{color:'#090806'},textColor:'#c7baa2',fontSize:12,attributionLogo:true,panes:{separatorColor:'#574324',enableResize:false}},grid:{vertLines:{color:'#201c14'},horzLines:{color:'#201c14'}},rightPriceScale:{minimumWidth:64,autoScale:true},timeScale:{borderColor:'#574324',rightOffset:0,lockVisibleTimeRangeOnResize:true,minBarSpacing:.01,timeVisible:false},crosshair:{mode:L.CrosshairMode.Normal},handleScroll:{mouseWheel:false,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:false},handleScale:{mouseWheel:false,pinch:true,axisPressedMouseMove:true},trackingMode:{exitMode:L.TrackingModeExitMode.OnNextTap}});
      s.chart.subscribeCrosshairMove(param=>{
        if(param.time)s.lastCrosshair={time:param.time,sourceEvent:Boolean(param.sourceEvent)};
        // Data/range/marker redraws also emit crosshair events. They must not
        // replace the latest date (or a retained selection) without user input.
        if(active!==s||s.syncingCursor||s.rendering)return;
        if(!param.time){syncCursor(s);return;}
        const time=typeof param.time==='string'?param.time:`${param.time.year}-${String(param.time.month).padStart(2,'0')}-${String(param.time.day).padStart(2,'0')}`;
        if(param.sourceEvent&&s.inputEpoch>s.consumedInputEpoch){s.consumedInputEpoch=s.inputEpoch;showDetail(s,time);}
        else if(time!==s.selected){s.syncingCursor=true;try{s.chart.clearCrosshairPosition();}finally{s.syncingCursor=false;}syncCursor(s);}
      });
      s.chart.subscribeClick(param=>{if(active!==s||!param.time||!param.sourceEvent)return;const time=typeof param.time==='string'?param.time:`${param.time.year}-${String(param.time.month).padStart(2,'0')}-${String(param.time.day).padStart(2,'0')}`;selectDate(s,time);});
      s.chart.timeScale().subscribeVisibleLogicalRangeChange(r=>visible(s,r));s.resize=new ResizeObserver(entries=>{const width=Math.floor(entries[0].contentRect.width);if(width>0)s.chart.applyOptions({width});});s.resize.observe(s.host.querySelector('.radarHistoryCanvas'));
      s.anchor=s.chart.addSeries(L.LineSeries,{color:'transparent',lineVisible:false,priceLineVisible:false,lastValueVisible:false},0);
      s.priceSeries=s.chart.addSeries(L.CandlestickSeries,{upColor:'#ed786f',downColor:'#64c593',borderUpColor:'#ed786f',borderDownColor:'#64c593',wickUpColor:'#ed786f',wickDownColor:'#64c593'},1);s.priceMarkers=L.createSeriesMarkers(s.priceSeries,[]);s.chart.panes()[0].setHeight(230);s.chart.panes()[1].setHeight(300);
    }
    for(const m of s.scoreMarkers||[])m.api.detach();s.scoreMarkers=[];
    for(const series of s.series)s.chart.removeSeries(series);s.series=[];
    const priceByDate=new Map(s.prices.map(r=>[r.time,r]));
    s.anchor.setData(s.axis.map(time=>({time})));s.priceSeries.applyOptions({visible:s.prefs.price});s.priceSeries.setData(s.axis.map(time=>priceByDate.get(time)||{time}));
    const addLines=(segments,options,pane)=>{const added=[];for(const data of segments){const series=s.chart.addSeries(L.LineSeries,{priceLineVisible:false,lastValueVisible:false,...options},pane);series.setData(data);s.series.push(series);added.push(series);}return added;};
    const scoreSeries=addLines(C.segments(s.axis,s.score.rows),{color:'#e8c367',lineWidth:2,pointMarkersVisible:true,pointMarkersRadius:2,visible:s.prefs.score},0);
    s.scoreLines=scoreSeries;
    s.scoreMarkers=scoreSeries.map(series=>({api:L.createSeriesMarkers(series,[]),times:new Set(series.data().map(r=>r.time))}));
    if(s.prefs.thresholds&&s.prefs.score&&scoreSeries[0])for(const t of s.thresholds)scoreSeries[0].createPriceLine({price:t.value,title:t.label,color:'#786442',lineWidth:1,lineStyle:2,axisLabelVisible:true});
    for(const [i,period] of [5,10,20,60].entries())if(!s.observedOnly&&s.prefs['ma'+period])addLines(C.segments(s.axis,C.movingAverage(s.axis,s.prices,period)),{color:['#d9c597','#9fbaed','#c29bcf','#80b9b0'][i],lineWidth:1},1);
    if(s.prefs.volume){const series=s.chart.addSeries(L.HistogramSeries,{priceScaleId:'volume',priceFormat:{type:'volume'},priceLineVisible:false,lastValueVisible:false},1);series.priceScale().applyOptions({scaleMargins:{top:.85,bottom:0}});series.setData(s.prices.map(p=>({time:p.time,value:p.volume,color:p.close>=p.open?'#ed786f55':'#64c59355'})));s.series.push(series);}
    if(preserve&&oldRange&&oldAxis?.length)s.chart.timeScale().setVisibleRange(oldRange);else setRange(s);visible(s,s.chart.timeScale().getVisibleLogicalRange());syncControls(s);showDetail(s,s.selected&&s.axis.includes(s.selected)?s.selected:s.axis.at(-1));s.rendering=false;syncCursor(s);
  }
  root.HSRadarHistoryView={html,mount,unmount,layoutDiagnostics};
})(window);
